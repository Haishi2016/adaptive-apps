extension radius
extension kubernetes with {
  kubeConfig: ''
  namespace: 'default'
}

param environmentName string = 'foundry-proof'
@description('Dedicated Radius executor namespace; not a Foundry compute namespace.')
param namespace string = 'foundry-proof'
@description('Terraform archive URL including //foundry-agent.')
param agentRecipe string
@description('Explicitly selected existing Foundry project data-plane endpoint.')
param projectEndpoint string
@description('Full ARM ID of an existing account-scoped RAI policy.')
param raiPolicyId string
@description('Native Azure executor credentials through Radius environment/secret bindings.')
param recipeConfig object

resource executorNamespace 'core/Namespace@v1' = {
  metadata: { name: namespace }
}
resource environment 'Applications.Core/environments@2023-10-01-preview' = {
  name: environmentName
  dependsOn: [executorNamespace]
  properties: {
    compute: { kind: 'kubernetes', namespace: namespace }
    providers: {}
    recipeConfig: recipeConfig
    recipes: {
      'Radius.Resources/agents': {
        default: {
          templateKind: 'terraform'
          templatePath: agentRecipe
          parameters: {
            project_endpoint: projectEndpoint
            rai_policy_id: raiPolicyId
          }
        }
      }
    }
  }
}
