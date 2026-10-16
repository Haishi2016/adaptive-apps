extension radius
extension radiusResources

param environment string
@description('New proof-only agent name. Do not adopt an existing cloud agent.')
param agentName string
@description('Native prompt definition or unchanged hosted ACR image digest and cloud environment.')
param definition object

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: agentName
  properties: { environment: environment }
}
resource agent 'Radius.Resources/agents@2025-08-01-preview' = {
  name: agentName
  properties: {
    application: app.id
    environment: environment
    kind: definition.kind
    identityRef: ''
    binding: null
    definition: definition
  }
}
output nativeName string = agent.properties.nativeName
output nativeIdentity object = agent.properties.nativeIdentity
output endpoint string = agent.properties.endpoint
