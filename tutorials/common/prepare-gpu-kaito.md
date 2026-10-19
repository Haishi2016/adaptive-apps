# Prepare NVIDIA GPU + KAITO

Local inference uses stock KAITO and vLLM, not a CPU llama.cpp server.
Foundry-only deployments do not require a GPU. Hybrid deployments require both
this local path and [gateway workload identity](../../docs/agents/native-radius.md#models).
Use the existing portfolio, Radius and OIDC preparation; do not install another
model gateway or agent operator.

## 1. Prepare a real GPU node

Use an existing GPU-capable K3s/AKS/Kubernetes cluster. Native agents require
Kubernetes 1.33+. On host K3s, install the appropriate NVIDIA driver and container
toolkit before K3s starts so its containerd can discover `nvidia-container-runtime`.
Verify `nvidia-smi` and the configured NVIDIA runtime. Restarting an existing
cluster is a separately scoped operation, not part of ordinary model delivery.

GPU availability on the host does not imply availability inside k3d. An ordinary
CLI-created k3d cluster does not install NVIDIA support. Container-based nodes
need a compatible GPU-enabled image, Docker's NVIDIA runtime, GPU passthrough
and, on WSL, the actual driver libraries/device. The older custom
`assets/gpu/Dockerfile.nvidia` is a trading-sample asset, not a qualified native
Kubernetes 1.33+ bootstrap. Do not replace a working cluster to follow that path.

## 2. Install the shared device plugin

Do not install a second plugin if the cluster already supplies one. For BYO
K3s with an NVIDIA container runtime:

```bash
kubectl apply -f tutorials/common/assets/gpu/device-plugin-daemonset.yaml
kubectl rollout status daemonset/nvidia-device-plugin-daemonset \
  -n kube-system --timeout=180s
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
./tutorials/common/assets/gpu/validate_gpu.sh
```

The CUDA validation Pod must finish **Succeeded**. Failures retain the Pod for
diagnosis; remove that exact test Pod before retrying. The device plugin fails
explicitly when initialization is unavailable.

## 3. Label only verified GPU facts

Select the actual node name and set the selector used in the model declaration:

```bash
kubectl label node <gpu-node> nvidia.com/gpu=true --overwrite
```

KAITO presets may additionally need truthful product, count and memory labels
when GPU Feature Discovery cannot supply them, particularly on WSL. Measure
these with `nvidia-smi`; never inflate GPU memory or remove validation webhooks
to make an unsuitable model schedule.

## 4. Install stock KAITO on BYO nodes

```bash
helm repo add kaito https://kaito-project.github.io/kaito/charts/kaito
helm repo update kaito
helm upgrade --install kaito-workspace kaito/workspace \
  --version 0.10.0 --namespace kaito-workspace --create-namespace \
  --set featureGates.disableNodeAutoProvisioning=true \
  --set nvidiaDevicePlugin.enabled=false \
  --set localCSIDriver.useLocalCSIDriver=false \
  --wait --timeout=10m
kubectl get deployments -n kaito-workspace
kubectl get crd workspaces.kaito.sh
```

The native recipe's custom Workspace sets `runtimeClassName: nvidia` itself.
**Kyverno is not required for native inference.** The separate
`assets/gpu/gpu_bootstrap.yaml` contains only the optional trading-preset
runtime-class mutation policy; apply it only where Kyverno is already installed
and that preset needs the mutation.

## 5. Declare the small GPU model through Radius

`ada agents-config --with-kaito-model` selects **Qwen/Qwen3-0.6B**, an exact
model revision and pinned vLLM image through the explicit `kaito` model recipe.
KAITO is off by default for every portfolio. Native `ada init` consumes explicit `models`, then the
normal bootstrap deploys them through `radius/agent-services.bicep`.
Alternatively, `radius/agent-models.bicep` declares independently owned local
and Foundry `aiModels` resources plus an `aiGateways` hybrid route built from
their real Radius outputs.

The smoke profile requests one GPU, a retained HF cache, 2048-token context,
one sequence and 30% GPU utilization. It is a small serving test, not a tool
quality or production-capacity claim. Image/model downloads require internet;
disconnected restart requires the image and exact weights to be present.
Do not change agent images or call the KAITO Service from application clients:
all calls and discovery still use the authenticated LiteLLM gateway.

```bash
kubectl get workspaces,pods,pvc -n <namespace>
kubectl describe workspace <model-resource-name> -n <namespace>
kubectl logs -n <namespace> <inference-pod> -c vllm
```

Confirm serving readiness and perform real inference through the model gateway
before retiring an earlier model. Preserve retained caches unless their deletion
is explicitly scoped.

KAITO 0.10.0 did not propagate a changed custom template into an existing
StatefulSet in the local qualification. Compare the desired Workspace and actual
StatefulSet container arguments; Workspace generation alone is not rollout
evidence. For an explicitly scoped update, stop and delete only that
KAITO-generated StatefulSet with foreground cascading, retaining the Workspace
and external HF-cache PVC, then wait for KAITO to recreate the desired singleton:

```bash
kubectl delete statefulset <model-resource-name> -n <namespace> \
  --cascade=foreground --wait=true --timeout=180s
kubectl wait --for=create statefulset/<model-resource-name> \
  -n <namespace> --timeout=180s
kubectl rollout status statefulset/<model-resource-name> \
  -n <namespace> --timeout=600s
kubectl wait --for=condition=InferenceReady workspace/<model-resource-name> \
  -n <namespace> --timeout=600s
kubectl get statefulset <model-resource-name> -n <namespace> \
  -o jsonpath='{.spec.template.spec.containers[0].args}'
```

Verify the recreated Pod and actual arguments as well as current Workspace
readiness. This operation interrupts serving; do not force-delete a Pod or
delete the cache to obtain an update.
