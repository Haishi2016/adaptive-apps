# Radius Deployment Guide — adaptive-apps

This directory contains the Radius application assets for the trading sample
and native prompt/hosted agents. Shared infrastructure is the portfolio Helm
chart; applications do not deploy another Keycloak.

The optional [native agent capability](../docs/agents/native-radius.md) uses
`agents-env.bicep`, `agent-services.bicep`, and opt-in declarations in
`app.bicep`. The reusable `agents.bicep` and advanced `agent-identity.bicep`
remain available for non-trading applications. The trading application
deployment creates separately owned retained identities and mutable runtimes
together. These deploy native resources,
not an agent operator or lifecycle CRDs. The trading application remains unchanged.
`agent-models.bicep` provides separately owned KAITO/vLLM and Foundry model
backends plus a priority-based `aiGateways` declaration using their actual outputs.
Foundry **agent hosting** has a source-tested
[initial-deployment recipe](../docs/agents/native-radius.md#pending-foundry-11-agent-hosting-proof):
`foundry-env.bicep`, `foundry-agent.bicep` and `recipes/foundry-agent`.
It deploys native prompt/hosted kinds, not a hosted prompt-runtime substitute.
Live proof and unchanged editor peer invocation
remain unqualified; the guide documents the current Foundry routing difference.
Connected clusters use the existing [Arc preparation guide](../tutorials/common/prepare-arc.md)
before Radius/application deployment. Use the shared CLI/manual
[Getting Started](../tutorials/getting-started/README.md) flow.
Native artifact/executor prerequisites
and secure credential-store delivery are documented in the agent capability
guide; they are not a second agent lifecycle installer.

```
radius/
├── app.bicep                          # Radius application model (set aiProvider=local to enable AI agent via Recipe)
├── local-env.bicep                    # Environment for local k3s (Kaito AI recipe)
├── aks-env.bicep                      # Environment for AKS / Azure (Azure OpenAI recipe)
├── bicepconfig.json                   # Bicep extension references
├── resource-types/
│   └── types.yaml                     # All custom types under Radius.Resources
└── recipes/
    ├── postgres/
    │   └── kubernetes-trading-postgres.bicep   # PostgreSQL 16 + trading schema
    ├── mqtt/
    │   └── kubernetes-mosquitto.bicep          # Eclipse Mosquitto 2 (MQTT + WS)
    └── ai-agent/
        ├── kubernetes-kaito.bicep              # Kaito LLM (local/AKS + GPU)
        └── azure-openai.bicep                  # Azure OpenAI account + deployment
```

---

## Prerequisites

| Tool | Install |
|------|---------|
| `rad` CLI | https://docs.radapp.io/installation/ |
| `kubectl` | https://kubernetes.io/docs/tasks/tools/ |
| A running Kubernetes cluster | [k3d](https://k3d.io) recommended for local dev |
| Access to GHCR images | Ensure your cluster can pull from `ghcr.io/microsoft/adaptive-apps` (or set `imageRegistry`/`imageTag` to your own published images) |
| `az bicep` / Bicep CLI | https://learn.microsoft.com/azure/azure-resource-manager/bicep/install |

---

## Step 1 — Install Radius on your cluster

```bash
rad install kubernetes
```

Verify:

```bash
rad version
kubectl get pods -n radius-system
```

---

## Step 2 — Register the Resource Types

Radius needs to know about the custom portable resource types before they can be
referenced in `app.bicep`. All types are defined in the single `types.yaml` file
and can be registered with one command:

```bash
cd radius/

rad resource-type create --from-file resource-types/types.yaml
```

---

## Step 3 — Generate the Bicep extension

Bicep needs type information to validate and auto-complete the custom resource
types. A single bundle is generated from the consolidated `types.yaml` and covers
the unified namespace (`Radius.Resources`):

```bash
cd radius/

rad bicep publish-extension --from-file resource-types/types.yaml --target types.tgz
```

> **Note:** `bicepconfig.json` references `types.tgz` via the single `radiusResources` extension.

---

## Step 4 — Create the group, workspace, and Environment

Create a dedicated Kubernetes namespace, Radius group, and workspace. The
Environment itself — including all Recipe registrations — is created
declaratively by deploying `local-env.bicep` in the next step.

```bash
kubectl create namespace trading

rad group create trading
rad workspace create kubernetes trading \
  --group trading \
  --context $(kubectl config current-context)
```

---

## Step 5 — Deploy the Environment

Deploy `local-env.bicep` to create the Radius Environment and register all
Recipes in one step. Recipes are pre-published to GHCR by the CI pipeline
([`.github/workflows/publish-recipes.yml`](../.github/workflows/publish-recipes.yml))
— no manual publishing required.

```bash
cd radius/

rad deploy local-env.bicep --group trading
```

Verify the environment and its recipes:

```bash
rad environment show trading
rad recipe list --environment trading
```

> **AKS / Azure deployments** use `aks-env.bicep` instead — see
> [Deploying to Azure](#deploying-to-azure) below.

---

## Step 6 — Identify your deployment parameters

Container images are built and published by CI
([`.github/workflows/build-and-publish.yml`](../.github/workflows/build-and-publish.yml)),
so you can use the default registry/tag values unless you intentionally override them.

Gather the values you will pass on the command line in Step 7 (`authPassword` is the only required value without a default):

| Parameter | Description | Local dev default |
|-----------|-------------|-------------------|
| `imageRegistry` | Container registry prefix | `ghcr.io/microsoft/adaptive-apps` |
| `authPassword` | Password for the local frontend login | *(required — no default)* |

---

## Step 7 — Deploy the application (without AI)

```bash
cd radius/
rad deploy app.bicep --group trading --environment trading --parameters imageRegistry=ghcr.io/microsoft/adaptive-apps --parameters imageTag=latest --parameters authUsername=admin --parameters authPassword=<your-password>
```

This single command:
1. Runs the PostgreSQL Recipe → deploys Postgres + seeds the trading schema
2. Runs the Mosquitto Recipe → deploys the MQTT broker
3. Deploys the `backend` and `frontend` containers with all
   environment variables wired up from the Recipe outputs
4. The frontend proxies all browser traffic to backend and MQTT
   — only port 3000 needs to be exposed

### Optional: deploy with AI agent enabled

```bash
cd radius/
rad deploy app.bicep --group trading --environment trading --parameters imageRegistry=ghcr.io/microsoft/adaptive-apps --parameters imageTag=latest --parameters authUsername=admin --parameters authPassword=<your-password> --parameters aiProvider=local --parameters aiModel=qwen2.5-coder-7b-instruct
```

Monitor deployment:

```bash
rad app graph -a adaptive-apps
rad resource list Applications.Core/containers -a adaptive-apps
```

---

## Step 8 — Access the application

The frontend server proxies all API, AI-agent, and MQTT WebSocket traffic, so
you only need to expose one port:

```bash
rad resource expose Applications.Core/containers frontend -a adaptive-apps --port 3000 --remote-port 3000
```

Then open **http://localhost:3000** and log in with the `authUsername` / `authPassword` you passed above.

---

## Deploying to Azure

For Azure deployments with AI, deploy `app.bicep` with `aiProvider=local`.
Instead of a local Kaito
LLM, the AI recipe provisions an Azure OpenAI account.

### Azure prerequisites

| Tool | Install |
|------|---------|
| Azure CLI (`az`) | https://learn.microsoft.com/cli/azure/install-azure-cli |
| An AKS cluster | Or any Kubernetes cluster with access to Azure |
| A service principal | Radius uses it to provision Azure resources |

### Azure Step 1 — Create an AKS cluster (if you don't have one)

```bash
az group create -n <resource-group> -l eastus
az aks create -g <resource-group> -n <cluster-name> --node-count 1 --generate-ssh-keys
az aks get-credentials -g <resource-group> -n <cluster-name> --context aks-trading
```

This stores the AKS credentials under a named context (`aks-trading`) so it
doesn't overwrite your local k3s context. Switch between them with:

```bash
kubectl config use-context aks-trading    # → AKS
kubectl config use-context default        # → local k3s (use your actual k3s context name)
kubectl config get-contexts               # list all contexts
```

> **GPU drivers on AKS:** AKS GPU node pools (e.g. `Standard_NC` series) come
> with NVIDIA drivers and the device plugin **pre-installed**. You do **not**
> need to install the NVIDIA device plugin, configure the containerd runtime, or
> label nodes — AKS handles all of this automatically. The WSL2-specific vLLM
> workarounds (`gpu-memory-utilization`, `enforce-eager`, `runtimeClassName`)
> are also not needed on AKS.

### Azure Step 2 — Install Radius + register types + generate extension

Steps 1–3 are identical to the local workflow:

```bash
rad install kubernetes
# rad install kubernetes --set global.azureWorkloadIdentity.enabled=true

cd radius/
rad resource-type create --from-file resource-types/types.yaml
rad bicep publish-extension --from-file resource-types/types.yaml --target types.tgz
```

### Azure Step 3 — Register Azure credentials

Create a service principal and register it so Radius can provision Azure resources.
The `rad credential register` command must target the **AKS workspace** — switch
to it first if you also have a local workspace.

```bash
az ad sp create-for-rbac -n radius-sp --role Contributor \
  --scopes /subscriptions/<subscription-id>/resourceGroups/<resource-group>

# Create a workspace pointing at the AKS context (no group yet)
rad workspace create kubernetes aks-trading --context aks-trading
rad workspace switch aks-trading

rad credential register azure \
  --client-id <appId> \
  --client-secret <password> \
  --tenant-id <tenant>
```

### Azure Step 4 — Create group, workspace, and deploy the Environment

> **Important:** `rad group create` and `rad workspace create` talk to the
> Radius instance on the **current workspace's** cluster. Make sure
> `rad workspace switch aks-trading` was run first, otherwise these commands
> target your local k3s Radius instance.

```bash
kubectl create namespace trading

# Create the Radius group on the AKS Radius instance
rad group create trading

# Update the workspace to use the group
rad workspace create kubernetes aks-trading \
  --group trading \
  --context aks-trading

cd radius/
rad deploy aks-env.bicep \
  --parameters azureSubscriptionId=<subscription-id> \
  --parameters azureResourceGroup=<resource-group>
```

### Azure Step 5 — Deploy the application

```bash
rad deploy app.bicep --group trading --environment aks-trading \
  --parameters authPassword=<your-password> \
  --parameters aiProvider=local \
  --parameters aiModel=gpt-4o
```

> The only difference from the local deploy is the environment name
> (`aks-trading` vs `trading`) and `aiModel=gpt-4o` (or another
> Azure OpenAI model) instead of `qwen2.5-coder-7b-instruct`.

### Azure Step 6 — Access the application

Same as the local workflow:

```bash
rad resource expose Applications.Core/containers frontend \
  -a adaptive-apps --port 3000 --remote-port 3000
```

Or configure an Ingress / Load Balancer for production access.

---

## Tear down

```bash
rad app delete adaptive-apps
rad resource delete Applications.Core/environments trading --group trading
rad group delete trading
```

---

## Architecture reference

```
┌──────────────────────────────────────────────────────────────────────┐
│  Radius Application: adaptive-apps                                   │
│                                                                      │
│  ┌──────────┐ /api/* ┌──────────┐  PostgreSQL  ┌────────────────┐  │
│  │ frontend │───────▶│ backend  │─────────────▶│  trading-db    │  │
│  │  :3000   │        │  :8080   │  MQTT        │  Postgres :5432│  │
│  │ (proxy)  │        └──────────┘─────────────▶├────────────────┤  │
│  │          │/advice                            │  trading-mqtt  │  │
│  │          │───────▶┌──────────┐              │  Mosquitto     │  │
│  │          │/mqtt   │ ai-agent │              │  :1883 / :9001 │  │
│  │          │──ws──▶ │  :7000   │              └────────────────┘  │
│  └──────────┘        └──────────┘  ◀── Radius.Resources/aiModels  │
│   (only :3000           │               recipe                    │
│    exposed)             │  CONNECTION_AI_*  (auto-injected)        │
│                     ┌───▼────────────────────┐                     │
│                     │  trading-ai             │                     │
│                     │  Radius.Resources/      │                     │
│                     │  aiModels               │                     │
│                     └────────────────────────┘                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Resource Type → Recipe mapping

| Resource Type | Recipe | Description |
|---------------|--------|-------------|
| `Radius.Resources/postgreSqlDatabases` | `kubernetes-trading-postgres.bicep` | PostgreSQL 16-alpine with custom init SQL that creates the trading schema and seeds a demo account |
| `Radius.Resources/mqttBrokers` | `kubernetes-mosquitto.bicep` | Eclipse Mosquitto 2 with both a plain TCP listener (1883) and a WebSocket listener (9001) |
| `Radius.Resources/mqttBrokers` | `azure-event-grid.bicep` | Azure Event Grid Namespace with MQTT topic spaces enabled (secure MQTT/TLS endpoint for Azure environments) |
| `Radius.Resources/workloadIdentities` | `local-noop.bicep` | Local stub workload identity contract for non-Azure environments |
| `Radius.Resources/workloadIdentities` | `azure-workload-identity.bicep` | User-assigned managed identity + federated credential + service account annotation + Event Grid TopicSpaces RBAC |
| `Radius.Resources/aiModels` | `kubernetes-kaito.bicep` | Open-source LLM served in-cluster via the Kaito operator (AKS + GPU). Outputs `provider=local`. |
| `Radius.Resources/aiModels` | `azure-openai.bicep` | Azure OpenAI account + model deployment. Outputs `provider=openai` and an API key. |

---

## Choosing an MQTT broker recipe

`Radius.Resources/mqttBrokers` has two recipes, and the containers adapt to
whichever one the environment registers — `MQTT_AUTH_METHOD` and
`MQTT_TOKEN_AUDIENCE` are wired from `tradingMqtt.properties.*`, so the broker
answers for itself.

| | `kubernetes-mosquitto.bicep` | `azure-event-grid.bicep` |
|---|---|---|
| `authMethod` | `none` | `OAUTH2-JWT` |
| Transport | MQTT 1883 / WS 9001 | MQTTS 8883 / WSS 443 |
| Backend order processing | ✅ | ✅ |
| Browser live order stream | ✅ | ❌ |

**Event Grid requires MQTT v5 enhanced authentication.** The backend sends the
Microsoft Entra token in the CONNECT *Authentication Data* property with
*Authentication Method* `OAUTH2-JWT`, and uses the token's `oid` claim as the
MQTT client identifier — Event Grid matches it against the authenticating
principal. It re-authenticates with an `AUTH` packet (reason code 25) before the
token expires. Event Grid never reads the CONNECT password field; see
[Microsoft Entra JWT authentication and Azure RBAC](https://learn.microsoft.com/azure/event-grid/mqtt-client-microsoft-entra-token-and-rbac).

Set `MQTT_CLIENT_ID` on the container to override the derived client identifier.

**The browser has no Event Grid path.** `src/frontend/public/index.html` connects
to `MQTT_WS_URL` with the `mqtt.js` client and no credentials. Selecting the
Event Grid recipe therefore gives you server-side order processing but no
browser-side live streaming.

**Deleting the app does not delete the namespace.** `azure-event-grid.bicep`
returns `resources: []`, so Radius does not track the Event Grid namespace it
created. `rad app delete`, or switching to another recipe, leaves it running and
billing — delete it with
`az eventgrid namespace delete --name <namespace> --resource-group <rg>`.

---

## Troubleshooting

**Recipe not found during deploy**
Check the recipe is registered: `rad recipe list --environment trading`.
Ensure the OCI image was published and is accessible from within the cluster.

**Database tables missing after deploy**
The init SQL runs only on a *fresh* PostgreSQL data directory. If the pod
already has data, delete the Deployment and its PVC to force re-initialisation:
```bash
kubectl delete deployment/postgres-<hash> -n trading
```

**Browser cannot reach backend / MQTT**
The frontend server proxies all backend, AI-agent, and MQTT WebSocket traffic.
Check the frontend pod logs for proxy errors:
```bash
kubectl logs -n <namespace> -l radapp.io/resource=frontend --tail=30
```
Ensure the in-cluster service names (`backend:8080`, `ai-agent:7000`, and the
mosquitto service) are reachable from the frontend pod.

**AI model pod not starting / checking model download progress**
The Kaito Workspace creates a StatefulSet pod that downloads the model and runs
vLLM. To check its status and logs:
```bash
# Find the inference pod (named after the Workspace resource)
kubectl get pods -n <namespace> -l kaito.sh/workspace=<workspace-name>

# Stream logs to watch model download and vLLM startup
kubectl logs -n <namespace> <workspace-pod-name> -f
```
If a Workspace reports insufficient nodes, verify allocatable GPUs, truthful
memory labels and the requested model size. Do not inflate GPU memory or remove
validation webhooks. Follow the [GPU preparation guide](../tutorials/common/prepare-gpu-kaito.md).

**Backend cannot connect to the MQTT broker**
The backend logs the CONNECT result and retries with exponential backoff instead
of terminating; the REST API stays available while order streaming is degraded.
```bash
kubectl logs -n <namespace> -l radapp.io/resource=backend --tail=50 | grep MQTT
```
Against Event Grid, `NotAuthorized` usually means the identity lacks the
`EventGrid TopicSpaces Publisher`/`Subscriber` role on the topic space, or the
CONNECT client identifier does not match the principal's object ID (the backend
derives it from the token's `oid` claim — override with `MQTT_CLIENT_ID`).

**Bicep type errors**
Make sure `types.tgz` has been generated (Step 3) and is present in the `radius/`
directory alongside `bicepconfig.json`.
