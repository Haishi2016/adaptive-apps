package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

var responsePath = regexp.MustCompile(`^/agents/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?/responses$`)

type adapter struct {
	tokenURL, sidecarURL, entraID, admissionURL string
	client                                      *http.Client
	graph                                       graphIdentity
}

func loadBroker() (*adapter, error) {
	a := &adapter{
		tokenURL:     os.Getenv("KEYCLOAK_TOKEN_URL"),
		sidecarURL:   os.Getenv("IDENTITY_SIDECAR_URL"),
		entraID:      os.Getenv("AGENT_IDENTITY_CLIENT_ID"),
		admissionURL: strings.TrimRight(os.Getenv("AGENT_GATEWAY_ADMISSION_URL"), "/"),
	}
	for name, value := range map[string]string{
		"AGENT_GATEWAY_ADMISSION_URL": a.admissionURL,
		"AGENT_IDENTITY_CLIENT_ID":    a.entraID,
		"IDENTITY_SIDECAR_URL":        a.sidecarURL,
		"KEYCLOAK_TOKEN_URL":          a.tokenURL,
	} {
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("%s is required", name)
		}
		if name == "AGENT_IDENTITY_CLIENT_ID" {
			continue
		}
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" ||
			u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("%s must be an HTTP(S) URL without credentials, query or fragment", name)
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	a.client = &http.Client{
		Transport: transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	if err := a.loadGraphIdentity(); err != nil {
		return nil, err
	}
	if !a.graph.enabled {
		return nil, fmt.Errorf("delegation broker requires GRAPH_DELEGATION_ENABLED=true")
	}
	return a, nil
}

func reject(w http.ResponseWriter, status int, message string) {
	slog.Warn("Agent Gateway request failed", "status", status, "reason", message)
	http.Error(w, message, status)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1:8083/healthz")
		if err != nil {
			os.Exit(1)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			os.Exit(1)
		}
		return
	}

	var handler http.Handler = gatewayAdmission()
	mode := os.Getenv("AGENT_GATEWAY_MODE")
	if mode == "delegation-broker" {
		broker, err := loadBroker()
		if err != nil {
			slog.Error("Invalid delegation broker configuration", "error", err)
			os.Exit(1)
		}
		defer broker.client.CloseIdleConnections()
		handler = broker.responseAdmission("")
	} else if mode != "" && mode != "admission" {
		slog.Error("AGENT_GATEWAY_MODE must be admission or delegation-broker")
		os.Exit(1)
	}

	server := &http.Server{
		Addr: ":8083", Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 35 * time.Second,
		IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10,
	}
	slog.Info("Agent Gateway policy service listening", "address", server.Addr, "mode", mode)
	if err := server.ListenAndServe(); err != nil {
		slog.Error("Agent Gateway policy service stopped", "error", err)
		os.Exit(1)
	}
}

func gatewayAdmission() http.Handler {
	return responseAdmission("")
}

func responseAdmission(path string) http.Handler {
	return (&adapter{}).responseAdmission(path)
}

func (a *adapter) responseAdmission(path string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodGet && r.URL.RequestURI() == "/healthz" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var body []byte
		if a.admissionURL != "" {
			var err error
			body, err = io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
			if err != nil || len(body) > 1<<20 {
				reject(w, http.StatusForbidden, "Agent Gateway request body is invalid or too large")
				return
			}
			if failure := a.authorizeWithGateway(r, body); failure != nil {
				reject(w, failure.status, failure.message)
				return
			}
		} else {
			var failure *admissionError
			body, failure = validateResponseRequest(r, path)
			if failure != nil {
				reject(w, failure.status, failure.message)
				return
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		if a.client != nil {
			if err := a.admitIdentity(w, r.WithContext(ctx)); err != nil {
				reject(w, err.status, err.message)
				return
			}
		} else {
			w.Header().Set(admissionMode, "app")
			w.Header().Set(admissionToken, "")
			w.Header().Set(admissionUser, "")
			if mode := r.Header.Get("X-Impersonation-Mode"); mode != "" && mode != "app" {
				reject(w, http.StatusForbidden, "Delegated identity requires a connected agent runtime")
				return
			}
			if r.Header.Get("X-Entra-User-Token") != "" {
				reject(w, http.StatusBadRequest, "An Entra user assertion requires delegated identity")
				return
			}
		}
		w.WriteHeader(http.StatusOK)
	})
}

func validateResponseRequest(r *http.Request, exactPath string) ([]byte, *admissionError) {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	pathAllowed := r.URL.RawQuery == "" && responsePath.MatchString(r.URL.Path)
	if exactPath != "" {
		pathAllowed = r.URL.RequestURI() == exactPath
	}
	if r.Method != http.MethodPost || !pathAllowed || err != nil ||
		contentType != "application/json" || r.Header.Get("Content-Encoding") != "" ||
		r.Header.Get("X-Envoy-Auth-Partial-Body") == "true" {
		return nil, admissionFailure(http.StatusForbidden, "Only stateless foreground Responses are qualified")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 || !statelessResponse(body) {
		return nil, admissionFailure(http.StatusForbidden, "Explicit store=false and text input required; references and background execution denied")
	}
	return body, nil
}

func (a *adapter) authorizeWithGateway(r *http.Request, body []byte) *admissionError {
	endpoint := a.admissionURL + r.URL.Path
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return admissionFailure(http.StatusServiceUnavailable, "Agent Gateway admission configuration is invalid")
	}
	for _, name := range []string{"Content-Type", "Content-Encoding", "X-Envoy-Auth-Partial-Body"} {
		if value := r.Header.Get(name); value != "" {
			request.Header.Set(name, value)
		}
	}
	response, err := a.client.Do(request)
	if err != nil {
		return admissionFailure(http.StatusServiceUnavailable, "Agent Gateway admission unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return admissionFailure(http.StatusForbidden, "Agent Gateway denied the Responses request")
	}
	return nil
}

func responseFields(body []byte) (map[string]json.RawMessage, bool) {
	d := json.NewDecoder(bytes.NewReader(body))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, false
		}
		name, ok := key.(string)
		if !ok || fields[name] != nil {
			return nil, false
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, false
		}
		fields[name] = value
	}
	if end, err := d.Token(); err != nil || end != json.Delim('}') || d.Decode(new(any)) != io.EOF {
		return nil, false
	}
	return fields, true
}

func textInput(body []byte) bool {
	var text string
	if json.Unmarshal(body, &text) == nil {
		return strings.TrimSpace(text) != ""
	}
	var messages []json.RawMessage
	if json.Unmarshal(body, &messages) != nil || len(messages) == 0 || len(messages) > 128 {
		return false
	}
	for _, raw := range messages {
		message, ok := responseFields(raw)
		if !ok || len(message) < 2 || len(message) > 3 ||
			(string(message["role"]) != `"user"` && string(message["role"]) != `"assistant"`) {
			return false
		}
		for key := range message {
			if key != "role" && key != "content" && key != "type" {
				return false
			}
		}
		if kind := message["type"]; kind != nil && string(kind) != `"message"` {
			return false
		}
		if json.Unmarshal(message["content"], &text) == nil {
			if strings.TrimSpace(text) == "" {
				return false
			}
			continue
		}
		var contents []json.RawMessage
		if json.Unmarshal(message["content"], &contents) != nil || len(contents) == 0 || len(contents) > 128 {
			return false
		}
		for _, content := range contents {
			block, ok := responseFields(content)
			if !ok || len(block) < 2 || len(block) > 4 ||
				(string(block["type"]) != `"input_text"` && string(block["type"]) != `"output_text"`) ||
				json.Unmarshal(block["text"], &text) != nil || strings.TrimSpace(text) == "" {
				return false
			}
			for key := range block {
				if key != "type" && key != "text" && key != "annotations" && key != "logprobs" {
					return false
				}
			}
			if annotations := block["annotations"]; annotations != nil && string(annotations) != "[]" {
				return false
			}
			if logprobs := block["logprobs"]; logprobs != nil && string(logprobs) != "[]" {
				return false
			}
		}
	}
	return true
}

func statelessResponse(body []byte) bool {
	fields, ok := responseFields(body)
	if !ok || string(fields["store"]) != "false" || !textInput(fields["input"]) {
		return false
	}
	for key, value := range fields {
		switch key {
		case "input", "store":
		case "background":
			if string(value) != "false" {
				return false
			}
		case "stream":
			if string(value) != "true" && string(value) != "false" {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func jwtExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Expires int64 `json:"exp"`
	}
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return 0
	}
	return claims.Expires
}
