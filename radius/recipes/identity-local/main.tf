terraform {
  required_version = ">= 1.10.0, < 1.17.0"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "= 2.38.0" }
    keycloak   = { source = "keycloak/keycloak", version = "= 5.10.0" }
  }
}
variable "context" {
  type = object({ runtime = object({ kubernetes = object({ namespace = string }) }), resource = object({
    name = string, id = string
    properties = object({
      agentName  = string
      delegation = optional(object({ enabled = optional(bool, false) }), {})
    })
  }) })
  validation {
    condition     = !var.context.resource.properties.delegation.enabled
    error_message = "Delegation is connected-only; a local recipe must not silently accept it."
  }
}

variable "namespace" {
  type = string
}

provider "kubernetes" {
  host                   = "https://kubernetes.default.svc"
  cluster_ca_certificate = try(file("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"), null)
  token                  = try(file("/var/run/secrets/kubernetes.io/serviceaccount/token"), null)
}

module "identity" {
  source    = "../identity"
  context   = var.context
  namespace = var.namespace
}
output "result" { value = module.identity.result }
