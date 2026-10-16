package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	admissionMode  = "X-Admission-Identity-Mode"
	admissionToken = "X-Admission-Graph-Token"
	admissionUser  = "X-Admission-Graph-User"
)

var identityID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type graphIdentity struct {
	enabled                            bool
	tenant, blueprint, browser, worker string
	userinfo                           string
}

type admissionError struct {
	status  int
	message string
}

func admissionFailure(status int, message string) *admissionError {
	return &admissionError{status: status, message: message}
}

func (a *adapter) loadGraphIdentity() error {
	flag := os.Getenv("GRAPH_DELEGATION_ENABLED")
	if flag != "" && flag != "false" && flag != "true" {
		return fmt.Errorf("GRAPH_DELEGATION_ENABLED must be true or false")
	}
	a.graph = graphIdentity{
		enabled: flag == "true", tenant: os.Getenv("ENTRA_TENANT_ID"),
		blueprint: os.Getenv("AGENT_BLUEPRINT_ID"), browser: os.Getenv("OBO_CLIENT_ID"),
		worker: os.Getenv("AGENT_USER_ID"),
	}
	if !a.graph.enabled {
		return nil
	}
	for _, value := range []string{a.graph.tenant, a.graph.blueprint, a.graph.browser} {
		if !identityID.MatchString(value) {
			return fmt.Errorf("Graph delegation requires exact tenant, blueprint and OBO client IDs")
		}
	}
	if a.graph.worker != "" && !identityID.MatchString(a.graph.worker) {
		return fmt.Errorf("AGENT_USER_ID must identify the bound worker user")
	}
	u, err := url.Parse(a.tokenURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasSuffix(u.Path, "/token") {
		return fmt.Errorf("Graph delegation requires the platform Keycloak token endpoint")
	}
	u.Path = strings.TrimSuffix(u.Path, "/token") + "/userinfo"
	a.graph.userinfo = u.String()
	return nil
}

func singleBearer(header http.Header, name string) (string, bool) {
	if len(header.Values(name)) != 1 {
		return "", false
	}
	token, ok := strings.CutPrefix(header.Get(name), "Bearer ")
	return token, ok && token != "" && !strings.ContainsAny(token, " \t\r\n") && len(token) <= 24<<10
}

func (a *adapter) identityJSON(r *http.Request, endpoint, bearer string, result any) *admissionError {
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, endpoint, nil)
	if err != nil {
		return admissionFailure(http.StatusServiceUnavailable, "Identity provider configuration is invalid")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return admissionFailure(http.StatusServiceUnavailable, "Identity provider unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return admissionFailure(http.StatusForbidden, "Identity provider rejected the selected user or consent")
		}
		return admissionFailure(http.StatusBadGateway, "Identity provider rejected delegation")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 || json.Unmarshal(body, result) != nil {
		return admissionFailure(http.StatusBadGateway, "Identity provider returned an invalid response")
	}
	return nil
}

func (a *adapter) admitIdentity(w http.ResponseWriter, r *http.Request) *admissionError {
	// Always overwrite these upstream headers, including app-mode empty values.
	// Envoy's subsequent Lua filter rejects caller x-client-* headers before
	// converting these admission outputs into the runtime's request-local context.
	w.Header().Set(admissionMode, "app")
	w.Header().Set(admissionToken, "")
	w.Header().Set(admissionUser, "")
	if len(r.Header.Values("X-Impersonation-Mode")) > 1 ||
		len(r.Header.Values("X-Entra-User-Token")) > 1 {
		return admissionFailure(http.StatusBadRequest, "Repeated identity headers are not supported")
	}
	mode := r.Header.Get("X-Impersonation-Mode")
	if mode == "" {
		mode = "app"
	}
	assertion := r.Header.Get("X-Entra-User-Token")
	if mode != "endUserOBO" && assertion != "" {
		return admissionFailure(http.StatusBadRequest, "An Entra user assertion is allowed only for OBO")
	}
	if mode == "app" {
		return nil
	}
	if mode != "endUserOBO" && mode != "agentUser" {
		return admissionFailure(http.StatusBadRequest, "Unsupported identity mode")
	}
	if !a.graph.enabled {
		return admissionFailure(http.StatusForbidden, "Graph delegation requires a configured prompt release and cloud connectivity")
	}
	if mode == "agentUser" && a.graph.worker == "" {
		return admissionFailure(http.StatusForbidden, "No agent worker user is bound to this identity")
	}
	platform, valid := singleBearer(r.Header, "Authorization")
	if !valid {
		return admissionFailure(http.StatusUnauthorized, "Platform user authentication is required")
	}
	var user struct {
		Subject string `json:"sub"`
		Tenant  string `json:"entra_tid"`
		Object  string `json:"entra_oid"`
	}
	if err := a.identityJSON(r, a.graph.userinfo, platform, &user); err != nil {
		return err
	}
	if user.Subject == "" {
		return admissionFailure(http.StatusForbidden, "Platform user identity is missing")
	}
	expected := a.graph.worker
	endpoint := "/AuthorizationHeaderUnauthenticated/Graph"
	params := url.Values{"AgentIdentity": {a.entraID}, "optionsOverride.RequestAppToken": {"false"}}
	bearer := ""
	if mode == "endUserOBO" {
		if assertion == "" || strings.ContainsAny(assertion, " \t\r\n") || len(assertion) > 24<<10 {
			return admissionFailure(http.StatusBadRequest, "A single Entra user assertion is required for OBO")
		}
		if user.Tenant != a.graph.tenant || !identityID.MatchString(user.Object) {
			return admissionFailure(http.StatusForbidden, "The platform user has no administrator-managed Entra link")
		}
		var validated struct {
			Protocol string `json:"protocol"`
			Claims   struct {
				Tenant   string `json:"tid"`
				Object   string `json:"oid"`
				Audience string `json:"aud"`
				Scopes   string `json:"scp"`
				Client   string `json:"azp"`
			} `json:"claims"`
		}
		if err := a.identityJSON(r, strings.TrimRight(a.sidecarURL, "/")+"/Validate", assertion, &validated); err != nil {
			return err
		}
		scope := false
		for _, value := range strings.Fields(validated.Claims.Scopes) {
			scope = scope || value == "access_agent"
		}
		if validated.Protocol != "Bearer" || validated.Claims.Tenant != user.Tenant ||
			validated.Claims.Object != user.Object || validated.Claims.Audience != a.graph.blueprint ||
			validated.Claims.Client != a.graph.browser || !scope {
			return admissionFailure(http.StatusForbidden, "The Entra assertion does not match the linked user and agent API")
		}
		expected, bearer = user.Object, assertion
		endpoint = "/AuthorizationHeader/Graph"
	} else {
		params.Set("AgentUserId", a.graph.worker)
	}
	var acquired struct {
		Authorization string `json:"authorizationHeader"`
	}
	if err := a.identityJSON(r, strings.TrimRight(a.sidecarURL, "/")+endpoint+"?"+params.Encode(), bearer, &acquired); err != nil {
		return err
	}
	token, ok := strings.CutPrefix(acquired.Authorization, "Bearer ")
	if !ok || token == "" || len(token) > 24<<10 || strings.ContainsAny(token, " \t\r\n") || jwtExpiry(token) <= time.Now().Unix() {
		return admissionFailure(http.StatusBadGateway, "The sidecar returned an invalid delegated token")
	}
	w.Header().Set(admissionMode, mode)
	w.Header().Set(admissionToken, token)
	w.Header().Set(admissionUser, expected)
	return nil
}
