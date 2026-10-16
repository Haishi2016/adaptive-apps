# Demo Agent Gateway policy service

This Go service is the policy component of the demo Agent Gateway:

```text
application -> Envoy agent ingress -> policy service -> agent
agent -> model ingress -> LiteLLM -> model
```

Envoy owns TLS, JWT validation, caller authorization and routing. This service
performs strict body-aware admission before the native Responses host can store
or execute a request. It is a proof-of-concept implementation of the Agent
Gateway boundary, not an agent lifecycle controller or a replacement for an
OSS/managed gateway.

## Shared admission mode

The Helm capability deploys one namespace-level instance with
`AGENT_GATEWAY_MODE=admission`. It accepts only exact stable agent paths,
plain-text input, explicit `store=false`, optional `background=false`, and
optional boolean `stream`. It rejects references, child operations, duplicate
JSON fields, encoded or oversized bodies, unsupported content and caller
delegation on runtimes without a connected broker.

The service returns only the verified `app` actor mode. Envoy converts verified
admission output into request-local `X-Client-*` context and strips caller
authorization, cookies and delegation inputs before forwarding.

## Connected Graph delegation broker

A prompt agent with an explicitly provisioned Graph delegation capability
adds a small colocated broker using
`AGENT_GATEWAY_MODE=delegation-broker`. The broker:

1. Sends the body to the shared admission service and fails closed.
2. Validates the Keycloak platform user.
3. Validates the linked Entra assertion for `endUserOBO`, or selects the one
   retained worker user for `agentUser`.
4. Uses the official Entra sidecar to acquire a request-local Graph token.

The broker never provides model credentials or emulates the Azure managed
identity endpoint. Local model and peer-agent calls use the agent's standard
Keycloak OAuth client credentials directly. LiteLLM independently uses its
gateway workload identity for Azure model providers.

Required broker configuration:

| Variable | Purpose |
| --- | --- |
| `AGENT_GATEWAY_ADMISSION_URL` | Shared admission service base URL |
| `KEYCLOAK_TOKEN_URL` | Realm token URL; its sibling `/userinfo` validates the platform user |
| `IDENTITY_SIDECAR_URL` | Loopback official Entra sidecar |
| `AGENT_IDENTITY_CLIENT_ID` | Retained Entra Agent ID |
| `GRAPH_DELEGATION_ENABLED` | Must be `true` |
| `ENTRA_TENANT_ID` | Exact connected tenant |
| `AGENT_BLUEPRINT_ID` | Exact agent blueprint application ID |
| `OBO_CLIENT_ID` | Reviewed browser/OBO client |
| `AGENT_USER_ID` | Optional fixed worker user |

Run `go test ./...` in this directory. The container exposes port `8083` and
supports `/agent-gateway --healthcheck`.
