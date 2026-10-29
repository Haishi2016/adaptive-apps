param context object
param namespace string
@description('Platform bindings supplied once by the environment recipe registration.')
param platform object

var p = context.resource.properties
var identityId = replace(context.resource.id, '/agents/', '/agentIdentities/')
var agentUid = p.binding.identity.ownerUid

extension kubernetes with {
  kubeConfig: ''
  namespace: namespace
}

resource agent 'core/ConfigMap@v1' = {
  metadata: {
    name: 'agent-${context.resource.name}'
    namespace: namespace
    labels: {
      'adaptive.jplck.io/resource': 'agent'
      'app.kubernetes.io/managed-by': 'radius'
    }
    annotations: {
      'radius.resource.id': context.resource.id
      'radius.identity.id': identityId
    }
  }
  data: {
    name: context.resource.name
    kind: p.kind
    agentUid: agentUid
    identityRef: p.?identityRef ?? ''
    definition: string(p.definition)
    governance: string(p.?governance ?? {})
  }
}

module runtime 'runtime.bicep' = {
  name: 'runtime'
  params: {
    context: {
      resource: {
        id: context.resource.id
        properties: union(p, {
          agentName: context.resource.name
          agentUid: agentUid
        })
      }
    }
    namespace: namespace
    platform: platform
  }
}

output result object = {
  resources: runtime.outputs.result.resources
  values: {
    agentName: context.resource.name
    namespace: namespace
    agentUid: agentUid
    endpoint: runtime.outputs.result.values.endpoint
    nativeName: runtime.outputs.result.values.nativeName
    nativeIdentity: p.binding.identity
  }
}
