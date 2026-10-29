mock_provider "azapi" {
  mock_resource "azapi_data_plane_resource" {
    defaults = {
      output = {
        versions = {
          latest = {
            instance_identity = { principal_id = "agent-principal", client_id = "agent-client" }
            blueprint         = { principal_id = "blueprint-principal", client_id = "blueprint-client" }
          }
        }
      }
    }
  }
}

variables {
  project_endpoint = "https://fixture.services.ai.azure.com/api/projects/proof"
  rai_policy_id    = "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.CognitiveServices/accounts/fixture/raiPolicies/default"
  context = {
    resource = {
      name = "writer"
      id   = "/planes/radius/local/resourceGroups/proof/providers/Radius.Resources/agents/writer"
      properties = {
        environment = "/environments/proof"
        application = "/applications/writer"
        kind        = "prompt"
        identityRef = ""
        binding     = null
        definition = {
          kind         = "prompt"
          model        = "gpt-4o-mini"
          instructions = "Write clearly."
          runtimeImage = "edge/prompt@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          temperature  = "0.7"
        }
      }
    }
  }
}

run "native_prompt" {
  command = apply
  assert {
    condition     = azapi_data_plane_resource.agent.body.definition.kind == "prompt" && azapi_data_plane_resource.agent.body.definition.instructions == "Write clearly."
    error_message = "Prompt content must become a native prompt definition."
  }
  assert {
    condition     = !contains(keys(azapi_data_plane_resource.agent.body.definition), "container_configuration") && azapi_data_plane_resource.agent.body.definition.temperature == 0.7
    error_message = "Native prompt deployment must preserve sampling without a container."
  }
  assert {
    condition     = output.result.resources == [] && output.result.values.nativeName == azapi_data_plane_resource.agent.name
    error_message = "The Radius agent must expose its current native runtime without a release capture."
  }
  assert {
    condition     = output.result.values.nativeIdentity.clientId == "agent-client" && output.result.values.nativeIdentity.blueprintId == "blueprint-client"
    error_message = "Export actual provider identities, not copied edge identities."
  }
}

run "mutable_update" {
  command = apply
  variables {
    context = {
      resource = merge(var.context.resource, {
        properties = merge(var.context.resource.properties, {
          definition = merge(var.context.resource.properties.definition, {
            instructions = "Write concisely."
          })
        })
      })
    }
  }
  assert {
    condition     = azapi_data_plane_resource.agent.body.definition.instructions == "Write concisely."
    error_message = "Updating the Radius resource must update the current Foundry agent."
  }
}

run "reject_edge_identity" {
  command = plan
  variables {
    context = {
      resource = merge(var.context.resource, {
        properties = merge(var.context.resource.properties, {
          binding = {
            identity = {}
          }
        })
      })
    }
  }
  expect_failures = [var.context]
}
