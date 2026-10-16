package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	demoTenant    = "11111111-1111-1111-1111-111111111111"
	demoBlueprint = "22222222-2222-2222-2222-222222222222"
	demoBrowser   = "33333333-3333-3333-3333-333333333333"
	demoHuman     = "44444444-4444-4444-4444-444444444444"
	demoWorker    = "55555555-5555-5555-5555-555555555555"
)

func TestGraphIdentityAdmission(t *testing.T) {
	type scenario struct {
		name, mode, assertion, platform, oid, scope, audience, browser string
		enabled                                                        bool
		status                                                         int
	}
	cases := []scenario{
		{name: "app", mode: "app", status: 200},
		{name: "human", mode: "endUserOBO", assertion: "human-assertion", platform: "platform-token", enabled: true, status: 200},
		{name: "worker", mode: "agentUser", platform: "platform-token", enabled: true, status: 200},
		{name: "cross-user", mode: "endUserOBO", assertion: "human-assertion", platform: "platform-token", oid: demoWorker, enabled: true, status: 403},
		{name: "wrong-audience", mode: "endUserOBO", assertion: "human-assertion", platform: "platform-token", audience: "https://graph.microsoft.com", enabled: true, status: 403},
		{name: "wrong-client", mode: "endUserOBO", assertion: "human-assertion", platform: "platform-token", browser: demoWorker, enabled: true, status: 403},
		{name: "wrong-scope", mode: "endUserOBO", assertion: "human-assertion", platform: "platform-token", scope: "User.Read", enabled: true, status: 403},
		{name: "no-admin-link", mode: "endUserOBO", assertion: "human-assertion", platform: "platform-token", enabled: true, status: 403},
		{name: "no-bound-worker", mode: "agentUser", platform: "platform-token", enabled: true, status: 403},
		{name: "expired-graph-token", mode: "agentUser", platform: "platform-token", enabled: true, status: 502},
		{name: "hosted-or-unconfigured", mode: "agentUser", platform: "platform-token", status: 403},
		{name: "missing-platform", mode: "agentUser", enabled: true, status: 401},
		{name: "missing-assertion", mode: "endUserOBO", platform: "platform-token", enabled: true, status: 400},
		{name: "app-with-assertion", mode: "app", assertion: "human-assertion", status: 400},
		{name: "worker-with-assertion", mode: "agentUser", assertion: "human-assertion", status: 400},
		{name: "unknown-mode", mode: "unknown", status: 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			acquisitions := 0
			oid, scope, audience, browser := demoHuman, "access_agent", demoBlueprint, demoBrowser
			if tc.oid != "" {
				oid = tc.oid
			}
			if tc.scope != "" {
				scope = tc.scope
			}
			if tc.audience != "" {
				audience = tc.audience
			}
			if tc.browser != "" {
				browser = tc.browser
			}
			payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"exp":%d}`, time.Now().Unix()+300)))
			graphToken := "header." + payload + ".signature"
			if tc.name == "expired-graph-token" {
				graphToken = "header." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1}`)) + ".signature"
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Entra-User-Token") != "" || r.Header.Get("X-IDENTITY-HEADER") != "" {
					t.Error("unrelated credentials reached provider")
				}
				switch r.URL.Path {
				case "/userinfo":
					if r.Header.Get("Authorization") != "Bearer platform-token" {
						t.Error("platform authentication not used for userinfo")
					}
					link := demoHuman
					if tc.name == "no-admin-link" {
						link = ""
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"sub": "platform-user", "entra_tid": demoTenant, "entra_oid": link})
				case "/Validate":
					if r.Header.Get("Authorization") != "Bearer human-assertion" {
						t.Error("sidecar did not receive the human assertion")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"protocol": "Bearer", "claims": map[string]string{
						"tid": demoTenant, "oid": oid, "aud": audience, "scp": scope, "azp": browser,
					}})
				case "/AuthorizationHeader/Graph", "/AuthorizationHeaderUnauthenticated/Graph":
					acquisitions++
					q := r.URL.Query()
					if q.Get("AgentIdentity") != "bound-agent" || q.Get("optionsOverride.RequestAppToken") != "false" {
						t.Error("wrong identity or application-token fallback")
					}
					if tc.mode == "agentUser" {
						if q.Get("AgentUserId") != demoWorker || r.Header.Get("Authorization") != "" {
							t.Error("worker identity was not server-bound")
						}
					} else if q.Get("AgentUserId") != "" || r.Header.Get("Authorization") != "Bearer human-assertion" {
						t.Error("OBO mixed with worker or app identity")
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"authorizationHeader": "Bearer " + graphToken})
				default:
					t.Errorf("unexpected provider path %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer provider.Close()
			a := &adapter{entraID: "bound-agent", sidecarURL: provider.URL, client: provider.Client(),
				graph: graphIdentity{enabled: tc.enabled, tenant: demoTenant, blueprint: demoBlueprint,
					browser: demoBrowser, worker: demoWorker, userinfo: provider.URL + "/userinfo"}}
			if tc.name == "no-bound-worker" {
				a.graph.worker = ""
			}
			path := "/agents/demo/responses"
			request := httptest.NewRequest("POST", path, strings.NewReader(`{"input":"Call graph_me","store":false}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Impersonation-Mode", tc.mode)
			if tc.assertion != "" {
				request.Header.Set("X-Entra-User-Token", tc.assertion)
			}
			if tc.platform != "" {
				request.Header.Set("Authorization", "Bearer "+tc.platform)
			}
			request.Header.Set(admissionToken, "spoofed")
			response := httptest.NewRecorder()
			a.responseAdmission(path).ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status %d, wanted %d: %s", response.Code, tc.status, response.Body)
			}
			if strings.Contains(response.Body.String(), graphToken) || strings.Contains(response.Body.String(), "human-assertion") {
				t.Error("credentials exposed in response body")
			}
			if tc.status == 200 && tc.mode != "app" {
				expected := demoHuman
				if tc.mode == "agentUser" {
					expected = demoWorker
				}
				if acquisitions != 1 || response.Header().Get(admissionToken) != graphToken ||
					response.Header().Get(admissionUser) != expected || response.Header().Get(admissionMode) != tc.mode {
					t.Fatal("missing verified request-local identity")
				}
			} else if (acquisitions != 0 && tc.name != "expired-graph-token") || response.Header().Get(admissionToken) != "" {
				t.Fatal("denied/app request acquired or forwarded a user token")
			}
		})
	}
}

func TestGraphProviderFailureAndHeaderAmbiguity(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "secret-provider-error", http.StatusUnauthorized)
	}))
	defer provider.Close()
	a := &adapter{client: provider.Client(),
		graph: graphIdentity{enabled: true, worker: demoWorker, userinfo: provider.URL}}
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set("X-Impersonation-Mode", "agentUser")
	r.Header.Set("Authorization", "Bearer platform-token")
	w := httptest.NewRecorder()
	if err := a.admitIdentity(w, r); err == nil || err.status != 403 || strings.Contains(err.message, "secret") {
		t.Fatal("provider rejection was not safely surfaced")
	}

	r.Header.Add("X-Impersonation-Mode", "app")
	if err := a.admitIdentity(w, r); err == nil || err.status != 400 {
		t.Fatal("ambiguous mode accepted")
	}
}

func TestDelegationConfiguration(t *testing.T) {
	t.Setenv("KEYCLOAK_TOKEN_URL", "http://identity.local/realms/adaptive/protocol/openid-connect/token")
	t.Setenv("AGENT_GATEWAY_ADMISSION_URL", "http://agent-gateway-policy:8083")
	t.Setenv("GRAPH_DELEGATION_ENABLED", "true")
	t.Setenv("ENTRA_TENANT_ID", demoTenant)
	t.Setenv("AGENT_BLUEPRINT_ID", demoBlueprint)
	t.Setenv("OBO_CLIENT_ID", demoBrowser)
	t.Setenv("AGENT_USER_ID", demoWorker)
	t.Setenv("AGENT_IDENTITY_CLIENT_ID", "bound-agent")
	t.Setenv("IDENTITY_SIDECAR_URL", "http://127.0.0.1:5000")
	a, err := loadBroker()
	if err != nil {
		t.Fatal(err)
	}
	defer a.client.CloseIdleConnections()
	if !a.graph.enabled || a.graph.userinfo != "http://identity.local/realms/adaptive/protocol/openid-connect/userinfo" {
		t.Fatal("userinfo did not remain bound to the configured realm")
	}
	for _, setting := range []struct{ name, value string }{
		{"GRAPH_DELEGATION_ENABLED", "yes"},
		{"ENTRA_TENANT_ID", ""},
		{"AGENT_BLUEPRINT_ID", "other"},
		{"OBO_CLIENT_ID", ""},
		{"AGENT_USER_ID", "caller-supplied-user"},
		{"KEYCLOAK_TOKEN_URL", "http://identity.local/arbitrary"},
	} {
		t.Run(setting.name, func(t *testing.T) {
			t.Setenv(setting.name, setting.value)
			if _, err := loadBroker(); err == nil {
				t.Fatal("incomplete/invalid delegation configuration accepted")
			}
		})
	}
}
