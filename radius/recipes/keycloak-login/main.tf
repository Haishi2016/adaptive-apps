terraform {
  required_version = ">= 1.10.0, < 1.17.0"
  required_providers {
    keycloak = { source = "keycloak/keycloak", version = "= 5.10.0" }
  }
}

variable "context" {
  type = object({ resource = object({ properties = object({
    realm                    = optional(string, "adaptive")
    manageEntraLinks         = optional(bool, false)
    uiOrigin                 = string, keycloakPublicUrl = string
    tradingOrigin            = optional(string, "")
    platformAudience         = optional(string, "api://adaptive-broker")
    platformRoles            = set(string), connected = optional(bool, false)
    entraTenantId            = optional(string, ""), entraClientId = optional(string, "")
    entraClientSecretVersion = optional(string, "1")
  }) }) })
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.context.resource.properties.realm))
    error_message = "Use an existing realm with a URL-safe name."
  }
  validation {
    condition     = var.context.resource.properties.tradingOrigin == "" || can(regex("^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://localhost(:[0-9]+)?)$", var.context.resource.properties.tradingOrigin))
    error_message = "Use an exact HTTPS trading origin, or loopback HTTP localhost for local development, without paths, credentials or wildcards."
  }
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?$", var.context.resource.properties.uiOrigin))
    error_message = "Use an exact HTTPS UI origin without paths, credentials or wildcards."
  }
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9_-]+)*$", var.context.resource.properties.keycloakPublicUrl))
    error_message = "Use Keycloak's stable HTTPS public URL, optionally with a path prefix, without a trailing slash."
  }
  validation {
    condition     = length(trimspace(var.context.resource.properties.platformAudience)) > 0 && !can(regex("[[:space:]*]", var.context.resource.properties.platformAudience))
    error_message = "An explicit platform API audience is required."
  }
  validation {
    condition     = length(var.context.resource.properties.platformRoles) > 0 && alltrue([for role in var.context.resource.properties.platformRoles : can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*$", role))])
    error_message = "Supply the exact role names enforced by the platform API; wildcard roles are not allowed."
  }
  validation {
    condition     = (!var.context.resource.properties.connected && var.context.resource.properties.entraTenantId == "" && var.context.resource.properties.entraClientId == "") || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.context.resource.properties.entraTenantId))
    error_message = "Use a specific Entra tenant UUID, never common or organizations."
  }
  validation {
    condition     = (!var.context.resource.properties.connected && var.context.resource.properties.entraTenantId == "" && var.context.resource.properties.entraClientId == "") || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.context.resource.properties.entraClientId))
    error_message = "Use the existing Entra web application's client UUID."
  }
}
variable "entra_client_secret" {
  type      = string
  sensitive = true
  ephemeral = true
  default   = ""
  validation {
    condition     = (var.context.resource.properties.entraTenantId == "" && var.context.resource.properties.entraClientId == "") || length(trimspace(var.entra_client_secret)) > 0
    error_message = "Supply the existing Entra credential through the executor secret store."
  }
}
locals {
  entra_configured = var.context.resource.properties.entraTenantId != "" || var.context.resource.properties.entraClientId != ""
}

data "keycloak_realm" "platform" {
  realm = var.context.resource.properties.realm
}

resource "keycloak_openid_client" "ui" {
  realm_id                        = data.keycloak_realm.platform.id
  client_id                       = "adaptive-ui"
  name                            = "Adaptive UI"
  access_type                     = "PUBLIC"
  standard_flow_enabled           = true
  pkce_code_challenge_method      = "S256"
  implicit_flow_enabled           = false
  direct_access_grants_enabled    = false
  service_accounts_enabled        = false
  full_scope_allowed              = false
  valid_redirect_uris             = ["${var.context.resource.properties.uiOrigin}/auth/callback"]
  valid_post_logout_redirect_uris = [var.context.resource.properties.uiOrigin]
  web_origins                     = [var.context.resource.properties.uiOrigin]
  lifecycle { prevent_destroy = true }
}

data "keycloak_openid_client" "trading" {
  count     = var.context.resource.properties.tradingOrigin == "" ? 0 : 1
  realm_id  = data.keycloak_realm.platform.id
  client_id = "adaptive-trading"
}

resource "keycloak_openid_client" "api" {
  realm_id                     = data.keycloak_realm.platform.id
  client_id                    = "adaptive-platform-api"
  name                         = "Adaptive platform API"
  access_type                  = "BEARER-ONLY"
  standard_flow_enabled        = false
  implicit_flow_enabled        = false
  direct_access_grants_enabled = false
  service_accounts_enabled     = false
  full_scope_allowed           = false
  lifecycle { prevent_destroy = true }
}

resource "keycloak_role" "platform" {
  for_each  = var.context.resource.properties.platformRoles
  realm_id  = data.keycloak_realm.platform.id
  client_id = keycloak_openid_client.api.id
  name      = each.value
}

resource "keycloak_generic_role_mapper" "ui_scope" {
  for_each  = keycloak_role.platform
  realm_id  = data.keycloak_realm.platform.id
  client_id = keycloak_openid_client.ui.id
  role_id   = each.value.id
}

resource "keycloak_generic_role_mapper" "trading_scope" {
  for_each  = var.context.resource.properties.tradingOrigin == "" ? {} : keycloak_role.platform
  realm_id  = data.keycloak_realm.platform.id
  client_id = data.keycloak_openid_client.trading[0].id
  role_id   = each.value.id
}

resource "keycloak_openid_user_client_role_protocol_mapper" "ui_roles" {
  realm_id                    = data.keycloak_realm.platform.id
  client_id                   = keycloak_openid_client.ui.id
  name                        = "platform-roles"
  claim_name                  = "roles"
  client_id_for_role_mappings = keycloak_openid_client.api.client_id
  multivalued                 = true
  add_to_access_token         = true
  add_to_id_token             = false
  add_to_userinfo             = false
}

resource "keycloak_openid_user_client_role_protocol_mapper" "trading_roles" {
  count                       = var.context.resource.properties.tradingOrigin == "" ? 0 : 1
  realm_id                    = data.keycloak_realm.platform.id
  client_id                   = data.keycloak_openid_client.trading[0].id
  name                        = "platform-roles"
  claim_name                  = "roles"
  client_id_for_role_mappings = keycloak_openid_client.api.client_id
  multivalued                 = true
  add_to_access_token         = true
  add_to_id_token             = false
  add_to_userinfo             = false
}

resource "keycloak_openid_audience_protocol_mapper" "ui_audience" {
  realm_id                 = data.keycloak_realm.platform.id
  client_id                = keycloak_openid_client.ui.id
  name                     = "platform-api"
  included_custom_audience = var.context.resource.properties.platformAudience
  add_to_access_token      = true
  add_to_id_token          = false
}

resource "keycloak_openid_audience_protocol_mapper" "trading_audience" {
  count                    = var.context.resource.properties.tradingOrigin == "" ? 0 : 1
  realm_id                 = data.keycloak_realm.platform.id
  client_id                = data.keycloak_openid_client.trading[0].id
  name                     = "platform-api"
  included_custom_audience = var.context.resource.properties.platformAudience
  add_to_access_token      = true
  add_to_id_token          = false
}

resource "keycloak_openid_user_property_protocol_mapper" "ui_oid" {
  realm_id            = data.keycloak_realm.platform.id
  client_id           = keycloak_openid_client.ui.id
  name                = "oid"
  user_property       = "id"
  claim_name          = "oid"
  add_to_access_token = true
  add_to_id_token     = false
  add_to_userinfo     = false
}

resource "keycloak_openid_user_property_protocol_mapper" "trading_oid" {
  count               = var.context.resource.properties.tradingOrigin == "" ? 0 : 1
  realm_id            = data.keycloak_realm.platform.id
  client_id           = data.keycloak_openid_client.trading[0].id
  name                = "oid"
  user_property       = "id"
  claim_name          = "oid"
  add_to_access_token = true
  add_to_id_token     = false
  add_to_userinfo     = false
}

resource "keycloak_authentication_flow" "approved_accounts" {
  count       = local.entra_configured ? 1 : 0
  realm_id    = data.keycloak_realm.platform.id
  alias       = "adaptive-prelinked-entra"
  description = "Unlinked Entra accounts require administrator-reviewed account linking."
  lifecycle { prevent_destroy = true }
}

resource "keycloak_authentication_execution" "deny_unlinked" {
  count             = local.entra_configured ? 1 : 0
  realm_id          = data.keycloak_realm.platform.id
  parent_flow_alias = keycloak_authentication_flow.approved_accounts[0].alias
  authenticator     = "deny-access-authenticator"
  requirement       = "REQUIRED"
}

resource "keycloak_oidc_identity_provider" "entra" {
  count        = local.entra_configured ? 1 : 0
  realm        = data.keycloak_realm.platform.id
  alias        = "entra"
  display_name = "Microsoft Entra"
  enabled      = var.context.resource.properties.connected
  # Disabled providers are hidden; link-only also rejects direct broker login.
  link_only                     = !var.context.resource.properties.connected
  client_id                     = var.context.resource.properties.entraClientId
  client_secret_wo              = var.entra_client_secret
  client_secret_wo_version      = var.context.resource.properties.entraClientSecretVersion
  authorization_url             = "https://login.microsoftonline.com/${var.context.resource.properties.entraTenantId}/oauth2/v2.0/authorize"
  token_url                     = "https://login.microsoftonline.com/${var.context.resource.properties.entraTenantId}/oauth2/v2.0/token"
  logout_url                    = "https://login.microsoftonline.com/${var.context.resource.properties.entraTenantId}/oauth2/v2.0/logout"
  issuer                        = "https://login.microsoftonline.com/${var.context.resource.properties.entraTenantId}/v2.0"
  jwks_url                      = "https://login.microsoftonline.com/${var.context.resource.properties.entraTenantId}/discovery/v2.0/keys"
  validate_signature            = true
  disable_user_info             = true
  default_scopes                = "openid profile email"
  store_token                   = false
  add_read_token_role_on_create = false
  trust_email                   = false
  sync_mode                     = "IMPORT"
  first_broker_login_flow_alias = keycloak_authentication_flow.approved_accounts[0].alias
  extra_config                  = { clientAuthMethod = "client_secret_post" }
  depends_on                    = [keycloak_authentication_execution.deny_unlinked]
  lifecycle { prevent_destroy = true }
}

output "result" {
  value = {
    resources = []
    values = {
      issuer                = "${var.context.resource.properties.keycloakPublicUrl}/realms/${var.context.resource.properties.realm}"
      discoveryUrl          = "${var.context.resource.properties.keycloakPublicUrl}/realms/${var.context.resource.properties.realm}/.well-known/openid-configuration"
      entraRedirectUri      = local.entra_configured ? "${var.context.resource.properties.keycloakPublicUrl}/realms/${var.context.resource.properties.realm}/broker/entra/endpoint" : null
      uiClientId            = keycloak_openid_client.ui.client_id
      tradingClientId       = length(data.keycloak_openid_client.trading) == 1 ? data.keycloak_openid_client.trading[0].client_id : null
      platformAudience      = var.context.resource.properties.platformAudience
      connectedLoginEnabled = local.entra_configured ? keycloak_oidc_identity_provider.entra[0].enabled : false
    }
  }
}
