extension radius
extension radiusResources

param environment string
param keycloakPublicUrl string
param login object
param loginEnvironment string
@description('Explicit model resources. Native gateway recipe accepts localService, localWorkspace, azure or members.')
param models array = []

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-services'
  properties: { environment: environment }
}
resource model 'Radius.Resources/aiModels@2025-08-01-preview' = [for entry in models: {
  name: entry.name
  properties: union(entry.properties, { application: app.id, environment: environment })
}]
resource browserLogin 'Radius.Resources/keycloakLogins@2025-08-01-preview' = {
  name: 'agent-login'
  properties: union(login, { application: loginApp.id, environment: loginEnvironment, keycloakPublicUrl: keycloakPublicUrl })
}
resource loginApp 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-login'
  properties: { environment: loginEnvironment }
}
