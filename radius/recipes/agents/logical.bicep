param context object
param namespace string
@description('Platform bindings supplied once by the environment recipe registration.')
param platform object

var p = context.resource.properties
var identityId = replace(context.resource.id, '/agents/', '/agentIdentities/')
var releaseEntries = items(p.?releases ?? {})

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
    activeVersion: p.?activeVersion ?? ''
    identityRef: p.?identityRef ?? ''
    releases: join(map(releaseEntries, release => release.key), ',')
  }
}

module deployedReleases 'release.bicep' = [for release in releaseEntries: {
  name: 'release-${release.key}'
  params: {
    context: {
      resource: {
        id: context.resource.id
        properties: union(release.value, {
          agentName: context.resource.name
          agentUid: any(agent).metadata.uid
          version: release.key
        })
      }
    }
    namespace: namespace
    platform: platform
  }
}]

// Logical metadata and identity survive application deletion. Purge is explicit.
output result object = {
  resources: flatten(map(releaseEntries, release => map([
    'apps/StatefulSet'
    'core/Service'
    'gateway.networking.k8s.io/HTTPRoute'
    'gateway.envoyproxy.io/SecurityPolicy'
    'gateway.envoyproxy.io/EnvoyExtensionPolicy'
    'networking.k8s.io/NetworkPolicy'
  ], kind => '/planes/kubernetes/local/namespaces/${namespace}/providers/${kind}/run-${uniqueString(namespace, any(agent).metadata.uid, release.key)}')))
  values: {
    agentName: context.resource.name
    namespace: namespace
    agentUid: any(agent).metadata.uid
    publishedVersions: map(releaseEntries, release => release.key)
  }
}
