# The native realm profile is a complete document: retain normal attributes
# and make the independently verified Entra link administrator-writable only.
resource "keycloak_realm_user_profile" "platform" {
  count                      = var.context.resource.properties.manageEntraLinks ? 1 : 0
  realm_id                   = data.keycloak_realm.platform.id
  unmanaged_attribute_policy = "DISABLED"
  dynamic "attribute" {
    for_each = {
      username  = { display = "username", validator = "username-prohibited-characters" }
      email     = { display = "email", validator = "email" }
      firstName = { display = "firstName", validator = "person-name-prohibited-characters" }
      lastName  = { display = "lastName", validator = "person-name-prohibited-characters" }
    }
    content {
      name               = attribute.key
      display_name       = "$${${attribute.value.display}}"
      required_for_roles = attribute.key == "username" ? [] : ["user"]
      permissions {
        view = ["admin", "user"]
        edit = ["admin", "user"]
      }
      validator {
        name = attribute.value.validator
      }
      validator {
        name   = "length"
        config = attribute.key == "username" ? { min = "3", max = "255" } : { max = "255" }
      }
      dynamic "validator" {
        for_each = attribute.key == "username" ? ["up-username-not-idn-homograph"] : []
        content {
          name = validator.value
        }
      }
    }
  }
  group {
    name                = "user-metadata"
    display_header      = "User metadata"
    display_description = "Attributes, which refer to user metadata"
  }
  dynamic "attribute" {
    for_each = toset(["entra_tid", "entra_oid"])
    content {
      name = attribute.value
      permissions {
        view = ["admin", "user"]
        edit = ["admin"]
      }
      validator {
        name   = "pattern"
        config = { pattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" }
      }
    }
  }
  lifecycle { prevent_destroy = true }
}

resource "keycloak_openid_user_attribute_protocol_mapper" "entra_link" {
  for_each            = var.context.resource.properties.manageEntraLinks ? toset(["entra_tid", "entra_oid"]) : toset([])
  realm_id            = data.keycloak_realm.platform.id
  client_id           = keycloak_openid_client.ui.id
  name                = each.value
  user_attribute      = each.value
  claim_name          = each.value
  claim_value_type    = "String"
  multivalued         = false
  add_to_access_token = false
  add_to_id_token     = true
  add_to_userinfo     = true
  depends_on          = [keycloak_realm_user_profile.platform]
}
