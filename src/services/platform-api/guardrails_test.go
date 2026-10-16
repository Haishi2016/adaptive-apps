package main

import (
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ktesting "k8s.io/client-go/testing"
)

func attachGovernance(t *testing.T, f fixture, reference, content string) {
	t.Helper()
	value, err := json.Marshal(map[string]any{"reference": reference, "content": content})
	if err != nil {
		t.Fatal(err)
	}
	_ = unstructured.SetNestedField(f.agent.Object, string(value), "data", "governance")
	update(t, f, "configmaps", f.agent)
}

const samplePolicy = `{"policies":[{"name":"local-only","apiVersion":"governance.toolkit/v1","default_action":"deny","rules":[{"name":"local-model","stage":"pre_input","condition":"true","action":"allow","description":"local"}]}],"targets":["adaptive/*"]}`

func installPolicy(t *testing.T, f fixture, content string) *corev1.ConfigMap {
	t.Helper()
	immutable := true
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "guardrail-l7ly2kv26qhto", Namespace: platformPolicies,
			Labels: map[string]string{"adaptive.jplck.io/resource": "agent-guardrails"}},
		Immutable: &immutable, Data: map[string]string{"policy.json": content},
	}
	if err := f.core.Tracker().Create(corev1.SchemeGroupVersion.WithResource("configmaps"), cm, platformPolicies); err != nil {
		t.Fatal(err)
	}
	return cm
}

func TestGuardrailsReadRetainedNativePoliciesAndAttachment(t *testing.T) {
	f := newFixture(t)
	cm := installPolicy(t, f, samplePolicy)
	platform := request(t, f.api, "GET", "/v1/guardrails", "", 200)
	policies := platform["policies"].([]any)
	if len(policies) != 1 || platform["enabled"] != true || platform["mode"] != nil || platform["enforcementVerified"] != false {
		t.Fatal("catalogue falsely reported effective enforcement")
	}
	ref := platformPolicies + "/" + cm.Name + "@sha256:" + contentDigest(samplePolicy)
	if policies[0].(map[string]any)["reference"] != ref {
		t.Fatal("catalogue discarded native revision/digest")
	}
	attachmentContent := strings.Replace(samplePolicy, `"targets":["adaptive/*"]`, `"targets":[]`, 1)
	attachmentReference := "adaptive-guardrails-apps/" + cm.Name + "@sha256:" + contentDigest(attachmentContent)
	attachGovernance(t, f, attachmentReference, attachmentContent)
	view := request(t, f.api, "GET", "/v1/agents/demo/guardrails", "", 200)
	if view["enabled"] != true || view["deployment"] != "demo-v1" || view["phase"] != "Ready" ||
		len(view["inherited"].([]any)) != 1 || view["attached"].(map[string]any)["reference"] != attachmentReference ||
		view["policy_sha256"] != nil || view["mode"] != nil || view["enforcementVerified"] != false {
		t.Fatalf("incorrect desired policy projection: %#v", view)
	}
	attachGovernance(t, f, attachmentReference+"bad", attachmentContent)
	request(t, f.api, "GET", "/v1/agents/demo/guardrails", "", 503)
}

func TestGuardrailsDoNotInventEmptyCatalogueOnFailure(t *testing.T) {
	f := newFixture(t)
	empty := request(t, f.api, "GET", "/v1/guardrails", "", 200)
	if empty["enabled"] != false || len(empty["policies"].([]any)) != 0 {
		t.Fatal("actual empty native list not represented")
	}
	f.core.PrependReactor("list", "configmaps", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "configmaps"}, "", nil)
	})
	request(t, f.api, "GET", "/v1/guardrails", "", 503)
	request(t, f.api, "GET", "/v1/agents/demo/guardrails", "", 503)
}

func TestDeclaredPolicyModeDoesNotClaimRuntimeEnforcement(t *testing.T) {
	for _, mode := range []string{"audit", "enforce"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			installPolicy(t, f, strings.Replace(samplePolicy, `"name":"local-only"`, `"name":"local-only","mode":"`+mode+`"`, 1))
			view := request(t, f.api, "GET", "/v1/guardrails", "", 200)
			bundle := view["policies"].([]any)[0].(map[string]any)["bundle"].(map[string]any)
			if bundle["policies"].([]any)[0].(map[string]any)["mode"] != mode ||
				view["mode"] != nil || view["enforcementVerified"] != false {
				t.Fatal("declared policy mode was confused with runtime enforcement")
			}
		})
	}
	f := newFixture(t)
	installPolicy(t, f, strings.Replace(samplePolicy, `"name":"local-only"`, `"name":"local-only","mode":"invalid"`, 1))
	request(t, f.api, "GET", "/v1/guardrails", "", 503)
}

func TestRetainedAttachmentWithoutGlobalPolicyRemainsConfigured(t *testing.T) {
	f := newFixture(t)
	content := strings.Replace(samplePolicy, `"targets":["adaptive/*"]`, `"targets":[]`, 1)
	ref := "adaptive-guardrails-apps/guardrail-" + strings.Repeat("a", 24) + "@sha256:" + contentDigest(content)
	attachGovernance(t, f, ref, content)
	global := request(t, f.api, "GET", "/v1/guardrails", "", 200)
	view := request(t, f.api, "GET", "/v1/agents/demo/guardrails", "", 200)
	if global["enabled"] != false || view["enabled"] != true ||
		view["attached"].(map[string]any)["reference"] != ref || view["mode"] != nil || view["enforcementVerified"] != false {
		t.Fatal("agent attachment was mistaken for absent governance")
	}
}

func TestGuardrailNativeRevisionValidation(t *testing.T) {
	for _, fault := range []string{"missingContent", "deleting", "name", "invalidJSON", "schema", "rules", "unknownFields", "oversize"} {
		t.Run(fault, func(t *testing.T) {
			f := newFixture(t)
			content := samplePolicy
			switch fault {
			case "invalidJSON":
				content = "{"
			case "schema":
				content = strings.Replace(content, "governance.toolkit/v1", "wrong/v1", 1)
			case "rules":
				content = strings.Replace(content, `"pre_input"`, `"unknown"`, 1)
			case "unknownFields":
				content = strings.Replace(content, `"targets":`, `"unsupported":true,"targets":`, 1)
			case "oversize":
				content += strings.Repeat(" ", 64001)
			}
			cm := installPolicy(t, f, content)
			switch fault {
			case "missingContent":
				cm.Data = nil
			case "deleting":
				now := metav1.Now()
				cm.DeletionTimestamp = &now
			case "name":
				if err := f.core.Tracker().Delete(corev1.SchemeGroupVersion.WithResource("configmaps"), platformPolicies, cm.Name); err != nil {
					t.Fatal(err)
				}
				cm.Name = "invalid-policy-revision"
				if err := f.core.Tracker().Create(corev1.SchemeGroupVersion.WithResource("configmaps"), cm, platformPolicies); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.core.Tracker().Update(corev1.SchemeGroupVersion.WithResource("configmaps"), cm, platformPolicies); err != nil {
				t.Fatal(err)
			}
			request(t, f.api, "GET", "/v1/guardrails", "", 503)
		})
	}
}

func TestCurrentRadiusPlatformPolicyNeedNotBeImmutable(t *testing.T) {
	f := newFixture(t)
	cm := installPolicy(t, f, samplePolicy)
	immutable := false
	cm.Immutable = &immutable
	if err := f.core.Tracker().Update(corev1.SchemeGroupVersion.WithResource("configmaps"), cm, platformPolicies); err != nil {
		t.Fatal(err)
	}
	view := request(t, f.api, "GET", "/v1/guardrails", "", 200)
	if view["enabled"] != true || view["projection"] != "current-platform-policy-catalogue" ||
		view["mode"] != nil || view["enforcementVerified"] != false {
		t.Fatal("current mutable desired policy was mistaken for an agent attachment")
	}
	inherited := request(t, f.api, "GET", "/v1/agents/demo/guardrails", "", 200)
	if len(inherited["inherited"].([]any)) != 1 {
		t.Fatal("active Radius policy was not projected as inherited")
	}
}

func TestGuardrailsMatchOnlyNativeTargets(t *testing.T) {
	f := newFixture(t)
	installPolicy(t, f, strings.Replace(samplePolicy, "adaptive/*", "different/*", 1))
	view := request(t, f.api, "GET", "/v1/agents/demo/guardrails", "", 200)
	if view["enabled"] != false || len(view["inherited"].([]any)) != 0 || view["attached"] != nil {
		t.Fatal("nonmatching native policy inherited")
	}
}
