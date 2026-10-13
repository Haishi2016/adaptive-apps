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
| `aiModels` | Gateway configuration; KAITO/vLLM inference, existing inference Service, remote Foundry binding or virtual priority group | Weights/cache retained |
| `agentGuardrails` | Immutable native policy ConfigMap | Retained; release captures exact content |
| `keycloakLogins` | Existing-realm PKCE client and optional reviewed Entra federation | Separate administrator environment |

The portfolio Helm release owns the additive native capability, shared
PostgreSQL-backed Keycloak and one OTel Collector. A stock Helm release owns
the upstream Envoy controller. Radius owns application models, login clients,
logical agents, retained identities and explicit releases, not either Helm
release. Superseded native H2/Keycloak, collector and platform Terraform
implementations have been removed.

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

Use an isolated cluster for first qualification. Kubernetes 1.33+ with
ValidatingAdmissionPolicy, a NetworkPolicy-enforcing CNI, Radius, a default
persistent StorageClass and registry/archive access are prerequisites.
The KAITO model variant additionally needs the fork's AI portfolio and suitable
GPU nodes. Installation/downloads are not disconnected operation.

This follows Adaptive Apps' existing split between
[cluster/platform preparation](../../tutorials/getting-started/README.md#2-bring-up-the-platform)
and application-owned Radius declarations. Connected clusters first complete
the existing [Arc preparation guide](../../tutorials/common/prepare-arc.md),
including the actual Kubernetes signer configuration. Do not install two
Keycloak/Envoy owners over the same resources. The native capability is
`min-ai` plus an additive application feature, not a seventh portfolio or a
claim to qualify every `core`/`ent` gate.

### Local artifact and executor preparation

Install stock Envoy **before Radius** on a fresh cluster. Envoy v1.9.2 ships
Gateway API v1.6.1; Radius 0.61 otherwise installs v1.4.0 CRDs first.
Do not force conflicting CRD ownership or run another CRD installation over
provider-managed incompatible resources. The CLI fails that preflight.
For a provider-managed compatible Gateway API installation, follow the
[upstream separate-CRD installation](https://gateway.envoyproxy.io/docs/install/install-helm/)
and [compatibility matrix](https://gateway.envoyproxy.io/news/releases/matrix/).

```bash
helm upgrade --install adaptive-envoy oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.2 -n envoy-gateway-system --create-namespace \
  --set config.envoyGateway.extensionApis.enableLua=true --wait --timeout 10m
```

Then install stock Radius using the existing manual bootstrap pattern, without
a second Contour installation:

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

When isolating Radius with a custom `HOME`, its workspace command also needs
the selected kubeconfig at `$HOME/.kube/config` and Bicep in `$HOME/.rad/bin`;
`KUBECONFIG` alone is insufficient for that stock command. Copy the selected
existing kubeconfig, never regenerate credentials.

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

For the optional private artifact servers, copy only public Terraform archives
into the artifact PVC through its nginx Pod. Preserve the shared Terraform
module's relative path:

```bash
mkdir -p build/bootstrap
tar --exclude=.terraform --exclude='*.tfstate*' --exclude=.test-artifacts \
  -czf build/bootstrap/recipes.tgz -C radius/recipes \
  identity identity-local identity-connected keycloak-login
sha256sum build/bootstrap/recipes.tgz
```

Use that hash as the immutable artifact-server directory; verify the downloaded
archive against it. Publish Bicep recipes
with native `rad bicep publish --plain-http` through a loopback registry
port-forward; enable the environment's explicit `plainHttp=true` only for that
private registry. Build the portfolio dependency with
`helm dependency build charts/adaptive-apps --skip-refresh`; install/package
only that parent chart. There is no native platform Helm recipe.

`radius/credentials.bicep` creates the native Radius secret store through
secure parameters. Deliver its inputs from an ignored mode-0600 private
parameter file, never command-line secret literals. Reference its returned ID
from `recipeConfig.envSecrets`.

Local setup writes only the two Keycloak keys. Graph certificate/password
parameters are optional and omitted from the store unless a reviewed
certificate is supplied. Connected setup requires both nonempty credential
files; no placeholder cloud credentials are generated.

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
| `agent-services.bicep` | Explicit models and separately owned browser login |
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
2. Publish `agent-logical` at `0.4.0`, and `agent-release` and `agent-policy` at `0.3.0`,
   and `agent-model` at `0.4.0`, using `rad bicep publish`.
   Their files are `recipes/agents/{logical,release}.bicep`,
   `recipes/ai-agent/native-gateway.bicep` and
   `recipes/agent-guardrails/native-policy.bicep`. Use the loopback registry
   address for publication, but the cluster-local address in environment
   bindings. These are local commands; CI is optional.
3. Publish an immutable Terraform source archive (HTTPS externally) containing `identity`,
   `identity-local`, `identity-connected` and `keycloak-login`
   at their existing relative paths, including lockfiles. Keep private provider
   state, `.terraform`, credentials and test artifacts out of that archive.
4. Copy `radius/agents.example.json` to a public reviewed configuration, replace
   its archive placeholder and select imported immutable images. Run
   `ada init --agents-config agents.json --namespace <namespace> --release <release>`.
   This creates missing durable private inputs without AI: administrator,
   database and service credentials, validated localhost TLS, secure Radius
   parameters, portfolio values and native Secret declarations. Existing
   credentials are reused; mismatching generated inputs fail for explicit review.
   Secrets are `adaptive-keycloak-admin` (`username`, `password`), `adaptive-keycloak-login-config`
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
   Create the namespace/Secrets before the portfolio install.
6. Use the [Getting Started native CLI/manual path](../../tutorials/getting-started/README.md#native-agent-application-choice).
   It installs stock Envoy v1.9.2 with Lua enabled before the parent portfolio
   chart, waits for the shared Keycloak realm, then deploys
   `radius/agent-services.bicep`. The initial Helm install does not wait for
   model configuration that the subsequent Radius application creates;
   final rollout validation happens after that declaration. The chart is
   `adaptive-apps` 0.2.0 with the `agent-platform` 0.3.0 dependency.
   `ada oidc demo-users` optionally creates `alice`/`bob` with only the API
   client invocation role. Native UI clients remain Terraform-owned; the
   existing confidential trading client is separate.
7. Deploy `radius/agents.bicep`, initially with `activeVersion=''`. Deploy
   `radius/agent-identity.bicep` independently, then update the logical
   declaration's `identityRef` to its returned retained binding.
8. Deploy `radius/agent-release.bicep` with the exact logical name, opaque
   version, immutable image digest and native definition. Wait for the native
   readiness gates and verify direct authenticated invocation. Explicitly
   update `activeVersion` using `radius/agents.bicep` only after qualification.
   Publish subsequent versions as separate applications/resources.
   Publish a new immutable chart/recipe version for changes rather than
   replacing an already published archive.

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
Grant approved human users the `adaptive-platform-api` client role `agent.invoke`.
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
  -l "gateway.envoyproxy.io/owning-gateway-name=ui-ingress,gateway.envoyproxy.io/owning-gateway-namespace=$NAMESPACE" \
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
passwords and assign the **client role** `agent.invoke` on
`adaptive-platform-api` (Users -> Role mapping -> Filter by clients). The login
recipe creates that role; `ada oidc demo-users --namespace "$NAMESPACE"
--release "$RELEASE"` performs this optional demo setup automatically.
Do not grant administrator roles to ordinary users. The qualified users are
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

## Models

Native setup requires explicit model declarations, not an implicit CPU server.
Reuse [GPU preparation](../../tutorials/common/prepare-gpu-kaito.md), the existing
`Radius.Resources/aiModels` type and the pinned LiteLLM gateway:

| Binding | Implementation |
| --- | --- |
| `localWorkspace` | KAITO custom Workspace, pinned vLLM image/model revision, NVIDIA runtime and retained HF cache |
| `localService` | An existing compatible inference Service; no runtime or CPU provisioning |
| `azure` | Foundry-hosted OpenAI deployment with gateway workload identity |
| `members` | Captured backend configurations with native LiteLLM `order` and `weight` |

`radius/agents.example.json` selects Qwen3-0.6B on a real GPU. The small serving
profile is not evidence of production quality or delegated-tool support.
For separately authored delivery, `radius/agent-models.bicep` declares local,
optional Foundry and hybrid resources; its hybrid uses primary resources'
actual `deployments` outputs rather than another provider-config implementation.
`localName` identifies the Radius/KAITO resource; `localModel` can preserve an
existing public model alias without changing agent artifacts.
Mount the chosen model ConfigMaps in the portfolio's
`agents.modelGateway.configs`, with their returned `configDigest` values.
ConfigMap projection alone does not reload LiteLLM: refresh the owning portfolio
release with reviewed changed digests after model delivery. Do not patch Pods or
independently Helm-install over a Radius-owned release.

### Foundry workload identity

Foundry authentication belongs to the gateway, not an agent blueprint, browser
bearer or Graph provisioner. The public CLI configuration is:

```json
{
  "modelGatewayIdentity": {"clientId": "<gateway-UAMI-client-id>", "tenantId": "<tenant-id>"},
  "models": [{
    "name": "foundry-chat",
    "properties": {
      "model": "foundry-chat",
      "azure": {
        "provider": "azure",
        "endpoint": "https://<account>.cognitiveservices.azure.com/",
        "deployment": "<existing-OpenAI-deployment>",
        "apiVersion": "2024-10-21"
      }
    }
  }]
}
```

Merge these fields into the full reviewed agents configuration. Grant the
gateway managed identity scoped inference access on that Foundry account, for
example **Cognitive Services OpenAI User**. Its federated credential must match
the cluster's actual HTTPS OIDC signer, subject
`system:serviceaccount:<namespace>:model-gateway` and audience
`api://AzureADTokenExchange`. Follow the existing Arc/OIDC preparation; an
unconnected k3d cluster cannot borrow another cluster's signer. Preserve other
owners' federated credentials and logical Agent IDs.

The chart projects a renewable Kubernetes assertion only into LiteLLM and selects
`WorkloadIdentityCredential`; it does not require a webhook, Azure API key or
client secret for this gateway. The traditional LiteLLM `azure` provider uses
the Cognitive Services token audience. This is distinct from Foundry's newer
`/openai/v1` SDK examples using `https://ai.azure.com/.default`; do not mix the
provider, endpoint and audience contracts.
See [Microsoft's keyless inference guidance](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/managed-identity).
Only claim connected cloud inference after the actual gateway can invoke the
configured deployment with its own identity.

### Priority, fallback and weights

Lower `priority` becomes lower native LiteLLM `order` and is preferred. Equal
orders use relative `weight`; higher orders provide fallback. The pinned
LiteLLM 1.104.2 router can advance orders despite zero general retries. Its
native fallback includes upstream authentication/permission errors, not only
transport failures; content-policy/context errors have separate handling.
Caller authorization still happens at Envoy before the gateway and cannot be
bypassed by provider fallback.

Choose local-first or cloud-first explicitly through the authored priorities.
Cloud-only aliases fail when cloud access is unavailable; hybrid aliases may use
their configured reachable local member. Verify actual upstream failure,
primary selection, streaming and recovery before claiming fallback qualification.
Do not replay output already emitted or represent upstream denial fallback as
transport-only policy.

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
connections. Hybrid fallback uses the native semantics documented above, not a
custom transport-only router. Zero general retries does not disable native
order-based fallback after upstream permission errors.

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

The following dated evidence qualified the prior Radius-owned standalone
foundation, not the shared portfolio/CLI integration. Requalify the new path
before treating these results as its deployment evidence.

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
Responses must not be exposed. Human Entra federation/OBO, evaluation Jobs and
same-image cloud hosting remain separate gates; the later model evidence below
does not qualify those capabilities.

### GPU, keyless Foundry models and login evidence

Later on 2026-10-13, the existing host cluster exposed one real RTX 3090 GPU.
Stock KAITO 0.10.0 deployed pinned Qwen3-0.6B through Radius; the retained cache,
actual GPU allocation and recreated desired serving arguments were verified.
The CPU model was retired through Radius in both the host and isolated setup
proof; only its obsolete weight PVCs were removed.

The existing gateway's Radius owner deployed the corrected multi-model chart,
without a platform ownership handover or identity/credential regeneration.
The chart regression fixes router settings accidentally rendered inside the
model include loop. An exact current-cluster federation was added to the
reviewed gateway identity without replacing its previous federation.
Real Foundry `gpt-4o-mini` inference uses renewable
`WorkloadIdentityCredential`, not an Azure API key.

Gateway provenance headers verified local-first hybrid selection. Stopping the
actual KAITO workload produced Foundry fallback for ordinary and streaming
requests; KAITO recovered with unchanged Workspace/cache UIDs. Local, Foundry
and hybrid SSE all reached `[DONE]`. Unchanged prompt/hosted releases and pinned
peer calls passed for both local users, including native Responses streaming
and stored/background/reference/guardrail denials.

Both Alice and Bob passed trusted-browser PKCE login. Their original and
isolated-proof password files differ; restored localhost forwarding selects the
original demo and its `.adaptive/private/demo-users.json`. Neither account was
disabled or locked, and no password reset was needed.

Evidence is in `.adaptive/diagnostics/native-model-proof.json`,
`native-model-fallback.json`, `native-invocation.json` and `native-browser.json`.
Seven native compilation/render checks, CLI tests/clippy, chart lint and GPU
helper shell syntax passed. The isolated shared-portfolio browser proof remains
separate from the original foundation; its Monitor hierarchy check is not yet
qualified.

Read-only Jaeger inspection later on 2026-10-13 confirmed that the shared
collector receives actual SDK spans under the correct release service names.
Prompt traces contain `invoke_agent writer` with a child `chat local-chat`, and
hosted-to-prompt calls preserve the trace and parent IDs. They do not contain
the required intermediate `agent_run` span. This is a native instrumentation
shape gap, not absent collector delivery; do not manufacture or rename spans
to pass the gate. The min-ai collector also has no metrics pipeline, while
the image's SDK emits metrics, producing explicit HTTP 404 export errors.
After CPU-model retirement, the isolated setup's old gateway configuration
still references the removed CPU backend; it is not a currently qualified
inference installation. The host cluster's GPU/Foundry proof remains separate.

## Pending Foundry 1:1 agent-hosting proof

**Status: initial-deployment source implemented and tested, not live-qualified.**
Track this separately from calling Foundry models through the edge gateway.
The cloud gate currently covers native deployment, not unchanged editor peer
invocation or a complete multi-release cloud lifecycle.

`radius/recipes/foundry-release` is a stock Terraform recipe using pinned
AzAPI 2.9.0 and the native data-plane type `Microsoft.Foundry/agents@v1`.
`radius/foundry-env.bicep` binds it to the existing
`Radius.Resources/agentReleases` type; `radius/foundry-agent.bicep` authors the
logical metadata and first release. There is no operator, management emulator,
image build or invocation proxy.

Dispatch remains **prompt → native Foundry prompt agent** and
**hosted → native Foundry hosted agent**. Prompt instructions/model/sampling
become a prompt definition; the edge `runtimeImage` is not deployed.
Hosted images must use an ACR URL retaining the original SHA-256 manifest
digest and Responses container protocol 2.0.0.
`binding: null` explicitly selects native Foundry identity instead of fake edge
Secret/ServiceAccount references. Foundry manages the cloud blueprint and
agent identity; the project identity pulls the image, and the native runtime
identity receives required downstream permissions. `nativeIdentity` returns
the actual provider client/principal and blueprint IDs, not edge identity
substitutes. The logical recipe's explicit cloud mode omits the edge
`radius.identity.id` annotation rather than referencing a nonexistent identity
resource.

### Initial-deployment ownership limitation

AzAPI manages one **named agent**, not an independently owned resource per
native version. Therefore this recipe is deliberately limited to one explicitly
configured initial Radius release ID and canonical `<agent>-<release>` resource
name per logical agent. An immutable Terraform capture rejects changed
definitions, bindings or target configuration; other release IDs are rejected
before a provider operation. The native version must be `1`, and its concrete
identifier is returned separately from the Radius release label.
The native name includes a hash of the retained logical UID, not the release
label; it is returned as `nativeName`. This avoids adopting unrelated existing
agents that happen to share a display name. Use new proof-only logical names
and one deployment owner. Do not import/adopt existing
agents, run another writer, or interpret Terraform locking as distributed
fencing.

Both capture and native agent use `prevent_destroy`: application deletion must
fail rather than delete the agent, identity and retained versions. Cloud
retirement, additional versions and promotion require a separately implemented
and qualified lifecycle. The recipe's endpoint output is a native URL, not a
readiness assertion; provider write success does not prove `active`, effective
guardrails or successful invocation.

### Current Responses routing difference

Both images use native Responses hosts and serve `/responses`. Public routing
differs:

| Target | Public Responses path | Version selection |
| --- | --- | --- |
| Edge Envoy | `/agents/{name}/versions/{version}/responses` | Explicit URL version |
| Foundry | `/api/projects/{project}/agents/{name}/endpoint/protocols/openai/responses` | Native endpoint selector; candidate-specific session |

The unchanged editor validates an exact edge-style peer base path in
`src/agents/editor/src/editor/agent.py` before sending a request. It rejects
native Foundry project-prefixed endpoints, and it does not create/pass a native
candidate session. Deployment of the same image can be tested without claiming
that its writer/auditor calls work in Foundry. Do not hide this limitation with
an Envoy compatibility route or silently rebuild the image.

### Source delivery and remaining live gate

The environment requires an explicitly selected existing `projectEndpoint`,
existing full `raiPolicyId`, `initialReleaseId`, published `logicalRecipe`,
immutable `releaseRecipe` archive and native Azure `recipeConfig` credentials.
No project or registry is chosen or provisioned automatically. Use the existing
Radius credential-store/workload-identity patterns; no browser bearer or Azure
API key belongs in these parameters.

Publish the updated logical Bicep recipe as `agent-logical:0.4.0` through the
existing native artifact path; never overwrite its earlier immutable tag.
Include `foundry-release` and its reviewed `.terraform.lock.hcl` in the immutable
Terraform archive, excluding `.terraform`, test files and state. Point
`releaseRecipe` to `<immutable-archive-url>//foundry-release`.
Deliver the environment once, then the authored agent declaration:

```bash
rad deploy radius/foundry-env.bicep \
  --parameters .adaptive/private/foundry-env.parameters.json
rad deploy radius/foundry-agent.bicep \
  --parameters .adaptive/private/foundry-prompt.parameters.json
rad deploy radius/foundry-agent.bicep \
  --parameters .adaptive/private/foundry-hosted.parameters.json
```

The private parameter files are explicit authored inputs, not generated
installation defaults. A prompt `definition` has `kind: prompt`, the selected
native model deployment and matching instructions. A hosted `definition` has
`kind: hosted`, its unchanged ACR image digest, the required `model` contract
field and reviewed native environment bindings. Nonempty tools, edge governance,
PVC state, edge resource settings, prompt container environment and
platform-reserved identity variables fail explicitly. The existing native RAI
policy is used; tool/skill parity and Graph OBO remain unqualified.

Eight Radius compilation/chart checks and ten mocked Terraform lifecycle
checks cover dispatch, digest preservation, replay, immutable input rejection,
extra release rejection, unexpected native versions, edge-binding rejection,
untrusted project URLs, foreign guardrails and invalid sandbox sizes.
Mocks and rendered files are not live proof.

Current contract references:
[native Terraform deployment](https://learn.microsoft.com/azure/foundry/agents/how-to/deploy-hosted-agent-terraform),
[runtime contract](https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agent-contract),
[native identity and endpoint migration](https://learn.microsoft.com/azure/foundry/agents/how-to/migrate-hosted-agent-preview),
and [endpoint/version management](https://learn.microsoft.com/azure/foundry/agents/how-to/manage-hosted-agent).

1. Verify the current Foundry native prompt and hosted-version APIs, Responses
   support, identity/blueprint support and cloud model/peer bindings. Preserve
   prompt instructions, model selection and supported tool/skill content;
   explicitly flag unsupported features rather than silently dropping them.
   Establish idempotent explicit-release mapping and pin native endpoint
   routing so creating a candidate cannot silently promote it.
2. Select an explicitly approved Foundry project, region, registry, identities
   and billing/compute scope. Mirror the existing hosted editor OCI image with
   an **identical manifest digest**, without rebuilding; verify registry pull
   and inference permissions. The prompt runtime image remains edge-only.
3. Qualify the initial cloud recipe and required target bindings. Supply
   native cloud DAC/configuration rather than edge Keycloak/adapter endpoints,
   sidecars or PVC paths. Replaying identical desired state must not allocate
   another version or replace a logical identity. Additional release ownership,
   promotion and retirement are separate from this initial-deployment proof.
4. Deploy **both native Foundry kinds**. Verify the prompt resource
   really has prompt kind and matching supported definition content, and the
   hosted resource uses the unchanged OCI digest. Verify provider provenance,
   active concrete versions and real native identity. Test prompt foreground
   Responses/SSE and model access. Record unchanged editor peer invocation as
   unqualified because of its URL/session assumptions. Preserve unrelated
   projects and record sanitized evidence in the existing guides. Do not claim
   retirement, promotion, tool/skill/OBO or full multi-release portability from
   a successful initial deployment.

The portability gates differ by kind: **prompt agents require native kind and
definition/content parity; hosted agents require unchanged image-digest parity**.
A native Foundry prompt agent has no user-supplied OCI image. The edge
prompt-runtime container is an edge implementation detail, not the cloud
deployment artifact.
