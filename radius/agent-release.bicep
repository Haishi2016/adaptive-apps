extension radius
extension radiusResources

param environment string
param agentName string
param version string
@description('Native prompt or hosted definition with immutable image digest.')
param definition object
param governance object = {}
param resources object = {}

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: '${agentName}-${version}'
  properties: { environment: environment }
}
resource agent 'Radius.Resources/agents@2025-08-01-preview' existing = { name: agentName }
resource identity 'Radius.Resources/agentIdentities@2025-08-01-preview' existing = { name: agentName }
resource release 'Radius.Resources/agentReleases@2025-08-01-preview' = {
  name: '${agentName}-${version}'
  properties: union({
    application: app.id
    environment: environment
    agentName: agentName
    agentUid: agent.properties.agentUid
    version: version
    definition: definition
    resources: resources
    binding: {
      identity: identity.properties.identity
      identityRef: identity.properties.identityRef
      secretRef: identity.properties.secretRef
      serviceAccountName: identity.properties.serviceAccountName
    }
  }, empty(governance) ? {} : { governance: governance })
}
output captureName string = release.properties.captureName
