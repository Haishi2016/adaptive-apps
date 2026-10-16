terraform {
  required_version = ">= 1.10.0, < 1.17.0"
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
        environment = string
        application = string
        kind        = string
        identityRef = optional(string, "")
        binding     = any
        definition  = any
        governance  = optional(any, null)
        resources   = optional(map(any), {})
        stateSize   = optional(string, "")
      })
    })
  })
  validation {
    condition     = var.context.resource.properties.binding == null
    error_message = "Foundry supplies native identity. Set binding=null; never copy edge identity, Secret or ServiceAccount bindings."
  }
  validation {
    condition = (
      contains(["prompt", "hosted"], var.context.resource.properties.kind) &&
      var.context.resource.properties.definition.kind == var.context.resource.properties.kind &&
      length(try(var.context.resource.properties.definition.tools, [])) == 0 &&
      var.context.resource.properties.governance == null &&
      var.context.resource.properties.stateSize == "" &&
      length(var.context.resource.properties.resources) == 0
    )
    error_message = "The Foundry proof supports prompt/hosted definitions without tools, edge governance, PVC state or edge resource settings. Configure native RAI and sandbox size separately."
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
  logical   = var.context.resource.properties
  agent_uid = substr(sha256(var.context.resource.id), 0, 32)
  def = merge({
    image        = null
    runtimeImage = null
    instructions = ""
    description  = ""
    temperature  = null
    top_p        = null
    tools        = []
    environment  = {}
  }, local.logical.definition)
  endpoint    = trimsuffix(var.project_endpoint, "/")
  native_name = "${var.context.resource.name}-${substr(local.agent_uid, 0, 10)}"
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
}

resource "azapi_data_plane_resource" "agent" {
  type      = "Microsoft.Foundry/agents@v1"
  name      = local.native_name
  parent_id = trimprefix(local.endpoint, "https://")
  body = {
    name        = local.native_name
    description = local.def.description
    definition  = local.definition
    metadata = {
      radius_resource_id = var.context.resource.id
      radius_agent_uid   = local.agent_uid
    }
  }
  response_export_values = [
    "versions.latest.instance_identity",
    "versions.latest.blueprint"
  ]
  lifecycle {
    precondition {
      condition     = local.def.kind != "hosted" || can(regex("^[a-zA-Z0-9.-]+\\.azurecr\\.io/[^@ ]+@sha256:[a-f0-9]{64}$", local.def.image))
      error_message = "Hosted deployment requires a linux/amd64 image mirrored to ACR by its original manifest digest."
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
      error_message = "Hosted instructions and sampling belong to the image/configuration, not silently discarded prompt-runtime fields."
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

output "result" {
  value = {
    resources = []
    values = {
      agentName  = var.context.resource.name
      agentUid   = local.agent_uid
      nativeName = azapi_data_plane_resource.agent.name
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
