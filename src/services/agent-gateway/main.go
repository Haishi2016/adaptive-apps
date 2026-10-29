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
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
)

var responsePath = regexp.MustCompile(`^/agents/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?/responses$`)

type adapter struct {
	tokenURL, sidecarURL, entraID string
	client                        *http.Client
	graph                         graphIdentity
	strictResponses               bool
}

func loadBroker() (*adapter, error) {
	strictResponses := os.Getenv("RESPONSES_ADMISSION_ENABLED")
	if strictResponses != "" && strictResponses != "false" && strictResponses != "true" {
		return nil, fmt.Errorf("RESPONSES_ADMISSION_ENABLED must be true or false")
	}
	a := &adapter{
		tokenURL:        os.Getenv("KEYCLOAK_TOKEN_URL"),
		sidecarURL:      os.Getenv("IDENTITY_SIDECAR_URL"),
		entraID:         os.Getenv("AGENT_IDENTITY_CLIENT_ID"),
		strictResponses: strictResponses == "true",
	}
	for name, value := range map[string]string{
		"AGENT_IDENTITY_CLIENT_ID": a.entraID,
		"IDENTITY_SIDECAR_URL":     a.sidecarURL,
		"KEYCLOAK_TOKEN_URL":       a.tokenURL,
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
	slog.Warn("Agent policy request failed", "status", status, "reason", message)
	http.Error(w, message, status)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		connection, err := net.DialTimeout("tcp", "127.0.0.1:8083", 2*time.Second)
		if err != nil {
			os.Exit(1)
		}
		connection.Close()
		return
	}

	var handler http.Handler = gatewayAdmission()
	mode := os.Getenv("AGENT_POLICY_MODE")
	if mode == "delegation-broker" {
		broker, err := loadBroker()
		if err != nil {
			slog.Error("Invalid delegation broker configuration", "error", err)
			os.Exit(1)
		}
		defer broker.client.CloseIdleConnections()
		handler = broker.responseAdmission("")
	} else if mode != "" && mode != "admission" {
		slog.Error("AGENT_POLICY_MODE must be admission or delegation-broker")
		os.Exit(1)
	}

	listener, err := net.Listen("tcp", ":8083")
	if err != nil {
		slog.Error("Agent policy service failed to listen", "error", err)
		os.Exit(1)
	}
	server := grpc.NewServer(grpc.MaxRecvMsgSize((1 << 20) + (64 << 10)))
	authv3.RegisterAuthorizationServer(server, &authorizationServer{handler: handler})
	slog.Info("Agent policy service listening", "address", listener.Addr(), "mode", mode)
	if err := server.Serve(listener); err != nil {
		slog.Error("Agent policy service stopped", "error", err)
		os.Exit(1)
	}
}

type authorizationServer struct {
	authv3.UnimplementedAuthorizationServer
	handler http.Handler
}

func (s *authorizationServer) Check(ctx context.Context, check *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	httpAttributes := check.GetAttributes().GetRequest().GetHttp()
	if httpAttributes == nil {
		return deniedResponse(http.StatusForbidden, "Missing HTTP request attributes"), nil
	}
	requestURL, err := url.ParseRequestURI(httpAttributes.GetPath())
	if err != nil {
		return deniedResponse(http.StatusForbidden, "Invalid request path"), nil
	}
	body := httpAttributes.GetRawBody()
	if len(body) == 0 {
		body = []byte(httpAttributes.GetBody())
	}
	request := &http.Request{
		Method: httpAttributes.GetMethod(),
		URL:    requestURL,
		Header: make(http.Header, len(httpAttributes.GetHeaders())),
		Body:   io.NopCloser(bytes.NewReader(body)),
	}
	request = request.WithContext(ctx)
	for name, value := range httpAttributes.GetHeaders() {
		request.Header.Set(name, value)
	}

	response := &responseCapture{header: make(http.Header), status: http.StatusOK}
	s.handler.ServeHTTP(response, request)
	if response.status < http.StatusOK || response.status >= http.StatusMultipleChoices {
		return deniedResponse(response.status, strings.TrimSpace(response.body.String())), nil
	}
	headers := make([]*corev3.HeaderValueOption, 0, 3)
	for _, name := range []string{admissionMode, admissionToken, admissionUser} {
		if values, found := response.header[http.CanonicalHeaderKey(name)]; found {
			headers = append(headers, &corev3.HeaderValueOption{
				Header:       &corev3.HeaderValue{Key: name, RawValue: []byte(values[0])},
				AppendAction: corev3.HeaderValueOption_OVERWRITE_IF_EXISTS_OR_ADD,
			})
		}
	}
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.OK)},
		HttpResponse: &authv3.CheckResponse_OkResponse{
			OkResponse: &authv3.OkHttpResponse{Headers: headers},
		},
	}, nil
}

type responseCapture struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (r *responseCapture) Header() http.Header  { return r.header }
func (r *responseCapture) WriteHeader(code int) { r.status = code }
func (r *responseCapture) Write(body []byte) (int, error) {
	return r.body.Write(body)
}

func deniedResponse(code int, message string) *authv3.CheckResponse {
	if code < 400 || code > 599 {
		code = http.StatusForbidden
	}
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied), Message: message},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{
			DeniedResponse: &authv3.DeniedHttpResponse{
				Status: &typev3.HttpStatus{Code: typev3.StatusCode(code)},
				Body:   message,
			},
		},
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
		if a.client == nil || a.strictResponses {
			_, failure := validateResponseRequest(r, path)
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
