extension radius

@secure()
param keycloakAdminPassword string
@secure()
param keycloakConfigClientSecret string
@secure()
param adaptiveTradingClientSecret string
@secure()
param graphClientCertificate string = ''
@secure()
param graphClientCertificatePassword string = ''

resource credentials 'Applications.Core/secretStores@2023-10-01-preview' = {
  name: 'agent-provisioning'
  location: 'global'
  properties: {
    type: 'generic'
    resource: 'radius-system/agent-provisioning'
    data: union({
      'keycloak-admin-password': { value: keycloakAdminPassword }
      'keycloak-config-client-secret': { value: keycloakConfigClientSecret }
      'adaptive-trading-client-secret': { value: adaptiveTradingClientSecret }
    }, empty(graphClientCertificate) ? {} : {
      'graph-client-certificate': { value: graphClientCertificate }
      'graph-client-certificate-password': { value: graphClientCertificatePassword }
    })
  }
}
output credentialsStoreId string = credentials.id
