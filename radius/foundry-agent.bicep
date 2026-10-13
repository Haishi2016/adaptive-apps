extension radius
extension radiusResources

param environment string
@description('New proof-only logical agent name. Do not adopt an existing cloud agent.')
param agentName string
param version string
@description('Promote only after the release has been published by an earlier deployment.')
param activeVersion string = ''
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
    activeVersion: activeVersion
    identityRef: ''
    releases: {
      '${version}': {
        binding: null
        definition: definition
      }
    }
  }
}
output nativeName string = agent.properties.nativeName
output nativeVersion string = agent.properties.nativeVersion
output nativeIdentity object = agent.properties.nativeIdentity
output endpoint string = agent.properties.endpoint
