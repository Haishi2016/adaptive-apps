terraform {
  required_version = ">= 1.10.0, < 1.17.0"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "= 2.38.0" }
    keycloak   = { source = "keycloak/keycloak", version = "= 5.10.0" }
    random     = { source = "hashicorp/random", version = "= 3.7.2" }
  }
}

variable "context" {
  type = object({ runtime = object({ kubernetes = object({ namespace = string }) }), resource = object({
    name       = string, id = string
    properties = object({ agentName = string, agentResourceId = string, agentUid = string })
  }) })
  validation {
    condition = (
      var.context.resource.name == var.context.resource.properties.agentName &&
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.context.resource.name)) &&
      var.context.resource.properties.agentUid != "" &&
      var.context.resource.id == replace(var.context.resource.properties.agentResourceId, "agents/", "agentIdentities/")
    )
    error_message = "Identity must reference its same-name logical Radius agent and exact nonempty UID."
  }
}
variable "namespace" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.namespace))
    error_message = "Select the shared native-agent namespace from the environment binding."
  }
}
variable "keycloak_realm" {
  type    = string
  default = "adaptive"
}
variable "model_audience" {
  type    = string
  default = "api://adaptive-model-gateway"
}
variable "entra" {
  type = object({
    blueprintId          = string
    blueprintObjectId    = string
    blueprintPrincipalId = string
    entraClientId        = string
    entraObjectId        = string
    ficName              = string
    entraTenantId        = optional(string, "")
    oboClientId          = optional(string, "")
    graphDelegation      = optional(bool, false)
    agentUserId          = optional(string, "")
  })
  default = {
    blueprintId   = "", blueprintObjectId = "", blueprintPrincipalId = ""
    entraClientId = "", entraObjectId = "", ficName = ""
  }
  validation {
    condition = (
      (alltrue([for key in ["blueprintId", "blueprintObjectId", "blueprintPrincipalId", "entraClientId", "entraObjectId", "ficName", "entraTenantId", "oboClientId", "agentUserId"] : var.entra[key] == ""]) && !var.entra.graphDelegation) ||
      (alltrue([for key in ["blueprintId", "blueprintObjectId", "blueprintPrincipalId", "entraClientId", "entraObjectId"] :
        can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.entra[key]))
        ]) && var.entra.ficName == "agent-runtime" && var.entra.entraClientId == var.entra.entraObjectId &&
        alltrue([for key in ["entraTenantId", "oboClientId", "agentUserId"] :
          var.entra[key] == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.entra[key]))
        ]) &&
        ((!var.entra.graphDelegation && var.entra.oboClientId == "" && var.entra.agentUserId == "") ||
        (var.entra.entraTenantId != "" && var.entra.oboClientId != ""))
      )
    )
    error_message = "Supply either an intentional local identity or every exact connected identity ID and federation binding."
  }
}

locals {
  name     = var.context.resource.name
  ns       = var.namespace
  owner    = { "radius.resource.id" = var.context.resource.id }
  client   = "adaptive-${local.ns}-${local.name}"
  namehash = substr(sha256(local.name), 0, 32)
}

resource "keycloak_openid_client" "agent" {
  realm_id                     = var.keycloak_realm
  client_id                    = local.client
  name                         = local.name
  description                  = "Radius ${var.context.resource.id}"
  access_type                  = "CONFIDENTIAL"
  service_accounts_enabled     = true
  standard_flow_enabled        = false
  implicit_flow_enabled        = false
  direct_access_grants_enabled = false
  full_scope_allowed           = false
  lifecycle { prevent_destroy = true }
}

resource "keycloak_openid_audience_protocol_mapper" "model" {
  realm_id                 = var.keycloak_realm
  client_id                = keycloak_openid_client.agent.id
  name                     = "model-gateway"
  included_custom_audience = var.model_audience
  add_to_access_token      = true
  add_to_id_token          = false
}

resource "random_password" "identity_header" {
  length  = 48
  special = false
  lifecycle { prevent_destroy = true }
}

resource "keycloak_openid_user_property_protocol_mapper" "oid" {
  realm_id            = var.keycloak_realm
  client_id           = keycloak_openid_client.agent.id
  name                = "oid"
  user_property       = "id"
  claim_name          = "oid"
  add_to_id_token     = false
  add_to_userinfo     = false
  add_to_access_token = true
}

resource "keycloak_openid_hardcoded_claim_protocol_mapper" "agent_id" {
  realm_id            = var.keycloak_realm
  client_id           = keycloak_openid_client.agent.id
  name                = "agent_id"
  claim_name          = "agent_id"
  claim_value         = var.entra.entraClientId == "" ? local.client : var.entra.entraClientId
  add_to_id_token     = false
  add_to_userinfo     = false
  add_to_access_token = true
}

data "kubernetes_resource" "agent" {
  api_version = "v1"
  kind        = "ConfigMap"
  metadata {
    name      = "agent-${local.name}"
    namespace = local.ns
  }
  lifecycle {
    postcondition {
      condition = (
        self.object.metadata.uid == var.context.resource.properties.agentUid &&
        self.object.metadata.annotations["radius.resource.id"] == var.context.resource.properties.agentResourceId &&
        self.object.metadata.annotations["radius.identity.id"] == var.context.resource.id
      )
      error_message = "Identity binding must match the exact logical agent UID and separate Radius owners."
    }
  }
}

locals {
  uid = data.kubernetes_resource.agent.object.metadata.uid
  labels = {
    "adaptive.jplck.io/agent"     = local.name
    "adaptive.jplck.io/agent-uid" = local.uid
  }
}

resource "kubernetes_secret_v1" "identity" {
  metadata {
    name        = "identity-${local.namehash}"
    namespace   = local.ns
    labels      = local.labels
    annotations = local.owner
  }

  data = {
    IDENTITY_HEADER        = random_password.identity_header.result
    KEYCLOAK_CLIENT_SECRET = keycloak_openid_client.agent.client_secret
  }
  lifecycle { prevent_destroy = true }
}

resource "kubernetes_service_account_v1" "agent" {
  metadata {
    name      = "agent-sa-${local.namehash}"
    namespace = local.ns
    labels    = local.labels
    annotations = merge(local.owner, var.entra.blueprintId == "" ? {} : {
      "azure.workload.identity/client-id" = var.entra.blueprintId
      "azure.workload.identity/tenant-id" = var.entra.entraTenantId
    })
  }
  automount_service_account_token = false
  lifecycle { prevent_destroy = true }
}

resource "kubernetes_config_map_v1" "binding" {
  metadata {
    name        = "binding-${local.namehash}"
    namespace   = local.ns
    labels      = local.labels
    annotations = local.owner
  }
  data = {
    "identity.json" = jsonencode(merge(var.entra, {
      ownerUid             = local.uid
      keycloakClientId     = local.client
      keycloakUuid         = keycloak_openid_client.agent.id
      serviceAccountUserId = keycloak_openid_client.agent.service_account_user_id
      entraPending         = false
    }))
  }
  depends_on = [
    kubernetes_secret_v1.identity, keycloak_openid_audience_protocol_mapper.model,
    keycloak_openid_user_property_protocol_mapper.oid, keycloak_openid_hardcoded_claim_protocol_mapper.agent_id,
  ]
}

output "result" {
  value = {
    resources = []
    values = {
      agentName          = local.name
      namespace          = local.ns
      identityRef        = kubernetes_config_map_v1.binding.metadata[0].name
      secretRef          = kubernetes_secret_v1.identity.metadata[0].name
      serviceAccountName = kubernetes_service_account_v1.agent.metadata[0].name
      identity           = jsondecode(kubernetes_config_map_v1.binding.data["identity.json"])
      blueprintId        = var.entra.blueprintId
      agentId            = var.entra.entraClientId
      identityMode       = var.entra.entraClientId == "" ? "local" : "connected"
    }
  }
}
