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
				return nil, failure{http.StatusConflict, "Logical agent ownership is ambiguous"}
			}
			found = &items[i]
		}
	}
	if found == nil {
		return nil, apierrors.NewNotFound(schema.GroupResource{Resource: "configmaps"}, name)
	}
	if found.GetUID() == "" || found.GetAnnotations()["radius.resource.id"] == "" ||
		!namePattern.MatchString(name) ||
		(text(found, "data", "kind") != "prompt" && text(found, "data", "kind") != "hosted") {
		return nil, unavailable("Logical agent metadata is invalid")
	}
	return found, nil
}

type release struct {
	snapshot   *object
	document   *object
	deployment *object
	ready      bool
	effective  string
}

func ownedBy(obj, snapshot *object) bool {
	if obj == nil || snapshot == nil || obj.GetDeletionTimestamp() != nil {
		return false
	}
	for _, owner := range obj.GetOwnerReferences() {
		if owner.APIVersion == "v1" && owner.Kind == "ConfigMap" &&
			owner.Name == snapshot.GetName() && owner.UID == snapshot.GetUID() && owner.UID != "" {
			return obj.GetAnnotations()["radius.resource.id"] == snapshot.GetAnnotations()["radius.resource.id"]
		}
	}
	return false
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

func (a *API) qualify(r *http.Request, agent *object, rel *release) error {
	name := text(rel.document, "workload")
	if !namePattern.MatchString(name) || !namePattern.MatchString(text(rel.document, "claim")) ||
		!namePattern.MatchString(text(rel.document, "gateway")) {
		return unavailable("Release resource coordinates are invalid")
	}
	resources := []struct {
		gvr  schema.GroupVersionResource
		name string
	}{
		{schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}, name},
		{configMaps, rel.snapshot.GetName()},
		{schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}, text(rel.document, "claim")},
		{schema.GroupVersionResource{Version: "v1", Resource: "services"}, name},
		{schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}, name},
		{schema.GroupVersionResource{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "securitypolicies"}, name},
		{schema.GroupVersionResource{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "envoyextensionpolicies"}, name},
		{schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"}, text(rel.document, "gateway")},
	}
	actual := make([]*object, 0, len(resources))
	for i, coordinate := range resources {
		obj, err := a.objects.Resource(coordinate.gvr).Namespace(a.namespace).Get(r.Context(), coordinate.name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if i == 0 {
			rel.deployment = obj
		}
		actual = append(actual, obj)
	}
	sts, claim, service, route, policy, headers, gateway := actual[0], actual[2], actual[3], actual[4], actual[5], actual[6], actual[7]
	if actual[1].GetUID() != rel.snapshot.GetUID() ||
		text(actual[1], "data", "release.json") != text(rel.snapshot, "data", "release.json") {
		return failure{http.StatusConflict, "Release capture changed during readiness qualification"}
	}
	if !ownedBy(sts, rel.snapshot) || !ownedBy(service, rel.snapshot) ||
		!ownedBy(route, rel.snapshot) || !ownedBy(policy, rel.snapshot) || !ownedBy(headers, rel.snapshot) ||
		claim.GetDeletionTimestamp() != nil || claim.GetLabels()["adaptive.jplck.io/agent-uid"] != string(agent.GetUID()) ||
		claim.GetLabels()["adaptive.jplck.io/version"] != text(rel.document, "version") {
		return unavailable("Native release resource ownership is invalid")
	}
	rel.ready = agent.GetDeletionTimestamp() == nil && rel.snapshot.GetDeletionTimestamp() == nil &&
		field(sts, "status", "observedGeneration") == sts.GetGeneration() && sts.GetGeneration() > 0 &&
		field(sts, "spec", "replicas") == int64(1) && field(sts, "status", "readyReplicas") == int64(1) &&
		text(sts, "status", "currentRevision") != "" &&
		text(sts, "status", "currentRevision") == text(sts, "status", "updateRevision") &&
		text(claim, "status", "phase") == "Bound" && gateway.GetDeletionTimestamp() == nil &&
		conditions(field(gateway, "status", "conditions"), gateway.GetGeneration(), "Accepted", "Programmed") &&
		routeReady(route, gateway.GetName(), a.namespace, false) &&
		routeReady(policy, gateway.GetName(), a.namespace, true) &&
		routeReady(headers, gateway.GetName(), a.namespace, true)
	return nil
}

func (a *API) releases(r *http.Request, agent *object) ([]release, error) {
	items, err := a.catalogue(r, "agent-release")
	if err != nil {
		return nil, err
	}
	result := make([]release, 0)
	seen := map[string]bool{}
	for i := range items {
		cm := &items[i]
		if cm.GetLabels()["adaptive.jplck.io/agent"] != text(agent, "data", "name") {
			continue
		}
		content := text(cm, "data", "release.json")
		var doc map[string]any
		if len(content) > 128000 || json.Unmarshal([]byte(content), &doc) != nil ||
			field(cm, "immutable") != true || cm.GetUID() == "" || cm.GetAnnotations()["radius.resource.id"] == "" {
			return nil, unavailable("Immutable native release capture is invalid")
		}
		record := &object{Object: doc}
		if text(record, "agentUid") != string(agent.GetUID()) {
			continue
		}
		version := text(record, "version")
		if text(record, "radiusResourceId") != cm.GetAnnotations()["radius.resource.id"] ||
			text(record, "binding", "identity", "ownerUid") != string(agent.GetUID()) ||
			!versionPattern.MatchString(version) || text(record, "definition", "kind") != text(agent, "data", "kind") ||
			text(record, "definition", "model") == "" || text(record, "agentName") != text(agent, "data", "name") ||
			text(record, "endpoint") == "" {
			return nil, unavailable("Native release definition is invalid")
		}
		if seen[version] {
			return nil, failure{http.StatusConflict, "Release ownership is ambiguous"}
		}
		seen[version] = true
		rel := release{snapshot: cm, document: record}
		if err := a.qualify(r, agent, &rel); err != nil {
			return nil, err
		}
		result = append(result, rel)
	}
	sort.Slice(result, func(i, j int) bool { return text(result[i].document, "version") < text(result[j].document, "version") })
	effective := ""
	for _, rel := range result {
		if rel.ready && text(rel.document, "version") == text(agent, "data", "activeVersion") {
			effective = text(rel.document, "version")
		}
	}
	for i := range result {
		result[i].effective = effective
	}
	return result, nil
}

func selectedRelease(agent *object, version string, releases []release) (release, error) {
	if version == "" {
		version = text(agent, "data", "activeVersion")
	}
	if version == "" {
		return release{}, nil
	}
	for _, rel := range releases {
		if text(rel.document, "version") == version {
			return rel, nil
		}
	}
	return release{}, failure{http.StatusNotFound, "Selected release has no retained capture; no fallback"}
}

func (rel release) available(_ *object) bool { return rel.ready }

func responsesEndpoint(rel release, _ *object) any {
	if !rel.ready {
		return nil
	}
	return "/agents/" + text(rel.document, "agentName") +
		"/versions/" + text(rel.document, "version") + "/responses"
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

func (a *API) agentView(r *http.Request, agent *object, rel release) (any, error) {
	name := text(agent, "data", "name")
	identity := map[string]any{}
	ref := text(agent, "data", "identityRef")
	if ref != "" {
		binding, err := a.objects.Resource(configMaps).Namespace(a.namespace).Get(r.Context(), ref, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		if json.Unmarshal([]byte(text(binding, "data", "identity.json")), &identity) != nil || identity["ownerUid"] != string(agent.GetUID()) {
			return nil, unavailable("Logical agent identity binding is invalid")
		}
	} else if rel.ready {
		return nil, unavailable("Ready release has no logical identity binding")
	}
	publicIdentity := map[string]any{"graphDelegation": identity["graphDelegation"] == true}
	for _, key := range []string{"entraClientId", "blueprintId", "keycloakClientId", "entraTenantId", "oboClientId", "agentUserId"} {
		value, _ := identity[key].(string)
		publicIdentity[key] = nullable(value)
	}
	active := text(agent, "data", "activeVersion")
	phase := "Pending"
	if rel.ready {
		phase = "Ready"
	}
	d := rel.document
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
			return nil, unavailable("Captured sampling parameter is invalid")
		}
		numbers[key] = n
	}
	return map[string]any{
		"name": name, "type": text(agent, "data", "kind"), "phase": phase,
		"version": nullable(text(d, "version")), "requestedActiveVersion": nullable(active), "activeVersion": nullable(rel.effective),
		"endpoint": responsesEndpoint(rel, agent), "identity": publicIdentity, "created": created(agent),
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
		releases, err := a.releases(r, agent)
		if err != nil {
			return nil, err
		}
		rel, err := selectedRelease(agent, "", releases)
		if err != nil {
			return nil, err
		}
		view, err := a.agentView(r, agent, rel)
		if err != nil {
			return nil, err
		}
		data = append(data, view)
	}
	return map[string]any{"object": "list", "data": data}, nil
}

func (a *API) selected(r *http.Request) (*object, release, error) {
	name, version, err := selection(r)
	if err != nil {
		return nil, release{}, err
	}
	agent, err := a.agent(r, name)
	if err != nil {
		return nil, release{}, err
	}
	releases, err := a.releases(r, agent)
	if err != nil {
		return nil, release{}, err
	}
	rel, err := selectedRelease(agent, version, releases)
	return agent, rel, err
}

func (a *API) getAgent(r *http.Request) (any, error) {
	agent, rel, err := a.selected(r)
	if err != nil {
		return nil, err
	}
	return a.agentView(r, agent, rel)
}

func (a *API) listVersions(r *http.Request) (any, error) {
	name, _, err := selection(r)
	if err != nil {
		return nil, err
	}
	agent, err := a.agent(r, name)
	if err != nil {
		return nil, err
	}
	releases, err := a.releases(r, agent)
	if err != nil {
		return nil, err
	}
	data := make([]any, 0, len(releases))
	for _, rel := range releases {
		phase := "Pending"
		if rel.ready {
			phase = "Available"
		} else if rel.deployment == nil {
			phase = "Retired"
		}
		active := text(agent, "data", "activeVersion") == text(rel.document, "version")
		data = append(data, map[string]any{
			"name": name, "version": text(rel.document, "version"), "status": phase, "endpoint": responsesEndpoint(rel, agent),
			"created_at": created(rel.snapshot), "definitionDigest": contentDigest(text(rel.snapshot, "data", "release.json")),
			"requestedActive": active, "active": active && rel.ready,
		})
	}
	return map[string]any{"object": "list", "data": data}, nil
}
