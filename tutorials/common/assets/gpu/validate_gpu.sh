#!/usr/bin/env bash
set -euo pipefail

kubectl get runtimeclass nvidia
kubectl rollout status daemonset/nvidia-device-plugin-daemonset -n kube-system --timeout=180s
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'

echo
echo "Running CUDA pod test..."
cat <<EOF | kubectl create -f -
apiVersion: v1
kind: Pod
metadata:
  name: nvidia-runtime-test
spec:
  runtimeClassName: nvidia
  restartPolicy: Never
  containers:
  - name: cuda
    image: nvidia/cuda:12.3.2-base-ubuntu22.04
    command: ["nvidia-smi"]
    resources:
      limits:
        nvidia.com/gpu: 1
EOF

if ! kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/nvidia-runtime-test --timeout=300s; then
  kubectl describe pod nvidia-runtime-test
  kubectl logs nvidia-runtime-test
  exit 1
fi
kubectl logs nvidia-runtime-test
kubectl delete pod nvidia-runtime-test