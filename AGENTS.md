# Native agent capability

- Keep the implementation minimal: Radius recipes and native Kubernetes
  resources, not a lifecycle operator, reconciliation API or compatibility layer.
- Preserve the trading sample. Extend the existing Radius type catalogue;
  do not register a second `Radius.Resources` namespace or duplicate model types.
- Agent artifacts and native Responses hosting remain unchanged. Model calls
  use the authenticated gateway; invocation never passes through the diagnostics API.
- Explicit releases are immutable. Identity and state have separate retained
  ownership; no automatic pruning, credential regeneration or release fallback.
- Connectivity is not deployment mode. Local identity always uses Keycloak;
  cloud-only identity uses Entra and fails explicitly when unavailable.
  Demo outage control changes one NetworkPolicy, not workloads or credentials.
- Do not deploy over an existing operator installation without a separately
  qualified ownership handover. Source tests are not live deployment evidence.
