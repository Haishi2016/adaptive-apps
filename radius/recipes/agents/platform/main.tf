terraform {
  required_version = ">= 1.15.7, < 1.16.0"
  required_providers {
    helm = { source = "hashicorp/helm", version = "= 3.1.1" }
  }
}

variable "context" {
  type = object({ resource = object({
    name = string
    properties = object({
      repository = string, chart = string, chartVersion = string
      namespace  = string, valuesJson = string
    })
  }) })
  validation {
    condition = (
      (can(regex("^(oci|https)://[^ ?#]+$", var.context.resource.properties.repository)) ||
      can(regex("^http://[a-z0-9-]+\\.[a-z0-9-]+\\.svc\\.cluster\\.local(:[0-9]+)?/[^ ?#]*$", var.context.resource.properties.repository))) &&
      can(regex("^v?[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.-]+)?$", var.context.resource.properties.chartVersion)) &&
      contains(["agent-platform", "gateway-helm"], var.context.resource.properties.chart) &&
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.context.resource.properties.namespace))
    )
    error_message = "Select a pinned agent-platform or upstream gateway-helm chart and explicit namespace."
  }
  validation {
    condition     = can(keys(jsondecode(var.context.resource.properties.valuesJson)))
    error_message = "Helm valuesJson must encode an object."
  }
}

locals {
  executor_ca    = try(file("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"), null)
  executor_token = try(file("/var/run/secrets/kubernetes.io/serviceaccount/token"), null)
}

provider "helm" {
  kubernetes = {
    host                   = "https://kubernetes.default.svc"
    cluster_ca_certificate = local.executor_ca
    token                  = local.executor_token
  }
}

resource "helm_release" "platform" {
  name             = var.context.resource.name
  namespace        = var.context.resource.properties.namespace
  create_namespace = true
  repository       = var.context.resource.properties.repository
  chart            = var.context.resource.properties.chart
  version          = var.context.resource.properties.chartVersion
  values           = [var.context.resource.properties.valuesJson]
  wait             = true
  wait_for_jobs    = true
  timeout          = 900
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = local.executor_ca != null && local.executor_token != null
      error_message = "Run the platform recipe inside Radius with mounted Kubernetes credentials."
    }
  }
}

output "result" {
  value = { resources = [], values = {
    namespace = helm_release.platform.namespace
    release   = helm_release.platform.name
  } }
}
