@description('Kubernetes hosting implementation for one portable agent.')
param context object
param namespace string

@description('Platform bindings supplied once by the environment recipe registration.')
param platform object

var p = context.resource.properties
var def = p.definition
var binding = p.binding
var id = binding.identity
var name = 'agent-${uniqueString(namespace, p.agentUid)}'
var claimName = 'state-${uniqueString(p.agentUid)}'
var path = '/agents/${p.agentName}'
var image = def.kind == 'prompt' ? def.runtimeImage : def.image
var graph = def.kind == 'prompt' && !empty(def.?tools ?? []) && (id.?graphDelegation ?? false)
var governanceConfig = p.?governance.?config ?? ''
var governanceDigest = p.?governance.?digest ?? ''
var governanceMode = p.?governance.?mode ?? ''
var governed = !empty(governanceConfig)
var modelUrl = 'http://model-ingress.${namespace}.svc.cluster.local:8080/v1'
var peers = filter(platform.?peers ?? [], peer => contains(peer.targets, p.agentName))
var strictResponses = platform.?strictResponses ?? false
var peerAuthorization = join(map(peers, peer => '(jwt.azp == "${peer.keycloakClientId}" && jwt.agent_id == "${peer.agentId}")'), ' || ')
var callerAuthorization = '(jwt.azp in ["adaptive-ui", "adaptive-trading"] && jwt.roles.exists(role, role == "agent.invoke"))${empty(peerAuthorization) ? '' : ' || ${peerAuthorization}'}'
var trustedHeaderAuthorization = '! ("x-client-identity-mode" in request.headers) && ! ("x-client-microsoft-graph-access-token" in request.headers) && ! ("x-client-graph-user-id" in request.headers)'
var labels = {
  'app.kubernetes.io/managed-by': 'radius'
  'app.kubernetes.io/component': 'agent-runtime'
  'adaptive.jplck.io/agent': p.agentName
  'adaptive.jplck.io/agent-uid': p.agentUid
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
var agentEnv = concat([
  { name: 'AGENT_NAME', value: p.agentName }
  { name: 'AGENT_NAMESPACE', value: namespace }
  { name: 'PORT', value: '8080' }
  { name: 'AGENTSERVER_STATE_ROOT', value: stateMount.mountPath }
  { name: 'FOUNDRY_HOSTING_ENVIRONMENT', value: '' }
  { name: 'OPENAI_BASE_URL', value: governed ? 'http://127.0.0.1:8082/v1' : modelUrl }
  { name: 'OPENAI_MODEL', value: def.model }
  { name: 'KEYCLOAK_TOKEN_URL', value: '${platform.keycloakUrl}/realms/adaptive/protocol/openid-connect/token' }
  { name: 'KEYCLOAK_CLIENT_ID', value: id.keycloakClientId }
  { name: 'KEYCLOAK_CLIENT_SECRET', valueFrom: { secretKeyRef: { name: binding.secretRef, key: 'KEYCLOAK_CLIENT_SECRET' } } }
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: platform.otelEndpoint }
  { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', value: 'http/protobuf' }
  { name: 'OTEL_SERVICE_NAME', value: name }
  { name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'service.namespace=${namespace},k8s.namespace.name=${namespace},adaptive.agent.name=${p.agentName}' }
], def.kind == 'prompt' ? [
  { name: 'AGENT_INSTRUCTIONS', value: def.instructions }
  { name: 'AGENT_TOOLS', value: string(def.?tools ?? []) }
] : [], contains(def, 'temperature') ? [{ name: 'TEMPERATURE', value: string(def.temperature) }] : [],
  contains(def, 'top_p') ? [{ name: 'TOP_P', value: string(def.top_p) }] : [],
  map(items(def.?environment ?? {}), item => { name: item.key, value: item.value }))
var brokerEnv = [
  { name: 'AGENT_POLICY_MODE', value: 'delegation-broker' }
  { name: 'RESPONSES_ADMISSION_ENABLED', value: strictResponses ? 'true' : 'false' }
  { name: 'IDENTITY_SIDECAR_URL', value: 'http://127.0.0.1:5000' }
  { name: 'AGENT_IDENTITY_CLIENT_ID', value: id.?entraClientId ?? '' }
  { name: 'KEYCLOAK_TOKEN_URL', value: '${platform.keycloakUrl}/realms/adaptive/protocol/openid-connect/token' }
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

resource governance 'core/ConfigMap@v1' = if (governed) {
  metadata: {
    name: '${name}-governance'
    namespace: namespace
    labels: labels
    annotations: annotations
  }
  data: { 'proxy.json': governanceConfig }
}
var metadata = {
  name: name
  namespace: namespace
  labels: labels
  annotations: annotations
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
          'azure.workload.identity/skip-containers': 'agent;delegation-broker;governance-sidecar;native-state'
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
        ], graph ? [{
          name: 'delegation-broker'
          image: platform.policyServiceImage
          env: brokerEnv
          ports: [{ name: 'authorization', containerPort: 8083 }]
          securityContext: union(security, { readOnlyRootFilesystem: true })
          readinessProbe: { exec: { command: ['/agent-policy', '--healthcheck'] } }
        }, {
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
            { name: 'ADAPTIVE_GOVERNANCE_SHA256', value: governanceDigest }
            { name: 'ADAPTIVE_GOVERNANCE_AGENT_ID', value: '${namespace}/${p.agentName}' }
            { name: 'ADAPTIVE_GOVERNANCE_MODE', value: governanceMode }
            { name: 'ADAPTIVE_GOVERNANCE_DEPLOYMENT', value: name }
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: platform.otelEndpoint }
          ]
          volumeMounts: [{ name: 'governance', mountPath: '/policies', readOnly: true }]
          readinessProbe: { exec: { command: ['python', '-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8082/readyz", timeout=2)'] } }
        }] : [])
        volumes: concat([
          { name: 'native-state', persistentVolumeClaim: { claimName: state.metadata.name } }
        ], graph ? [
          { name: 'blueprint-assertion', projected: { sources: [{ serviceAccountToken: {
            audience: 'api://AzureADTokenExchange'
            expirationSeconds: 3600
            path: 'azure-identity-token'
          } }] } }
          { name: 'sidecar-keys', emptyDir: {} }
          { name: 'sidecar-tmp', emptyDir: {} }
        ] : [], governed ? [{ name: 'governance', configMap: { name: governance!.metadata.name } }] : [])
      }
    }
  }
}
resource service 'core/Service@v1' = {
  metadata: any(metadata)
  spec: {
    clusterIP: 'None'
    selector: labels
    ports: concat([
      { name: 'http', port: 8080, targetPort: 'http' }
    ], graph ? [
      { name: 'authorization', port: 8083, targetPort: 'authorization', appProtocol: 'kubernetes.io/h2c' }
    ] : [])
  }
}
resource route 'gateway.networking.k8s.io/HTTPRoute@v1' = {
  metadata: metadata
  spec: {
    parentRefs: [{ name: 'agent-ingress' }]
    rules: [{
      matches: [
        { method: 'POST', path: { type: 'Exact', value: responsePath } }
        { method: 'OPTIONS', path: { type: 'Exact', value: responsePath } }
      ]
      filters: [
        { type: 'URLRewrite', urlRewrite: { path: { type: 'ReplaceFullPath', replaceFullPath: '/responses' } } }
      ]
      timeouts: { request: '0s', backendRequest: '0s' }
      backendRefs: [{ name: service.metadata.name, port: 8080 }]
    }]
  }
}
resource authorization 'agentgateway.dev/AgentgatewayPolicy@v1alpha1' = {
  metadata: metadata
  spec: {
    targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: route.metadata.name }]
    traffic: union({
      cors: {
        allowOrigins: [
          'http://localhost:3000'
          'https://localhost:8443'
        ]
        allowMethods: ['POST', 'OPTIONS']
        allowHeaders: [
          'Authorization'
          'Content-Type'
          'Accept'
          'X-Impersonation-Mode'
          'X-Entra-User-Token'
        ]
        exposeHeaders: ['Content-Type']
        allowCredentials: true
        maxAge: 600
      }
      jwtAuthentication: {
        mode: 'Strict'
        preserveToken: graph
        providers: concat([{
          issuer: platform.issuer
          audiences: ['api://adaptive-broker']
          jwks: { remote: {
            backendRef: {
              group: ''
              kind: 'Service'
              name: platform.keycloakService
              namespace: namespace
              port: 8080
            }
            jwksPath: '/realms/adaptive/protocol/openid-connect/certs'
            cacheDuration: '5m'
          } }
        }], empty(peers) ? [] : [{
          issuer: platform.issuer
          audiences: ['api://adaptive-model-gateway']
          jwks: { remote: {
            backendRef: {
              group: ''
              kind: 'Service'
              name: platform.keycloakService
              namespace: namespace
              port: 8080
            }
            jwksPath: '/realms/adaptive/protocol/openid-connect/certs'
            cacheDuration: '5m'
          } }
        }])
      }
      authorization: {
        action: 'Allow'
        policy: {
          matchExpressions: ['${trustedHeaderAuthorization} && (${callerAuthorization})']
        }
      }
      headerModifiers: {
        request: {
          remove: concat([
            'Authorization'
            'Cookie'
            'X-Impersonation-Mode'
            'X-Entra-User-Token'
          ], graph ? [] : [
            'X-Client-Identity-Mode'
            'X-Client-Microsoft-Graph-Access-Token'
            'X-Client-Graph-User-Id'
          ])
        }
      }
    }, graph || strictResponses ? {
      extAuth: {
        backendRef: graph
          ? { name: service.metadata.name, port: 8083 }
          : { name: 'responses-admission', port: 8083 }
        failureMode: 'FailClosed'
        forwardBody: { maxSize: 1048576 }
        grpc: {}
      }
    } : {})
  }
}
resource isolation 'networking.k8s.io/NetworkPolicy@v1' = {
  metadata: any(metadata)
  spec: {
    podSelector: { matchLabels: labels }
    policyTypes: ['Ingress', 'Egress']
    ingress: [{
      from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } }
        podSelector: { matchLabels: {
          'gateway.networking.k8s.io/gateway-name': 'agent-ingress'
        } }
      }]
      ports: concat([{ protocol: 'TCP', port: 8080 }], graph ? [{ protocol: 'TCP', port: 8083 }] : [])
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
        to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/component': 'keycloak' } } }]
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
      {
        to: [{ podSelector: { matchLabels: { 'gateway.networking.k8s.io/gateway-name': 'agent-ingress' } } }]
        ports: [{ protocol: 'TCP', port: 8080 }]
      }
    ]
  }
}

// Radius deletes the mutable runtime resources, never the retained native state.
output result object = {
  resources: concat([
    '/planes/kubernetes/local/namespaces/${namespace}/providers/apps/StatefulSet/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/core/Service/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/gateway.networking.k8s.io/HTTPRoute/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/agentgateway.dev/AgentgatewayPolicy/${name}'
    '/planes/kubernetes/local/namespaces/${namespace}/providers/networking.k8s.io/NetworkPolicy/${name}'
  ], governed ? [
    '/planes/kubernetes/local/namespaces/${namespace}/providers/core/ConfigMap/${governance!.metadata.name}'
  ] : [])
  values: {
    endpoint: '${platform.ingressUrl}${path}'
    nativeName: name
  }
}
