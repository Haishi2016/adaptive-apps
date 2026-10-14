extension radius
extension kubernetes with {
  kubeConfig: ''
  namespace: 'default'
}

param namespace string = 'adaptive'
param environmentName string = 'agents'
param recipeRegistry string
@description('Immutable Terraform source archive; HTTPS externally or explicit cluster-local HTTP.')
param recipeArchive string
@description('Use HTTP only for the private in-cluster public-artifact registry.')
param plainHttp bool = false
param identityParameters object = {}
param connected bool = false
@description('Executor environment and Secret-store bindings. Credentials never belong in application inputs.')
param recipeConfig object = {}
param loginEnvironmentName string = 'agents-login'
@description('Dedicated Keycloak login executor credentials; do not share with agent provisioning.')
param loginRecipeConfig object
@description('Fixed platform URLs, immutable sidecar images and explicit peer grants.')
param platform object

resource agentNamespace 'core/Namespace@v1' = {
  metadata: { name: namespace }
}
resource loginNamespace 'core/Namespace@v1' = {
  metadata: { name: loginEnvironmentName }
}

resource environment 'Applications.Core/environments@2023-10-01-preview' = {
  name: environmentName
  dependsOn: [agentNamespace]
  properties: {
    compute: { kind: 'kubernetes', namespace: namespace }
    providers: {}
    recipeConfig: recipeConfig
    recipes: {
      'Radius.Resources/agents': {
        default: {
          templateKind: 'bicep'
          templatePath: '${recipeRegistry}/agents:0.5.1'
          plainHttp: plainHttp
          parameters: { platform: platform, namespace: namespace }
        }
      }
      'Radius.Resources/agentIdentities': {
        default: {
          templateKind: 'terraform'
          templatePath: '${recipeArchive}//identity-${connected ? 'connected' : 'local'}'
          parameters: union(identityParameters, { namespace: namespace })
        }
      }
      'Radius.Resources/aiModels': {
        default: {
          templateKind: 'bicep'
          templatePath: '${recipeRegistry}/ai-models:0.5.2'
          plainHttp: plainHttp
          parameters: { namespace: namespace }
        }
        kaito: {
          templateKind: 'bicep'
          templatePath: '${recipeRegistry}/ai-models-kaito:0.5.2'
          plainHttp: plainHttp
          parameters: { namespace: namespace }
        }
      }
      'Radius.Resources/aiGateways': {
        default: {
          templateKind: 'bicep'
          templatePath: '${recipeRegistry}/ai-gateways:0.2.0'
          plainHttp: plainHttp
          parameters: { namespace: namespace }
        }
      }
      'Radius.Resources/agentGuardrails': {
        default: {
          templateKind: 'bicep'
          templatePath: '${recipeRegistry}/agent-guardrails:0.3.0'
          plainHttp: plainHttp
        }
      }
    }

  }
}

resource loginEnvironment 'Applications.Core/environments@2023-10-01-preview' = {
  name: loginEnvironmentName
  dependsOn: [loginNamespace]
  properties: {
    compute: { kind: 'kubernetes', namespace: loginEnvironmentName }
    providers: {}
    recipeConfig: loginRecipeConfig
    recipes: {
      'Radius.Resources/keycloakLogins': {
        default: { templateKind: 'terraform', templatePath: '${recipeArchive}//keycloak-login' }
      }
    }
  }
}
