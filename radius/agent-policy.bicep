extension radius
extension radiusResources

param environment string
param policyName string
@description('Validated canonical PolicyDefinition JSON, including optional platform targets.')
param policyContent string
param policyDigest string
@allowed(['adaptive-guardrails-apps', 'adaptive-guardrails-platform'])
param policyNamespace string = 'adaptive-guardrails-apps'

resource app 'Applications.Core/applications@2023-10-01-preview' = {
  name: 'policy-${policyName}'
  properties: { environment: environment }
}
resource policy 'Radius.Resources/agentGuardrails@2025-08-01-preview' = {
  name: policyName
  properties: {
    application: app.id
    environment: environment
    policyNamespace: policyNamespace
    policies: policyContent
    policyDigest: policyDigest
  }
}
output bundleRef string = policy.properties.bundleRef
