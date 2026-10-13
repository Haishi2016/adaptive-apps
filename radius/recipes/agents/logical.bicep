param context object
param namespace string
@description('Foundry owns cloud identity; do not advertise a nonexistent edge identity resource.')
param foundryManagedIdentity bool = false

var p = context.resource.properties
var identityId = replace(context.resource.id, '/agents/', '/agentIdentities/')

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
    annotations: union({
      'radius.resource.id': context.resource.id
    }, foundryManagedIdentity ? {} : {
      'radius.identity.id': identityId
    })
  }
  data: {
    name: context.resource.name
    kind: p.kind
    activeVersion: p.?activeVersion ?? ''
    identityRef: p.?identityRef ?? ''
  }
}

// Logical metadata and identity survive application deletion. Purge is explicit.
output result object = {
  resources: []
  values: {
    agentName: context.resource.name
    namespace: namespace
    agentUid: any(agent).metadata.uid
  }
}
