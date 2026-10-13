package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type adapter struct {
	tokenURL, clientID, clientSecret, header string
	sidecarURL, entraID                      string
	resources                                map[string]downstream
	client                                   *http.Client
	graph                                    graphIdentity
}

type downstream struct {
	Scope         string `json:"scope"`
	LocalAudience string `json:"local_audience"`
	name          string
}

func loadAdapter() (*adapter, error) {
	a := &adapter{
		tokenURL: os.Getenv("KEYCLOAK_TOKEN_URL"), clientID: os.Getenv("KEYCLOAK_CLIENT_ID"),
		clientSecret: os.Getenv("KEYCLOAK_CLIENT_SECRET"), header: os.Getenv("IDENTITY_HEADER"),
		sidecarURL: os.Getenv("IDENTITY_SIDECAR_URL"),
		entraID:    os.Getenv("AGENT_IDENTITY_CLIENT_ID"), resources: make(map[string]downstream),
	}
	required := map[string]string{
		"IDENTITY_HEADER": a.header, "IDENTITY_DOWNSTREAM": os.Getenv("IDENTITY_DOWNSTREAM"),
		"KEYCLOAK_CLIENT_ID": a.clientID, "KEYCLOAK_CLIENT_SECRET": a.clientSecret,
		"KEYCLOAK_TOKEN_URL": a.tokenURL,
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("%s is required", name)
		}
	}
	var bindings map[string]downstream
	decoder := json.NewDecoder(strings.NewReader(required["IDENTITY_DOWNSTREAM"]))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&bindings); err != nil || len(bindings) == 0 {
		return nil, fmt.Errorf("IDENTITY_DOWNSTREAM must contain app-only downstream bindings")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("IDENTITY_DOWNSTREAM must contain one JSON object")
	}
	for name, binding := range bindings {
		resource := strings.TrimSuffix(binding.Scope, "/.default")
		if name == "" || name == "." || name == ".." || url.PathEscape(name) != name ||
			resource == "" || resource == binding.Scope || strings.ContainsAny(resource, " \t\r\n?#") ||
			(binding.LocalAudience != "" && strings.TrimSpace(binding.LocalAudience) != binding.LocalAudience) {
			return nil, fmt.Errorf("IDENTITY_DOWNSTREAM contains an invalid name, scope or local audience")
		}
		if _, exists := a.resources[resource]; exists {
			return nil, fmt.Errorf("IDENTITY_DOWNSTREAM contains duplicate resources")
		}
		binding.name = name
		a.resources[resource] = binding
		if binding.LocalAudience == "" {
			required["AGENT_IDENTITY_CLIENT_ID"] = a.entraID
			required["IDENTITY_SIDECAR_URL"] = a.sidecarURL
		}
	}
	if os.Getenv("GRAPH_DELEGATION_ENABLED") == "true" {
		required["AGENT_IDENTITY_CLIENT_ID"] = a.entraID
		required["IDENTITY_SIDECAR_URL"] = a.sidecarURL
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("%s is required", name)
		}
		if name != "KEYCLOAK_TOKEN_URL" && name != "IDENTITY_SIDECAR_URL" {
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
	return a, nil
}

func reject(w http.ResponseWriter, status int, message string) {
	slog.Warn("DAC request failed", "status", status, "reason", message)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": http.StatusText(status), "error_description": message,
	})
}

func (a *adapter) token(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		reject(w, http.StatusMethodNotAllowed, "Use GET")
		return
	}
	if len(r.Header.Values("X-IDENTITY-HEADER")) != 1 || a.header == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-IDENTITY-HEADER")), []byte(a.header)) != 1 {
		reject(w, http.StatusUnauthorized, "Managed identity endpoint authorization required")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || r.ContentLength > 0 || len(r.TransferEncoding) != 0 {
		reject(w, http.StatusBadRequest, "Invalid managed identity request")
		return
	}
	for key, values := range query {
		if len(values) != 1 || (key != "resource" && key != "api-version" && key != "client_id") {
			reject(w, http.StatusBadRequest, "Unsupported or repeated parameter")
			return
		}
	}
	resource := query.Get("resource")
	target, allowed := a.resources[resource]
	if query.Get("api-version") != "2019-08-01" || !allowed {
		reject(w, http.StatusBadRequest, "Unsupported API version or resource")
		return
	}
	actor := a.clientID
	if a.entraID != "" {
		actor = a.entraID
	}
	if ids, present := query["client_id"]; present && ids[0] != actor {
		reject(w, http.StatusBadRequest, "Requested identity is not bound to this pod")
		return
	}

	method, endpoint := http.MethodGet, ""
	var payload io.Reader
	local := target.LocalAudience != ""
	if !local {
		params := url.Values{"AgentIdentity": {a.entraID}, "optionsOverride.RequestAppToken": {"true"}}
		endpoint = strings.TrimRight(a.sidecarURL, "/") + "/AuthorizationHeaderUnauthenticated/" + url.PathEscape(target.name) + "?" + params.Encode()
	} else {
		method, endpoint = http.MethodPost, a.tokenURL
		form := url.Values{
			"grant_type": {"client_credentials"}, "client_id": {a.clientID},
			"client_secret": {a.clientSecret},
		}
		payload = strings.NewReader(form.Encode())
	}
	request, err := http.NewRequestWithContext(r.Context(), method, endpoint, payload)
	if err != nil {
		reject(w, http.StatusInternalServerError, "Invalid identity provider configuration")
		return
	}
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	started := time.Now().Unix()
	response, err := a.client.Do(request)
	if err != nil {
		reject(w, http.StatusServiceUnavailable, "Identity provider unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		slog.Warn("Identity provider rejected token request", "downstream", target.name, "status", response.StatusCode)
		reject(w, http.StatusBadGateway, "Identity provider rejected token acquisition")
		return
	}
	const maxResponse = 64 << 10
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	var token struct {
		AccessToken         string `json:"access_token"`
		TokenType           string `json:"token_type"`
		ExpiresIn           int64  `json:"expires_in"`
		AuthorizationHeader string `json:"authorizationHeader"`
	}
	if err != nil || len(body) > maxResponse || json.Unmarshal(body, &token) != nil {
		reject(w, http.StatusBadGateway, "Identity provider returned an invalid token response")
		return
	}
	var expires int64
	if !local {
		var bearer bool
		token.AccessToken, bearer = strings.CutPrefix(token.AuthorizationHeader, "Bearer ")
		if bearer {
			expires = jwtExpiry(token.AccessToken)
		}
	} else if strings.EqualFold(token.TokenType, "Bearer") && token.ExpiresIn > 0 && token.ExpiresIn <= math.MaxInt64-started {
		expires = started + token.ExpiresIn
	}
	if token.AccessToken == "" || strings.TrimSpace(token.AccessToken) != token.AccessToken || expires <= time.Now().Unix() {
		reject(w, http.StatusBadGateway, "Identity provider returned an invalid token response")
		return
	}
	// ponytail: DAC owns caching; this endpoint only translates the token response.
	if err := json.NewEncoder(w).Encode(map[string]string{
		"access_token": token.AccessToken, "expires_on": strconv.FormatInt(expires, 10),
		"resource": resource, "token_type": "Bearer", "client_id": actor,
	}); err != nil {
		slog.Warn("Could not deliver token response")
	}
}

func jwtExpiry(token string) int64 {
	// Read lifetime from the trusted Entra sidecar; resource servers verify the JWT.
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

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1:8081/healthz")
		if err != nil {
			os.Exit(1)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			os.Exit(1)
		}
		if os.Getenv("AGENT_RESPONSE_PATH") != "" {
			response, err = client.Get("http://127.0.0.1:8083/healthz")
			if err != nil {
				os.Exit(1)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				os.Exit(1)
			}
		}
		return
	}
	a, err := loadAdapter()
	if err != nil {
		slog.Error("Invalid adapter configuration", "error", err)
		os.Exit(1)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/identity/token", a.token)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	if path := os.Getenv("AGENT_RESPONSE_PATH"); path != "" {
		if !strings.HasPrefix(path, "/agents/") || !strings.HasSuffix(path, "/responses") || strings.ContainsAny(path, "?#%") {
			slog.Error("Invalid AGENT_RESPONSE_PATH")
			os.Exit(1)
		}
		admission := &http.Server{
			Addr: ":8083", Handler: a.responseAdmission(path),
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
			WriteTimeout: 30 * time.Second, MaxHeaderBytes: 32 << 10,
		}
		go func() {
			if err := admission.ListenAndServe(); err != nil {
				slog.Error("Responses admission stopped", "error", err)
				os.Exit(1)
			}
		}()
	}
	server := &http.Server{
		Addr: "127.0.0.1:8081", Handler: mux, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 15 * time.Second,
		IdleTimeout: time.Minute, MaxHeaderBytes: 8 << 10,
	}
	slog.Info("DAC adapter listening", "address", server.Addr)
	if err := server.ListenAndServe(); err != nil {
		slog.Error("DAC adapter stopped", "error", err)
		os.Exit(1)
	}
}

// Envoy verifies callers. This check only bounds SDK behavior until native
// stored-response caller isolation is qualified; it never forwards invocation.
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
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if r.Method != http.MethodPost || r.URL.RequestURI() != path || err != nil ||
			contentType != "application/json" || r.Header.Get("Content-Encoding") != "" ||
			r.Header.Get("X-Envoy-Auth-Partial-Body") == "true" {
			http.Error(w, "Only stateless foreground Responses are qualified", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
		if err != nil || len(body) > 1<<20 || !statelessResponse(body) {
			http.Error(w, "Explicit store=false and text input required; references and background execution denied", http.StatusForbidden)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		if err := a.admitIdentity(w, r.WithContext(ctx)); err != nil {
			slog.Warn("Responses identity admission failed", "status", err.status, "reason", err.message)
			http.Error(w, err.message, err.status)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
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
