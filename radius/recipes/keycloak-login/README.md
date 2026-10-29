# Shared Keycloak login

Administrator-owned configuration for an **existing** Keycloak realm. This
recipe creates a public `adaptive-ui` PKCE client, the bearer-only
`adaptive-platform-api` client and its explicitly supplied roles, and an
optional, tenant-pinned `entra` identity provider. It does not install Keycloak,
create users, grant user roles or change realm-wide authentication/MFA policy.
Optional `manageEntraLinks=true` manages the native realm user profile once,
retaining normal profile fields and adding administrator-only `entra_tid`/`entra_oid`
identity-link attributes with native ID-token/userinfo mappers. The default is
false and neither writes the profile nor needs additional profile permissions.
See the
[native agent identity setup](../../../docs/agents/native-radius.md).

## Prerequisites

- An existing realm and a dedicated service-account client authorized to manage
  its clients, roles, identity providers, authentication flows and user profile.
  User-profile configuration requires explicitly reviewed `manage-realm`;
  the current seeded executor does not already have it. Do not use
  this credential for ordinary agent recipe execution.
- Keycloak's externally advertised hostname/path must match
  `keycloakPublicUrl`. The UI origin must be exact HTTPS, without wildcards.
- For optional connected login, an existing single-tenant Entra **web**
  application and credential. Local login needs neither. Register
  this exact web redirect URI:
  `<keycloakPublicUrl>/realms/<realm>/broker/entra/endpoint`.
  Configure Entra app assignment and tenant policies explicitly.
- A Radius executor credentials store containing
  `keycloak-config-client-secret`; add `entra-login-client-secret` only for
  a configured Entra application. Create/update
  it through the existing secret-management process; never place either value
  in Bicep parameters, source, command history or public recipe archives.
- The exact `platformRoles` accepted by the external operational API and its
  expected audience. The default audience is `api://adaptive-broker`; an
  audience claim alone grants no permission.

## Deployment and retained ownership

Publish the Terraform recipe directories at an immutable executor-accessible
archive URL. Register `radius/resource-types/types.yaml` and generate its Bicep
extension with the native Radius commands in the agent delivery guide.
`radius/agents-env.bicep` declares an isolated login environment with its own
`loginRecipeConfig`. Configure the archive URL, credentials-store ID, Keycloak
URL, realm and dedicated administrator client through that environment.
`radius/agent-services.bicep` declares the login in that administrator environment
with exact UI/public URLs, API roles/audience, Entra tenant/client IDs and `connected`.
Use explicit reviewed Radius resource-group/environment selection for both.
The default is `connected=false`.
Before deploying the login declaration with a nonempty `tradingOrigin`, `ada`
creates or verifies the retained confidential `adaptive-trading` client using
its private client-secret file. The recipe reads that existing client and owns
only its platform role, audience and claim mappings; Radius 0.57 intentionally
rejects `TF_VAR_*` values in `recipeConfig.envSecrets`.
For local-only login, omit Entra tenant/client IDs and any Entra secret
reference in its recipe bindings. This creates the
existing UI's native PKCE client and scoped role mappers, without an Entra
provider, first-login flow or dummy cloud credentials. For connected login,
supply both IDs and its secret-store reference, and retain
that configuration while switching `connected` off.
The declaration uses `Radius.Resources/keycloakLogins`; only this dedicated
administrator environment registers its default recipe. Configuration properties
arrive through `context.resource.properties`, not an extender parameter bag.

Keep this environment separate from agent deployment and restrict who
can deploy to it. Its Kubernetes namespace matches its environment name:
Radius requires a unique namespace per environment. The provider still
configures the existing `adaptive` realm through its explicit Service URL.
Retain and protect its Terraform state. The Entra credential
is supplied as an ephemeral input to the provider's write-only field; change
`entraClientSecretVersion` only for deliberate credential rotation.

If matching resources already exist, **import them into this recipe's actual
retained backend before the first apply**. Do not create a parallel local state
and then let Radius create the same resources. Relevant provider import IDs:

| Terraform address | Import ID |
| --- | --- |
| `keycloak_openid_client.ui` / `.api` | `<realm>/<client UUID>` |
| `keycloak_role.platform["<role>"]` | `<realm>/<role UUID>` |
| `keycloak_generic_role_mapper.ui_scope["<role>"]` | `<realm>/client/<UI client UUID>/scope-mappings/<API client UUID>/<role UUID>` |
| `keycloak_openid_user_client_role_protocol_mapper.ui_roles` | `<realm>/client/<UI client UUID>/<mapper UUID>` |
| `keycloak_openid_audience_protocol_mapper.ui_audience` | `<realm>/client/<UI client UUID>/<mapper UUID>` |
| `keycloak_openid_user_property_protocol_mapper.ui_oid` | `<realm>/client/<UI client UUID>/<mapper UUID>` |
| `keycloak_realm_user_profile.platform[0]` | `<realm>` |
| `keycloak_openid_user_attribute_protocol_mapper.entra_link["entra_tid"]` / `["entra_oid"]` | `<realm>/client/<UI client UUID>/<mapper UUID>` |
| `keycloak_authentication_flow.approved_accounts[0]` | `<realm>/<flow UUID>` |
| `keycloak_authentication_execution.deny_unlinked[0]` | `<realm>/<flow alias>/<execution UUID>` |
| `keycloak_oidc_identity_provider.entra[0]` | `<realm>/entra` |

For example, with the correct backend and secret environment already selected:
`terraform import keycloak_openid_client.ui adaptive/<existing-client-UUID>`.
Review the complete plan after import, including the write-only secret version;
import cannot recover that secret. Preserve existing IDs/credentials. Resolve
incompatible existing clients/flows explicitly rather than replacing them.
Clients, provider and first-login flow have destruction protection; removing
roles is still an explicit authorization change.
The user profile is a complete native document, not a patch. Review existing
custom fields before import/delivery; do not remove them as incidental cleanup.

## Connected and local user login

Administrators must prelink approved existing Keycloak users to provider
`entra`, using the user's verified Entra OIDC **subject for this application**,
not an email match or assumed Entra object ID. Review assignments and grant
the required `adaptive-platform-api` client roles separately. The first-login
flow denies unlinked accounts; no automatic creation or email-based linking
is enabled. Paired users must retain an approved local login method for offline
operation.

Use Keycloak's standard OIDC discovery at
`<keycloakPublicUrl>/realms/<realm>/.well-known/openid-configuration`.
The UI callback is `<uiOrigin>/auth/callback`, with authorization-code flow and
PKCE S256. `kc_idp_hint=entra` selects connected Entra login; without it,
Keycloak offers the existing local login flow. Keycloak issues the resulting
platform token in either case, with its local `oid`, scoped `roles` and the
configured API audience. It does not store/expose upstream Entra tokens for OBO.

Applying `connected=false` disables the **same** Entra provider without
replacing clients or user links. It also sets `link_only` so direct broker-login
URLs cannot bypass the disabled login option. This blocks new Entra login, not
existing sessions/tokens, network egress or already-started login transactions.
Demo egress injection does not change this configuration. Session revocation
and deliberate federation changes remain separate administrator operations.

The UI supports native Keycloak OIDC through `VITE_KEYCLOAK_AUTHORITY`, but
authentication remains off by default. Before enabling it, complete the
[API/gateway authorization](../../../src/services/ui/README.md#authorization):
validate Keycloak issuer/signature/audience, scoped roles and the intended
local-to-Entra identity mapping. Do not reinterpret Keycloak `oid` as an Entra
object ID. The native release recipe uses the shared Agent Gateway and validates
native Keycloak user tokens with `azp=adaptive-ui` and the explicit `agent.invoke`
role; include that exact role in `platformRoles` for the bounded agent path.
Delegated Graph tokens continue through the colocated broker/Entra SDK
sidecar path; current native identity flows need no platform broker service.
