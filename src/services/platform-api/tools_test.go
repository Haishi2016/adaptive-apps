package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestBuiltinCatalogueMatchesUIContract(t *testing.T) {
	f := newFixture(t)
	items := request(t, f.api, "GET", "/v1/tools", "", 200)["data"].([]any)
	if len(items) != 1 {
		t.Fatal("bounded catalogue must expose only graph-me")
	}
	entry := items[0].(map[string]any)
	for key, expected := range map[string]string{
		"name": "graph-me", "kind": "builtin", "builtin": "graph-me", "displayName": "Graph profile",
		"authType": "entra", "audience": "https://graph.microsoft.com", "executionIdentity": "caller",
	} {
		if entry[key] != expected {
			t.Fatalf("unexpected catalogue %s: %#v", key, entry)
		}
	}
	if entry["description"] == "" || len(entry["identityModes"].([]any)) != 3 {
		t.Fatal("catalogue metadata missing")
	}
}

func TestInventoryProjectsCurrentDefinitionAndDelegation(t *testing.T) {
	f := newFixture(t)
	f.agent.SetCreationTimestamp(metav1.NewTime(time.Unix(1770000000, 0)))
	binding, err := f.objects.Resource(configMaps).Namespace("adaptive").Get(context.Background(), "binding-demo", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	identity := map[string]any{}
	if err := json.Unmarshal([]byte(text(binding, "data", "identity.json")), &identity); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]any{
		"entraTenantId": "tenant", "oboClientId": "demo-client", "agentUserId": "worker",
		"graphDelegation": true,
	} {
		identity[key] = value
	}
	tool := map[string]any{
		"type": "builtin", "name": "graph-me", "connectionRef": "profile", "serverLabel": "Graph profile",
		"requireApproval": "never", "authType": "entra", "audience": "https://graph.microsoft.com",
		"identityModes": []any{"app", "endUserOBO", "agentUser"}, "executionIdentity": "caller",
	}
	def := map[string]any{}
	if err := json.Unmarshal([]byte(text(f.agent, "data", "definition")), &def); err != nil {
		t.Fatal(err)
	}
	def["description"], def["tools"], def["temperature"], def["top_p"] = "Profile demo", []any{tool}, "0.2", "0.9"
	definition, err := json.Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	_ = unstructured.SetNestedField(f.agent.Object, string(definition), "data", "definition")
	content, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	binding.Object["data"] = map[string]any{"identity.json": string(content)}
	update(t, f, "configmaps", binding)
	update(t, f, "configmaps", f.agent)
	view := request(t, f.api, "GET", "/v1/agents/demo", "", 200)
	if view["instructions"] != "Be concise" || view["model"] != "local-chat" || view["description"] != "Profile demo" ||
		view["created"] != float64(1770000000) || view["temperature"] != 0.2 || view["topP"] != 0.9 {
		t.Fatalf("inventory read obsolete definition fields: %#v", view)
	}
	captured := view["tools"].([]any)[0].(map[string]any)
	if captured["type"] != "builtin" || captured["connectionRef"] != "profile" {
		t.Fatal("agent tools missing")
	}
	gotIdentity := view["identity"].(map[string]any)
	for _, key := range []string{"entraTenantId", "oboClientId", "agentUserId", "graphDelegation"} {
		if gotIdentity[key] != identity[key] {
			t.Fatalf("UI identity prerequisite %s missing", key)
		}
	}
}
