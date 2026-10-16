package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/dynamic"
	core "k8s.io/client-go/kubernetes/typed/core/v1"
)

type API struct {
	namespace string
	objects   dynamic.Interface
	core      core.CoreV1Interface
	monitor   *monitorReader
}

type failure struct {
	status int
	detail string
}

func (f failure) Error() string { return f.detail }

func unavailable(detail string) error { return failure{http.StatusServiceUnavailable, detail} }

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func respond(f func(*http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, err := f(r)
		if err == nil {
			writeJSON(w, http.StatusOK, result)
			return
		}
		status, detail := http.StatusServiceUnavailable, "Kubernetes operational data unavailable"
		var explicit failure
		switch {
		case errors.As(err, &explicit):
			status, detail = explicit.status, explicit.detail
		case apierrors.IsNotFound(err):
			status, detail = http.StatusNotFound, "Requested Kubernetes resource not found"
		case apierrors.IsConflict(err):
			status, detail = http.StatusConflict, "Resource changed concurrently; read current state and retry"
		}
		// Never return provider messages, resource bodies or request tokens.
		writeJSON(w, status, map[string]string{"detail": detail})
	}
}

var namePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func selection(r *http.Request) (string, error) {
	name := r.PathValue("name")
	if !namePattern.MatchString(name) || r.URL.RawQuery != "" {
		return "", failure{http.StatusUnprocessableEntity, "Invalid agent name or unsupported query parameters"}
	}
	return name, nil
}

func decodeJSON(r *http.Request, value any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(body) > 4096 {
		return failure{http.StatusRequestEntityTooLarge, "JSON request exceeds 4096 bytes"}
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return failure{http.StatusUnprocessableEntity, "Expected a valid JSON object with supported fields"}
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return failure{http.StatusUnprocessableEntity, "Expected exactly one JSON object"}
	}
	return nil
}

func (a *API) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", respond(func(*http.Request) (any, error) {
		return map[string]string{"status": "ok"}, nil
	}))
	mux.HandleFunc("GET /v1/connectivity-fault", respond(a.getConnectivityFault))
	mux.HandleFunc("PATCH /v1/connectivity-fault", respond(a.patchConnectivityFault))
	mux.HandleFunc("GET /v1/environment", respond(a.environment))
	mux.HandleFunc("GET /v1/agents", respond(a.listAgents))
	mux.HandleFunc("GET /v1/agents/{name}", respond(a.getAgent))
	mux.HandleFunc("GET /v1/tools", respond(a.tools))
	mux.HandleFunc("GET /v1/guardrails", respond(a.platformGuardrails))
	mux.HandleFunc("GET /v1/agents/{name}/guardrails", respond(a.agentGuardrails))
	mux.HandleFunc("GET /v1/agents/{name}/spans", a.agentSpans)
	// Authentication belongs to the Envoy human JWT policy and its isolated
	// Service network boundary; arbitrary forwarded headers are never trusted.
	return mux
}
