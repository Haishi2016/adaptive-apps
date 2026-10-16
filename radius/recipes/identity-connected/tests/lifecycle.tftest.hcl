mock_provider "msgraph" {
  mock_resource "msgraph_resource" {
    defaults = {
      id     = "99999999-9999-4999-8999-999999999999"
      output = { app_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
    }
  }
  mock_data "msgraph_resource" {
    defaults = { output = {
      app_id    = "00000003-0000-0000-c000-000000000000"
      scopes    = [{ id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d", value = "User.Read", isEnabled = true }]
      grants    = []
      next_link = null
      api = {
        oauth2PermissionScopes = [{
          id = "ffffffff-ffff-4fff-8fff-ffffffffffff", value = "ExistingScope", isEnabled = true, type = "User"
        }]
        preAuthorizedApplications = []
      }
      uris = ["api://retained-resource"]
      access = [{
        resourceAppId  = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        resourceAccess = [{ id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", type = "Scope" }]
      }]
    } }
  }
}
mock_provider "keycloak" {
  mock_resource "keycloak_openid_client" {
    defaults = { id = "keycloak-object", client_secret = "test-only-client-secret", service_account_user_id = "service-user" }
  }
}
mock_provider "kubernetes" {}
variables {
  namespace = "adaptive"
  context = { runtime = { kubernetes = { namespace = "adaptive-scout-identity" } }, resource = {
    name       = "scout", id = "/radius/agentIdentities/scout"
    properties = { agentName = "scout" }
  } }
  sponsor_user_id = "77777777-7777-4777-8777-777777777777"
  owner_user_id   = "88888888-8888-4888-8888-888888888888"
  oidc_issuer     = "https://issuer.example/"
}
override_resource {
  target = msgraph_resource_action.blueprint
  override_during = plan
  values = { output = { object_id = "22222222-2222-4222-8222-222222222222", app_id = "11111111-1111-4111-8111-111111111111" } }
}
override_resource {
  target = msgraph_resource_action.principal
  override_during = plan
  values = { output = { object_id = "33333333-3333-4333-8333-333333333333" } }
}
override_resource {
  target = msgraph_resource_action.fic
  override_during = plan
  values = { output = { object_id = "66666666-6666-4666-8666-666666666666" } }
}
override_resource {
  target = msgraph_resource_action.agent
  override_during = plan
  values = { output = { object_id = "55555555-5555-4555-8555-555555555555" } }
}
override_resource {
  target = msgraph_resource_action.scope_inheritance["00000003-0000-0000-c000-000000000000"]
  override_during = plan
  values = { output = {
    resource_app_id = "00000003-0000-0000-c000-000000000000", scopes_kind = "enumerated", scopes = ["User.Read"]
  } }
}
override_resource {
  target = msgraph_update_resource.scope_inheritance["00000003-0000-0000-c000-000000000000"]
  override_during = plan
  values = { output = {
    resource_app_id = "00000003-0000-0000-c000-000000000000", scopes_kind = "enumerated", scopes = ["User.Read"]
  } }
}
run "create" {
  command = plan
  assert {
    condition = (
      output.result.values.agentId == "55555555-5555-4555-8555-555555555555" &&
      output.result.values.identityMode == "connected" &&
      msgraph_resource_action.fic.body.subject == "system:serviceaccount:adaptive:agent-sa-${substr(sha256("scout"), 0, 32)}"
    )
    error_message = "Publish exact Agent ID and sidecar federation; credentials belong to the blueprint."
  }
}
run "unchanged" {
  command = plan
}
run "generic_browser_without_worker" {
  command = plan
  variables {
    tenant_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, {
        delegation = {
          enabled  = true
          tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          uiOrigin = "https://adaptive.example"
          permissions = [{
            resourceAppId       = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            resourcePrincipalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            scopes              = [{ id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", value = "Profile.Read" }]
          }]
        }
      })
    }) }
  }
  override_data {
    target = data.msgraph_resource.resource_principal["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
    values = { output = {
      app_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      scopes = [{ id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", value = "Profile.Read", isEnabled = true }]
    } }
  }
  assert {
    condition = (
      length(msgraph_resource.agent_user) == 0 &&
      !local.graph_delegation &&
      msgraph_resource.resource_consent["dddddddd-dddd-4ddd-8ddd-dddddddddddd"].body.scope == "Profile.Read" &&
      toset(msgraph_resource_action.scope_inheritance["dddddddd-dddd-4ddd-8ddd-dddddddddddd"].body.inheritableScopes.scopes) == toset(["Profile.Read"]) &&
      !contains(keys(msgraph_resource_action.scope_inheritance["dddddddd-dddd-4ddd-8ddd-dddddddddddd"].body), "inheritableRoles")
    )
    error_message = "Delegation must be resource-neutral and must not create an unauthored agent user or advertise Graph."
  }
}
run "invalid_delegation" {
  command = plan
  variables {
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, {
        delegation = { enabled = true }
      })
    }) }
  }
  expect_failures = [var.context]
}
run "enable_graph_plan" {
  command = plan
  variables {
    tenant_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, {
        delegation = {
          enabled  = true
          tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          uiOrigin = "https://adaptive.example"
          permissions = [{
            resourceAppId       = "00000003-0000-0000-c000-000000000000"
            resourcePrincipalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            scopes              = [{ id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d", value = "User.Read" }]
          }]
          agentUser = {
            userPrincipalName = "scout-worker@example.onmicrosoft.com"
            displayName       = "Scout worker"
            mailNickname      = "scout-worker"
          }
        }
      })
    }) }
  }
}
run "enable_graph" {
  command = plan
  variables {
    tenant_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, {
        delegation = {
          enabled  = true
          tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          uiOrigin = "https://adaptive.example"
          permissions = [{
            resourceAppId       = "00000003-0000-0000-c000-000000000000"
            resourcePrincipalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            scopes              = [{ id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d", value = "User.Read" }]
          }]
          agentUser = {
            userPrincipalName = "scout-worker@example.onmicrosoft.com"
            displayName       = "Scout worker"
            mailNickname      = "scout-worker"
          }
        }
      })
    }) }
  }
  assert {
    condition = (
      msgraph_resource.agent_user[0].body.identityParentId == msgraph_resource_action.agent.output.object_id &&
      msgraph_resource.agent_user[0].url == "users/microsoft.graph.agentUser" &&
      msgraph_resource.resource_consent["00000003-0000-0000-c000-000000000000"].body.scope == "User.Read" &&
      msgraph_resource.obo_consent[0].body.scope == "access_agent" &&
      toset(msgraph_resource_action.scope_inheritance["00000003-0000-0000-c000-000000000000"].body.inheritableScopes.scopes) == toset(["User.Read"]) &&
      !contains(keys(msgraph_resource_action.scope_inheritance["00000003-0000-0000-c000-000000000000"].body), "inheritableRoles") &&
      endswith(msgraph_resource_action.delete_scope_inheritance["00000003-0000-0000-c000-000000000000"].resource_url, "/inheritablePermissions/00000003-0000-0000-c000-000000000000") &&
      msgraph_resource.obo_client[0].body.spa.redirectUris == ["https://adaptive.example/auth/entra-callback"]
    )
    error_message = "The graph-me approval must use native agentUser, a public SPA and exactly the authored delegated User.Read permission."
  }
}
run "graph_unchanged" {
  command = plan
  variables {
    tenant_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, {
        delegation = {
          enabled  = true
          tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          uiOrigin = "https://adaptive.example"
          permissions = [{
            resourceAppId       = "00000003-0000-0000-c000-000000000000"
            resourcePrincipalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            scopes              = [{ id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d", value = "User.Read" }]
          }]
          agentUser = {
            userPrincipalName = "scout-worker@example.onmicrosoft.com"
            displayName       = "Scout worker"
            mailNickname      = "scout-worker"
          }
        }
      })
    }) }
  }
}
run "change_approved_scopes" {
  command = plan
  variables {
    tenant_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, {
        delegation = {
          enabled  = true
          tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          uiOrigin = "https://adaptive.example"
          permissions = [{
            resourceAppId       = "00000003-0000-0000-c000-000000000000"
            resourcePrincipalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            scopes = [
              { id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d", value = "User.Read" },
              { id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", value = "Other.Read" },
            ]
          }]
          agentUser = {
            userPrincipalName = "scout-worker@example.onmicrosoft.com"
            displayName       = "Scout worker"
            mailNickname      = "scout-worker"
          }
        }
      })
    }) }
  }
  override_data {
    target = data.msgraph_resource.resource_principal["00000003-0000-0000-c000-000000000000"]
    values = { output = {
      app_id = "00000003-0000-0000-c000-000000000000"
      scopes = [
        { id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d", value = "User.Read", isEnabled = true },
        { id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", value = "Other.Read", isEnabled = true },
      ]
    } }
  }
  override_resource {
    target          = msgraph_resource_action.scope_inheritance["00000003-0000-0000-c000-000000000000"]
    override_during = plan
    values = { output = {
      resource_app_id = "00000003-0000-0000-c000-000000000000"
      scopes_kind     = "enumerated"
      scopes          = ["User.Read", "Other.Read"]
    } }
  }
  override_resource {
    target          = msgraph_update_resource.scope_inheritance["00000003-0000-0000-c000-000000000000"]
    override_during = plan
    values = { output = {
      resource_app_id = "00000003-0000-0000-c000-000000000000"
      scopes_kind     = "enumerated"
      scopes          = ["User.Read", "Other.Read"]
    } }
  }
}
