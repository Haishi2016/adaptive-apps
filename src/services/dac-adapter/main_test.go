package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func configure(t *testing.T, endpoint string) *adapter {
	t.Helper()
	t.Setenv("KEYCLOAK_TOKEN_URL", endpoint)
	t.Setenv("KEYCLOAK_CLIENT_ID", "agent-client")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "private-client-secret")
	t.Setenv("IDENTITY_HEADER", "pod-secret")
	t.Setenv("AGENT_IDENTITY_CLIENT_ID", "")
	t.Setenv("IDENTITY_DOWNSTREAM", `{"model-gateway":{"scope":"https://cognitiveservices.azure.com/.default","local_audience":"api://adaptive-model-gateway"}}`)
	a, err := loadAdapter()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.client.CloseIdleConnections)
	return a
}

func request(a *adapter, method, query, header string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/identity/token?"+query, nil)
	if header != "" {
		r.Header.Set("X-IDENTITY-HEADER", header)
	}
	w := httptest.NewRecorder()
	a.token(w, r)
	return w
}

const validQuery = "resource=https%3A%2F%2Fcognitiveservices.azure.com&api-version=2019-08-01"

func TestTokenEndpoint(t *testing.T) {
	calls := 0
	status, body := http.StatusOK, `{"access_token":"keycloak-token","token_type":"Bearer","expires_in":300}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPost || r.URL.Path != "/token" {
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("X-IDENTITY-HEADER") != "" || r.Header.Get("Authorization") != "" {
			t.Error("caller credentials forwarded upstream")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if len(r.PostForm) != 3 || r.PostForm.Get("grant_type") != "client_credentials" ||
			r.PostForm.Get("client_id") != "agent-client" || r.PostForm.Get("client_secret") != "private-client-secret" {
			t.Error("unexpected OAuth form")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	defer upstream.Close()
	a := configure(t, upstream.URL+"/token")

	t.Run("DAC response", func(t *testing.T) {
		start := time.Now().Unix()
		w := request(a, http.MethodGet, validQuery+"&client_id=agent-client", "pod-secret")
		var result map[string]string
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("invalid response: %d %s", w.Code, w.Body)
		}
		expires, err := strconv.ParseInt(result["expires_on"], 10, 64)
		if err != nil || expires < start+300 || expires > time.Now().Unix()+300 ||
			len(result) != 5 || result["access_token"] != "keycloak-token" ||
			result["resource"] != "https://cognitiveservices.azure.com" || result["client_id"] != a.clientID ||
			result["token_type"] != "Bearer" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unexpected managed identity response: %v", result)
		}
	})
	for _, tc := range []struct {
		name, method, query, header string
		code                        int
	}{
		{"missing header", "GET", validQuery, "", 401},
		{"wrong header", "GET", validQuery, "wrong", 401},
		{"wrong method", "POST", validQuery, "pod-secret", 405},
		{"wrong version", "GET", "resource=https://cognitiveservices.azure.com", "pod-secret", 400},
		{"cloud resource", "GET", "api-version=2019-08-01&resource=https://graph.microsoft.com", "pod-secret", 400},
		{"wrong identity", "GET", validQuery + "&client_id=other", "pod-secret", 400},
		{"empty identity", "GET", validQuery + "&client_id=", "pod-secret", 400},
		{"unsupported selector", "GET", validQuery + "&object_id=other", "pod-secret", 400},
		{"duplicate resource", "GET", validQuery + "&resource=other", "pod-secret", 400},
		{"malformed query", "GET", validQuery + "&bad=%zz", "pod-secret", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls
			w := request(a, tc.method, tc.query, tc.header)
			if w.Code != tc.code || calls != before {
				t.Fatalf("status %d, upstream calls %d; wanted %d and no calls", w.Code, calls-before, tc.code)
			}
		})
	}
	for _, tc := range []struct {
		name string
		code int
		body string
	}{
		{"rejected", 401, "private-client-secret"},
		{"outage", 503, "private-client-secret"},
		{"malformed", 200, "not json"},
		{"empty token", 200, `{"access_token":"","token_type":"Bearer","expires_in":300}`},
		{"wrong type", 200, `{"access_token":"token","token_type":"Basic","expires_in":300}`},
		{"expired", 200, `{"access_token":"token","token_type":"Bearer","expires_in":0}`},
		{"fractional expiry", 200, `{"access_token":"token","token_type":"Bearer","expires_in":0.5}`},
		{"overflow", 200, `{"access_token":"token","token_type":"Bearer","expires_in":9223372036854775807}`},
		{"oversized", 200, strings.Repeat("x", (64<<10)+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body = tc.code, tc.body
			before := calls
			w := request(a, "GET", validQuery, "pod-secret")
			if w.Code != 502 || calls != before+1 || strings.Contains(w.Body.String(), "private-client-secret") {
				t.Fatalf("unexpected failure response or retries: %d %s", w.Code, w.Body)
			}
		})
	}
	upstream.Close()
	if w := request(a, "GET", validQuery, "pod-secret"); w.Code != 503 {
		t.Fatalf("unreachable provider returned %d", w.Code)
	}
}

func TestNoRedirects(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
	}))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	a := configure(t, upstream.URL)
	w := request(a, "GET", validQuery, "pod-secret")
	if w.Code != 502 || calls != 0 {
		t.Fatal("token request followed a redirect")
	}
}

func TestConfiguration(t *testing.T) {
	configure(t, "https://keycloak.example/realms/adaptive/protocol/openid-connect/token")
	for _, name := range []string{"KEYCLOAK_TOKEN_URL", "KEYCLOAK_CLIENT_ID", "KEYCLOAK_CLIENT_SECRET", "IDENTITY_HEADER", "IDENTITY_DOWNSTREAM"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "")
			if _, err := loadAdapter(); err == nil {
				t.Fatal("missing configuration accepted")
			}
		})
	}
	for _, endpoint := range []string{"file:///token", "https://", "https://user:secret@host/token", "https://host/token?secret=value", "https://host/token#fragment"} {
		t.Run(endpoint, func(t *testing.T) {
			t.Setenv("KEYCLOAK_TOKEN_URL", endpoint)
			if _, err := loadAdapter(); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatal("invalid endpoint accepted or disclosed")
			}
		})
	}
	for _, bindings := range []string{
		`null`, `{}`, `{"model":{}}`, `{"model":{"scope":"https://model"}}`,
		`{"..":{"scope":"https://model/.default"}}`,
		`{"model":{"scope":"https://model/.default","identity_modes":["endUserOBO"]}}`,
		`{"a":{"scope":"https://model/.default"},"b":{"scope":"https://model/.default"}}`,
		`{"model":{"scope":"https://model/.default"}} {}`,
	} {
		t.Run(bindings, func(t *testing.T) {
			t.Setenv("IDENTITY_DOWNSTREAM", bindings)
			if _, err := loadAdapter(); err == nil {
				t.Fatal("invalid downstream configuration accepted")
			}
		})
	}
}

func TestIdentityProviderIsBoundToDestinationNotConnectivity(t *testing.T) {
	localCalls, entraCalls := 0, 0
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		localCalls++
		if r.Method != "POST" || r.ParseForm() != nil || r.Form.Get("client_id") != "agent-client" ||
			r.Form.Get("client_secret") != "private-client-secret" || len(r.Form) != 3 {
			t.Error("invalid local credentials or Entra data leaked to Keycloak")
		}
		_, _ = io.WriteString(w, `{"access_token":"local-token","token_type":"Bearer","expires_in":300}`)
	}))
	defer local.Close()
	configure(t, local.URL)
	expires := time.Now().Unix() + 600
	bearer := "e30." + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"exp":%d}`, expires))) + ".signature"
	status, authorization := http.StatusOK, "Bearer "+bearer
	entra := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entraCalls++
		q := r.URL.Query()
		if r.Method != "GET" || r.URL.Path != "/AuthorizationHeaderUnauthenticated/microsoft-graph" ||
			len(q) != 2 || q.Get("AgentIdentity") != "entra-agent" || q.Get("optionsOverride.RequestAppToken") != "true" ||
			r.Header.Get("Authorization") != "" || r.Header.Get("X-IDENTITY-HEADER") != "" {
			t.Error("incorrect Entra sidecar request")
		}
		content, _ := io.ReadAll(r.Body)
		if len(content) != 0 {
			t.Error("credentials sent in Entra request body")
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"authorizationHeader": authorization})
	}))
	defer entra.Close()
	t.Setenv("AGENT_IDENTITY_CLIENT_ID", "entra-agent")
	t.Setenv("IDENTITY_SIDECAR_URL", entra.URL)
	t.Setenv("IDENTITY_DOWNSTREAM", `{
		"model-gateway":{"scope":"https://cognitiveservices.azure.com/.default","local_audience":"api://adaptive-model-gateway"},
		"microsoft-graph":{"scope":"https://graph.microsoft.com/.default"}
	}`)
	a, err := loadAdapter()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.client.CloseIdleConnections)
	graphQuery := "api-version=2019-08-01&resource=" + url.QueryEscape("https://graph.microsoft.com")
	for _, tc := range []struct {
		query, token, expiry string
	}{
		{validQuery, "local-token", ""},
		{graphQuery, bearer, strconv.FormatInt(expires, 10)},
	} {
		w := request(a, "GET", tc.query+"&client_id=entra-agent", "pod-secret")
		var result map[string]string
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil ||
			result["access_token"] != tc.token || (tc.expiry != "" && result["expires_on"] != tc.expiry) ||
			result["client_id"] != "entra-agent" {
			t.Fatalf("invalid destination-bound response: %d %s", w.Code, w.Body)
		}
	}
	if localCalls != 1 || entraCalls != 1 {
		t.Fatal("local and cloud destinations used the wrong providers")
	}
	for _, name := range []string{"AGENT_IDENTITY_CLIENT_ID", "IDENTITY_SIDECAR_URL"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "")
			if _, err := loadAdapter(); err == nil {
				t.Fatal("missing connected binding accepted")
			}
		})
	}
	for _, tc := range []struct {
		name, auth string
		status     int
	}{
		{"denied", "secret-upstream-body", 403}, {"outage", "secret-upstream-body", 503},
		{"wrong scheme", "Basic secret-upstream-body", 200}, {"malformed", "Bearer not-a-jwt", 200},
		{"missing expiry", "Bearer e30.e30.signature", 200},
		{"expired", "Bearer e30." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1}`)) + ".signature", 200},
		{"invalid expiry", "Bearer e30." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":"later"}`)) + ".signature", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, authorization = tc.status, tc.auth
			before := entraCalls
			w := request(a, "GET", graphQuery, "pod-secret")
			if w.Code != 502 || entraCalls != before+1 || localCalls != 1 ||
				strings.Contains(w.Body.String(), "secret-upstream-body") {
				t.Fatalf("invalid failure or provider fallback: %d %s", w.Code, w.Body)
			}
		})
	}
	entra.Close()
	if w := request(a, "GET", graphQuery, "pod-secret"); w.Code != 503 || localCalls != 1 {
		t.Fatal("unreachable Entra sidecar triggered fallback")
	}

	before := entraCalls
	w := request(a, "GET", validQuery+"&client_id=entra-agent", "pod-secret")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "local-token") || localCalls != 2 || entraCalls != before {
		t.Fatal("cloud outage broke local identity without a configuration change")
	}
	w = request(a, "GET", graphQuery, "pod-secret")
	if w.Code != 503 || localCalls != 2 || entraCalls != before {
		t.Fatal("cloud-only failure substituted the local identity")
	}
}
