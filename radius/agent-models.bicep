extension radius
extension radiusResources

param environment string
param localWorkspace object
param azure object = {}
param localName string = 'local-chat'
param localModel string = localName
param cloudName string = 'foundry-chat'
param hybridName string = 'hybrid-chat'
@description('Smaller priorities are tried first; equal priorities use relative weights.')
param localPriority int = 0
param cloudPriority int = 1

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-models'
  properties: { environment: environment }
}
resource local 'Radius.Resources/aiModels@2025-08-01-preview' = {
  name: localName
  properties: {
    application: app.id
    environment: environment
    model: localModel
    localWorkspace: localWorkspace
  }
}
resource cloud 'Radius.Resources/aiModels@2025-08-01-preview' = if (!empty(azure)) {
  name: cloudName
  properties: {
    application: app.id
    environment: environment
    model: cloudName
    azure: azure
  }
}
resource hybrid 'Radius.Resources/aiModels@2025-08-01-preview' = if (!empty(azure)) {
  name: hybridName
  properties: {
    application: app.id
    environment: environment
    model: hybridName
    members: [
      { model: local.properties.model, deployments: local.properties.deployments, priority: localPriority, weight: 1 }
      { model: cloud!.properties.model, deployments: cloud!.properties.deployments, priority: cloudPriority, weight: 1 }
    ]
  }
}
