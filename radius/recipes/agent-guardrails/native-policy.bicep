param context object

var p = context.resource.properties
var namespace = p.?policyNamespace ?? 'adaptive-guardrails-apps'
var name = 'guardrail-${take('${uniqueString(context.resource.id)}${uniqueString(context.resource.id, 'policy')}', 24)}'

extension kubernetes with {
  kubeConfig: ''
  namespace: namespace
}

resource policy 'core/ConfigMap@v1' = {
  metadata: {
    name: name
    namespace: namespace
    labels: {
      'adaptive.jplck.io/resource': 'agent-guardrails'
      'app.kubernetes.io/managed-by': 'radius'
    }
    annotations: { 'radius.resource.id': context.resource.id }
  }
  immutable: true
  data: { 'policy.json': p.policies }
}

output result object = {
  resources: []
  values: {
    provider: 'agt-native-proxy'
    policiesConfigMapName: policy.metadata.name
    bundleRef: '${namespace}/${name}@sha256:${p.policyDigest}'
    content: p.policies
  }
}
