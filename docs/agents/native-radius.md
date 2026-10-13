# Native agents with Radius

This fork adds an optional native agent capability alongside the unchanged
trading application. Radius deploys prompt/hosted agents directly; there is no
agent lifecycle operator, Kubernetes agent CRD, Foundry management emulation or
API reconciliation loop. The existing `aiModels` and `agentGuardrails` Radius
types are extended, not registered again under conflicting contracts. Their
trading recipes remain independent of the native-agent environment.

## Ownership and boundaries

| Declaration | Native implementation | Retention |
| --- | --- | --- |
| `agents` | Logical ConfigMap: kind, identity binding and explicit active version | Retained |
| `agentIdentities` | Keycloak client, optional Entra blueprint/principal/Agent ID, Secret, binding ConfigMap and ServiceAccount | Independent protected Terraform state |
| `agentReleases` | Immutable ConfigMap capture; singleton StatefulSet, Service, HTTPRoute, SecurityPolicy, Lua header boundary and NetworkPolicy | Capture and state PVC retained; runtime independently deletable |
| `aiModels` | Gateway configuration; optional CPU/KAITO inference, or remote Azure binding | Weights/cache retained |
| `agentGuardrails` | Immutable native policy ConfigMap | Retained; release captures exact content |
| `agentPlatforms` | Native Helm release through Radius's Terraform executor | Destruction protected |
| `keycloakLogins` | Existing-realm PKCE client and optional reviewed Entra federation | Separate administrator environment |

Native ValidatingAdmissionPolicies keep logical kind/ownership immutable,
prevent a second runtime replica (including the scale subresource), reject
cross-agent identity bindings and prohibit replacing published pod content.
Native names derive from logical UID and explicit version. A second Radius
declaration for the same release encounters the same immutable capture, whose
content includes its Radius resource ID; it cannot create a second state writer.
Do not force-delete a writer or bypass admission. Singleton scheduling is not
distributed fencing or crash recovery.

The agent environment explicitly binds one shared native namespace to logical,
identity, release and model recipes. Radius's application-specific
`context.runtime.kubernetes.namespace` is not this shared namespace. This keeps
independently authored releases, identity federation subjects and diagnostics
on the same contract; application deletion does not own the shared namespace.
Guardrail policy declarations retain their separate application/platform scopes.

Agents retain their existing native Responses-host implementations and OCI
build inputs in `src/agents/{prompt-agent,editor}`. Build these Dockerfiles with
`src` as context; no source/image changes are required for the migration.
The environment supplies identity, model, telemetry and optional governance
sidecars. Prompt MCP/skills, stored/child/background Responses, hosted delegation,
evaluation Jobs and same-image cloud hosting are not qualified by this capability.

Ordinary calls go directly through authorized Envoy ingress to
`POST /agents/{agent}/versions/{version}/responses`. The adapter admits only
foreground plain-text requests with explicit `store=false`, removes browser
assertions before SDK handling and never forwards Responses. Native child,
reference and background operations are denied. All edge model calls and
`GET /v1/models` use authenticated `model-ingress`/LiteLLM, never the diagnostics
API or an inference Pod directly.

The diagnostic API reads retained metadata and current native StatefulSet,
PVC, Gateway, HTTPRoute and authorization-policy conditions. It writes no
agent resource, workload, identity or promotion status. An effective endpoint
requires one ready, current-revision replica, Bound state, current-generation
accepted/programmed ingress and exact capture ownership. Requested promotion
does not make an unready release available; missing selections never fall back.
Monitor reads bounded native Jaeger/Loki records, not manufactured events.

## Delivery

Use an isolated cluster for first qualification. Kubernetes 1.30+ with
ValidatingAdmissionPolicy, a NetworkPolicy-enforcing CNI, Radius, a default
persistent StorageClass and registry/archive access are prerequisites.
The KAITO model variant additionally needs the fork's AI portfolio and suitable
GPU nodes. Installation/downloads are not disconnected operation.

This follows Adaptive Apps' existing split between
[cluster/platform preparation](../../tutorials/getting-started/README.md#2-bring-up-the-platform)
and application-owned Radius declarations. Connected clusters first complete
the existing [Arc preparation guide](../../tutorials/common/prepare-arc.md),
including the actual Kubernetes signer configuration. Do not install two
Keycloak/Envoy owners over the same resources. The native capability chart is
an optional delivery branch, not a claim to implement every `core`/`ent` portfolio.

### Local artifact and executor preparation

Install stock Radius in the selected, trusted cluster using the existing
manual bootstrap pattern. The native ingress uses Envoy, so skip a second
Contour installation:

```bash
rad install kubernetes --skip-contour-install \
  --set global.terraform.version=1.15.8 --timeout 15m
rad version
kubectl get deployments -n radius-system
```

Use the existing Radius workspace/group procedure. A private kubeconfig and
Radius config under ignored `.adaptive/access/` avoid changing another
workspace's context. `radius/prerequisites.yaml` provides stock PVC-backed
artifact/OCI servers and the native executor installer role:

```bash
kubectl apply -f radius/prerequisites.yaml
kubectl -n radius-system rollout status deployment/agent-artifacts --timeout=180s
kubectl -n radius-system rollout status deployment/agent-recipe-registry --timeout=180s
```

The installer role deliberately permits native infrastructure installation in
the development cluster; it is not the diagnostic API's restricted role or a
production least-privilege claim. Its artifact ingress permits only Radius
namespace peers and carries public deployment artifacts, never credentials.
External production registries/archive servers use HTTPS.

Build images through `just --justfile src/Justfile image <component>` with an
explicit `REGISTRY`/`TAG`. A single-node K3s development cluster can import the
selected image using `docker save <image> | sudo k3s ctr -n k8s.io images import -`.
Capture the imported manifest digest for the authored release; do not pass a
mutable image tag. No `agent-operator` image is built or imported.

For the optional private artifact servers, package the chart with
`helm package`, generate its index with `helm repo index`, and copy only public
archives/indexes into the artifact PVC through its nginx Pod. Preserve the
shared Terraform module's relative path in the archive. Publish Bicep recipes
with native `rad bicep publish --plain-http` through a loopback registry
port-forward; enable the environment's explicit `plainHttp=true` only for that
private registry. The Helm recipe accepts HTTP only for a `.svc.cluster.local`
repository; external HTTP is rejected. Verify published archive hashes.

`radius/credentials.bicep` creates the native Radius secret store through
secure parameters. Deliver its inputs from an ignored mode-0600 private
parameter file, never command-line secret literals. Reference its returned ID
from `recipeConfig.envSecrets`:

| Executor | Environment / secret-store bindings |
| --- | --- |
| Agent identity | `KEYCLOAK_URL`, `KEYCLOAK_REALM=master`, `KEYCLOAK_CLIENT_ID=admin-cli`, `KEYCLOAK_USER=admin`; `KEYCLOAK_PASSWORD` from `keycloak-admin-password` |
| Connected identity | Exact `ARM_TENANT_ID`, `ARM_CLIENT_ID`, `ARM_USE_CLI=false`; certificate/password from `graph-client-certificate` / `graph-client-certificate-password` |
| Login administration | `KEYCLOAK_URL`, `KEYCLOAK_REALM=adaptive`, `KEYCLOAK_CLIENT_ID=adaptive-login-config`; `KEYCLOAK_CLIENT_SECRET` from `keycloak-config-client-secret` |

The login executor has a separate environment and credential. Optional Entra
human federation additionally needs its reviewed login-application secret;
that is distinct from agent blueprint federation and the Graph provisioner.

### Authored delivery order

Delivery declarations and recipe implementations have different boundaries:
the former declare Radius resources; the latter are published implementations
selected by an environment. The following is the deployment map, not a second
orchestration layer.

| Authored file | Ownership / published implementation |
| --- | --- |
| `agents-env.bicep` | Environment and recipe bindings |
| `credentials.bicep` | Shared provisioning secret store |
| `agent-platform.bicep` | Shared platform, explicit models and separately owned browser login |
| `agents.bicep` | Logical agent and promotion intent; `recipes/agents/logical.bicep` |
| `agent-identity.bicep` | Independently retained identity; `recipes/identity-{local,connected}` |
| `agent-policy.bicep` | Immutable policy; `recipes/agent-guardrails/native-policy.bicep` |
| `agent-release.bicep` | Explicit immutable release; `recipes/agents/release.bicep` |

Bicep can compose declarations, including multiple separately owned Radius
applications. Keeping these small entrypoints separate makes selective
promotion, identity retention and release retirement explicit. Do not fold
recipe internals into application declarations or make shared identity,
credentials and platform resources owned by a disposable release.

1. Register `radius/resource-types/types.yaml` using
   `rad resource-type create --from-file radius/resource-types/types.yaml`.
   Generate its existing extension:
   `rad bicep publish-extension --from-file radius/resource-types/types.yaml --target radius/types.tgz`.
2. Publish the four native Bicep recipes as `agent-logical`, `agent-release`,
   `agent-model` and `agent-policy`, version `0.2.1`, using `rad bicep publish`.
   Package `charts/agent-platform` with `helm package` and publish it to your
   reviewed OCI repository. These are local delivery commands; no CI/Flux
   dependency is introduced.
3. Publish an immutable Terraform source archive (HTTPS externally) containing `identity`,
   `identity-local`, `identity-connected`, `keycloak-login` and `agents/platform`
   at their existing relative paths, including lockfiles. Keep private provider
   state, `.terraform`, credentials and test artifacts out of that archive.
4. Prepare durable private input files with the existing secret-management process:
   `adaptive-keycloak-admin` (`password`), `adaptive-keycloak-login-config`
   (`client-secret`), `model-gateway-auth` (`master-key` and matching Envoy
   `credential`) and the UI TLS Secret. Do not regenerate existing credentials.
   Give the Radius executor native workload permissions and narrowly scoped
   access to these provisioning secrets. Connected Graph provisioning uses
   dedicated application credentials, not Azure CLI tokens.
5. Deploy `radius/agents-env.bicep` with the OCI recipe registry, archive URL,
   platform bindings, agent executor `recipeConfig` and separate
   `loginRecipeConfig`. Credentials use Radius secret-store references, never
   application parameters. The login environment has a distinct namespace and
   credentials. Local identity is the default; connected provisioning supplies
   `connected=true` plus exact tenant, sponsor, owner and OIDC issuer parameters.
   On a fresh workspace, create this environment before deploying
   `radius/credentials.bicep`; pass its exact resource ID with
   `rad deploy --environment <environment-id> --group <group>`.
   The environment may reference the store before its creation, but create
   the store before any identity/login recipe executes. Native `rad env switch`
   has no `--group` flag; explicit deployment IDs avoid workspace-default ambiguity.
   Create the namespaced prerequisite Secrets after the environment has created
   the shared namespace, before deploying the foundation.
6. Deploy `radius/agent-platform.bicep` with explicit model declarations,
   chart repository/version, browser login environment and platform values.
   This owns the upstream Envoy controller and the agent capability chart
   through Radius. Do not install a second controller/Helm release over an
   existing owned installation.
7. Deploy `radius/agents.bicep`, initially with `activeVersion=''`. Deploy
   `radius/agent-identity.bicep` independently, then update the logical
   declaration's `identityRef` to its returned retained binding.
8. Deploy `radius/agent-release.bicep` with the exact logical name, opaque
   version, immutable image digest and native definition. Wait for the native
   readiness gates and verify direct authenticated invocation. Explicitly
   update `activeVersion` using `radius/agents.bicep` only after qualification.
   Publish subsequent versions as separate applications/resources.
   The capability chart's current version is `0.2.1`; publish a new immutable
   chart version for changes rather than replacing an already published archive.

Platform recipe bindings are `adapterImage`, `sidecarImage`, `governanceImage`,
`keycloakUrl`, `issuer`, `ingressUrl`, `otelEndpoint` and optional explicit
`peers` (`keycloakClientId`, `agentId`, `targets`). Sidecar images must be pinned
digests. `ingressUrl` is the public client origin, not an internal DNS name.
Model-gateway chart values require an exact issuer/JWKS URL and explicit
per-agent Keycloak client allowlist. Connected Azure models use the gateway's
own federated workload identity; no Azure API key is introduced.

UI values include immutable `runtime.uiImage`/`apiImage`, the exact realm issuer,
TLS Secret and `environmentJson` (`name`, optional `description`,
`cloud.enabled`). Build the UI with `VITE_AUTH_ENABLED=true`,
`VITE_KEYCLOAK_AUTHORITY=<exact HTTPS issuer>` and
`VITE_KEYCLOAK_CLIENT_ID=adaptive-ui`. Nginx receives the Pod namespace at runtime;
API, Responses and model traffic retain their separate native ingress boundaries.
Grant approved human users `agent.invoke` through the existing realm process.
Audience claims alone do not grant invocation.

Prompt definitions supply `runtimeImage`, `model`, `instructions` and optional
captured built-in tool objects. Hosted definitions supply `image`, `model` and
application-specific `environment` bindings. Do not override platform identity,
model, state or telemetry environment variables. Radius sampling fields
`temperature`/`top_p` use validated decimal strings because its type catalogue
does not support fractional numbers; the UI receives numeric values.
The editor's writer/auditor URLs must pin concrete releases. Peer grants are
explicit; no discovery, automatic active resolution or replay is added.
Read the peer's actual identity binding before authoring `peers`: in connected
provisioning, `agentId` is the Entra Agent ID GUID mirrored into the Keycloak
`agent_id` claim, not the deterministic Keycloak client-name string.

Optional governance supplies canonical `ProxyConfig` JSON, its SHA-256,
`audit`/`enforce`, and the exact policy reference/content. Use the shipped
`governance_sidecar.contracts` validation/canonicalization rather than inventing
a second policy format. Default-deny policies are enforced by the locked AGT
sidecar without modifying agent code. Unsupported policies fail readiness;
the catalogue alone is not proof of runtime enforcement.

Deploy policies independently through `radius/agent-policy.bicep`, passing
`environment`, `policyName`, canonical `policyContent` and `policyDigest`.
`PolicyDefinition.canonical()` produces the content; compute its SHA-256 from
the exact UTF-8 bytes. The qualified development policy is:

```json
{
  "policies": [{
    "apiVersion": "governance.toolkit/v1",
    "name": "demo-model-boundary",
    "default_action": "deny",
    "rules": [
      {"name": "deny-pii", "stage": "pre_input", "condition": "pii == 'detected'", "action": "deny"},
      {"name": "deny-injection", "stage": "pre_input", "condition": "prompt_injection == 'detected'", "action": "deny"},
      {"name": "local-model", "stage": "pre_input", "condition": "resource == 'local-chat'", "action": "allow"}
    ]
  }]
}
```

Use the resulting native reference, `<namespace>/<configmap>@sha256:<digest>`,
with `PolicySnapshot`, `compose_bundle` and `ProxyConfig` to capture the
release's exact proxy configuration and digest. ConfigMap names are opaque
lowercase Radius names; only the SHA-256 suffix is hexadecimal. The retained
custom sidecar supplies the transparent OpenAI/SSE bridge; detection and policy
evaluation use upstream AGT. The prebuilt AGT detection HTTP server is not a
drop-in transparent proxy for unchanged agent images.

### Local browser access and users

For the single-host development configuration, discover the stock Envoy
Service and forward only loopback ports:

```bash
service=$(kubectl -n envoy-gateway-system get services \
  -l gateway.envoyproxy.io/owning-gateway-name=ui-ingress,gateway.envoyproxy.io/owning-gateway-namespace=adaptive \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n envoy-gateway-system port-forward --address 127.0.0.1 \
  "service/$service" 8443:8443 8444:8444
```

The UI is `https://localhost:8443`; Keycloak is `https://localhost:8444`.
Trust the declared TLS certificate, which must contain the public host SAN.
For command-line checks, use
`curl --cacert .adaptive/private/ui-tls.crt https://localhost:8443/healthz`.
Browser qualification uses a scoped development trust store, not
`ignoreHTTPSErrors`, disabled certificate verification or global trust changes.

The Keycloak administrator console is `https://localhost:8444/admin/`.
Sign into the `master` realm as `admin` using the durable private administrator
password (`.adaptive/private/keycloak-admin-password` in the qualified demo).
In the `adaptive` realm, create approved development users, set permanent
passwords and assign the realm role `agent.invoke`. Ensure that role exists;
do not grant administrator roles to ordinary users. The qualified users are
`alice` and `bob`; their generated passwords are recorded only in the
mode-0600 `.adaptive/private/demo-users.json`. Reuse existing users/passwords;
do not regenerate credentials to repeat setup.

Use the UI's Sign in action and authorization-code PKCE. Do not enable password
grants on `adaptive-ui`. Browser model discovery uses `/models/v1/models`,
rewritten to the gateway's `/v1/models`; `/v1/models` on the browser origin is
not a model discovery wrapper. Native agent calls pin
`/agents/{name}/versions/{version}/responses` and send `store: false`.
Stored/background/reference operations remain denied. Monitor uses
authenticated streaming fetch at `/v1/agents/{name}/spans`.

### Promotion and retirement qualification

For a logical `writer`, Radius applications are `writer-logical`,
`writer-identity` and one `writer-<version>` per release. Author a subsequent
release as a new explicit `version` with the unchanged image digest; do not
edit the prior release declaration. Wait for singleton workload/PVC and
current-generation native route/policy readiness, then invoke its exact
endpoint before separately updating `agents.bicep` with `activeVersion`.
Preserve the existing `identityRef` when updating promotion intent.

Test an unavailable selection without accepting an earlier version as a
fallback. A nonexistent selected release makes the diagnostic agent lookup
return 404; it does not construct a v1 endpoint. Restore the intended ready
selection before retiring a test release.

Retire only its application, for example
`rad app delete writer-v3 --group adaptive --yes`. Wait for graceful Pod
deletion; do not force-delete or scale another writer. Before and after
retirement, record the exact capture/PVC and logical/identity UIDs. The runtime
and version routes must disappear while immutable capture, PVC, logical agent,
identity, realm, shared models and other agents remain. Retained captures/PVCs
are intentional state, not orphan cleanup candidates; purge requires a separate
explicit authorized operation.

## Connectivity and the demo button

Connectivity is not deployment mode. In-cluster DAC bindings always obtain
paired Keycloak application tokens, including while Azure is reachable.
Cloud-only and delegated Graph calls use Entra and fail explicitly on outage;
denials/timeouts never substitute a local or application actor.

The UI button calls strict `GET/PATCH /v1/connectivity-fault`. The only write
patches `demo-cloud-egress` with optimistic concurrency, validating its exact
label, selector and rules. Enabling the fault removes public HTTPS egress from
selected agents/model gateway. Baseline policies retain local identity,
gateway, telemetry and DNS access. No Pod restart, identity reconfiguration,
login-provider toggle, global mode ConfigMap or turn replay occurs.

NetworkPolicies are additive: another public-egress grant defeats this
injection. The reported value is fault configuration, not WAN reachability,
completed CNI enforcement, cached-token revocation or termination of established
connections. Hybrid-model transport fallback remains unqualified; broad retries
that also retry permission denials are intentionally not enabled.

Qualification must verify actual cloud HTTPS loss, not just the button value.
Request an unused cloud audience during the fault to test a cold token mint,
exercise fresh local PKCE login and prompt/hosted calls, then restore the fault
in guaranteed cleanup and prove cloud minting recovers. Record selected Pod
UIDs/restart counts before and after. A cached, still-valid Graph token can
remain available during the outage; this is not new cloud minting or a local
actor fallback. Established connections and all cache-expiry behavior are not
qualified by this test.

Connected identity qualification uses the official sidecar's
`/AuthorizationHeaderUnauthenticated/qualification` endpoint on localhost,
with query overrides `AgentIdentity=<actual-agent-id>`,
`optionsOverride.Scopes=https://graph.microsoft.com/.default` and
`optionsOverride.RequestAppToken=true`. Keep the blueprint assertion confined
to the sidecar. Never publish or persist the returned bearer.
Microsoft-owned access tokens are opaque to clients: validation belongs to
the target API, not a generic local JWT verifier
([Microsoft access-token guidance](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens)).
The qualified app token is accepted by Graph's authentication boundary and
denied on delegated-only `/me`; decoded actor claims are diagnostic evidence,
not a replacement authorization check. Cognitive Services cold-mint recovery
proves token issuance only, not access to a configured cloud model.

## Verification status

Source validation covers native recipe/application compilation (including the
unchanged trading application), chart rendering, paired identity Terraform
tests, SDK/sidecar regressions, actual nginx template substitution/configuration
validation and diagnostic API/UI tests.
Run `python3 radius/tests/native_agents.py` (PyYAML and Bicep/Helm required),
`just --justfile src/Justfile lint`, `test` and `build`; run `terraform test`
from the individual initialized identity/login recipe directories.

On 2026-10-13, the explicitly scoped old host demo cluster was wiped and a fresh
K3s datastore/cluster UID established without restoring its old PVCs or lifecycle
operator. Trusted server admission dry-run, stock DNS/storage, Radius installation
and fresh Arc onboarding passed. The Kubernetes signer matches the exact Arc
HTTPS discovery issuer and its public JWKS was verified. OIDC and workload
identity are enabled; the official webhook is ready. All six current native
images were built/imported, with no operator image.

The fresh native foundation and writer/auditor prompt plus hosted editor v1
releases are qualified. Both local users completed real PKCE and browser login,
gateway model discovery, direct native foreground invocation and SSE.
The hosted editor called pinned writer/auditor v1 peers. Captured AGT policy
allowed normal calls and denied the PII/injection fixtures; stored/background/
reference operations were denied. Monitor returned actual SDK spans and a
trace-correlated `guardrail.decision` log, not only heartbeats.

All three official Entra sidecars completed autonomous exact-agent Graph
exchanges; Graph validated the tokens and denied delegated-only access.
Assertions remained absent from agent containers. Real cloud HTTPS loss,
uncached Cognitive Services mint failure, fresh local login, local agent
continuity and recovered cloud minting passed with unchanged selected Pod UIDs
and restart counts. The fault was restored to off.

Separate writer v2/v3 releases were invoked, explicitly selected and retired;
missing selection returned 404 without fallback. The final selection is v1.
The v3 test persisted exact before/after capture/PVC UIDs and proved logical
identity and other agents unchanged. Retired endpoints returned 404; retained
v2/v3 capture/state remains. Server admission dry-runs accepted valid updates
and rejected replica two, duplicate platform environment bindings and logical
type changes. Chart `0.2.1` fixes optional `AdmissionRequest.subResource`
handling and matches CREATE requests through object metadata.

Evidence is under `.adaptive/diagnostics/` in `native-invocation.json`,
`native-browser.json`, `native-monitor.json`, `entra-sidecar-exchange.json`,
`native-outage.json`, `native-lifecycle{,-before}.json` and `admission-*.txt`.
Radius deployment/retirement logs are under rebuildable `build/bootstrap/`.
Private user passwords/tokens and provisioning inputs are not evidence to
publish. Session-only qualification helpers are not an installation dependency.

No existing installation ownership handover was performed. Restart fencing,
SDK stored-state caller isolation and durable telemetry replay remain separate
gates. Six existing SDK isolation tests remain expected failures; denied stored
Responses must not be exposed. Cloud-model inference/UAMI authorization,
human Entra federation/OBO, evaluation Jobs and same-image cloud hosting remain
unqualified; this local demo does not complete those capabilities.
