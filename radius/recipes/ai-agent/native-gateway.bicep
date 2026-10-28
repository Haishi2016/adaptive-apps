extension kubernetes with {
  kubeConfig: ''
  namespace: namespace
} as k8s

param context object
param namespace string

var properties = context.resource.properties
var deployments = map(properties.members, member => {
  model_name: properties.model
  litellm_params: union({
    model: member.provider == 'local' ? 'openai/${member.deployment}' : '${member.provider}/${member.deployment}'
    api_base: member.endpoint
    max_retries: properties.?maxRetries ?? 0
  }, member.provider == 'local' ? {
    api_key: 'unused-local-no-auth'
  } : member.provider == 'openai' ? {
    api_key: 'os.environ/OPENAI_API_KEY'
  } : empty(member.?apiVersion ?? '') ? {} : {
    api_version: member.apiVersion
  }, {
      order: member.priority
      weight: member.weight
  })
})
var config = {
  'config.yaml': string({ model_list: deployments })
}

resource model 'core/ConfigMap@v1' = {
  metadata: {
    name: context.resource.name
    namespace: namespace
    annotations: { 'radius.resource.id': context.resource.id }
  }
  data: config
}

output result object = {
  resources: ['/planes/kubernetes/local/namespaces/${namespace}/providers/core/ConfigMap/${context.resource.name}']
  values: {
    model: properties.model
    endpoint: 'http://model-ingress.${namespace}.svc.cluster.local:8080/v1'
    provider: 'gateway'
    configMapName: context.resource.name
    configDigest: uniqueString(string(config))
    deployments: deployments
    discovery: '/v1/models'
  }
}
