extension radius
extension kubernetes with {
  kubeConfig: ''
  namespace: 'default'
}

param environmentName string = 'foundry-proof'
@description('Dedicated Radius executor namespace; not a Foundry compute namespace.')
param namespace string = 'foundry-proof'
@description('Published native logical-metadata Bicep recipe.')
param logicalRecipe string
@description('Immutable Terraform archive URL including //foundry-release.')
param releaseRecipe string
@description('Explicitly selected existing Foundry project data-plane endpoint.')
param projectEndpoint string
@description('Only this explicit first release is supported; subsequent release lifecycle is not qualified.')
param initialReleaseId string
@description('Full ARM ID of an existing account-scoped RAI policy.')
param raiPolicyId string
@description('Native Azure executor credentials through Radius environment/secret bindings.')
param recipeConfig object
param plainHttp bool = false

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
          templateKind: 'bicep'
          templatePath: logicalRecipe
          plainHttp: plainHttp
          parameters: { namespace: namespace, foundryManagedIdentity: true }
        }
      }
      'Radius.Resources/agentReleases': {
        default: {
          templateKind: 'terraform'
          templatePath: releaseRecipe
          parameters: {
            project_endpoint: projectEndpoint
            initial_release_id: initialReleaseId
            rai_policy_id: raiPolicyId
          }
        }
      }
    }
  }
}
