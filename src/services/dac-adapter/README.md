# DAC identity adapter

A standard-library-only Go sidecar translating the Azure App Service
managed-identity HTTP contract into Entra SDK sidecar or Keycloak requests.
It listens only on `127.0.0.1:8081`. No token signing, claim rewriting, token
cache, provider fallback or cluster-mode watcher.

## Configuration

Supply these environment variables to the adapter:

| Variable | Value |
| --- | --- |
| `IDENTITY_HEADER` | Existing pod-bound Secret value, shared with the native agent |
| `IDENTITY_DOWNSTREAM` | JSON allowlist of named downstreams, shown below |
| `IDENTITY_SIDECAR_URL` | Required for cloud-only bindings or Graph delegation: existing Entra SDK sidecar, e.g. `http://127.0.0.1:5000` |
| `AGENT_IDENTITY_CLIENT_ID` | Required for cloud-only bindings or Graph delegation: provisioned Entra Agent Identity, not the blueprint ID |
| `KEYCLOAK_TOKEN_URL` | Required: fixed realm token URL, preferably HTTPS with a trusted CA |
| `KEYCLOAK_CLIENT_ID` | Required: existing paired per-agent service-account client |
| `KEYCLOAK_CLIENT_SECRET` | Required: Kubernetes Secret reference, adapter-only |

For example, `IDENTITY_DOWNSTREAM`:

```json
{
  "model-gateway": {
    "scope": "https://cognitiveservices.azure.com/.default",
    "local_audience": "api://adaptive-model-gateway"
  },
  "microsoft-graph": {
    "scope": "https://graph.microsoft.com/.default"
  }
}
```

Each resource must be unique. Downstream names must match the existing Entra
sidecar's configured `DownstreamApis`; that sidecar's scopes must match these
bindings. Only app-token bindings are supported, not delegated identity modes.
This JSON allowlist replaces the prototype's single `IDENTITY_RESOURCE`.

Cloud-only bindings (without `local_audience`) call
`GET /AuthorizationHeaderUnauthenticated/{name}?AgentIdentity=...&optionsOverride.RequestAppToken=true`
on the trusted sidecar. The adapter reads JWT expiry without re-signing or
verifying the token; the destination validates it. Entra RBAC/API permissions
and the sidecar's workload identity must already be provisioned.

Bindings with a nonempty `local_audience` always request Keycloak client
credentials, including while Azure is healthy. An unreachable Entra sidecar
cannot affect these calls; no configuration change or restart is required.
Cloud-only failures never trigger Keycloak fallback, including denied
credentials, timeouts or malformed tokens. This process neither watches
cluster state nor invalidates tokens already cached by a client.

Configure the native agent, without changing its image:

```text
IDENTITY_ENDPOINT=http://127.0.0.1:8081/identity/token
IDENTITY_HEADER=<same pod-bound Secret reference>
AZURE_TOKEN_CREDENTIALS=ManagedIdentityCredential
```

The environment credential selector requires Python Azure Identity 1.24+;
the existing native-agent contract uses 1.25+. If an explicit client ID is
requested, it must equal `AGENT_IDENTITY_CLIENT_ID` when that binding is present,
otherwise `KEYCLOAK_CLIENT_ID`. The paired binding keeps that selector stable
across connectivity changes. Other identity selectors and
unknown/repeated query parameters are rejected.

Keycloak must configure the declared local audiences and roles on this client;
`local_audience` does not dynamically change the token's audience. For a local
binding an Azure resource is only an explicit alias for a local service accepting
Keycloak tokens; it does not authorize calls to Azure. No caller-controlled
audience, scope or credentials are forwarded to Keycloak. Resource servers
must validate issuer, signature, audience, expiry and permissions.

DAC supplies a resource, not the destination URL. For a shared model scope, the
local gateway must accept the paired Keycloak identity. Do not route a local token to
Azure. Cloud egress restrictions remain a separate platform responsibility.

`GET /healthz` reports process availability, not provider availability.
Token requests require the App Service API version `2019-08-01` and
`X-IDENTITY-HEADER`. Failed provider requests are not retried or redirected;
errors never include provider response bodies or secrets. DAC owns caching.
HTTP is supported for private cluster endpoints; traffic crossing an untrusted
network requires HTTPS. This is not an isolation boundary against another
container with access to the same Pod's credentials.

## Build and scope

Use `just build`, `just test`, `just lint` or `just image` here, or the root
commands. With Go alone: `go test ./...` and `go build .`.

The native Radius release recipe wires this image directly, with a Secret-bound identity
header and paired agent client, both native model scopes and a loopback exec
readiness probe (`/dac-adapter --healthcheck`). The Python pod adapter is removed.
The managed-identity endpoint supplies application tokens only. Browser login
and A365 export remain outside this process.

When `AGENT_RESPONSE_PATH` is set to the exact version `/responses` path, an
additional HTTP admission listener on port 8083 bounds the native SDK to
plain-text `input`, explicit `store=false`, optional boolean `stream` and
`background=false`. All other fields, duplicate fields, references, encoded or
oversized bodies, query parameters and child operations are denied.
`GET /healthz` on this listener is process-only readiness.

Envoy validates caller JWT signature/issuer/audience/lifetime, explicit user
client and role. Native authorization rejects spoofed downstream identity
headers and strips browser bearers before SDK handling.
The listener never forwards, interprets Responses or signs identity. It is
necessary because native JWT policies cannot inspect JSON persistence/background
flags. A release NetworkPolicy restricts both SDK and admission ports to the
agent Gateway, and identity remains loopback-only. This is a bounded initial
path, not qualification of stored Responses or arbitrary Responses input.
See [native Radius agents](../../../docs/agents/native-radius.md).

## Delegated prompt tools

The admission listener accepts `X-Impersonation-Mode` values `app`,
`endUserOBO` and `agentUser`. The release enables delegation only for a prompt
release with its captured Graph tool and provisioned identity capability.
Model DAC remains application identity regardless of the tool's selected actor.
Graph `/me` cannot execute as an application.

`GRAPH_DELEGATION_ENABLED=true` requires exact `ENTRA_TENANT_ID`,
`AGENT_BLUEPRINT_ID` and `OBO_CLIENT_ID`, plus the platform `KEYCLOAK_TOKEN_URL`.
`AGENT_USER_ID` optionally selects the one fixed worker user; callers cannot
override it. These are recipe-supplied bindings from reusable Radius
`delegation` configuration, not credentials or a separate login service.

Both delegated modes validate the platform session using Keycloak userinfo.
OBO requires one `X-Entra-User-Token` assertion. The official sidecar validates
its signature and returns claims; the adapter additionally requires the exact
blueprint audience, browser client, `access_agent` scope and the same
administrator-managed `entra_tid`/`entra_oid` link as the platform user.
The official sidecar performs OBO or the fixed agent-user exchange. Outages,
unsupported profiles, mismatched identities and provider failures fail closed,
without application-token fallback.

Envoy executes external authorization before its Lua filter. Every successful
admission therefore overwrites three internal `X-Admission-*` headers, including
empty credentials in app mode. Lua rejects caller `X-Client-*` headers, converts
the verified admission output into request-local runtime headers, and removes
the internal headers and original assertions. Runtime middleware removes all
client identity headers before SDK handling and clears its context afterward.
The release NetworkPolicy remains part of this trust boundary.

From the root, `just graph-identity-check` runs the actual pinned Envoy image,
compiled Go adapter and runtime middleware against fixture identity providers.
Docker must be available with the pinned image pulled, and local ports 8081 and
8083 must be unused. This test does not provision permissions or qualify real
Entra consent, human OBO or agent-user access to Graph.
