package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const platformPolicies = "adaptive-guardrails-platform"

var policyReference = regexp.MustCompile(`^(adaptive-guardrails-platform|adaptive-guardrails-apps)/guardrail-[a-z0-9-]{1,50}@sha256:[a-f0-9]{64}$`)

type policyRule struct {
	Name        string `json:"name"`
	Stage       string `json:"stage"`
	Condition   string `json:"condition"`
	Action      string `json:"action"`
	Description string `json:"description"`
}

type policy struct {
	Name          string       `json:"name"`
	APIVersion    string       `json:"apiVersion"`
	DefaultAction string       `json:"default_action"`
	Mode          string       `json:"mode,omitempty"`
	Rules         []policyRule `json:"rules"`
}

type policyDocument struct {
	Policies []policy `json:"policies"`
	Targets  []string `json:"targets"`
}

type policyResource struct {
	Reference string         `json:"reference"`
	Namespace string         `json:"namespace"`
	Targets   []string       `json:"targets"`
	Bundle    map[string]any `json:"bundle"`
}

func contentDigest(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func readPolicy(reference, content string) (policyResource, error) {
	var result policyResource
	if !policyReference.MatchString(reference) || len(content) > 64000 ||
		!strings.HasSuffix(reference, "@sha256:"+contentDigest(content)) {
		return result, unavailable("Guardrail reference or retained content digest is invalid")
	}
	var document policyDocument
	d := json.NewDecoder(bytes.NewBufferString(content))
	d.DisallowUnknownFields()
	if d.Decode(&document) != nil || d.Decode(new(any)) != io.EOF ||
		len(document.Policies) == 0 || len(document.Policies) > 20 {
		return result, unavailable("Guardrail policy document is invalid")
	}
	namespace := strings.SplitN(reference, "/", 2)[0]
	if namespace != platformPolicies && len(document.Targets) > 0 {
		return result, unavailable("Application guardrails cannot declare inherited targets")
	}
	for _, p := range document.Policies {
		if p.APIVersion != "governance.toolkit/v1" || p.Name == "" || p.DefaultAction != "deny" || p.Rules == nil ||
			(p.Mode != "" && p.Mode != "audit" && p.Mode != "enforce") {
			return result, unavailable("Guardrail policy contract is invalid")
		}
		for _, rule := range p.Rules {
			if rule.Name == "" || rule.Condition == "" ||
				(rule.Stage != "pre_input" && rule.Stage != "pre_tool") ||
				(rule.Action != "allow" && rule.Action != "deny" && rule.Action != "require_approval") {
				return result, unavailable("Guardrail rule contract is invalid")
			}
		}
	}
	targets := document.Targets
	if targets == nil {
		targets = []string{}
	}
	return policyResource{reference, namespace, targets, map[string]any{"policies": document.Policies}}, nil
}

func (a *API) policies(r *http.Request) ([]policyResource, error) {
	cms, err := a.core.ConfigMaps(platformPolicies).List(r.Context(), metav1.ListOptions{
		LabelSelector: "adaptive.jplck.io/resource=agent-guardrails",
	})
	if err != nil {
		return nil, err
	}
	result := make([]policyResource, 0, len(cms.Items))
	for _, cm := range cms.Items {
		if cm.DeletionTimestamp != nil ||
			cm.Labels["adaptive.jplck.io/resource"] != "agent-guardrails" {
			return nil, unavailable("Guardrail resource is not an active platform policy")
		}
		content, ok := cm.Data["policy.json"]
		if !ok {
			return nil, unavailable("Guardrail policy.json is missing")
		}
		reference := platformPolicies + "/" + cm.Name + "@sha256:" + contentDigest(content)
		p, err := readPolicy(reference, content)
		if err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Reference < result[j].Reference })
	return result, nil
}

func (a *API) platformGuardrails(r *http.Request) (any, error) {
	policies, err := a.policies(r)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"enabled": len(policies) > 0, "mode": nil, "policies": policies,
		"projection": "current-platform-policy-catalogue", "enforcementVerified": false,
	}, nil
}

func (a *API) agentGuardrails(r *http.Request) (any, error) {
	agent, runtime, err := a.selected(r)
	if err != nil {
		return nil, err
	}
	policies, err := a.policies(r)
	if err != nil {
		return nil, err
	}
	inherited := make([]policyResource, 0)
	for _, policy := range policies {
		for _, target := range policy.Targets {
			pattern := "^" + strings.ReplaceAll(regexp.QuoteMeta(target), `\*`, ".*") + "$"
			if regexp.MustCompile(pattern).MatchString(a.namespace + "/" + text(agent, "data", "name")) {
				inherited = append(inherited, policy)
				break
			}
		}
	}
	var attached *policyResource
	if governance := field(runtime.document, "governance"); governance != nil {
		reference := text(runtime.document, "governance", "reference")
		content := text(runtime.document, "governance", "content")
		policy, err := readPolicy(reference, content)
		if err != nil {
			return nil, err
		}
		attached = &policy
	}
	return map[string]any{
		"name":    text(agent, "data", "name"),
		"enabled": len(inherited) > 0 || attached != nil, "mode": nil,
		"inherited": inherited, "attached": attached, "policy_sha256": nil,
		"deployment":          nullable(text(runtime.deployment, "metadata", "name")),
		"phase":               map[bool]string{true: "Ready", false: "Pending"}[runtime.ready],
		"projection":          "current-platform-policies-and-agent-attachment",
		"enforcementVerified": false,
	}, nil
}
