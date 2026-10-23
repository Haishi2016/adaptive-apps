# Native agent capability

This is the optional `agents` dependency of `charts/adaptive-apps`, enabled by
`features.agents.enabled`. Install the portfolio chart, not a second foundation.
The portfolio owns shared PostgreSQL-backed Keycloak and one OTel Collector.
This capability contains native ingress, model gateway, optional diagnostics,
retained Jaeger/Loki stores and native admission policies,
not an agent lifecycle operator or lifecycle CRDs.

Invocation follows two explicit gateway boundaries:

```text
application -> Agent Gateway -> agent -> Model Gateway -> model
```

Upstream agentgateway authenticates callers, authorizes exact agent routes,
strips caller credentials, and routes requests. Set `strictResponses: true` to
add the optional shared `responses-admission` request-shape validator.
Agents use their paired Keycloak OAuth clients for Model Gateway and peer-agent
calls. LiteLLM separately owns provider routing and cloud provider identity.
Connected prompt agents add a Graph delegation broker only when
their retained identity declares that capability.

Start with [Getting Started](../../tutorials/getting-started/README.md). See
[native Radius agents](../../docs/agents/native-radius.md) for provisioning
inputs, retained ownership, outage behavior and unqualified live gates.
