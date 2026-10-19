extension radius
extension radiusResources

param environment string
param keycloakPublicUrl string
param login object
param loginEnvironment string
@description('Explicit model resources. Each model is exposed through a separately owned AI gateway.')
param models array = []

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-services'
  properties: { environment: environment }
}
resource model 'Radius.Resources/aiModels@2025-08-01-preview' = [for entry in models: {
  name: entry.name
  properties: union(entry.properties, {
    application: app.id
    environment: environment
    recipe: { name: entry.?recipe ?? 'default' }
  })
}]
resource gateway 'Radius.Resources/aiGateways@2025-08-01-preview' = [for (entry, index) in models: {
  name: entry.name
  properties: {
    application: app.id
    environment: environment
    model: entry.name
    members: [{
      deployment: model[index].properties.deployment
      endpoint: model[index].properties.endpoint
      provider: model[index].properties.provider
      apiVersion: model[index].properties.apiVersion
      priority: entry.?priority ?? 0
      weight: entry.?weight ?? 1
    }]
  }
}]
resource browserLogin 'Radius.Resources/keycloakLogins@2025-08-01-preview' = {
  name: 'agent-login'
  properties: union(login, { application: loginApp.id, environment: loginEnvironment, keycloakPublicUrl: keycloakPublicUrl })
}
resource loginApp 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-login'
  properties: { environment: loginEnvironment }
}
