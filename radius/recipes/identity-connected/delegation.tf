locals {
  delegation = var.context.resource.properties.delegation
  permissions = {
    for permission in local.delegation.permissions : permission.resourceAppId => permission
    if local.delegation.enabled
  }
  agent_user      = local.delegation.enabled ? local.delegation.agentUser : null
  access_scope_id = uuidv5("url", "api://${msgraph_resource_action.blueprint.output.app_id}/access_agent")
  access_scope = {
    id                      = local.access_scope_id
    value                   = "access_agent"
    type                    = "Admin"
    isEnabled               = true
    adminConsentDisplayName = "Access the agent"
    adminConsentDescription = "Allow the reviewed browser client to call this agent on behalf of the signed-in user."
    userConsentDisplayName  = "Access the agent"
    userConsentDescription  = "Call this agent on your behalf."
  }
  # This is the graph-me capability, not a source of permission declarations.
  graph_delegation = try(
    contains([for scope in local.permissions["00000003-0000-0000-c000-000000000000"].scopes : "${scope.id}/${scope.value}"], "e1fe6dd8-ba31-4d61-89e7-88639da4683d/User.Read") &&
    msgraph_resource.resource_consent["00000003-0000-0000-c000-000000000000"].id != "" &&
    msgraph_update_resource.scope_inheritance["00000003-0000-0000-c000-000000000000"].output.resource_app_id == "00000003-0000-0000-c000-000000000000" &&
    msgraph_resource.obo_consent[0].id != "",
    false
  )
}

resource "terraform_data" "agent_user_contract" {
  count = local.agent_user == null ? 0 : 1
  input = {
    parent = msgraph_resource_action.agent.output.object_id
    upn    = local.agent_user.userPrincipalName
    alias  = local.agent_user.mailNickname
  }
  triggers_replace = {
    parent = msgraph_resource_action.agent.output.object_id
    upn    = local.agent_user.userPrincipalName
    alias  = local.agent_user.mailNickname
  }
  lifecycle { prevent_destroy = true }
}

# Update only the retained blueprint's API fields. Preserve other scopes,
# resource declarations and identifier URIs; never repeat its creation POST.
data "msgraph_resource" "blueprint_api" {
  count       = local.delegation.enabled ? 1 : 0
  url         = "applications/${msgraph_resource_action.blueprint.output.object_id}"
  api_version = "v1.0"
  query_parameters = {
    "$select" = ["id,appId,api,identifierUris,requiredResourceAccess"]
  }
  response_export_values = { api = "api", uris = "identifierUris", access = "requiredResourceAccess" }
}

resource "msgraph_update_resource" "blueprint_api" {
  count       = local.delegation.enabled ? 1 : 0
  url         = data.msgraph_resource.blueprint_api[0].url
  api_version = "v1.0"
  body = {
    identifierUris = distinct(concat(data.msgraph_resource.blueprint_api[0].output.uris, ["api://${msgraph_resource_action.blueprint.output.app_id}"]))
    api = merge(data.msgraph_resource.blueprint_api[0].output.api, {
      requestedAccessTokenVersion = 2
      oauth2PermissionScopes = concat([
        for scope in data.msgraph_resource.blueprint_api[0].output.api.oauth2PermissionScopes : scope
        if scope.value != "access_agent"
      ], [local.access_scope])
    })
    requiredResourceAccess = concat([
      for access in data.msgraph_resource.blueprint_api[0].output.access : access
      if !contains(keys(local.permissions), access.resourceAppId)
      ], [
      for resource_app_id, permission in local.permissions : {
        resourceAppId  = resource_app_id
        resourceAccess = [for scope in permission.scopes : { id = scope.id, type = "Scope" }]
      }
    ])
  }
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = alltrue([
        for scope in data.msgraph_resource.blueprint_api[0].output.api.oauth2PermissionScopes :
        (scope.value != "access_agent" && scope.id != local.access_scope_id) ||
        (scope.value == "access_agent" && scope.id == local.access_scope_id && scope.isEnabled && scope.type == "Admin")
      ])
      error_message = "Existing access_agent scope differs; review its exact ID rather than overwriting it."
    }
    precondition {
      condition = alltrue(flatten([
        for access in data.msgraph_resource.blueprint_api[0].output.access : [
          for permission in access.resourceAccess :
          permission.type == "Scope" && contains([for scope in local.permissions[access.resourceAppId].scopes : scope.id], permission.id)
        ] if contains(keys(local.permissions), access.resourceAppId)
      ]))
      error_message = "Existing permissions exceed the explicit approval; review inheritance instead of silently removing permissions."
    }
  }
}

resource "msgraph_resource" "obo_client" {
  count       = local.delegation.enabled ? 1 : 0
  url         = "applications"
  api_version = "v1.0"
  body = {
    displayName    = "${local.identity_inputs.name}-browser"
    signInAudience = "AzureADMyOrg"
    spa            = { redirectUris = ["${local.delegation.uiOrigin}/auth/entra-callback"] }
    requiredResourceAccess = [{
      resourceAppId  = msgraph_resource_action.blueprint.output.app_id
      resourceAccess = [{ id = local.access_scope_id, type = "Scope" }]
    }]
  }
  response_export_values = { app_id = "appId" }
  depends_on             = [msgraph_update_resource.blueprint_api]
  lifecycle {
    prevent_destroy = true
    postcondition {
      condition     = can(regex(local.uuid, self.id)) && can(regex(local.uuid, self.output.app_id))
      error_message = "The public browser client must have exact object and application IDs."
    }
  }
}

resource "msgraph_resource" "obo_principal" {
  count       = local.delegation.enabled ? 1 : 0
  url         = "servicePrincipals"
  api_version = "v1.0"
  body        = { appId = msgraph_resource.obo_client[0].output.app_id }
  lifecycle { prevent_destroy = true }
}

data "msgraph_resource" "resource_principal" {
  for_each               = local.permissions
  url                    = "servicePrincipals/${each.value.resourcePrincipalId}"
  api_version            = "v1.0"
  response_export_values = { app_id = "appId", scopes = "oauth2PermissionScopes" }
  lifecycle {
    postcondition {
      condition = (
        self.output.app_id == each.key &&
        alltrue([for scope in each.value.scopes :
          anytrue([for published in self.output.scopes : published.id == scope.id && published.value == scope.value && published.isEnabled])
        ])
      )
      error_message = "The reviewed resource principal must publish every exact approved scope ID/name."
    }
  }
}

data "msgraph_resource" "blueprint_grants" {
  count       = local.delegation.enabled ? 1 : 0
  url         = "oauth2PermissionGrants"
  api_version = "v1.0"
  query_parameters = {
    "$filter" = ["clientId eq '${msgraph_resource_action.principal.output.object_id}'"]
  }
  response_export_values = { grants = "value", next_link = "\"@odata.nextLink\"" }
  lifecycle {
    postcondition {
      condition     = self.output.next_link == null
      error_message = "Consent inventory is paginated; review the complete grants rather than validating an incomplete page."
    }
  }
}

resource "msgraph_resource" "resource_consent" {
  for_each    = local.permissions
  url         = "oauth2PermissionGrants"
  api_version = "v1.0"
  body = {
    clientId    = msgraph_resource_action.principal.output.object_id
    resourceId  = each.value.resourcePrincipalId
    consentType = "AllPrincipals"
    scope       = join(" ", sort([for scope in each.value.scopes : scope.value]))
  }
  depends_on = [data.msgraph_resource.resource_principal, msgraph_update_resource.blueprint_api]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = alltrue(flatten([
        for grant in data.msgraph_resource.blueprint_grants[0].output.grants : [
          for scope in split(" ", trimspace(grant.scope)) :
          contains([for approved in each.value.scopes : approved.value], scope)
        ] if grant.resourceId == each.value.resourcePrincipalId
      ]))
      error_message = "Existing consent exceeds approved scopes; review the existing grant instead of duplicating or silently narrowing it."
    }
  }
}

resource "msgraph_resource" "obo_consent" {
  count       = local.delegation.enabled ? 1 : 0
  url         = "oauth2PermissionGrants"
  api_version = "v1.0"
  body = {
    clientId    = msgraph_resource.obo_principal[0].id
    resourceId  = msgraph_resource_action.principal.output.object_id
    consentType = "AllPrincipals"
    scope       = "access_agent"
  }
  lifecycle { prevent_destroy = true }
}

# Freeze the creation body; exact-key PATCH owns subsequent approval changes.
resource "msgraph_resource_action" "scope_inheritance" {
  for_each     = local.permissions
  resource_url = "applications/${msgraph_resource_action.blueprint.output.object_id}/microsoft.graph.agentIdentityBlueprint/inheritablePermissions"
  api_version  = "v1.0"
  method       = "POST"
  headers      = local.headers
  body = {
    resourceAppId = each.key
    inheritableScopes = {
      "@odata.type" = "microsoft.graph.enumeratedScopes"
      scopes        = sort([for scope in each.value.scopes : scope.value])
    }
  }
  response_export_values = {
    resource_app_id = "resourceAppId"
    scopes_kind     = "inheritableScopes.kind"
    scopes          = "inheritableScopes.scopes"
  }
  depends_on = [msgraph_resource.resource_consent]
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [body]
    postcondition {
      condition = (
        self.output.resource_app_id == each.key &&
        self.output.scopes_kind == "enumerated" &&
        toset(self.output.scopes) == toset(self.body.inheritableScopes.scopes)
      )
      error_message = "Graph must return the exact resourceAppId and delegated-only inheritance; recover a partial creation before retrying."
    }
  }
}

resource "msgraph_update_resource" "scope_inheritance" {
  for_each    = local.permissions
  url         = "${msgraph_resource_action.scope_inheritance[each.key].resource_url}/${msgraph_resource_action.scope_inheritance[each.key].output.resource_app_id}"
  api_version = "v1.0"
  body = {
    inheritableScopes = {
      "@odata.type" = "microsoft.graph.enumeratedScopes"
      scopes        = sort([for scope in each.value.scopes : scope.value])
    }
  }
  response_export_values = {
    resource_app_id = "resourceAppId"
    scopes_kind     = "inheritableScopes.kind"
    scopes          = "inheritableScopes.scopes"
  }
  lifecycle {
    prevent_destroy = true
    postcondition {
      condition = (
        self.output.resource_app_id == each.key &&
        self.output.scopes_kind == "enumerated"
      )
      error_message = "The inheritance readback must retain the exact resource key and enumerated delegated scope type."
    }
  }
}

resource "msgraph_resource_action" "delete_scope_inheritance" {
  for_each     = local.permissions
  resource_url = "applications/${msgraph_resource_action.blueprint.output.object_id}/microsoft.graph.agentIdentityBlueprint/inheritablePermissions/${msgraph_resource_action.scope_inheritance[each.key].output.resource_app_id}"
  api_version  = "v1.0"
  method       = "DELETE"
  when         = "destroy"
  headers      = local.headers
  depends_on   = [msgraph_resource_action.delete_blueprint, msgraph_update_resource.scope_inheritance]
}

resource "msgraph_resource" "agent_user" {
  count       = local.agent_user == null ? 0 : 1
  url         = "users/microsoft.graph.agentUser"
  api_version = "v1.0"
  body = merge(local.agent_user, {
    accountEnabled   = true
    identityParentId = msgraph_resource_action.agent.output.object_id
  })
  lifecycle {
    prevent_destroy      = true
    replace_triggered_by = [terraform_data.agent_user_contract]
    postcondition {
      condition     = can(regex(local.uuid, self.id))
      error_message = "Graph did not return the real bound agent-user object ID."
    }
  }
}
