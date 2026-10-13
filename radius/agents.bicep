extension radius
extension radiusResources

param environment string
@description('Explicit logical name, at most 32 lowercase DNS-label characters.')
@minLength(1)
@maxLength(32)
param agentName string
@allowed(['prompt', 'hosted'])
param kind string = 'prompt'
param activeVersion string = ''
param identityRef string = ''

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: '${agentName}-logical'
  properties: { environment: environment }
}
resource agent 'Radius.Resources/agents@2025-08-01-preview' = {
  name: agentName
  properties: {
    application: app.id
    environment: environment
    kind: kind
    activeVersion: activeVersion
    identityRef: identityRef
  }
}
output agentUid string = agent.properties.agentUid
