extension kubernetes with {
  kubeConfig: ''
  namespace: namespace
} as k8s

param context object
param namespace string

var properties = context.resource.properties
var workspace = properties.localWorkspace
var labels = { 'adaptive.jplck.io/inference': context.resource.name }
resource ingress 'networking.k8s.io/NetworkPolicy@v1' = {
  metadata: { name: context.resource.name, namespace: namespace }
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
resource cache 'core/PersistentVolumeClaim@v1' = {
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
resource kaito 'kaito.sh/Workspace@v1beta1' = {
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
            '--served-model-name=${context.resource.properties.model}'
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

output result object = {
  resources: [
    '/planes/kubernetes/local/namespaces/${namespace}/providers/kaito.sh/Workspace/${context.resource.name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/networking.k8s.io/NetworkPolicy/${context.resource.name}'
  ]
  values: {
    model: properties.model
    deployment: properties.model
    endpoint: 'http://${context.resource.name}.${namespace}.svc.cluster.local:80/v1'
    provider: 'local'
    apiVersion: ''
  }
}
