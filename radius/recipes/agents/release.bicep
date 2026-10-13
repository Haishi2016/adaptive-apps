param context object
param namespace string

@description('Platform bindings supplied once by the environment recipe registration.')
param platform object

var p = context.resource.properties
var def = p.definition
var binding = p.binding
var id = binding.identity
var name = 'run-${uniqueString(namespace, p.agentUid, p.version)}'
var captureName = 'release-${uniqueString(namespace, p.agentUid, p.version)}'
var claimName = 'state-${uniqueString(p.agentUid, p.version)}'
var path = '/agents/${p.agentName}/versions/${p.version}'
var image = def.kind == 'prompt' ? def.runtimeImage : def.image
var connected = !empty(id.?blueprintId ?? '')
var graph = def.kind == 'prompt' && !empty(def.?tools ?? []) && (id.?graphDelegation ?? false)
var governed = !empty(p.?governance ?? {})
var modelUrl = 'http://model-ingress.${namespace}.svc.cluster.local:8080/v1'
var proxy = p.?governance ?? {}
var peers = filter(platform.?peers ?? [], peer => contains(peer.targets, p.agentName))
var labels = {
  'app.kubernetes.io/managed-by': 'radius'
  'app.kubernetes.io/component': 'agent-release'
  'adaptive.jplck.io/agent': p.agentName
  'adaptive.jplck.io/agent-uid': p.agentUid
  'adaptive.jplck.io/version': p.version
  'adaptive.jplck.io/cloud-egress': 'true'
}
var annotations = {
  'radius.resource.id': context.resource.id
  'adaptive.jplck.io/identity-owner-uid': id.ownerUid
}
var security = {
  allowPrivilegeEscalation: false
  runAsNonRoot: true
  capabilities: { drop: ['ALL'] }
}
var stateMount = { name: 'native-state', mountPath: '/var/lib/agentserver' }
var stateInit = '''
import asyncio
from azure.ai.agentserver.core.storage import FoundryStateStore
async def main():
    for name in ("agent_sessions", "function_approvals"):
        async with await FoundryStateStore.get_or_create(name, user_isolation=True, item_ttl_seconds=-1) as store:
            if (await store.get()).item_ttl_seconds != -1:
                raise RuntimeError("Existing state has expiring TTL; explicit migration required")
asyncio.run(main())
'''
var responsePath = '${path}/responses'
var localBindings = {
  'model-gateway': { scope: 'https://cognitiveservices.azure.com/.default', local_audience: 'api://adaptive-model-gateway' }
  'agent-ingress': { scope: 'https://ai.azure.com/.default', local_audience: 'api://adaptive-model-gateway' }
}
var agentEnv = concat([
  { name: 'AGENT_NAME', value: p.agentName }
  { name: 'AGENT_NAMESPACE', value: namespace }
  { name: 'PORT', value: '8080' }
  { name: 'AGENTSERVER_STATE_ROOT', value: stateMount.mountPath }
  { name: 'FOUNDRY_HOSTING_ENVIRONMENT', value: '' }
  { name: 'OPENAI_BASE_URL', value: governed ? 'http://127.0.0.1:8082/v1' : modelUrl }
  { name: 'OPENAI_MODEL', value: def.model }
  { name: 'IDENTITY_ENDPOINT', value: 'http://127.0.0.1:8081/identity/token' }
  { name: 'IDENTITY_HEADER', valueFrom: { secretKeyRef: { name: binding.secretRef, key: 'IDENTITY_HEADER' } } }
  { name: 'AZURE_TOKEN_CREDENTIALS', value: 'ManagedIdentityCredential' }
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: platform.otelEndpoint }
  { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: 'http/protobuf' }
  { name: 'OTEL_SERVICE_NAME', value: name }
  { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.namespace=${namespace},k8s.namespace.name=${namespace},adaptive.agent.name=${p.agentName},adaptive.agent.deployment=${name}' }
], def.kind == 'prompt' ? [
  { name: 'AGENT_INSTRUCTIONS', value: def.instructions }
  { name: 'AGENT_TOOLS', value: string(def.?tools ?? []) }
] : [], contains(def, 'temperature') ? [{ name: 'TEMPERATURE', value: string(def.temperature) }] : [],
  contains(def, 'top_p') ? [{ name: 'TOP_P', value: string(def.top_p) }] : [],
  map(items(def.?environment ?? {}), item => { name: item.key, value: item.value }))
var adapterEnv = [
  { name: 'AGENT_RESPONSE_PATH', value: responsePath }
  { name: 'IDENTITY_HEADER', valueFrom: { secretKeyRef: { name: binding.secretRef, key: 'IDENTITY_HEADER' } } }
  { name: 'IDENTITY_SIDECAR_URL', value: connected ? 'http://127.0.0.1:5000' : '' }
  { name: 'AGENT_IDENTITY_CLIENT_ID', value: id.?entraClientId ?? '' }
  { name: 'KEYCLOAK_TOKEN_URL', value: '${platform.keycloakUrl}/realms/adaptive/protocol/openid-connect/token' }
  { name: 'KEYCLOAK_CLIENT_ID', value: id.keycloakClientId }
  { name: 'KEYCLOAK_CLIENT_SECRET', valueFrom: { secretKeyRef: { name: binding.secretRef, key: 'KEYCLOAK_CLIENT_SECRET' } } }
  { name: 'IDENTITY_DOWNSTREAM', value: string(localBindings) }
  { name: 'GRAPH_DELEGATION_ENABLED', value: graph ? 'true' : 'false' }
  { name: 'ENTRA_TENANT_ID', value: id.?entraTenantId ?? '' }
  { name: 'AGENT_BLUEPRINT_ID', value: id.?blueprintId ?? '' }
  { name: 'OBO_CLIENT_ID', value: id.?oboClientId ?? '' }
  { name: 'AGENT_USER_ID', value: id.?agentUserId ?? '' }
]
var sidecarEnv = concat([
  { name: 'ASPNETCORE_URLS', value: 'http://+:5000' }
  { name: 'ASPNETCORE_ENVIRONMENT', value: 'Production' }
  { name: 'Sidecar__AllowOverrides__GetAuthorizationHeader', value: 'true' }
  { name: 'Sidecar__AllowOverrides__GetAuthorizationHeaderUnauthenticated', value: 'true' }
  { name: 'AzureAd__Instance', value: 'https://login.microsoftonline.com/' }
  { name: 'AzureAd__TenantId', value: id.?entraTenantId ?? '' }
  { name: 'AzureAd__ClientId', value: id.?blueprintId ?? '' }
  { name: 'AzureAd__ClientCredentials__0__SourceType', value: 'SignedAssertionFilePath' }
  { name: 'AzureAd__ClientCredentials__0__SignedAssertionFileDiskPath', value: '/var/run/secrets/azure/tokens/azure-identity-token' }
], graph ? [
  { name: 'AzureAd__Audience', value: id.blueprintId }
  { name: 'AzureAd__Scopes', value: 'access_agent' }
  { name: 'DownstreamApis__Graph__BaseUrl', value: 'https://graph.microsoft.com/v1.0' }
  { name: 'DownstreamApis__Graph__Scopes__0', value: 'https://graph.microsoft.com/.default' }
  { name: 'DownstreamApis__Graph__RequestAppToken', value: 'false' }
] : [])

extension kubernetes with {
  kubeConfig: ''
  namespace: namespace
}

resource capture 'core/ConfigMap@v1' = {
  metadata: {
    name: captureName
    namespace: namespace
    labels: union(labels, { 'adaptive.jplck.io/resource': 'agent-release' })
    annotations: annotations
  }
  immutable: true
  data: union({
    'release.json': string(union(p, {
      workload: name
      claim: claimName
      gateway: 'agent-ingress'
      endpoint: '${platform.ingressUrl}${path}'
      platform: platform
      radiusResourceId: context.resource.id
    }))
  }, governed ? { 'proxy.json': proxy.config } : {})
}
var owner = [{
  apiVersion: 'v1'
  kind: 'ConfigMap'
  name: capture.metadata.name
  uid: any(capture).metadata.uid
}]
var metadata = {
  name: name
  namespace: namespace
  labels: labels
  annotations: annotations
  ownerReferences: owner
}

resource state 'core/PersistentVolumeClaim@v1' = {
  metadata: {
    name: claimName
    namespace: namespace
    labels: labels
    annotations: annotations
  }
  spec: {
    accessModes: ['ReadWriteOnce']
    resources: { requests: { storage: p.?stateSize ?? '1Gi' } }
  }
  dependsOn: [capture]
}
resource workload 'apps/StatefulSet@v1' = {
  // The extension schema omits native ObjectMeta.ownerReferences.
  metadata: any(metadata)
  spec: {
    replicas: 1
    serviceName: name
    podManagementPolicy: 'OrderedReady'
    updateStrategy: { type: 'RollingUpdate' }
    selector: { matchLabels: labels }
    template: {
      metadata: {
        labels: labels
        annotations: {
          'azure.workload.identity/skip-containers': 'agent;identity-adapter;governance-sidecar;native-state;identity-sidecar'
          'sidecar.istio.io/inject': 'false'
          'kubectl.kubernetes.io/default-container': 'agent'
        }
      }
      spec: {
        serviceAccountName: binding.serviceAccountName
        automountServiceAccountToken: false
        securityContext: {
          runAsNonRoot: true
          runAsUser: 10001
          runAsGroup: 10001
          fsGroup: 10001
          seccompProfile: { type: 'RuntimeDefault' }
        }
        initContainers: [{
          name: 'native-state'
          image: image
          command: ['python', '-c', stateInit]
          env: [
            { name: 'AGENTSERVER_STATE_ROOT', value: stateMount.mountPath }
            { name: 'FOUNDRY_HOSTING_ENVIRONMENT', value: '' }
          ]
          volumeMounts: [stateMount]
          securityContext: security
        }]
        containers: concat([
          {
            name: 'agent'
            image: image
            env: agentEnv
            ports: [{ name: 'http', containerPort: 8080 }]
            volumeMounts: [stateMount]
            securityContext: security
            resources: p.?resources ?? { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } }
            readinessProbe: { httpGet: { path: '/readiness', port: 'http' } }
            livenessProbe: { httpGet: { path: '/readiness', port: 'http' } }
          }
          {
            name: 'identity-adapter'
            image: platform.adapterImage
            env: adapterEnv
            ports: [{ name: 'authorization', containerPort: 8083 }]
            securityContext: union(security, { readOnlyRootFilesystem: true })
            readinessProbe: { exec: { command: ['/dac-adapter', '--healthcheck'] } }
          }
        ], connected ? [{
          name: 'identity-sidecar'
          image: platform.sidecarImage
          env: sidecarEnv
          securityContext: union(security, { readOnlyRootFilesystem: true })
          readinessProbe: { tcpSocket: { port: 5000 } }
          volumeMounts: [
            { name: 'blueprint-assertion', mountPath: '/var/run/secrets/azure/tokens', readOnly: true }
            { name: 'sidecar-keys', mountPath: '/app/keys' }
            { name: 'sidecar-tmp', mountPath: '/tmp' }
          ]
        }] : [], governed ? [{
          name: 'governance-sidecar'
          image: platform.governanceImage
          securityContext: union(security, { readOnlyRootFilesystem: true })
          env: [
            { name: 'ADAPTIVE_GOVERNANCE_SHA256', value: proxy.digest }
            { name: 'ADAPTIVE_GOVERNANCE_AGENT_ID', value: '${namespace}/${p.agentName}' }
            { name: 'ADAPTIVE_GOVERNANCE_MODE', value: proxy.mode }
            { name: 'ADAPTIVE_GOVERNANCE_AGENT_VERSION', value: p.version }
            { name: 'ADAPTIVE_GOVERNANCE_DEPLOYMENT', value: name }
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: platform.otelEndpoint }
          ]
          volumeMounts: [{ name: 'governance', mountPath: '/policies', readOnly: true }]
          readinessProbe: { exec: { command: ['python', '-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8082/readyz", timeout=2)'] } }
        }] : [])
        volumes: concat([
          { name: 'native-state', persistentVolumeClaim: { claimName: state.metadata.name } }
        ], connected ? [
          { name: 'blueprint-assertion', projected: { sources: [{ serviceAccountToken: {
            audience: 'api://AzureADTokenExchange'
            expirationSeconds: 3600
            path: 'azure-identity-token'
          } }] } }
          { name: 'sidecar-keys', emptyDir: {} }
          { name: 'sidecar-tmp', emptyDir: {} }
        ] : [], governed ? [{ name: 'governance', configMap: { name: capture.metadata.name } }] : [])
      }
    }
  }
}
resource service 'core/Service@v1' = {
  metadata: any(metadata)
  spec: {
    clusterIP: 'None'
    selector: labels
    ports: [
      { name: 'http', port: 8080, targetPort: 'http' }
      { name: 'authorization', port: 8083, targetPort: 'authorization' }
    ]
  }
}
resource route 'gateway.networking.k8s.io/HTTPRoute@v1' = {
  metadata: metadata
  spec: {
    parentRefs: [{ name: 'agent-ingress' }]
    rules: [{
      matches: [{ method: 'POST', path: { type: 'Exact', value: responsePath } }]
      filters: [
        { type: 'URLRewrite', urlRewrite: { path: { type: 'ReplaceFullPath', replaceFullPath: '/responses' } } }
      ]
      timeouts: { request: '0s', backendRequest: '0s' }
      backendRefs: [{ name: service.metadata.name, port: 8080 }]
    }]
  }
}
resource authorization 'gateway.envoyproxy.io/SecurityPolicy@v1alpha1' = {
  metadata: metadata
  spec: {
    targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: route.metadata.name }]
    jwt: {
      providers: concat([{
        name: 'keycloak'
        issuer: platform.issuer
        audiences: ['api://adaptive-broker']
        remoteJWKS: { uri: '${platform.keycloakUrl}/realms/adaptive/protocol/openid-connect/certs' }
        extractFrom: { headers: [{ name: 'Authorization', valuePrefix: 'Bearer ' }] }
      }], empty(peers) ? [] : [{
        name: 'keycloak-agent'
        issuer: platform.issuer
        audiences: ['api://adaptive-model-gateway']
        remoteJWKS: { uri: '${platform.keycloakUrl}/realms/adaptive/protocol/openid-connect/certs' }
        extractFrom: { headers: [{ name: 'Authorization', valuePrefix: 'Bearer ' }] }
      }])
    }
    authorization: {
      defaultAction: 'Deny'
      rules: concat([{
        name: 'human-invoke'
        action: 'Allow'
        operation: { methods: ['POST'] }
        principal: { jwt: { provider: 'keycloak', claims: [
          { name: 'roles', valueType: 'StringArray', values: ['agent.invoke'] }
          { name: 'azp', values: ['adaptive-ui'] }
        ] } }
      }], empty(peers) ? [] : [{
        name: 'local-peer-invoke'
        action: 'Allow'
        operation: { methods: ['POST'] }
        principal: { jwt: { provider: 'keycloak-agent', claims: [
          { name: 'azp', values: map(peers, peer => peer.keycloakClientId) }
          { name: 'agent_id', values: map(peers, peer => peer.agentId) }
        ] } }
      }])
    }
    extAuth: {
      http: {
        backendRefs: [{ name: service.metadata.name, port: 8083 }]
        headersToBackend: ['X-Admission-Identity-Mode', 'X-Admission-Graph-Token', 'X-Admission-Graph-User']
      }
      headersToExtAuth: ['Content-Type', 'Content-Encoding', 'X-Envoy-Auth-Partial-Body', 'Authorization', 'X-Impersonation-Mode', 'X-Entra-User-Token']
      bodyToExtAuth: { maxRequestBytes: 1048576 }
      failOpen: false
      recomputeRoute: false
      timeout: '30s'
    }
  }
}
resource headers 'gateway.envoyproxy.io/EnvoyExtensionPolicy@v1alpha1' = {
  metadata: metadata
  spec: {
    targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: route.metadata.name }]
    lua: [{ type: 'Inline', inline: loadTextContent('headers.lua') }]
  }
}
resource isolation 'networking.k8s.io/NetworkPolicy@v1' = {
  metadata: any(metadata)
  spec: {
    podSelector: { matchLabels: labels }
    policyTypes: ['Ingress', 'Egress']
    ingress: [{
      from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'envoy-gateway-system' } }
        podSelector: { matchLabels: {
          'gateway.envoyproxy.io/owning-gateway-namespace': namespace
          'gateway.envoyproxy.io/owning-gateway-name': 'agent-ingress'
        } }
      }]
      ports: [{ protocol: 'TCP', port: 8080 }, { protocol: 'TCP', port: 8083 }]
    }]
    egress: [
      {
        to: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } }
        }]
        ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }]
      }
      {
        to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'keycloak' } } }]
        ports: [{ protocol: 'TCP', port: 8080 }]
      }
      {
        to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'otel-collector' } } }]
        ports: [{ protocol: 'TCP', port: 4318 }]
      }
      {
        to: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'envoy-gateway-system' } }
          podSelector: { matchLabels: { 'gateway.envoyproxy.io/owning-gateway-namespace': namespace } }
        }]
        ports: [{ protocol: 'TCP', port: 8080 }]
      }
    ]
  }
}

// Radius deletes runtime resources, never the capture or native state.
output result object = {
  resources: [
    '/planes/kubernetes/local/namespaces/${namespace}/providers/apps/StatefulSet/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/core/Service/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/gateway.networking.k8s.io/HTTPRoute/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/gateway.envoyproxy.io/SecurityPolicy/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/gateway.envoyproxy.io/EnvoyExtensionPolicy/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/networking.k8s.io/NetworkPolicy/${name}'
  ]
  values: {
    version: p.version
    captureName: capture.metadata.name
    endpoint: ''
  }
}
