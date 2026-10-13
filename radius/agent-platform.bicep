extension radius
extension radiusResources

param environment string
param namespace string = 'adaptive'
param chartRepository string
param chartVersion string = '0.2.1'
param keycloakPublicUrl string
param platformValues object = {}
param login object
param loginEnvironment string
@description('Explicit model resources. Native gateway recipe accepts localService, localWorkspace, azure or members.')
param models array = []

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-platform'
  properties: { environment: environment }
}
resource controller 'Radius.Resources/agentPlatforms@2025-08-01-preview' = {
  name: 'agent-envoy-controller'
  properties: {
    application: app.id
    environment: environment
    namespace: 'envoy-gateway-system'
    repository: 'oci://docker.io/envoyproxy'
    chart: 'gateway-helm'
    chartVersion: 'v1.9.2'
    valuesJson: string({
      config: { envoyGateway: { extensionApis: { enableLua: true } } }
    })
  }
}
resource model 'Radius.Resources/aiModels@2025-08-01-preview' = [for entry in models: {
  name: entry.name
  properties: union(entry.properties, { application: app.id, environment: environment })
}]
var modelConfigs = map(models, entry => {
  name: entry.name
  digest: uniqueString(string(entry.properties))
})
resource platform 'Radius.Resources/agentPlatforms@2025-08-01-preview' = {
  name: 'agent-platform'
  dependsOn: [controller, model]
  properties: {
    application: app.id
    environment: environment
    namespace: namespace
    repository: chartRepository
    chart: 'agent-platform'
    chartVersion: chartVersion
    valuesJson: string(union(platformValues, {
      foundation: true
      keycloak: union(platformValues.?keycloak ?? {}, { publicUrl: keycloakPublicUrl })
      modelGateway: union(platformValues.?modelGateway ?? {}, {
        configs: modelConfigs
      })
    }))
  }
}
resource browserLogin 'Radius.Resources/keycloakLogins@2025-08-01-preview' = {
  name: 'agent-login'
  dependsOn: [platform]
  properties: union(login, { application: loginApp.id, environment: loginEnvironment, keycloakPublicUrl: keycloakPublicUrl })
}
resource loginApp 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'agent-login'
  properties: { environment: loginEnvironment }
}
