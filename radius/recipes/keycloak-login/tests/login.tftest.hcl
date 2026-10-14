mock_provider "keycloak" {
  mock_data "keycloak_realm" {
    defaults = { id = "adaptive" }
  }
  mock_data "keycloak_openid_client" {
    defaults = { id = "adaptive-trading", client_id = "adaptive-trading" }
  }
}

variables {
  context = { resource = { properties = {
    uiOrigin          = "https://adaptive.example"
    tradingOrigin     = "https://trading.example"
    keycloakPublicUrl = "https://identity.example"
    platformRoles     = ["Adaptive.Agents.Deploy"]
    entraTenantId     = "11111111-1111-4111-8111-111111111111"
    entraClientId     = "22222222-2222-4222-8222-222222222222"
    connected         = true
    manageEntraLinks  = true
  } } }
  entra_client_secret = "test-only-idp-secret"
}

run "local_only" {
  command = plan
  variables {
    context = { resource = { properties = merge(var.context.resource.properties, {
      connected = false, entraTenantId = "", entraClientId = "", manageEntraLinks = false
    }) } }
    entra_client_secret = ""
  }
  assert {
    condition = (
      length(keycloak_oidc_identity_provider.entra) == 0 &&
      length(keycloak_authentication_flow.approved_accounts) == 0 &&
      length(keycloak_authentication_execution.deny_unlinked) == 0 &&
      length(keycloak_realm_user_profile.platform) == 0 &&
      length(keycloak_openid_user_attribute_protocol_mapper.entra_link) == 0 &&
      keycloak_openid_client.ui.pkce_code_challenge_method == "S256" &&
      !output.result.values.connectedLoginEnabled &&
      output.result.values.entraRedirectUri == null
    )
    error_message = "Local UI login must use native PKCE without Entra resources or credentials."
  }
}

run "connected" {
  command = apply
  assert {
    condition = (
      keycloak_openid_client.ui.access_type == "PUBLIC" &&
      keycloak_openid_client.ui.pkce_code_challenge_method == "S256" &&
      keycloak_openid_client.ui.standard_flow_enabled &&
      !keycloak_openid_client.ui.implicit_flow_enabled &&
      !keycloak_openid_client.ui.direct_access_grants_enabled &&
      !keycloak_openid_client.ui.service_accounts_enabled &&
      !keycloak_openid_client.ui.full_scope_allowed &&
      keycloak_openid_client.ui.valid_redirect_uris == toset(["https://adaptive.example/auth/callback"]) &&
      keycloak_openid_client.ui.web_origins == toset(["https://adaptive.example"])
    )
    error_message = "UI login must use PKCE and exact origins, without alternate grants or broad roles."
  }
  assert {
    condition = (
      data.keycloak_openid_client.trading[0].client_id == "adaptive-trading" &&
      keycloak_generic_role_mapper.trading_scope["Adaptive.Agents.Deploy"].client_id == "adaptive-trading" &&
      keycloak_openid_audience_protocol_mapper.trading_audience[0].included_custom_audience == "api://adaptive-broker"
    )
    error_message = "The retained trading BFF client must receive the platform roles and audience."
  }
  assert {
    condition = (
      keycloak_oidc_identity_provider.entra[0].enabled &&
      !keycloak_oidc_identity_provider.entra[0].link_only &&
      keycloak_oidc_identity_provider.entra[0].validate_signature &&
      keycloak_oidc_identity_provider.entra[0].issuer == "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0" &&
      !keycloak_oidc_identity_provider.entra[0].store_token &&
      !keycloak_oidc_identity_provider.entra[0].trust_email &&
      keycloak_oidc_identity_provider.entra[0].first_broker_login_flow_alias == keycloak_authentication_flow.approved_accounts[0].alias &&
      keycloak_authentication_execution.deny_unlinked[0].authenticator == "deny-access-authenticator" &&
      keycloak_authentication_execution.deny_unlinked[0].requirement == "REQUIRED"
    )
    error_message = "Entra login must validate the pinned tenant and reject unlinked accounts."
  }
  assert {
    condition = (
      keycloak_openid_user_client_role_protocol_mapper.ui_roles.claim_name == "roles" &&
      keycloak_openid_user_client_role_protocol_mapper.ui_roles.client_id_for_role_mappings == "adaptive-platform-api" &&
      keycloak_openid_audience_protocol_mapper.ui_audience.included_custom_audience == "api://adaptive-broker"
    )
    error_message = "Tokens must carry the explicit API audience and only scoped platform roles."
  }
}
run "unchanged" {
  command = plan
  assert {
    condition = (
      toset([for a in keycloak_realm_user_profile.platform[0].attribute : a.name]) == toset(["username", "email", "firstName", "lastName", "entra_tid", "entra_oid"]) &&
      alltrue([for a in keycloak_realm_user_profile.platform[0].attribute : a.permissions[0].edit == toset(["admin"]) if startswith(a.name, "entra_")]) &&
      alltrue([for a in keycloak_realm_user_profile.platform[0].attribute : a.permissions[0].edit == toset(["admin", "user"]) if !startswith(a.name, "entra_")]) &&
      alltrue([for mapper in keycloak_openid_user_attribute_protocol_mapper.entra_link : mapper.add_to_userinfo && mapper.add_to_id_token && !mapper.multivalued && !mapper.add_to_access_token])
    )
    error_message = "Preserve ordinary profile editing; only administrators may link Entra IDs surfaced by native userinfo/ID-token mappers."
  }
}
run "disable_federation" {
  command = plan
  variables {
    context = { resource = { properties = merge(var.context.resource.properties, { connected = false }) } }
  }
  assert {
    condition = (
      !keycloak_oidc_identity_provider.entra[0].enabled &&
      keycloak_oidc_identity_provider.entra[0].link_only &&
      keycloak_oidc_identity_provider.entra[0].client_id == var.context.resource.properties.entraClientId &&
      keycloak_openid_client.ui.client_id == run.connected.result.values.uiClientId
    )
    error_message = "Red button must disable the existing Entra provider."
  }
}
run "invalid_origin" {
  command = plan
  variables {
    context = { resource = { properties = merge(var.context.resource.properties, { uiOrigin = "https://*.example" }) } }
  }
  expect_failures = [var.context]
}
run "tenant_not_pinned" {
  command = plan
  variables {
    context = { resource = { properties = merge(var.context.resource.properties, { entraTenantId = "common" }) } }
  }
  expect_failures = [var.context]
}
