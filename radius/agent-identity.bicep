extension radius
extension radiusResources

param environment string
param agentName string
param delegation object = { enabled: false }

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: '${agentName}-identity'
  properties: { environment: environment }
}
resource agent 'Radius.Resources/agents@2025-08-01-preview' existing = { name: agentName }
resource identity 'Radius.Resources/agentIdentities@2025-08-01-preview' = {
  name: agentName
  properties: {
    application: app.id
    environment: environment
    agentName: agentName
    agentResourceId: agent.id
    agentUid: agent.properties.agentUid
    delegation: delegation
  }
}
output identityRef string = identity.properties.identityRef
output identity object = identity.properties.identity
output secretRef string = identity.properties.secretRef
output serviceAccountName string = identity.properties.serviceAccountName
