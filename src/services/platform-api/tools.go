package main

import "net/http"

func (a *API) tools(_ *http.Request) (any, error) {
	return map[string]any{"object": "list", "data": []any{map[string]any{
		"name": "graph-me", "displayName": "Graph profile",
		"description": "Read the selected signed-in user or bound agent worker profile from Microsoft Graph. Connected mode only; application identity is not supported.",
		"kind":        "builtin", "builtin": "graph-me", "authType": "entra",
		"audience": "https://graph.microsoft.com", "identityModes": []string{"app", "endUserOBO", "agentUser"},
		"executionIdentity": "caller",
	}}}, nil
}
