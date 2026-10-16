extension radius
extension radiusResources

param environment string
@description('Explicit logical name, at most 32 lowercase DNS-label characters.')
@minLength(1)
@maxLength(32)
param agentName string
@allowed(['prompt', 'hosted'])
param kind string = 'prompt'
param definition object
param delegation object = { enabled: false }
param governance object = {}
param resources object = {}
param stateSize string = '1Gi'

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: '${agentName}-logical'
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
resource agent 'Radius.Resources/agents@2025-08-01-preview' = {
  name: agentName
  properties: {
    application: app.id
    environment: environment
    kind: kind
    identityRef: identity.properties.identityRef
    binding: {
      identity: identity.properties.identity
      identityRef: identity.properties.identityRef
      secretRef: identity.properties.secretRef
      serviceAccountName: identity.properties.serviceAccountName
    }
    definition: definition
    governance: governance
    resources: resources
    stateSize: stateSize
  }
}
output agentUid string = agent.properties.agentUid
output identityRef string = identity.properties.identityRef
output endpoint string = agent.properties.endpoint
