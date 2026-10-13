mock_provider "keycloak" {}
mock_provider "random" {}
mock_provider "kubernetes" {
  mock_data "kubernetes_resource" {
    defaults = { object = { metadata = {
      uid = "agent-uid"
      annotations = {
        "radius.resource.id" = "/radius/agents/scout"
        "radius.identity.id" = "/radius/agentIdentities/scout"
      }
    } } }
  }
}
variables {
  namespace = "adaptive"
  context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = {
    name       = "scout", id = "/radius/agentIdentities/scout"
    properties = { agentName = "scout", agentUid = "agent-uid", agentResourceId = "/radius/agents/scout" }
  } }
}
run "correct_binding" {
  command = plan
  assert {
    condition     = data.kubernetes_resource.agent.metadata[0].namespace == "adaptive"
    error_message = "Logical identity must use the explicit shared namespace, not Radius's application namespace."
  }
}
run "wrong_uid" {
  command = plan
  variables {
    context = { runtime = { kubernetes = { namespace = "adaptive" } }, resource = {
      name       = "scout", id = "/radius/agentIdentities/scout"
      properties = { agentName = "scout", agentUid = "other-uid", agentResourceId = "/radius/agents/scout" }
    } }
  }
  expect_failures = [data.kubernetes_resource.agent]
}
run "wrong_owner" {
  command = plan
  override_data {
    target = data.kubernetes_resource.agent
    values = { object = { metadata = {
      uid = "agent-uid"
      annotations = {
        "radius.resource.id" = "/radius/agents/scout"
        "radius.identity.id" = "/radius/agentIdentities/other"
      }
    } } }
  }
  expect_failures = [data.kubernetes_resource.agent]
}
run "partial_connected_ids" {
  command = plan
  variables {
    entra = {
      blueprintId          = "11111111-1111-4111-8111-111111111111"
      blueprintObjectId    = ""
      blueprintPrincipalId = ""
      entraClientId        = ""
      entraObjectId        = ""
      ficName              = ""
      graphDelegation      = false
    }
  }
  expect_failures = [var.entra]
}
run "delegation_without_connected_identity" {
  command = plan
  variables {
    entra = {
      blueprintId          = ""
      blueprintObjectId    = ""
      blueprintPrincipalId = ""
      entraClientId        = ""
      entraObjectId        = ""
      ficName              = ""
      graphDelegation      = true
      entraTenantId        = "11111111-1111-4111-8111-111111111111"
      oboClientId          = "22222222-2222-4222-8222-222222222222"
      agentUserId          = "33333333-3333-4333-8333-333333333333"
    }
  }
  expect_failures = [var.entra]
}
run "connected_app_only_with_optional_fields" {
  command = plan
  variables {
    entra = {
      blueprintId          = "11111111-1111-4111-8111-111111111111"
      blueprintObjectId    = "22222222-2222-4222-8222-222222222222"
      blueprintPrincipalId = "33333333-3333-4333-8333-333333333333"
      entraClientId        = "44444444-4444-4444-8444-444444444444"
      entraObjectId        = "44444444-4444-4444-8444-444444444444"
      ficName              = "agent-runtime"
      entraTenantId        = "55555555-5555-4555-8555-555555555555"
    }
  }
  assert {
    condition     = !var.entra.graphDelegation
    error_message = "Known tenant metadata alone must not enable Graph delegation."
  }
}
run "malformed_optional_id" {
  command = plan
  variables {
    entra = {
      blueprintId          = "11111111-1111-4111-8111-111111111111"
      blueprintObjectId    = "22222222-2222-4222-8222-222222222222"
      blueprintPrincipalId = "33333333-3333-4333-8333-333333333333"
      entraClientId        = "44444444-4444-4444-8444-444444444444"
      entraObjectId        = "44444444-4444-4444-8444-444444444444"
      ficName              = "agent-runtime"
      entraTenantId        = "common"
    }
  }
  expect_failures = [var.entra]
}
