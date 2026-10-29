# Editor

The editor is a portable Agent Framework agent. Its behavior depends on an
`AgentResolver` and token provider, not environment variables, Keycloak,
Kubernetes or Foundry hosting. The executable selects `foundry-compatible` by
default or `kubernetes` through `AGENT_HOST_ADAPTER`; each adapter resolves
those contracts from deployment environment bindings.

The agent calls stable routes through the OpenAI Responses SDK: writer first,
then auditor with the draft and original request. It returns both results as
Markdown sections labelled with each specialist's name.
The auditor receives the writer's text, not display labels.
Failed, incomplete or empty responses abort the sequence; no automatic retries,
fallback, discovery or runtime provisioning are performed.

The current environment adapter accepts `WRITER_NAME`,
`WRITER_RESPONSES_BASE_URL`, `AUDITOR_NAME` and
`AUDITOR_RESPONSES_BASE_URL`.
Each base URL ends in `/agents/{name}/`; the SDK appends
`responses`. Credentials, query strings and unpinned paths are rejected.
The current identity adapter uses Keycloak OAuth client credentials configured by
`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET`.
Both calls explicitly disable server-side storage.
The host-neutral Kubernetes Responses adapter supports this foreground
`store: false` path and rejects stored, background and streaming requests
explicitly. The Foundry-compatible Responses host remains available for those
features. No Foundry project or agent management client is used by the
Kubernetes deployment. Cloud-specific routing, user delegation and same-image
Foundry hosting remain separately qualified. The portable agent contains no
Kubernetes or Radius access.

See the [portable agent guide](../../../docs/agents/native-radius.md)
for Radius delivery.
