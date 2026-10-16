# Adaptive AI UI

See [native Radius agents](../../../docs/agents/native-radius.md). The UI uses
Keycloak login and native agent/model ingress; the portfolio chart deploys it with the
read-only operational API.
After `npm ci`, use `VITE_MOCK_BACKEND=true npm run dev` for a frontend-only
preview, or configure external services below for live operations.

The UI is the optional native capability in `charts/adaptive-apps`.
Configure exact HTTPS UI/Keycloak origins, a retained TLS Secret and
reviewed human role grants. Local port forwarding and browser certificate trust
are environment-specific. `ada oidc demo-users` optionally provisions local demo users.

The browser reads operational inventory/configuration from `platform-api`
(`/v1/environment`, `/v1/agents` and `/v1/agents/{name}`).
Inventories return `{object:"list",data:[...]}` with direct current agent
records, without pagination or SDK metadata envelopes.
`/v1/agents/{name}` returns the current mutable agent runtime directly.
The environment reports name, description and cloud configuration,
not an emulated project identifier. Cloud configuration may link a genuine Azure
Foundry project independently of edge inventory.
Model calls default to `/models/v1`; `VITE_GATEWAY_URL` overrides the complete
OpenAI-compatible API base, including `/v1` (for example `/v1` or
`https://gateway.example/v1`). Discovery appends `/models`; chat and image
invocation append `/chat/completions` and `/images/generations`. The UI does not
append another `/v1` or fall back to operational API model discovery.
The image build defaults to `VITE_GATEWAY_URL=/models/v1`, matching nginx's
model-gateway proxy. Keep that value for the local UI; bare `/v1` is an
operational/agent-ingress path on this UI origin, not its model proxy.
Agent calls use the reported stable endpoint through `agent-ingress`, never the
operational API.
The Agents list refreshes inventory every ten seconds. Readiness uses the
current runtime's API `phase`. Created needs Unix-seconds `created`, and
Description needs `description`.
Absent values render as —, not fabricated metadata or readiness.

Playgrounds use the current runtime. The first send pins the observed agent
configuration and call identity for that conversation. Each send uses plain-text
input and explicit `store=false`, with no reference to a previous response.
Displayed history is not model context. Updating the agent does not move an
existing UI conversation to a different captured configuration.
Failed, incomplete or cancelled turns require **New conversation**; no automatic
replay or runtime fallback occurs. Hosted delegation remains unavailable.
Prompt agents with the captured native `graph-me` tool can select app,
signed-in-user OBO or the provisioned agent worker user when their actual
identity prerequisites are reported. Graph `/me` rejects app identity explicitly;
model calls always retain application identity.
Agent info shows actual Keycloak client IDs separately from retained Entra
Agent ID/blueprint IDs; a local client has no Entra blueprint.

Model discovery errors are visible and disable Send until the selected model
is in the gateway catalogue. Native model SSE must complete with `[DONE]`;
HTML fallbacks, native error frames and incomplete streams are failures.
Unknown provider metadata is displayed neutrally, not inferred as local.

## Operational browser contracts

The exact response schemas are in `src/api/client.ts`; Monitor event schemas
are in `src/components/MonitorPanel.tsx`. API changes must preserve those contracts:

- `GET /v1/guardrails`: `enabled`, nullable `mode`, and `policies`.
- `GET /v1/agents/{name}/guardrails`: current agent configuration with
  `enabled`, nullable `mode`, `inherited`, nullable `attached`, `policy_sha256`,
  `deployment` and `phase`. Policy resources include `reference`, `namespace`,
  `targets` and the AGT `bundle`; do not report empty configuration on errors.
- `GET /v1/agents/{name}/spans`: authenticated `text/event-stream` fetch;
  each data frame is either the span schema or a `type=log` guardrail/identity
  record. Span trace/parent IDs, timestamps, duration, status, service,
  primitive attributes and events are required. HTTP auth errors fail visibly;
  5xx/disconnections reconnect after three seconds. Emit recent/live actual
  telemetry, not success-shaped synthetic spans.
- `GET` / `PATCH /v1/connectivity-fault`: `{enabled, policyName, namespace}`;
  PATCH receives `{enabled:boolean}`. The ten-second authenticated poll reports
  demo fault configuration, not actual WAN connectivity. Changes are shown
  after acceptance and re-read; failures stay visible. No Pod restart,
  configuration mode switch or automatic turn replay is requested.
- `GET /v1/tools` retains read-only catalogue behavior; A2A
  remains a visible consumer of its existing `src/api` contracts. Unsupported
  operations must return explicit errors, not fabricated empty/success data.

Both nginx and Vite route `/v1` inventory and `/agents` native Responses through agent ingress, not directly to
the API Service. Local Vite proxies use `AGENT_INGRESS_URL` / `MODEL_INGRESS_URL`
(default `http://127.0.0.1:8091`). See
[delivery](../../../docs/agents/native-radius.md#delivery).

## Keycloak login

Set these Vite build variables only after the receiving services trust Keycloak:

```text
VITE_AUTH_ENABLED=true
VITE_KEYCLOAK_AUTHORITY=https://identity.example/realms/adaptive
VITE_KEYCLOAK_CLIENT_ID=adaptive-ui
```

The authority is the realm issuer, not its discovery URL. The
[administrator recipe](../../../radius/recipes/keycloak-login/README.md)
configures the exact HTTPS UI origin, `/auth/callback` redirect and origin-only
post-logout redirect. Keycloak discovery/token endpoints must be browser
reachable; its client Web Origins must allow that exact UI origin. Never put a
client secret in the UI.

`oidc-client-ts` owns discovery, PKCE/state validation, token exchange and
Keycloak logout. The UI offers an explicit Sign in button in both modes;
Keycloak shows the available local/Entra choices. Login does not depend on a
fault-configuration lookup and does not automatically redirect again after sign-out
or failure. Demo fault injection does not reconfigure federation. Administrators
may explicitly disable Entra login separately; hiding a UI option is not
authorization enforcement or session revocation.

The existing login screen and `/auth/callback` are the human-login surface for
local agent qualification; no separate login page or app-token substitution is
needed. The UI reads its displayed user from the native SDK's ID-token profile,
not `/v1/me`. Login therefore does not depend on the operational API. Resource
servers still validate access tokens and permissions independently. Conversation
identity uses the exact issuer and subject, not an inferred Entra object ID.

Keycloak tokens stay in per-tab session storage. API, model, agent and monitor
requests share token renewal before expiry.
Concurrent requests share one renewal; failed renewal or HTTP 401 ends the
local session without replaying application requests. Existing broker sessions
require sign-in again. The old broker token fields, Entra refresh grants and
`/oidc` proxy are removed. A Keycloak login token is not an Entra delegated token.
Agent application identity is independent.

### Delegated Graph tool

The API supplies `identity.entraTenantId`, `oboClientId`, `graphDelegation`,
`agentUserId` and the existing `blueprintId`. Captured tools include
`{type:"builtin",name:"graph-me",connectionRef,serverLabel,requireApproval:"never",
authType:"entra",audience:"https://graph.microsoft.com",identityModes,
executionIdentity:"caller"}` with no MCP `serverUrl`. `/v1/tools` publishes the
existing catalogue fields with `kind:"builtin"` for these bindings.

OBO is enabled only in connected mode with Graph delegation, a tenant/client/
blueprint and the same-tenant administrator-managed `entra_tid`/`entra_oid`
claims in the Keycloak profile. Email never establishes this link. The per-agent
Entra public SPA client must allow the exact UI origin's `/auth/entra-callback`
redirect URI and the blueprint's `access_agent` scope.

Each OBO turn opens a native `oidc-client-ts` PKCE popup against
`https://login.microsoftonline.com/<tenant>/v2.0`, requesting only
`openid profile api://<blueprintId>/access_agent`. Returned Entra `tid`/`oid`
must match the linked Keycloak profile. The callback only notifies the opener;
Keycloak login is not replaced. SDK interaction state and delegated assertions
stay in memory, with a fresh acquisition per turn and no browser Graph token.
The opener retains PKCE/state and validates the callback plus an explicit
per-request OIDC nonce. The callback window transports only the native
authorization response URL; it neither reads opener state nor exchanges tokens.
Cancelled login, consent and Conditional Access errors remain visible.
Session/link or mode changes during acquisition prevent the invocation.

Native ingress receives `X-Impersonation-Mode`; OBO alone adds
`X-Entra-User-Token`. No downstream Graph bearer or `X-client-*` token is sent.
Backend assertion validation and userinfo matching remain authoritative.
Agent-user mode additionally requires reported `agentUserId`; a Keycloak mirror
does not qualify a worker user. All call identity/release controls are pinned
until **New conversation**. Real human OBO/worker-user behavior requires separate
live qualification; UI source tests do not establish that gate.

Auth remains off by default for mocks/static-token development, not production
authorization. In enabled mode, static/legacy tokens are never a fallback.

## Authorization

The deployed UI uses separate human and application authorization boundaries:

| Caller | Required trust |
| --- | --- |
| Browser, in either mode | Exact Keycloak realm issuer, its JWKS, and the configured `platformAudience` (default `api://adaptive-broker`); explicit user roles/route permissions |
| Local agent | Existing Keycloak issuer, model audience `api://adaptive-model-gateway`, and authorized application identity |
| Connected Graph broker | Existing tenant-pinned Entra issuer/JWKS and exact Graph delegation bindings |

Keycloak discovery is `<authority>/.well-known/openid-configuration`; its JWKS
is `<authority>/protocol/openid-connect/certs`. Use HTTPS and trusted
certificates, validate signatures/expiry/issuer/audience, and support key
rotation. The audience named `api://adaptive-broker` is an identifier, **not**
the new issuer. Do not use the broker's combined JWKS/provider metadata.

For read-only `/v1/*`, the native Envoy route requires `azp=adaptive-ui` and the
explicit `agent.invoke` user role with the platform audience. The API Service
accepts ingress only from that Gateway and consumes no spoofable caller headers.
It cannot be exposed directly as an alternative authorization path. Preserve
principal separation: local Keycloak IDs are not Entra object IDs.

Browser `/models/v1/*` calls use an explicitly authorized platform-audience
policy alongside the separate agent application policy. Audience acceptance alone
does not authorize a caller.
Preserve the gateway's existing Azure backend credentials; browser Keycloak
tokens must not be forwarded as Azure service credentials.

Agent ingress source now validates native Keycloak JWTs and requires the
`adaptive-ui` user client plus `agent.invoke` in the mapped `roles` array.
The shared Agent Gateway policy service supplies fail-closed HTTP admission on
port 8083, not gRPC.
Only exact version POST `/responses` with plain-text input and `store=false`
is qualified in source; stored children, references and background remain denied.
Graph delegation requires the separately implemented native admission contract
above; the UI does not qualify backend token removal or delegation. Bearers are
removed before SDK handling. See the
[qualification status](../../../docs/agents/native-radius.md#verification-status).

Both playgrounds send the bounded stateless shape and select exact releases.
Stored conversations remain unavailable; browser renewal/logout, federation and
key rotation need separate checks.
