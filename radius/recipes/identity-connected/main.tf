terraform {
  required_version = ">= 1.10.0, < 1.17.0"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "= 2.38.0" }
    keycloak   = { source = "keycloak/keycloak", version = "= 5.10.0" }
    msgraph    = { source = "microsoft/msgraph", version = "= 0.6.0" }
  }
}
variable "context" {
  type = object({ runtime = object({ kubernetes = object({ namespace = string }) }), resource = object({
    name = string, id = string
    properties = object({
      agentName = string
      delegation = optional(object({
        enabled  = optional(bool, false)
        tenantId = optional(string, "")
        uiOrigin = optional(string, "")
        permissions = optional(list(object({
          resourceAppId       = string
          resourcePrincipalId = string
          scopes              = list(object({ id = string, value = string }))
        })), [])
        agentUser = optional(object({
          userPrincipalName = string
          displayName       = string
          mailNickname      = string
        }))
      }), {})
    })
  }) })
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.context.resource.name))
    error_message = "Agent name must be a DNS label before provisioning remote identity."
  }
  validation {
    condition = !var.context.resource.properties.delegation.enabled || (
      var.context.resource.properties.delegation.tenantId == var.tenant_id &&
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.context.resource.properties.delegation.tenantId)) &&
      can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?$", var.context.resource.properties.delegation.uiOrigin)) &&
      (var.context.resource.properties.delegation.agentUser == null ? true : (
        can(regex("^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.context.resource.properties.delegation.agentUser.userPrincipalName)) &&
        length(trimspace(var.context.resource.properties.delegation.agentUser.displayName)) > 0 &&
        can(regex("^[A-Za-z0-9._-]+$", var.context.resource.properties.delegation.agentUser.mailNickname))
      )) &&
      length(var.context.resource.properties.delegation.permissions) > 0 &&
      length(distinct([for permission in var.context.resource.properties.delegation.permissions : permission.resourceAppId])) == length(var.context.resource.properties.delegation.permissions) &&
      alltrue([for permission in var.context.resource.properties.delegation.permissions :
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", permission.resourceAppId)) &&
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", permission.resourcePrincipalId)) &&
        length(permission.scopes) > 0 &&
        length(distinct([for scope in permission.scopes : scope.id])) == length(permission.scopes) &&
        length(distinct([for scope in permission.scopes : scope.value])) == length(permission.scopes) &&
        alltrue([for scope in permission.scopes :
          can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", scope.id)) &&
          can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*$", scope.value))
        ])
      ])
    )
    error_message = "Delegation requires the executor tenant, exact HTTPS UI origin, unique reviewed resource/scopes and valid optional agent-user attributes."
  }
}
variable "namespace" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.namespace))
    error_message = "Select the shared native-agent namespace before creating blueprint federation."
  }
}
variable "tenant_id" {
  type    = string
  default = ""
  validation {
    condition = (
      var.tenant_id == "" ||
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.tenant_id))
    )
    error_message = "Use the exact Entra tenant UUID; delegation requires a configured tenant."
  }
}
variable "sponsor_user_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.sponsor_user_id))
    error_message = "Use an explicit Entra sponsor user object ID."
  }
}
variable "owner_user_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.owner_user_id))
    error_message = "Use an explicit Entra owner user object ID."
  }
}
variable "oidc_issuer" {
  type = string
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~%-]+)*/$", var.oidc_issuer))
    error_message = "Use the cluster's exact HTTPS OIDC issuer, including its trailing slash."
  }
}

provider "msgraph" {
  use_cli                   = false
  use_powershell            = false
  use_msi                   = false
  use_oidc                  = false
  use_aks_workload_identity = false
}

provider "kubernetes" {
  host                   = "https://kubernetes.default.svc"
  cluster_ca_certificate = try(file("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"), null)
  token                  = try(file("/var/run/secrets/kubernetes.io/serviceaccount/token"), null)
}

locals {
  # Keep every creation input here. Runtime updates must never repeat a Graph POST.
  identity_inputs = {
    name      = var.context.resource.name
    radius_id = replace(var.context.resource.id, "agentIdentities", "agents")
    sponsor   = var.sponsor_user_id
    owner     = var.owner_user_id
    issuer    = var.oidc_issuer
    subject   = "system:serviceaccount:${var.namespace}:agent-sa-${substr(sha256(var.context.resource.name), 0, 32)}"
  }
  headers = { "OData-Version" = "4.0" }
  uuid    = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
}

resource "terraform_data" "identity_contract" {
  input            = local.identity_inputs
  triggers_replace = local.identity_inputs
  lifecycle { prevent_destroy = true }
}

resource "msgraph_resource_action" "blueprint" {
  resource_url = "applications/microsoft.graph.agentIdentityBlueprint"
  api_version  = "v1.0"
  method       = "POST"
  headers      = local.headers
  body = {
    displayName           = "${local.identity_inputs.name}-blueprint"
    description           = "Radius ${local.identity_inputs.radius_id}"
    "sponsors@odata.bind" = ["https://graph.microsoft.com/v1.0/users/${local.identity_inputs.sponsor}"]
    "owners@odata.bind"   = ["https://graph.microsoft.com/v1.0/users/${local.identity_inputs.owner}"]
  }
  response_export_values = { object_id = "id", app_id = "appId" }
  lifecycle {
    prevent_destroy      = true
    replace_triggered_by = [terraform_data.identity_contract]
    postcondition {
      condition     = can(regex(local.uuid, self.output.object_id)) && can(regex(local.uuid, self.output.app_id))
      error_message = "Graph did not return blueprint object/client IDs; stop and recover the partial creation."
    }
  }
}

resource "msgraph_resource_action" "principal" {
  resource_url           = "servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal"
  api_version            = "v1.0"
  method                 = "POST"
  headers                = local.headers
  body                   = { appId = msgraph_resource_action.blueprint.output.app_id }
  response_export_values = { object_id = "id" }
  lifecycle {
    prevent_destroy      = true
    replace_triggered_by = [terraform_data.identity_contract]
    postcondition {
      condition     = can(regex(local.uuid, self.output.object_id))
      error_message = "Graph did not return the blueprint principal object ID; recover the partial creation."
    }
  }
}

resource "msgraph_resource_action" "fic" {
  resource_url = "applications/${msgraph_resource_action.blueprint.output.object_id}/federatedIdentityCredentials"
  api_version  = "v1.0"
  method       = "POST"
  headers      = local.headers
  body = {
    name      = "agent-runtime"
    issuer    = local.identity_inputs.issuer
    subject   = local.identity_inputs.subject
    audiences = ["api://AzureADTokenExchange"]
  }
  response_export_values = { object_id = "id" }
  lifecycle {
    prevent_destroy      = true
    replace_triggered_by = [terraform_data.identity_contract]
    postcondition {
      condition     = can(regex(local.uuid, self.output.object_id))
      error_message = "Graph did not return the federation object ID; recover the partial creation."
    }
  }
}

resource "msgraph_resource_action" "agent" {
  resource_url = "servicePrincipals/microsoft.graph.agentIdentity"
  api_version  = "v1.0"
  method       = "POST"
  headers      = local.headers
  body = {
    displayName              = local.identity_inputs.name
    agentIdentityBlueprintId = msgraph_resource_action.blueprint.output.app_id
    "sponsors@odata.bind"    = ["https://graph.microsoft.com/v1.0/users/${local.identity_inputs.sponsor}"]
    "owners@odata.bind"      = ["https://graph.microsoft.com/v1.0/users/${local.identity_inputs.owner}"]
  }
  response_export_values = { object_id = "id" }
  depends_on             = [msgraph_resource_action.principal, msgraph_resource_action.fic]
  lifecycle {
    prevent_destroy      = true
    replace_triggered_by = [terraform_data.identity_contract]
    postcondition {
      condition     = can(regex(local.uuid, self.output.object_id))
      error_message = "Graph did not return an Agent ID; recover the partial creation before retrying."
    }
  }
}

module "identity" {
  source    = "../identity"
  context   = var.context
  namespace = var.namespace
  entra = {
    blueprintId          = msgraph_resource_action.blueprint.output.app_id
    blueprintObjectId    = msgraph_resource_action.blueprint.output.object_id
    blueprintPrincipalId = msgraph_resource_action.principal.output.object_id
    entraClientId        = msgraph_resource_action.agent.output.object_id
    entraObjectId        = msgraph_resource_action.agent.output.object_id
    ficName              = "agent-runtime"
    entraTenantId        = var.tenant_id
    oboClientId          = local.delegation.enabled ? msgraph_resource.obo_client[0].output.app_id : ""
    graphDelegation      = local.graph_delegation
    agentUserId          = local.agent_user == null ? "" : msgraph_resource.agent_user[0].id
  }
  depends_on = [msgraph_resource_action.delete_agent]
}

# Explicit cleanup runs only after deletion protection is deliberately removed.
# Dependencies reverse on destroy: runtime/local identity, Agent ID, principal,
# then blueprint (which includes its FIC). No display-name lookup or hard purge.
resource "msgraph_resource_action" "delete_blueprint" {
  resource_url = "applications/${msgraph_resource_action.blueprint.output.object_id}"
  api_version  = "v1.0"
  method       = "DELETE"
  when         = "destroy"
  headers      = local.headers
}
resource "msgraph_resource_action" "delete_principal" {
  resource_url = "servicePrincipals/${msgraph_resource_action.principal.output.object_id}"
  api_version  = "v1.0"
  method       = "DELETE"
  when         = "destroy"
  headers      = local.headers
  depends_on   = [msgraph_resource_action.delete_blueprint]
}
resource "msgraph_resource_action" "delete_agent" {
  resource_url = "servicePrincipals/${msgraph_resource_action.agent.output.object_id}"
  api_version  = "v1.0"
  method       = "DELETE"
  when         = "destroy"
  headers      = local.headers
  depends_on   = [msgraph_resource_action.delete_principal]
}
output "result" { value = module.identity.result }
