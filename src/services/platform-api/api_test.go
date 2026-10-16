package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"
)

type fixture struct {
	api               *API
	objects           *dynamicfake.FakeDynamicClient
	core              *kubefake.Clientset
	agent, deployment *object
}

func resource(plural string) schema.GroupVersionResource {
	switch plural {
	case "statefulsets":
		return schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: plural}
	case "httproutes", "gateways":
		return schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: plural}
	case "securitypolicies", "envoyextensionpolicies":
		return schema.GroupVersionResource{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: plural}
	default:
		return schema.GroupVersionResource{Version: "v1", Resource: plural}
	}
}

func native(kind, plural, name string, spec, status map[string]any) *object {
	gvr := resource(plural)
	version := gvr.Version
	if gvr.Group != "" {
		version = gvr.Group + "/" + version
	}
	o := &object{Object: map[string]any{
		"apiVersion": version, "kind": kind,
		"metadata": map[string]any{"name": name, "namespace": "adaptive"},
	}}
	if spec != nil {
		o.Object["spec"] = spec
	}
	if status != nil {
		o.Object["status"] = status
	}
	o.SetGeneration(3)
	return o
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	a := native("ConfigMap", "configmaps", "agent-demo", nil, nil)
	a.SetUID("agent-uid")
	a.SetLabels(map[string]string{"adaptive.jplck.io/resource": "agent"})
	a.SetAnnotations(map[string]string{"radius.resource.id": "/radius/agents/demo"})
	a.Object["data"] = map[string]any{
		"name": "demo", "kind": "prompt", "agentUid": "agent-uid", "identityRef": "binding-demo",
		"definition": `{"kind":"prompt","instructions":"Be concise","model":"local-chat"}`,
		"governance": "{}",
	}
	d := native("StatefulSet", "statefulsets", "demo-v1", map[string]any{"replicas": int64(1)}, map[string]any{
		"observedGeneration": int64(3), "readyReplicas": int64(1), "currentRevision": "r1", "updateRevision": "r1",
	})
	own := func(o *object) {
		o.SetAnnotations(map[string]string{"radius.resource.id": "/radius/agents/demo"})
		o.SetLabels(map[string]string{
			"adaptive.jplck.io/agent-uid": "agent-uid",
			"app.kubernetes.io/component": "agent-runtime",
		})
	}
	own(d)
	service := native("Service", "services", "demo-v1", nil, nil)
	own(service)
	claim := native("PersistentVolumeClaim", "persistentvolumeclaims", "state-v1", nil, map[string]any{"phase": "Bound"})
	claim.SetLabels(map[string]string{"adaptive.jplck.io/agent-uid": "agent-uid"})
	gate := func(types ...string) []any {
		list := []any{}
		for _, name := range types {
			list = append(list, map[string]any{"type": name, "status": "True", "observedGeneration": int64(3)})
		}
		return list
	}
	route := native("HTTPRoute", "httproutes", "demo-v1", nil, map[string]any{"parents": []any{map[string]any{
		"parentRef": map[string]any{"name": "agent-ingress"}, "controllerName": "gateway.envoyproxy.io/gatewayclass-controller", "conditions": gate("Accepted", "ResolvedRefs"),
	}}})
	own(route)
	policy := native("SecurityPolicy", "securitypolicies", "demo-v1", nil, map[string]any{"ancestors": []any{map[string]any{
		"ancestorRef": map[string]any{"name": "agent-ingress"}, "controllerName": "gateway.envoyproxy.io/gatewayclass-controller", "conditions": gate("Accepted"),
	}}})
	own(policy)
	headers := policy.DeepCopy()
	headers.SetKind("EnvoyExtensionPolicy")
	gateway := native("Gateway", "gateways", "agent-ingress", nil, map[string]any{"conditions": gate("Accepted", "Programmed")})
	binding := native("ConfigMap", "configmaps", "binding-demo", nil, nil)
	binding.Object["data"] = map[string]any{"identity.json": `{"ownerUid":"agent-uid","keycloakClientId":"paired-client","entraClientId":"entra-id","blueprintId":"blueprint-id"}`}
	kinds := map[schema.GroupVersionResource]string{}
	for plural, kind := range map[string]string{"configmaps": "ConfigMap", "statefulsets": "StatefulSet", "services": "Service", "persistentvolumeclaims": "PersistentVolumeClaim", "httproutes": "HTTPRoute", "gateways": "Gateway", "securitypolicies": "SecurityPolicy", "envoyextensionpolicies": "EnvoyExtensionPolicy"} {
		kinds[resource(plural)] = kind + "List"
	}
	objects := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), kinds, a, d, claim, service, route, policy, headers, gateway, binding)
	// The generic tracker guesses "gatewaies"; use the Gateway API's actual plural.
	if err := objects.Tracker().Create(resource("gateways"), gateway, "adaptive"); err != nil {
		t.Fatal(err)
	}
	core := kubefake.NewClientset(&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "environment-config", Namespace: "adaptive"},
		Data: map[string]string{"environment.json": `{"name":"local","cloud":{"enabled":false}}`}})
	return fixture{&API{namespace: "adaptive", objects: objects, core: core.CoreV1()}, objects, core, a, d}
}

func request(t *testing.T, api *API, method, path, body string, status int) map[string]any {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "do-not-copy")
	r.Header.Set("x-adaptive-user", "untrusted")
	w := httptest.NewRecorder()
	api.handler().ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: got %d, want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "do-not-copy") || strings.Contains(w.Body.String(), "untrusted") {
		t.Fatal("request identity leaked")
	}
	if status == 404 || status == 405 {
		return nil
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("operational state must not be cached")
	}
	result := map[string]any{}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func update(t *testing.T, f fixture, plural string, o *object) {
	t.Helper()
	if err := f.objects.Tracker().Update(resource(plural), o, "adaptive"); err != nil {
		t.Fatal(err)
	}
}

func TestMutableNativeAgent(t *testing.T) {
	f := newFixture(t)
	view := request(t, f.api, "GET", "/v1/agents/demo", "", 200)
	if view["phase"] != "Ready" || view["instructions"] != "Be concise" || view["endpoint"] != "/agents/demo/responses" {
		t.Fatalf("bad native projection: %#v", view)
	}
	if view["identity"].(map[string]any)["keycloakClientId"] != "paired-client" {
		t.Fatal("paired identity missing")
	}
	_ = unstructured.SetNestedField(f.agent.Object,
		`{"kind":"prompt","instructions":"Be brief","model":"local-chat"}`, "data", "definition")
	update(t, f, "configmaps", f.agent)
	if request(t, f.api, "GET", "/v1/agents/demo", "", 200)["instructions"] != "Be brief" {
		t.Fatal("mutable definition update unavailable")
	}
	request(t, f.api, "GET", "/v1/agents/demo/versions/v1", "", 404)
	request(t, f.api, "GET", "/v1/agents/unknown", "", 404)
	request(t, f.api, "GET", "/v1/agents/demo?version=v1", "", 422)
}

func TestNativeReadinessFailsClosed(t *testing.T) {
	for _, fault := range []string{"generation", "replicas", "revision", "claim", "route", "policy", "gateway", "owner", "deleted"} {
		t.Run(fault, func(t *testing.T) {
			f := newFixture(t)
			want := 200
			switch fault {
			case "generation":
				_ = unstructured.SetNestedField(f.deployment.Object, int64(2), "status", "observedGeneration")
			case "replicas":
				_ = unstructured.SetNestedField(f.deployment.Object, int64(2), "spec", "replicas")
			case "revision":
				_ = unstructured.SetNestedField(f.deployment.Object, "r2", "status", "updateRevision")
			case "owner":
				f.deployment.SetAnnotations(map[string]string{"radius.resource.id": "/other"})
				want = 503
			case "deleted":
				stamp := metav1.Now()
				f.deployment.SetDeletionTimestamp(&stamp)
				want = 503
			case "claim", "route", "policy", "gateway":
				plural, name := "persistentvolumeclaims", "state-v1"
				switch fault {
				case "route":
					plural, name = "httproutes", "demo-v1"
				case "policy":
					plural, name = "securitypolicies", "demo-v1"
				case "gateway":
					plural, name = "gateways", "agent-ingress"
				}
				obj, err := f.objects.Tracker().Get(resource(plural), "adaptive", name)
				if err != nil {
					t.Fatal(err)
				}
				u := obj.(*object)
				u.SetGeneration(4)
				if fault == "claim" {
					_ = unstructured.SetNestedField(u.Object, "Pending", "status", "phase")
				}
				update(t, f, plural, u)
			}
			update(t, f, "statefulsets", f.deployment)
			view := request(t, f.api, "GET", "/v1/agents/demo", "", want)
			if want == 200 && (view["endpoint"] != nil || view["phase"] != "Pending") {
				t.Fatal("unqualified endpoint exposed")
			}
		})
	}
}

func TestMissingRuntimeIsPending(t *testing.T) {
	f := newFixture(t)
	if err := f.objects.Tracker().Delete(resource("statefulsets"), "adaptive", "demo-v1"); err != nil {
		t.Fatal(err)
	}
	v := request(t, f.api, "GET", "/v1/agents/demo", "", 200)
	if v["phase"] != "Pending" || v["endpoint"] != nil {
		t.Fatal("missing runtime reported ready")
	}
}

func TestEnvironmentAndNoControlOrInferenceRoutes(t *testing.T) {
	f := newFixture(t)
	if request(t, f.api, "GET", "/v1/environment", "", 200)["name"] != "local" {
		t.Fatal("environment missing")
	}
	for _, path := range []string{"/v1/cluster-mode", "/v1/models", "/openai/v1/responses"} {
		request(t, f.api, "GET", path, "", 404)
	}
	request(t, f.api, "POST", "/v1/agents", "{}", 405)
	request(t, f.api, "GET", "/v1/agents/demo?version=v1&version=v2", "", 422)
}
