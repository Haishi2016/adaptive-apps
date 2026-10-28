extension radius
extension radiusResources

param environment string
param agentName string
param delegation object = { enabled: false }

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: '${agentName}-identity'
  properties: { environment: environment }
}
resource identity 'Radius.Resources/agentIdentities@2025-08-01-preview' = {
  name: agentName
  properties: {
    application: app.id
    environment: environment
    agentName: agentName
    delegation: delegation
  }
}
output agentResourceId string = identity.properties.agentResourceId
output agentUid string = identity.properties.agentUid
output identityRef string = identity.properties.identityRef
output identity object = identity.properties.identity
output secretRef string = identity.properties.secretRef
output serviceAccountName string = identity.properties.serviceAccountName
