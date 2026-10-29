package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ktesting "k8s.io/client-go/testing"
)

func faultFixture(t *testing.T) fixture {
	t.Helper()
	f := newFixture(t)
	egress, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&struct {
		Egress any `json:"egress"`
	}{cloudEgress()})
	if err != nil {
		t.Fatal(err)
	}
	policy := &object{Object: map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
		"metadata": map[string]any{
			"name": faultPolicyName, "namespace": "adaptive", "resourceVersion": "7",
			"labels":      map[string]any{"adaptive.jplck.io/demo": "cloud-outage"},
			"annotations": map[string]any{"retained": "untouched"},
		},
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": map[string]any{"adaptive.jplck.io/cloud-egress": "true"}},
			"policyTypes": []any{"Egress"}, "egress": egress["egress"],
		},
	}}
	if err := f.objects.Tracker().Create(networkPolicies, policy, "adaptive"); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestFaultControlOnlyChangesOnePolicyWithoutRestartingWorkloads(t *testing.T) {
	f := faultFixture(t)
	f.objects.PrependReactor("patch", "networkpolicies", func(action ktesting.Action) (bool, runtime.Object, error) {
		p := action.(ktesting.PatchAction)
		var payload map[string]any
		if p.GetName() != faultPolicyName || p.GetPatchType() != types.MergePatchType || json.Unmarshal(p.GetPatch(), &payload) != nil ||
			len(payload) != 2 || payload["metadata"].(map[string]any)["resourceVersion"] != "7" ||
			len(payload["spec"].(map[string]any)) != 1 {
			t.Fatal("fault mutation exceeded exact policy scope or omitted concurrency protection")
		}
		return false, nil, nil
	})
	for _, enabled := range []bool{false, true, true, false} {
		before := len(f.objects.Actions())
		body := `{"enabled":false}`
		if enabled {
			body = `{"enabled":true}`
		}
		view := request(t, f.api, "PATCH", "/v1/connectivity-fault", body, 200)
		if view["enabled"] != enabled || view["transitionStatus"] != nil || view["cloudEgressEnforced"] != nil {
			t.Fatal("fault configuration claimed connectivity or rollout enforcement")
		}
		for _, action := range f.objects.Actions()[before:] {
			if action.GetResource() != networkPolicies || (action.GetVerb() != "get" && action.GetVerb() != "patch") {
				t.Fatal("fault control mutated a workload or unrelated resource")
			}
		}
	}
	for _, action := range f.core.Actions() {
		if action.GetVerb() != "get" {
			t.Fatal("fault control mutated identity or mode ConfigMaps")
		}
	}
	stored, err := f.objects.Tracker().Get(networkPolicies, "adaptive", faultPolicyName)
	if err != nil || stored.(*object).GetAnnotations()["retained"] != "untouched" {
		t.Fatal("fault control changed unrelated metadata")
	}
}

func TestFaultControlRejectsMalformedInputAndUnexpectedPolicy(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `[]`, `{"enabled":"true"}`, `{"enabled":true,"mode":"local"}`, `{"enabled":true}{}`} {
		f := faultFixture(t)
		f.objects.ClearActions()
		request(t, f.api, "PATCH", "/v1/connectivity-fault", body, 422)
		if len(f.objects.Actions()) != 0 {
			t.Fatal("invalid fault request reached Kubernetes")
		}
	}
	for _, path := range [][]string{
		{"metadata", "labels"}, {"spec", "podSelector"}, {"spec", "policyTypes"},
	} {
		f := faultFixture(t)
		obj, err := f.objects.Tracker().Get(networkPolicies, "adaptive", faultPolicyName)
		if err != nil {
			t.Fatal(err)
		}
		policy := obj.(*object)
		unstructured.RemoveNestedField(policy.Object, path...)
		if err := f.objects.Tracker().Update(networkPolicies, policy, "adaptive"); err != nil {
			t.Fatal(err)
		}
		request(t, f.api, "PATCH", "/v1/connectivity-fault", `{"enabled":true}`, 503)
		for _, action := range f.objects.Actions() {
			if action.GetVerb() == "patch" {
				t.Fatal("unexpected policy was silently adopted")
			}
		}
	}
}

func TestFaultErrorsAreExplicitAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{
		{apierrors.NewConflict(schema.GroupResource{Resource: "networkpolicies"}, faultPolicyName, errors.New("private")), 409},
		{apierrors.NewForbidden(schema.GroupResource{Resource: "networkpolicies"}, faultPolicyName, errors.New("private")), 503},
		{apierrors.NewNotFound(schema.GroupResource{Resource: "networkpolicies"}, faultPolicyName), 404},
		{errors.New("private provider error"), 503},
	} {
		f := faultFixture(t)
		f.objects.PrependReactor("patch", "networkpolicies", func(ktesting.Action) (bool, runtime.Object, error) {
			return true, nil, tc.err
		})
		view := request(t, f.api, "PATCH", "/v1/connectivity-fault", `{"enabled":true}`, tc.status)
		data, _ := json.Marshal(view)
		if strings.Contains(string(data), "private") {
			t.Fatal("provider error leaked")
		}
	}
	request(t, newFixture(t).api, "GET", "/v1/connectivity-fault", "", 404)
	request(t, newFixture(t).api, "GET", "/healthz", "", 200)
}
