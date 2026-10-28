param context object
param namespace string

var properties = context.resource.properties
var service = properties.?localService ?? {}
var azure = properties.?azure ?? {}
var openai = properties.?openai ?? {}
var local = !empty(service)

output result object = {
  resources: []
  values: {
    model: properties.model
    deployment: local
      ? service.model
      : (!empty(openai) ? openai.?model ?? properties.model : azure.?deployment ?? '')
    endpoint: local
      ? 'http://${service.name}.${namespace}.svc.cluster.local:${service.port}/v1'
      : (!empty(openai) ? openai.endpoint : azure.?endpoint ?? '')
    provider: local ? 'local' : (!empty(openai) ? 'openai' : 'azure')
    apiVersion: azure.?apiVersion ?? ''
  }
}
