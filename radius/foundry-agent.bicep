extension radius
extension radiusResources

param environment string
@description('New proof-only logical agent name. Do not adopt an existing cloud agent.')
param agentName string
param version string
@description('Native prompt definition or unchanged hosted ACR image digest and cloud environment.')
param definition object

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: '${agentName}-${version}'
  properties: { environment: environment }
}
resource agent 'Radius.Resources/agents@2025-08-01-preview' = {
  name: agentName
  properties: {
    application: app.id
    environment: environment
    kind: definition.kind
  }
}
resource release 'Radius.Resources/agentReleases@2025-08-01-preview' = {
  name: '${agentName}-${version}'
  properties: {
    application: app.id
    environment: environment
    agentName: agentName
    agentUid: agent.properties.agentUid
    version: version
    binding: null
    definition: definition
  }
}
output nativeName string = release.properties.nativeName
output nativeVersion string = release.properties.nativeVersion
output nativeIdentity object = release.properties.nativeIdentity
output endpoint string = release.properties.endpoint
