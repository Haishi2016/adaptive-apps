mock_provider "azapi" {
  mock_resource "azapi_data_plane_resource" {
    defaults = {
      output = {
        versions = {
          latest = {
            version           = "1"
            instance_identity = { principal_id = "agent-principal", client_id = "agent-client" }
            blueprint         = { principal_id = "blueprint-principal", client_id = "blueprint-client" }
          }
        }
      }
    }
  }
}

variables {
  initial_release_id = "v1"
  project_endpoint   = "https://fixture.services.ai.azure.com/api/projects/proof"
  rai_policy_id      = "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.CognitiveServices/accounts/fixture/raiPolicies/default"
  context = {
    resource = {
      name = "writer"
      id   = "/planes/radius/local/resourceGroups/proof/providers/Radius.Resources/agents/writer"
      properties = {
        environment   = "/environments/proof"
        application   = "/applications/writer"
        kind          = "prompt"
        activeVersion = ""
        identityRef   = ""
        releases = {
          v1 = {
            binding = null
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
  }
}

run "native_prompt" {
  command = apply
  assert {
    condition     = azapi_data_plane_resource.agent.body.definition.kind == "prompt" && azapi_data_plane_resource.agent.body.definition.instructions == "Write clearly."
    error_message = "Prompt content must become a native prompt definition, never a hosted runtime."
  }
  assert {
    condition     = !contains(keys(azapi_data_plane_resource.agent.body.definition), "container_configuration") && azapi_data_plane_resource.agent.body.definition.temperature == 0.7
    error_message = "Native prompt deployment must preserve sampling without a container."
  }
  assert {
    condition     = output.result.values.nativeVersion == "1" && output.result.resources == []
    error_message = "Capture the concrete native version without claiming ARM or Kubernetes runtime ownership."
  }
  assert {
    condition     = azapi_data_plane_resource.agent.name == "writer-${substr(sha256(output.result.values.agentUid), 0, 10)}"
    error_message = "Native identity must derive from the retained logical UID, not a release label or an existing unrelated agent name."
  }
  assert {
    condition     = output.result.values.nativeIdentity.clientId == "agent-client" && output.result.values.nativeIdentity.blueprintId == "blueprint-client"
    error_message = "Export actual provider identities, not copied edge identities."
  }
}

run "identical_replay" {
  command = apply
  assert {
    condition     = output.result.values.nativeVersion == run.native_prompt.result.values.nativeVersion
    error_message = "Identical replay must retain the native version."
  }
}

run "promote_published_release" {
  command = apply
  variables {
    context = {
      resource = merge(var.context.resource, {
        properties = merge(var.context.resource.properties, {
          activeVersion     = "v1"
          publishedVersions = ["v1"]
        })
      })
    }
  }
  assert {
    condition     = output.result.values.nativeVersion == run.native_prompt.result.values.nativeVersion
    error_message = "Promotion must not republish or mutate the retained release."
  }
}

run "reject_unpublished_promotion" {
  command = plan
  variables {
    context = {
      resource = merge(var.context.resource, {
        properties = merge(var.context.resource.properties, { activeVersion = "v1" })
      })
    }
  }
  expect_failures = [var.context]
}

run "reject_changed_definition" {
  command = plan
  variables {
    context = {
      resource = {
        name = "writer"
        id   = "/planes/radius/local/resourceGroups/proof/providers/Radius.Resources/agents/writer"
        properties = {
          environment   = "/environments/proof"
          application   = "/applications/writer"
          kind          = "prompt"
          activeVersion = ""
          identityRef   = ""
          releases = {
            v1 = {
              binding    = null
              definition = { kind = "prompt", model = "gpt-4o-mini", instructions = "Changed." }
            }
          }
        }
      }
    }
  }
  expect_failures = [terraform_data.capture]
}

run "reject_another_release" {
  command = plan
  variables {
    initial_release_id = "v2"
  }
  expect_failures = [var.context]
}

run "native_hosted" {
  command   = apply
  state_key = "hosted"
  variables {
    context = {
      resource = {
        name = "editor"
        id   = "/planes/radius/local/resourceGroups/proof/providers/Radius.Resources/agents/editor"
        properties = {
          environment   = "/environments/proof"
          application   = "/applications/editor"
          kind          = "hosted"
          activeVersion = ""
          identityRef   = ""
          releases = {
            v1 = {
              binding = null
              definition = {
                kind        = "hosted"
                model       = "gpt-4o-mini"
                image       = "fixture.azurecr.io/editor@sha256:77292ef9596a27c259b7edd5cd73a5b0fcb45c74424b1b6a754b0de9e2c04620"
                environment = { WRITER_NAME = "writer" }
              }
            }
          }
        }
      }
    }
  }
  assert {
    condition     = azapi_data_plane_resource.agent.body.definition.container_configuration.image == var.context.resource.properties.releases.v1.definition.image
    error_message = "Hosted deployment must preserve the exact input OCI manifest digest."
  }
  assert {
    condition     = azapi_data_plane_resource.agent.body.definition.kind == "hosted" && azapi_data_plane_resource.agent.body.definition.protocol_versions[0].version == "2.0.0"
    error_message = "Use native hosted kind and the current Responses container protocol."
  }
}

run "reject_existing_versions" {
  command   = apply
  state_key = "unexpected-version"
  override_resource {
    target = azapi_data_plane_resource.agent
    values = {
      output = {
        versions = {
          latest = {
            version           = "2"
            instance_identity = { principal_id = "agent-principal", client_id = "agent-client" }
            blueprint         = { principal_id = "blueprint-principal", client_id = "blueprint-client" }
          }
        }
      }
    }
  }
  expect_failures = [azapi_data_plane_resource.agent]
}

run "reject_edge_bindings" {
  command = plan
  variables {
    context = {
      resource = {
        name = "writer"
        id   = "/radius/agents/writer"
        properties = {
          environment   = "/environments/proof"
          application   = "/applications/writer"
          kind          = "prompt"
          activeVersion = ""
          identityRef   = ""
          releases = {
            v1 = {
              binding = {
                identity           = {}
                identityRef        = "edge-identity"
                secretRef          = "edge-secret"
                serviceAccountName = "edge-service-account"
              }
              definition = { kind = "prompt", model = "gpt-4o-mini" }
            }
          }
        }
      }
    }
  }
  expect_failures = [var.context]
}

run "reject_untrusted_project_endpoint" {
  command = plan
  variables {
    project_endpoint = "https://example.com/api/projects/proof?api-key=not-allowed"
  }
  expect_failures = [var.project_endpoint]
}

run "reject_foreign_guardrail" {
  command = plan
  variables {
    rai_policy_id = "/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.CognitiveServices/accounts/another-account/raiPolicies/default"
  }
  expect_failures = [terraform_data.capture]
}

run "reject_invalid_sandbox" {
  command = plan
  variables {
    cpu    = "2"
    memory = "1Gi"
  }
  expect_failures = [terraform_data.capture]
}
