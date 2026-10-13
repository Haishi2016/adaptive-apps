extension kubernetes with {
  kubeConfig: ''
  namespace: namespace
} as k8s

param context object
param namespace string

var properties = context.resource.properties
var service = properties.?localService ?? {}
var workspace = properties.?localWorkspace ?? {}
var azure = properties.?azure ?? {}
var local = !empty(service) || !empty(workspace)
var upstream = local ? {
  model: 'openai/${empty(workspace) ? service.model : properties.model}'
  api_base: 'http://${empty(workspace) ? service.name : context.resource.name}.${namespace}.svc.cluster.local:${empty(workspace) ? service.port : 80}/v1'
  api_key: 'unused-local-no-auth'
  max_retries: 0
} : union({
  model: '${azure.?provider ?? 'azure'}/${azure.?deployment ?? ''}'
  api_base: azure.?endpoint ?? ''
  max_retries: 0
  timeout: 8
}, empty(azure.?apiVersion ?? '') ? {} : { api_version: azure.apiVersion })
var deployments = local || !empty(azure) ? [{
  model_name: properties.model
  litellm_params: upstream
}] : flatten(map(properties.?members ?? [], member => map(
  filter(member.deployments, entry => entry.model_name == member.model),
  entry => {
    model_name: properties.model
    litellm_params: union(entry.litellm_params, {
      order: member.priority
      weight: member.weight
    })
  }
)))
var config = {
  'config.yaml': string({ model_list: deployments })
}

var cpu = service.?cpuInference ?? false
var gpu = !empty(workspace)
var labels = { 'adaptive.jplck.io/inference': context.resource.name }
var image = 'ghcr.io/ggml-org/llama.cpp@sha256:f8f71e3be397e868cdddfb9c404e3a263d9697f82fd7205f4737ac981feea4b8'
var security = {
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ['ALL'] }
}
resource weights 'core/PersistentVolumeClaim@v1' = if (cpu) {
  metadata: { name: '${service.name}-weights', namespace: namespace }
  spec: {
    accessModes: ['ReadWriteOnce']
    resources: { requests: { storage: '2Gi' } }
  }
}
resource inference 'apps/Deployment@v1' = if (cpu) {
  metadata: { name: service.name, namespace: namespace }
  spec: {
    replicas: 1
    strategy: { type: 'Recreate' }
    selector: { matchLabels: labels }
    template: {
      metadata: { labels: labels }
      spec: {
        automountServiceAccountToken: false
        securityContext: {
          runAsNonRoot: true
          runAsUser: 10001
          fsGroup: 10001
          seccompProfile: { type: 'RuntimeDefault' }
        }
        initContainers: [{
          name: 'model-weights'
          image: image
          command: [
            '/bin/sh'
            '-ec'
            '''
            cd /models
            if printf '%s\n' '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db  qwen2.5-0.5b-instruct-q4_k_m.gguf' | sha256sum -c -; then exit 0; fi
            curl --fail --location --proto '=https' --proto-redir '=https' --output model.gguf.part 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf'
            printf '%s\n' '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db  model.gguf.part' | sha256sum -c -
            mv model.gguf.part qwen2.5-0.5b-instruct-q4_k_m.gguf
            '''
          ]
          volumeMounts: [{ name: 'weights', mountPath: '/models' }]
          securityContext: security
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '128Mi' } }
        }]
        containers: [{
          name: 'llama-server'
          image: image
          args: [
            '--host', '0.0.0.0', '--port', string(service.port)
            '--model', '/models/qwen2.5-0.5b-instruct-q4_k_m.gguf'
            '--alias', service.model
            '--ctx-size', '2048', '--threads', '2', '--parallel', '1', '--n-predict', '256', '--no-webui'
          ]
          ports: [{ name: 'http', containerPort: service.port }]
          volumeMounts: [{ name: 'weights', mountPath: '/models' }]
          securityContext: security
          resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } }
          startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, failureThreshold: 180 }
          readinessProbe: { httpGet: { path: '/health', port: 'http' } }
        }]
        volumes: [{ name: 'weights', persistentVolumeClaim: { claimName: '${service.name}-weights' } }]
      }
    }
  }
  dependsOn: [weights]
}
resource endpoint 'core/Service@v1' = if (cpu) {
  metadata: { name: service.name, namespace: namespace }
  spec: {
    selector: labels
    ports: [{ port: service.port, targetPort: 'http' }]
  }
}
resource ingress 'networking.k8s.io/NetworkPolicy@v1' = if (cpu || gpu) {
  metadata: { name: gpu ? context.resource.name : service.name, namespace: namespace }
  spec: {
    podSelector: { matchLabels: labels }
    policyTypes: ['Ingress']
    ingress: [{
      from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } }
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } }
      }]
      ports: [{ protocol: 'TCP', port: 'http' }]
    }]
  }
}
resource cache 'core/PersistentVolumeClaim@v1' = if (gpu) {
  metadata: {
    name: '${context.resource.name}-hf-cache'
    namespace: namespace
    annotations: { 'radius.resource.id': context.resource.id }
  }
  spec: {
    accessModes: ['ReadWriteOnce']
    storageClassName: workspace.?storageClass ?? 'adaptive-model-cache'
    resources: { requests: { storage: workspace.?cacheSize ?? '4Gi' } }
  }
}
resource kaito 'kaito.sh/Workspace@v1beta1' = if (gpu) {
  metadata: {
    name: context.resource.name
    namespace: namespace
    annotations: { 'radius.resource.id': context.resource.id }
  }
  resource: { labelSelector: { matchLabels: workspace.nodeSelector } }
  inference: {
    template: {
      metadata: { labels: labels }
      spec: {
        runtimeClassName: workspace.?runtimeClass ?? 'nvidia'
        nodeSelector: workspace.nodeSelector
        automountServiceAccountToken: false
        containers: [{
          name: 'vllm'
          image: workspace.image
          args: [
            '--model=${workspace.source}', '--revision=${workspace.revision}'
            '--served-model-name=${properties.model}'
            '--dtype=half', '--max-model-len=2048', '--gpu-memory-utilization=0.3'
            '--tensor-parallel-size=1', '--max-num-seqs=1', '--enforce-eager'
            '--port=5000', '--host=0.0.0.0'
          ]
          env: [
            { name: 'VLLM_USE_V2_MODEL_RUNNER', value: '0' }
            { name: 'HF_HOME', value: '/hf-cache' }
            { name: 'HUGGINGFACE_HUB_CACHE', value: '/hf-cache/hub' }
            { name: 'HF_HUB_DISABLE_XET', value: '1' }
            { name: 'HF_HUB_OFFLINE', value: workspace.?offline ?? false ? '1' : '0' }
            { name: 'TRANSFORMERS_OFFLINE', value: workspace.?offline ?? false ? '1' : '0' }
          ]
          ports: [{ name: 'http', containerPort: 5000 }]
          startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, failureThreshold: 360 }
          readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, failureThreshold: 3 }
          livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 30, failureThreshold: 5 }
          resources: {
            requests: { cpu: '1', memory: '6Gi', 'nvidia.com/gpu': '1' }
            limits: { cpu: '2', memory: '8Gi', 'nvidia.com/gpu': '1' }
          }
          volumeMounts: [{ name: 'hf-cache', mountPath: '/hf-cache' }, { name: 'shm', mountPath: '/dev/shm' }]
        }]
        volumes: [
          { name: 'hf-cache', persistentVolumeClaim: { claimName: '${context.resource.name}-hf-cache' } }
          { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } }
        ]
      }
    }
  }
  dependsOn: [cache, ingress]
}
resource model 'core/ConfigMap@v1' = {
  metadata: {
    name: context.resource.name
    namespace: namespace
    annotations: { 'radius.resource.id': context.resource.id }
  }
  data: config
}

// ponytail: PVCs outlive applications; KAITO template changes use an explicit stop-before-start operation.
output result object = {
  resources: concat(
    ['/planes/kubernetes/local/namespaces/${namespace}/providers/core/ConfigMap/${context.resource.name}'],
    cpu ? [
      '/planes/kubernetes/local/namespaces/${namespace}/providers/apps/Deployment/${service.name}'
      '/planes/kubernetes/local/namespaces/${namespace}/providers/core/Service/${service.name}'
    ] : [],
    gpu ? ['/planes/kubernetes/local/namespaces/${namespace}/providers/kaito.sh/Workspace/${context.resource.name}'] : [],
    cpu || gpu ? ['/planes/kubernetes/local/namespaces/${namespace}/providers/networking.k8s.io/NetworkPolicy/${gpu ? context.resource.name : service.name}'] : []
  )
  values: {
    model: properties.model
    endpoint: 'http://model-ingress.${namespace}.svc.cluster.local:8080/v1'
    provider: 'gateway'
    configMapName: context.resource.name
    configDigest: uniqueString(string(config))
    deployments: deployments
    discovery: '/v1/models'
  }
}
