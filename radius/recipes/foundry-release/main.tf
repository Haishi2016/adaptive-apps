terraform {
  required_version = ">= 1.15.7, < 1.16.0"
  required_providers {
    azapi = { source = "Azure/azapi", version = "= 2.9.0" }
  }
}

provider "azapi" {}

variable "context" {
  type = object({
    resource = object({
      name = string
      id   = string
      properties = object({
        agentName = string
        agentUid  = string
        version   = string
        binding = object({
          identity           = any
          identityRef        = string
          secretRef          = string
          serviceAccountName = string
        })
        definition = object({
          kind         = string
          model        = string
          image        = optional(string)
          runtimeImage = optional(string)
          instructions = optional(string, "")
          description  = optional(string, "")
          temperature  = optional(string)
          top_p        = optional(string)
          tools        = optional(list(any), [])
          environment  = optional(map(string), {})
        })
        governance = optional(any)
        resources  = optional(any)
        stateSize  = optional(string)
      })
    })
  })
  validation {
    condition     = var.context.resource.properties.binding == null
    error_message = "Foundry supplies native identity. Set binding=null; never copy edge identity, Secret or ServiceAccount bindings."
  }
  validation {
    condition = (
      var.context.resource.properties.version == var.initial_release_id &&
      var.context.resource.name == "${var.context.resource.properties.agentName}-${var.initial_release_id}"
    )
    error_message = "This environment accepts only its explicitly configured initial release and canonical Radius resource name; additional releases are unsupported."
  }
  validation {
    condition = (
      contains(["prompt", "hosted"], var.context.resource.properties.definition.kind) &&
      length(var.context.resource.properties.definition.tools) == 0 &&
      var.context.resource.properties.governance == null &&
      var.context.resource.properties.stateSize == null &&
      length(coalesce(var.context.resource.properties.resources, {})) == 0
    )
    error_message = "The initial Foundry proof supports prompt/hosted definitions without tools, edge governance, PVC state or edge resource settings. Configure native RAI and sandbox size separately."
  }
}

variable "initial_release_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$", var.initial_release_id))
    error_message = "Declare one explicit initial release ID as a lowercase DNS label, at most 32 characters."
  }
}

variable "project_endpoint" {
  type = string
  validation {
    condition     = can(regex("^https://[a-zA-Z0-9-]+\\.services\\.ai\\.azure\\.com/api/projects/[a-zA-Z0-9_-]+/?$", var.project_endpoint))
    error_message = "Use the explicitly selected public-Azure Foundry project endpoint without credentials, query or fragment."
  }
}

variable "rai_policy_id" {
  type = string
  validation {
    condition     = can(regex("(?i)^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\\.CognitiveServices/accounts/[^/]+/raiPolicies/[^/]+$", var.rai_policy_id))
    error_message = "Supply the full ARM ID of an existing account-scoped native RAI policy."
  }
}

variable "cpu" {
  type    = string
  default = "1"
}

variable "memory" {
  type    = string
  default = "2Gi"
}

locals {
  p           = var.context.resource.properties
  def         = local.p.definition
  endpoint    = trimsuffix(var.project_endpoint, "/")
  native_name = "${local.p.agentName}-${substr(sha256(local.p.agentUid), 0, 10)}"
  definitions = {
    prompt = merge({
      kind         = "prompt"
      model        = local.def.model
      instructions = local.def.instructions
      rai_config   = { rai_policy_name = var.rai_policy_id }
      },
      local.def.temperature != null ? { temperature = tonumber(local.def.temperature) } : {},
      local.def.top_p != null ? { top_p = tonumber(local.def.top_p) } : {}
    )
    hosted = {
      kind                    = "hosted"
      container_configuration = { image = local.def.image }
      cpu                     = var.cpu
      memory                  = var.memory
      protocol_versions       = [{ protocol = "responses", version = "2.0.0" }]
      environment_variables   = local.def.environment
      rai_config              = { rai_policy_name = var.rai_policy_id }
    }
  }
  definition = local.definitions[local.def.kind]
  capture = {
    radius_id  = var.context.resource.id
    properties = local.p
    endpoint   = local.endpoint
    definition = local.definition
  }
}

resource "terraform_data" "capture" {
  input = local.capture
  lifecycle {
    ignore_changes  = [input]
    prevent_destroy = true
    postcondition {
      condition     = self.output == local.capture
      error_message = "A published Foundry proof release is immutable. This recipe does not support another release or update of the named agent."
    }
    precondition {
      condition     = local.def.kind != "hosted" || can(regex("^[a-zA-Z0-9.-]+\\.azurecr\\.io/[^@ ]+@sha256:[a-f0-9]{64}$", local.def.image))
      error_message = "Hosted deployment requires an unchanged linux/amd64 image mirrored to ACR by its original manifest digest."
    }
    precondition {
      condition     = local.def.kind != "prompt" || length(local.def.environment) == 0
      error_message = "Native prompt agents have no container environment; do not silently drop runtime bindings."
    }
    precondition {
      condition     = local.def.temperature == null || local.def.top_p == null
      error_message = "Configure temperature or top_p, not both."
    }
    precondition {
      condition     = local.def.kind != "hosted" || (local.def.instructions == "" && local.def.temperature == null && local.def.top_p == null && local.def.runtimeImage == null)
      error_message = "Hosted instructions and sampling belong to the unchanged image/configuration, not silently discarded prompt-runtime fields."
    }
    precondition {
      condition     = local.def.kind != "prompt" || local.def.image == null
      error_message = "A native prompt agent has no hosted image; runtimeImage is an edge-only artifact."
    }
    precondition {
      condition     = lower(regex("(?i)/accounts/([^/]+)/", var.rai_policy_id)[0]) == lower(split(".", trimprefix(local.endpoint, "https://"))[0])
      error_message = "The RAI policy must belong to the selected Foundry account."
    }
    precondition {
      condition     = contains(["0.5:1Gi", "1:2Gi", "2:4Gi"], "${var.cpu}:${var.memory}")
      error_message = "Use a supported Foundry sandbox CPU/memory pair."
    }
    precondition {
      condition = alltrue([
        for key in keys(local.def.environment) :
        !startswith(key, "FOUNDRY_") && !contains([
          "IDENTITY_ENDPOINT", "IDENTITY_HEADER", "AZURE_TOKEN_CREDENTIALS",
          "AZURE_CLIENT_SECRET", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
          "AGENTSERVER_STATE_ROOT"
        ], key)
      ])
      error_message = "Use native cloud identity and platform-injected Foundry bindings, not edge bindings or Azure API keys."
    }
  }
}

resource "azapi_data_plane_resource" "agent" {
  type      = "Microsoft.Foundry/agents@v1"
  name      = local.native_name
  parent_id = trimprefix(terraform_data.capture.output.endpoint, "https://")
  body = {
    name        = local.native_name
    description = terraform_data.capture.output.properties.definition.description
    definition  = terraform_data.capture.output.definition
    metadata = {
      radius_resource_id = terraform_data.capture.output.radius_id
      radius_release_id  = terraform_data.capture.output.properties.version
      radius_agent_uid   = terraform_data.capture.output.properties.agentUid
    }
  }
  response_export_values = [
    "versions.latest.version",
    "versions.latest.instance_identity",
    "versions.latest.blueprint"
  ]
  lifecycle {
    prevent_destroy = true
    postcondition {
      condition     = self.output.versions.latest.version == "1"
      error_message = "Expected an exclusively owned initial native version. Stop: additional versions or another writer require a separate lifecycle implementation."
    }
  }
}

output "result" {
  value = {
    resources = []
    values = {
      nativeName    = azapi_data_plane_resource.agent.name
      nativeVersion = azapi_data_plane_resource.agent.output.versions.latest.version
      nativeIdentity = {
        clientId             = azapi_data_plane_resource.agent.output.versions.latest.instance_identity.client_id
        principalId          = azapi_data_plane_resource.agent.output.versions.latest.instance_identity.principal_id
        blueprintId          = azapi_data_plane_resource.agent.output.versions.latest.blueprint.client_id
        blueprintPrincipalId = azapi_data_plane_resource.agent.output.versions.latest.blueprint.principal_id
      }
      endpoint = "${local.endpoint}/agents/${azapi_data_plane_resource.agent.name}/endpoint/protocols/openai/responses"
    }
  }
}
