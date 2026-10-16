mock_provider "keycloak" {
  mock_resource "keycloak_openid_client" {
    defaults = {
      id = "keycloak-object", client_secret = "test-only-client-secret", service_account_user_id = "service-user"
    }
  }
}
mock_provider "kubernetes" {
  mock_data "kubernetes_resource" {
    defaults = { object = { metadata = {
      uid = "agent-uid"
      annotations = {
        "radius.resource.id" = "/test/Radius.Resources/agents/scout"
        "radius.identity.id" = "/test/Radius.Resources/agentIdentities/scout"
      }
    } } }
  }
}
variables {
  namespace = "adaptive"
  context = { runtime = { kubernetes = { namespace = "adaptive-scout-identity" } }, resource = {
    name = "scout", id = "/test/Radius.Resources/agentIdentities/scout"
    properties = {
      agentName = "scout"
    }
  } }
}
run "configure" {
  command = plan
  assert {
    condition = (
      output.result.values.agentName == "scout" &&
      output.result.values.agentId == "" &&
      output.result.values.blueprintId == "" &&
      output.result.values.identityMode == "local" &&
      module.identity.result.values.namespace == "adaptive" &&
      startswith(output.result.values.identityRef, "binding-")
    )
    error_message = "Local custom agent properties must produce the retained identity binding."
  }
}
run "reject_delegation" {
  command = plan
  variables {
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = merge(var.context.resource, {
      properties = merge(var.context.resource.properties, { delegation = { enabled = true } })
    }) }
  }
  expect_failures = [var.context]
}
