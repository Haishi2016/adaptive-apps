# Agent diagnostics API

Go `net/http` projects retained native agent ConfigMaps and current
StatefulSet, PVC and Gateway/policy readiness for the UI. It has no lifecycle
CRD client, controller loop, identity provisioning, runtime writer, model
inventory or inference proxy.

`GET /v1/agents` and `GET /v1/agents/{name}` expose current operational
records. Guardrails are read-only retained policy views. Monitor streams bounded native Jaeger/Loki records through
authenticated fetch, without forwarding browser tokens to stores.
`GET/PATCH /v1/connectivity-fault` reads/patches only the exact existing demo
NetworkPolicy; no workload or identity mutation is authorized.

Envoy validates human JWT issuer/audience, authorized party and `agent.invoke`.
The Service is isolated to authorized native ingress, not exposed directly.
Run with `K8S_NAMESPACE` and fixed `TRACE_QUERY_ENDPOINT`/`LOG_QUERY_ENDPOINT`.
`/healthz` is process-only. `just lint`, `test`, `build` run package checks.

See [native Radius agents](../../../docs/agents/native-radius.md) for deployment,
retention, outage semantics and live qualification gaps.
