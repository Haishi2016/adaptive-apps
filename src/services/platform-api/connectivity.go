package main

import (
	"encoding/json"
	"net/http"
	"reflect"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
)

const faultPolicyName = "demo-cloud-egress"

var networkPolicies = schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"}

func cloudEgress() []networkingv1.NetworkPolicyEgressRule {
	tcp, port := corev1.ProtocolTCP, intstr.FromInt32(443)
	return []networkingv1.NetworkPolicyEgressRule{{
		To: []networkingv1.NetworkPolicyPeer{
			{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0", Except: []string{
				"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8",
			}}},
			{IPBlock: &networkingv1.IPBlock{CIDR: "::/0", Except: []string{"fc00::/7", "fe80::/10", "::1/128"}}},
		},
		Ports: []networkingv1.NetworkPolicyPort{{Protocol: &tcp, Port: &port}},
	}}
}

func (a *API) connectivityPolicy(r *http.Request) (*networkingv1.NetworkPolicy, error) {
	obj, err := a.objects.Resource(networkPolicies).Namespace(a.namespace).Get(r.Context(), faultPolicyName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	var policy networkingv1.NetworkPolicy
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &policy); err != nil {
		return nil, unavailable("Demo cloud egress policy is invalid")
	}
	if policy.DeletionTimestamp != nil || policy.Labels["adaptive.jplck.io/demo"] != "cloud-outage" ||
		!reflect.DeepEqual(policy.Spec.PodSelector, metav1.LabelSelector{MatchLabels: map[string]string{"adaptive.jplck.io/cloud-egress": "true"}}) ||
		!reflect.DeepEqual(policy.Spec.PolicyTypes, []networkingv1.PolicyType{networkingv1.PolicyTypeEgress}) ||
		len(policy.Spec.Ingress) != 0 ||
		(len(policy.Spec.Egress) != 0 && !reflect.DeepEqual(policy.Spec.Egress, cloudEgress())) {
		return nil, unavailable("Demo cloud egress policy has unexpected ownership, targets or rules")
	}
	return &policy, nil
}

func (a *API) getConnectivityFault(r *http.Request) (any, error) {
	policy, err := a.connectivityPolicy(r)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"enabled": len(policy.Spec.Egress) == 0, "policyName": faultPolicyName, "namespace": a.namespace,
	}, nil
}

func (a *API) patchConnectivityFault(r *http.Request) (any, error) {
	var update struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeJSON(r, &update); err != nil {
		return nil, err
	}
	if update.Enabled == nil {
		return nil, failure{http.StatusUnprocessableEntity, "enabled must be a boolean"}
	}
	policy, err := a.connectivityPolicy(r)
	if err != nil {
		return nil, err
	}
	if *update.Enabled == (len(policy.Spec.Egress) == 0) {
		return a.getConnectivityFault(r)
	}
	if policy.ResourceVersion == "" {
		return nil, unavailable("Demo cloud egress policy resourceVersion is missing")
	}
	egress := []networkingv1.NetworkPolicyEgressRule{}
	if !*update.Enabled {
		egress = cloudEgress()
	}
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]string{"resourceVersion": policy.ResourceVersion},
		"spec":     map[string]any{"egress": egress},
	})
	if err != nil {
		return nil, err
	}
	if _, err := a.objects.Resource(networkPolicies).Namespace(a.namespace).
		Patch(r.Context(), policy.Name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		return nil, err
	}
	observed, err := a.connectivityPolicy(r)
	if err != nil {
		return nil, err
	}
	if *update.Enabled != (len(observed.Spec.Egress) == 0) {
		return nil, unavailable("Demo cloud egress mutation was not persisted")
	}
	return map[string]any{"enabled": *update.Enabled, "policyName": policy.Name, "namespace": a.namespace}, nil
}
