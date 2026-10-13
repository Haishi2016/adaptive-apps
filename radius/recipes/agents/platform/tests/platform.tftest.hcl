mock_provider "helm" {}

variables {
  context = {
    resource = {
      name = "fixture"
      properties = {
        repository   = "oci://registry.example/charts"
        chart        = "agent-platform"
        chartVersion = "0.2.0"
        namespace    = "adaptive"
        valuesJson   = "{}"
      }
    }
  }
}

run "reject_laptop_execution" {
  command         = plan
  expect_failures = [helm_release.platform]
}

run "reject_unpinned_chart" {
  command = plan
  variables {
    context = {
      resource = {
        name = "fixture"
        properties = {
          repository   = "oci://registry.example/charts"
          chart        = "agent-platform"
          chartVersion = "latest"
          namespace    = "adaptive"
          valuesJson   = "{}"
        }
      }
    }
  }
  expect_failures = [var.context]
}

run "reject_nonobject_values" {
  command = plan
  variables {
    context = {
      resource = {
        name = "fixture"
        properties = {
          repository   = "oci://registry.example/charts"
          chart        = "agent-platform"
          chartVersion = "0.2.0"
          namespace    = "adaptive"
          valuesJson   = "[]"
        }
      }
    }
  }
  expect_failures = [var.context]
}
