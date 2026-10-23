# Native agent policy service

Upstream [agentgateway](https://agentgateway.dev/) is the native agent data
plane:

```text
application -> agentgateway -> agent
agent -> model ingress -> LiteLLM -> model
```

Agentgateway owns JWT validation, authorization, routing, credential stripping,
and telemetry. This repository-built image is not a gateway. It provides only
the optional strict Responses validator and the connected Graph delegation
broker through the Envoy external authorization gRPC protocol.

## Optional strict Responses admission

Set `strictResponses: true` in `agents.json` to deploy one namespace-level
`responses-admission` instance with `AGENT_POLICY_MODE=admission`. The default
is direct routing without this service.

Strict admission accepts only exact stable agent paths, plain-text input,
explicit `store=false`, optional `background=false`, and optional boolean
`stream`. It rejects references, duplicate JSON fields, encoded or oversized
bodies, unsupported content, and delegation on runtimes without a connected
broker.

## Connected Graph delegation broker

A prompt agent with explicitly provisioned Graph delegation adds a colocated
broker using `AGENT_POLICY_MODE=delegation-broker`. The broker:

1. Applies strict Responses validation when `RESPONSES_ADMISSION_ENABLED=true`.
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
| `RESPONSES_ADMISSION_ENABLED` | Apply the strict request profile in the broker |
| `KEYCLOAK_TOKEN_URL` | Realm token URL; its sibling `/userinfo` validates the platform user |
| `IDENTITY_SIDECAR_URL` | Loopback official Entra sidecar |
| `AGENT_IDENTITY_CLIENT_ID` | Retained Entra Agent ID |
| `GRAPH_DELEGATION_ENABLED` | Must be `true` |
| `ENTRA_TENANT_ID` | Exact connected tenant |
| `AGENT_BLUEPRINT_ID` | Exact agent blueprint application ID |
| `OBO_CLIENT_ID` | Reviewed browser/OBO client |
| `AGENT_USER_ID` | Optional fixed worker user |

Run `go test ./...` in this directory. The container exposes the gRPC
authorization service on port `8083` and supports
`/agent-policy --healthcheck`.
