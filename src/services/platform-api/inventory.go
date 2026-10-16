package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

type object = unstructured.Unstructured

var configMaps = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}

func field(o *object, path ...string) any {
	if o == nil {
		return nil
	}
	value, _, _ := unstructured.NestedFieldNoCopy(o.Object, path...)
	return value
}

func text(o *object, path ...string) string {
	value, _ := field(o, path...).(string)
	return value
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (a *API) catalogue(r *http.Request, kind string) ([]object, error) {
	list, err := a.objects.Resource(configMaps).Namespace(a.namespace).List(r.Context(), metav1.ListOptions{
		LabelSelector: "adaptive.jplck.io/resource=" + kind,
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(list.Items, func(i, j int) bool { return list.Items[i].GetName() < list.Items[j].GetName() })
	return list.Items, nil
}

func (a *API) agent(r *http.Request, name string) (*object, error) {
	items, err := a.catalogue(r, "agent")
	if err != nil {
		return nil, err
	}
	var found *object
	for i := range items {
		if text(&items[i], "data", "name") == name {
			if found != nil {
				return nil, failure{http.StatusConflict, "Agent ownership is ambiguous"}
			}
			found = &items[i]
		}
	}
	if found == nil {
		return nil, apierrors.NewNotFound(schema.GroupResource{Resource: "configmaps"}, name)
	}
	if text(found, "data", "agentUid") == "" || found.GetAnnotations()["radius.resource.id"] == "" ||
		!namePattern.MatchString(name) ||
		(text(found, "data", "kind") != "prompt" && text(found, "data", "kind") != "hosted") ||
		text(found, "data", "identityRef") == "" {
		return nil, unavailable("Agent metadata is invalid")
	}
	return found, nil
}

type agentRuntime struct {
	document   *object
	deployment *object
	ready      bool
}

func conditions(value any, generation int64, required ...string) bool {
	list, ok := value.([]any)
	if !ok || generation < 1 {
		return false
	}
	for _, kind := range required {
		found := false
		for _, entry := range list {
			c, ok := entry.(map[string]any)
			found = found || (ok && c["type"] == kind && c["status"] == "True" && c["observedGeneration"] == generation)
		}
		if !found {
			return false
		}
	}
	return true
}

func routeReady(obj *object, gateway, namespace string, policy bool) bool {
	if obj.GetDeletionTimestamp() != nil {
		return false
	}
	key, refKey, required := "parents", "parentRef", []string{"Accepted", "ResolvedRefs"}
	if policy {
		key, refKey, required = "ancestors", "ancestorRef", []string{"Accepted"}
	}
	list, _ := field(obj, "status", key).([]any)
	for _, entry := range list {
		parent, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		ref, ok := parent[refKey].(map[string]any)
		if ok && ref["name"] == gateway &&
			(ref["namespace"] == nil || ref["namespace"] == namespace) &&
			(ref["kind"] == nil || ref["kind"] == "Gateway") &&
			(ref["group"] == nil || ref["group"] == "gateway.networking.k8s.io") &&
			parent["controllerName"] == "gateway.envoyproxy.io/gatewayclass-controller" &&
			conditions(parent["conditions"], obj.GetGeneration(), required...) {
			return true
		}
	}
	return false
}

func exact(items []object, description string) (*object, error) {
	if len(items) != 1 {
		return nil, unavailable(description + " ownership is ambiguous")
	}
	return &items[0], nil
}

func (a *API) runtime(r *http.Request, agent *object) (agentRuntime, error) {
	uid := text(agent, "data", "agentUid")
	radiusID := agent.GetAnnotations()["radius.resource.id"]
	selector := "adaptive.jplck.io/agent-uid=" + uid
	statefulSets := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}
	workloads, err := a.objects.Resource(statefulSets).Namespace(a.namespace).List(r.Context(), metav1.ListOptions{
		LabelSelector: selector + ",app.kubernetes.io/component=agent-runtime",
	})
	if err != nil {
		return agentRuntime{}, err
	}
	if len(workloads.Items) == 0 {
		return agentRuntime{document: agentDocument(agent)}, nil
	}
	workload, err := exact(workloads.Items, "Agent runtime")
	if err != nil {
		return agentRuntime{}, err
	}
	name := workload.GetName()
	coordinates := []schema.GroupVersionResource{
		{Version: "v1", Resource: "services"},
		{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"},
		{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "securitypolicies"},
		{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "envoyextensionpolicies"},
	}
	actual := make([]*object, 0, len(coordinates))
	for _, gvr := range coordinates {
		item, err := a.objects.Resource(gvr).Namespace(a.namespace).Get(r.Context(), name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return agentRuntime{document: agentDocument(agent), deployment: workload}, nil
		}
		if err != nil {
			return agentRuntime{}, err
		}
		actual = append(actual, item)
	}
	claims, err := a.objects.Resource(schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}).
		Namespace(a.namespace).List(r.Context(), metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return agentRuntime{}, err
	}
	claim, err := exact(claims.Items, "Agent state")
	if err != nil {
		return agentRuntime{}, err
	}
	gateway, err := a.objects.Resource(schema.GroupVersionResource{
		Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways",
	}).Namespace(a.namespace).Get(r.Context(), "agent-ingress", metav1.GetOptions{})
	if err != nil {
		return agentRuntime{}, err
	}
	for _, item := range append([]*object{workload}, actual...) {
		if item.GetDeletionTimestamp() != nil ||
			item.GetAnnotations()["radius.resource.id"] != radiusID ||
			item.GetLabels()["adaptive.jplck.io/agent-uid"] != uid {
			return agentRuntime{}, unavailable("Agent runtime ownership is invalid")
		}
	}
	service, route, policy, headers := actual[0], actual[1], actual[2], actual[3]
	_ = service
	ready := agent.GetDeletionTimestamp() == nil &&
		field(workload, "status", "observedGeneration") == workload.GetGeneration() && workload.GetGeneration() > 0 &&
		field(workload, "spec", "replicas") == int64(1) && field(workload, "status", "readyReplicas") == int64(1) &&
		text(workload, "status", "currentRevision") != "" &&
		text(workload, "status", "currentRevision") == text(workload, "status", "updateRevision") &&
		text(claim, "status", "phase") == "Bound" && gateway.GetDeletionTimestamp() == nil &&
		conditions(field(gateway, "status", "conditions"), gateway.GetGeneration(), "Accepted", "Programmed") &&
		routeReady(route, gateway.GetName(), a.namespace, false) &&
		routeReady(policy, gateway.GetName(), a.namespace, true) &&
		routeReady(headers, gateway.GetName(), a.namespace, true)
	return agentRuntime{document: agentDocument(agent), deployment: workload, ready: ready}, nil
}

func agentDocument(agent *object) *object {
	definition := map[string]any{}
	governance := map[string]any{}
	_ = json.Unmarshal([]byte(text(agent, "data", "definition")), &definition)
	_ = json.Unmarshal([]byte(text(agent, "data", "governance")), &governance)
	document := map[string]any{"definition": definition}
	if len(governance) > 0 {
		document["governance"] = governance
	}
	return &object{Object: document}
}

func created(o *object) any {
	if o == nil {
		return nil
	}
	stamp := o.GetCreationTimestamp()
	if stamp.IsZero() {
		return nil
	}
	return stamp.Unix()
}

func responsesEndpoint(runtime agentRuntime, agent *object) any {
	if !runtime.ready {
		return nil
	}
	return "/agents/" + text(agent, "data", "name") + "/responses"
}

func (a *API) agentView(r *http.Request, agent *object, runtime agentRuntime) (any, error) {
	name := text(agent, "data", "name")
	identity := map[string]any{}
	ref := text(agent, "data", "identityRef")
	binding, err := a.objects.Resource(configMaps).Namespace(a.namespace).Get(r.Context(), ref, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if json.Unmarshal([]byte(text(binding, "data", "identity.json")), &identity) != nil ||
		identity["ownerUid"] != text(agent, "data", "agentUid") {
		return nil, unavailable("Agent identity binding is invalid")
	}
	publicIdentity := map[string]any{"graphDelegation": identity["graphDelegation"] == true}
	for _, key := range []string{"entraClientId", "blueprintId", "keycloakClientId", "entraTenantId", "oboClientId", "agentUserId"} {
		value, _ := identity[key].(string)
		publicIdentity[key] = nullable(value)
	}
	d := runtime.document
	numbers := map[string]any{}
	for _, key := range []string{"temperature", "top_p"} {
		value := field(d, "definition", key)
		if value == nil {
			continue
		}
		s, ok := value.(string)
		n, err := strconv.ParseFloat(s, 64)
		max := 1.0
		if key == "temperature" {
			max = 2
		}
		if !ok || err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > max {
			return nil, unavailable("Sampling parameter is invalid")
		}
		numbers[key] = n
	}
	phase := "Pending"
	if runtime.ready {
		phase = "Ready"
	}
	return map[string]any{
		"name": name, "type": text(agent, "data", "kind"), "phase": phase,
		"endpoint": responsesEndpoint(runtime, agent), "identity": publicIdentity, "created": created(agent),
		"description": nullable(text(d, "definition", "description")), "instructions": field(d, "definition", "instructions"),
		"model": nullable(text(d, "definition", "model")), "temperature": numbers["temperature"],
		"topP": numbers["top_p"], "tools": field(d, "definition", "tools"), "skills": field(d, "definition", "skills"),
		"image": nullable(text(d, "definition", "image")), "port": 8080,
	}, nil
}

func (a *API) listAgents(r *http.Request) (any, error) {
	items, err := a.catalogue(r, "agent")
	if err != nil {
		return nil, err
	}
	data := make([]any, 0, len(items))
	for i := range items {
		agent, err := a.agent(r, text(&items[i], "data", "name"))
		if err != nil {
			return nil, err
		}
		runtime, err := a.runtime(r, agent)
		if err != nil {
			return nil, err
		}
		view, err := a.agentView(r, agent, runtime)
		if err != nil {
			return nil, err
		}
		data = append(data, view)
	}
	return map[string]any{"object": "list", "data": data}, nil
}

func (a *API) selected(r *http.Request) (*object, agentRuntime, error) {
	name, err := selection(r)
	if err != nil {
		return nil, agentRuntime{}, err
	}
	agent, err := a.agent(r, name)
	if err != nil {
		return nil, agentRuntime{}, err
	}
	runtime, err := a.runtime(r, agent)
	return agent, runtime, err
}

func (a *API) getAgent(r *http.Request) (any, error) {
	agent, runtime, err := a.selected(r)
	if err != nil {
		return nil, err
	}
	return a.agentView(r, agent, runtime)
}
