//! Deterministic native-agent inputs for the existing CLI/manual bootstrap paths.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ui;

const SIDECAR: &str = "mcr.microsoft.com/entra-sdk/auth-sidecar:1.1.0-azurelinux3.0-distroless@sha256:ebd2f7478db04f42f9b89a880ba104480b5b8b97b395dcd4aeb37cb79a5d08e3";
const COMPONENTS: [&str; 6] = [
    "prompt-agent",
    "editor",
    "dac-adapter",
    "governance-sidecar",
    "platform-api",
    "ui",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub recipe_archive: String,
    #[serde(default = "default_registry")]
    pub recipe_registry: String,
    #[serde(default)]
    pub images: BTreeMap<String, String>,
    #[serde(default = "default_image_registry")]
    pub image_registry: String,
    #[serde(default = "default_tag")]
    pub image_tag: String,
    #[serde(default)]
    pub connected: Option<Connected>,
    #[serde(default = "default_agents")]
    pub agent_names: Vec<String>,
    #[serde(default)]
    pub peers: Vec<Peer>,
    #[serde(default)]
    pub models: Vec<Model>,
    #[serde(default)]
    pub model_gateway_identity: Option<GatewayIdentity>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub name: String,
    pub properties: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayIdentity {
    pub client_id: String,
    pub tenant_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Peer {
    pub keycloak_client_id: String,
    pub agent_id: String,
    pub targets: Vec<String>,
}

fn default_agents() -> Vec<String> {
    ["writer", "auditor", "editor"].map(String::from).into()
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connected {
    pub tenant_id: String,
    pub provisioner_client_id: String,
    pub sponsor_user_id: String,
    pub owner_user_id: String,
    pub oidc_issuer: String,
    pub certificate_file: PathBuf,
    pub certificate_password_file: PathBuf,
}

fn default_registry() -> String {
    "agent-recipe-registry.radius-system.svc.cluster.local:5000/recipes".into()
}
fn default_image_registry() -> String {
    "adaptive.local/adaptive".into()
}
fn default_tag() -> String {
    "dev".into()
}

pub fn check_ownership(namespace: &str, release: &str) -> Result<()> {
    for (kind, name, owner, scope) in [
        ("crd", "gateways.gateway.networking.k8s.io", "", ""),
        ("gatewayclass", "adaptive", release, ""),
        (
            "deployment",
            "envoy-gateway",
            "adaptive-envoy",
            "envoy-gateway-system",
        ),
    ] {
        let mut command = Command::new("kubectl");
        if !scope.is_empty() {
            command.args(["-n", scope]);
        }
        let result = command.args(["get", kind, name, "-o", "json"]).output()?;
        if !result.status.success() {
            let error = String::from_utf8_lossy(&result.stderr);
            if error.contains("NotFound") || error.contains("doesn't have a resource type") {
                continue;
            }
            bail!(
                "Cannot verify native infrastructure ownership: {}",
                error.trim()
            );
        }
        let resource: Value = serde_json::from_slice(&result.stdout)?;
        let annotations = &resource["metadata"]["annotations"];
        if kind == "crd" {
            if annotations["gateway.networking.k8s.io/bundle-version"] != "v1.6.1"
                || annotations["gateway.networking.k8s.io/channel"] != "experimental"
            {
                bail!("Native Envoy v1.9.2 requires experimental Gateway API v1.6.1; use a fresh cluster or explicitly qualify the provider-owned CRD upgrade first");
            }
            continue;
        }
        let expected_namespace = if scope.is_empty() { namespace } else { scope };
        if annotations["meta.helm.sh/release-name"] != owner
            || annotations["meta.helm.sh/release-namespace"] != expected_namespace
        {
            bail!("{kind}/{name} has another owner; complete an explicit demo reset or ownership handover first");
        }
    }
    Ok(())
}

pub struct Prepared {
    pub private: PathBuf,
    pub environment: String,
}

pub fn pinned(image: &str) -> bool {
    image
        .rsplit_once("@sha256:")
        .is_some_and(|(repository, digest)| {
            !repository.is_empty()
                && digest.len() == 64
                && digest
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
}

pub fn save(path: &Path, value: &Value) -> Result<()> {
    if path.is_symlink() {
        bail!("Refusing a symlink input: {}", path.display());
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    if path.exists() {
        let previous: Value = serde_json::from_slice(&fs::read(path)?)?;
        if previous != *value {
            bail!(
                "{} differs from the requested inputs; review it explicitly instead of overwriting",
                path.display()
            );
        }
        return Ok(());
    }
    private_write(path, &bytes)
}

pub fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub(super) fn secret(directory: &Path, name: &str) -> Result<String> {
    let path = directory.join(name);
    if path.is_symlink() {
        bail!("Refusing a symlink credential: {}", path.display());
    }
    if !path.exists() {
        let result = Command::new("openssl")
            .args(["rand", "-hex", "32"])
            .output()?;
        if !result.status.success() {
            bail!("OpenSSL credential generation failed");
        }
        private_write(&path, &result.stdout)?;
    }
    let result = fs::read_to_string(path)?.trim().to_owned();
    if result.is_empty() {
        bail!("Existing credential {name} is empty");
    }
    Ok(result)
}

fn parameters(directory: &Path, name: &str, values: Value) -> Result<()> {
    let parameters: BTreeMap<_, _> = values
        .as_object()
        .context("Expected parameter object")?
        .iter()
        .map(|(key, value)| (key.clone(), json!({"value": value})))
        .collect();
    save(&directory.join(name), &json!({"parameters": parameters}))
}

fn local_images(config: &Config) -> Result<BTreeMap<String, String>> {
    if !config.images.is_empty() {
        return Ok(config.images.clone());
    }
    let inventory = Command::new("sudo")
        .args(["k3s", "ctr", "-n", "k8s.io", "images", "list"])
        .output()
        .context("Use pinned images in the config, or import the selected tags into local K3s")?;
    if !inventory.status.success() {
        bail!("Cannot read local K3s images; import them or supply config.images");
    }
    let inventory = String::from_utf8(inventory.stdout)?;
    let mut images = BTreeMap::new();
    for component in COMPONENTS {
        let tag = format!(
            "{}/{}:{}",
            config.image_registry, component, config.image_tag
        );
        let columns = inventory
            .lines()
            .find_map(|line| {
                let parts: Vec<_> = line.split_whitespace().collect();
                (parts.first() == Some(&tag.as_str())).then_some(parts)
            })
            .with_context(|| format!("Missing imported image {tag}"))?;
        let digest = columns
            .get(2)
            .context("Invalid containerd image inventory")?;
        images.insert(
            component.into(),
            format!("{}/{}@{}", config.image_registry, component, digest),
        );
    }
    Ok(images)
}

pub fn prepare(
    config_file: &Path,
    state: &Path,
    namespace: &str,
    release: &str,
    group: &str,
) -> Result<Prepared> {
    let config: Config = serde_json::from_slice(&fs::read(config_file)?)?;
    if config.recipe_archive.contains("REPLACE_WITH")
        || (!config.recipe_archive.starts_with("https://")
            && !(config.recipe_archive.starts_with("http://")
                && config
                    .recipe_archive
                    .split('/')
                    .nth(2)
                    .is_some_and(|host| host.contains(".svc.cluster.local:"))))
    {
        bail!("Use HTTPS for the immutable archive or the explicit cluster-local artifact server");
    }
    for value in [namespace, release, group]
        .into_iter()
        .chain(config.agent_names.iter().map(String::as_str))
        .chain(config.models.iter().map(|model| model.name.as_str()))
    {
        if value.is_empty()
            || value.len() > 63
            || value.starts_with('-')
            || value.ends_with('-')
            || !value
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            bail!("Use explicit lowercase DNS-label namespace, release and group names");
        }
    }
    if config.agent_names.iter().any(|name| name.len() > 32) {
        bail!("Agent names must be lowercase DNS labels of at most 32 characters");
    }
    if config.models.is_empty() {
        bail!("Supply explicit KAITO/vLLM, Foundry or hybrid model declarations in config.models");
    }
    let mut model_names = std::collections::BTreeSet::new();
    for model in &config.models {
        if !model_names.insert(&model.name) {
            bail!("Model resource names must be unique: {}", model.name);
        }
        let properties = model
            .properties
            .as_object()
            .context("Model properties must be an object")?;
        if !properties
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty())
        {
            bail!("Each model declaration requires an explicit model name");
        }
        if ["localWorkspace", "localService", "azure", "members"]
            .iter()
            .filter(|key| properties.contains_key(**key))
            .count()
            != 1
        {
            bail!("Each model requires exactly one localWorkspace, localService, azure or members binding");
        }
        for key in ["localWorkspace", "localService", "azure"] {
            if properties.get(key).is_some_and(|binding| {
                !binding.as_object().is_some_and(|object| !object.is_empty())
            }) {
                bail!("Model {key} binding must be a nonempty object");
            }
        }
        if properties
            .get("members")
            .is_some_and(|members| !members.as_array().is_some_and(|items| !items.is_empty()))
        {
            bail!("Hybrid models require nonempty captured members");
        }
        if properties
            .get("localService")
            .is_some_and(|service| service.get("cpuInference").is_some())
        {
            bail!("CPU inference provisioning is removed; use KAITO/vLLM or an existing inference Service");
        }
        if let Some(workspace) = properties.get("localWorkspace") {
            if !workspace
                .get("image")
                .and_then(Value::as_str)
                .is_some_and(pinned)
                || !workspace
                    .get("revision")
                    .and_then(Value::as_str)
                    .is_some_and(|revision| {
                        revision.len() == 40 && revision.bytes().all(|c| c.is_ascii_hexdigit())
                    })
            {
                bail!("KAITO/vLLM requires an immutable image digest and exact 40-character model revision");
            }
        }
        if properties
            .get("azure")
            .is_some_and(|azure| azure.get("apiKey").is_some() || azure.get("api_key").is_some())
        {
            bail!("Foundry model authentication uses gateway workload identity, never API keys");
        }
    }
    let cloud_models = config.models.iter().any(|model| {
        model.properties.get("azure").is_some()
            || model
                .properties
                .get("members")
                .and_then(Value::as_array)
                .is_some_and(|members| {
                    members.iter().any(|member| {
                        member
                            .get("deployments")
                            .and_then(Value::as_array)
                            .is_some_and(|deployments| {
                                deployments.iter().any(|deployment| {
                                    deployment["litellm_params"]["model"]
                                        .as_str()
                                        .is_some_and(|provider| provider.starts_with("azure/"))
                                })
                            })
                    })
                })
    });
    if cloud_models && config.model_gateway_identity.is_none() {
        bail!("Foundry models require modelGatewayIdentity with the reviewed gateway client and tenant IDs");
    }
    if config
        .model_gateway_identity
        .as_ref()
        .is_some_and(|identity| {
            identity.client_id.trim().is_empty() || identity.tenant_id.trim().is_empty()
        })
    {
        bail!("Gateway workload identity requires nonempty reviewed clientId and tenantId");
    }
    let model_configs: Vec<_> = config
        .models
        .iter()
        .map(|model| {
            json!({
                "name": model.name,
                "digest": model.properties.to_string()
            })
        })
        .collect();
    let images = local_images(&config)?;
    for component in COMPONENTS {
        if !images.get(component).is_some_and(|image| pinned(image)) {
            bail!("Supply an immutable image digest for {component}");
        }
    }
    let private = state.join("private");
    if private.is_symlink() {
        bail!("Refusing a symlink private directory");
    }
    fs::create_dir_all(&private)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&private, fs::Permissions::from_mode(0o700))?;
    }
    let admin = secret(&private, "keycloak-admin-password")?;
    let login = secret(&private, "keycloak-config-client-secret")?;
    let gateway = secret(&private, "model-gateway-master-key")?;
    let database = secret(&private, "keycloak-db-password")?;
    let cert = private.join("ui-tls.crt");
    let key = private.join("ui-tls.key");
    if cert.is_symlink() || key.is_symlink() {
        bail!("Refusing a symlink TLS certificate or key");
    }
    if cert.exists() != key.exists() {
        bail!("TLS certificate/key is incomplete; restore the existing pair");
    }
    if !cert.exists() {
        let status = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "365",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
                "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()?;
        if !status.status.success() {
            bail!("Development TLS certificate generation failed");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&key, fs::Permissions::from_mode(0o600))?;
            fs::set_permissions(&cert, fs::Permissions::from_mode(0o600))?;
        }
    }
    if !Command::new("openssl")
        .args(["verify", "-partial_chain", "-trusted"])
        .arg(&cert)
        .args(["-verify_hostname", "localhost"])
        .arg(&cert)
        .output()?
        .status
        .success()
    {
        bail!("Existing development certificate is expired or does not cover localhost; replace it explicitly");
    }
    let public = Command::new("openssl")
        .args(["x509", "-in"])
        .arg(&cert)
        .args(["-pubkey", "-noout"])
        .output()?;
    let private_key = Command::new("openssl")
        .args(["pkey", "-in"])
        .arg(&key)
        .args(["-passin", "pass:", "-pubout"])
        .output()?;
    if !public.status.success()
        || !private_key.status.success()
        || public.stdout != private_key.stdout
    {
        bail!("Development TLS certificate and key do not match");
    }
    let base = format!("/planes/radius/local/resourceGroups/{group}/providers/Applications.Core");
    let environment = format!("{base}/environments/agents");
    let login_environment = format!("{base}/environments/agents-login");
    let store = format!("{base}/secretStores/agent-provisioning");
    let keycloak = format!("http://{release}-keycloak.{namespace}.svc.cluster.local:8080");
    let issuer = "https://localhost:8444/realms/adaptive";
    let mut executor = json!({
        "env": {"KEYCLOAK_URL": keycloak, "KEYCLOAK_REALM": "master", "KEYCLOAK_CLIENT_ID": "admin-cli", "KEYCLOAK_USER": "admin"},
        "envSecrets": {"KEYCLOAK_PASSWORD": {"source": store, "key": "keycloak-admin-password"}}
    });
    let mut identity = json!({});
    let mut graph_certificate = String::new();
    let mut graph_password = String::new();
    if let Some(connected) = &config.connected {
        graph_certificate = fs::read_to_string(&connected.certificate_file)?;
        graph_password = fs::read_to_string(&connected.certificate_password_file)?;
        if graph_certificate.trim().is_empty() || graph_password.trim().is_empty() {
            bail!("Reviewed Graph certificate credentials must not be empty");
        }
        identity = json!({
            "tenant_id": connected.tenant_id, "sponsor_user_id": connected.sponsor_user_id,
            "owner_user_id": connected.owner_user_id, "oidc_issuer": connected.oidc_issuer
        });
        executor["env"]["ARM_TENANT_ID"] = json!(connected.tenant_id);
        executor["env"]["ARM_CLIENT_ID"] = json!(connected.provisioner_client_id);
        executor["env"]["ARM_USE_CLI"] = json!("false");
        executor["envSecrets"]["ARM_CLIENT_CERTIFICATE"] =
            json!({"source": store, "key": "graph-client-certificate"});
        executor["envSecrets"]["ARM_CLIENT_CERTIFICATE_PASSWORD"] =
            json!({"source": store, "key": "graph-client-certificate-password"});
    }
    parameters(
        &private,
        "credentials.parameters.json",
        json!({
            "keycloakAdminPassword": admin, "keycloakConfigClientSecret": login,
            "graphClientCertificate": graph_certificate, "graphClientCertificatePassword": graph_password
        }),
    )?;
    parameters(
        &private,
        "environment.parameters.json",
        json!({
            "namespace": namespace, "recipeArchive": config.recipe_archive,
            "recipeRegistry": config.recipe_registry,
            "plainHttp": config.recipe_registry.split('/').next().is_some_and(|host| host.contains(".svc.cluster.local:")),
            "connected": config.connected.is_some(), "identityParameters": identity,
            "recipeConfig": executor,
            "loginRecipeConfig": {
                "env": {"KEYCLOAK_URL": keycloak, "KEYCLOAK_REALM": "adaptive", "KEYCLOAK_CLIENT_ID": "adaptive-login-config"},
                "envSecrets": {"KEYCLOAK_CLIENT_SECRET": {"source": store, "key": "keycloak-config-client-secret"}}
            },
            "platform": {
                "adapterImage": images["dac-adapter"], "sidecarImage": SIDECAR,
                "governanceImage": images["governance-sidecar"], "keycloakUrl": keycloak,
                "issuer": issuer, "ingressUrl": "https://localhost:8443",
                "otelEndpoint": format!("http://otel-collector.{namespace}.svc.cluster.local:4318"),
                "peers": config.peers
            }
        }),
    )?;
    parameters(
        &private,
        "services.parameters.json",
        json!({
            "environment": environment, "loginEnvironment": login_environment,
            "keycloakPublicUrl": "https://localhost:8444",
            "login": {"uiOrigin": "https://localhost:8443", "platformRoles": ["agent.invoke"], "connected": false},
            "models": config.models
        }),
    )?;
    save(
        &private.join("portfolio.values.json"),
        &json!({
            "features": {"agents": {"enabled": true}},
            "keycloak": {"existingSecret": "adaptive-keycloak-admin", "publicUrl": "https://localhost:8444"},
            "postgresql": {"auth": {"password": database}},
            "agents": {
                "keycloakService": format!("{release}-keycloak"),
                "telemetry": {"enabled": true},
                "runtime": {
                    "uiImage": images["ui"], "apiImage": images["platform-api"], "issuer": issuer,
                    "certificateSecret": "adaptive-ui-tls",
                    "environmentJson": json!({"name": namespace, "cloud": {"enabled": config.connected.is_some() || cloud_models}}).to_string()
                },
                "modelGateway": {
                    "configs": model_configs,
                    "identity": config.model_gateway_identity,
                    "authorization": {
                        "issuer": issuer, "jwksUrl": format!("{keycloak}/realms/adaptive/protocol/openid-connect/certs"),
                        "clients": (config.agent_names.iter().map(|name| format!("adaptive-{namespace}-{name}")).collect::<Vec<_>>()),
                        "agentIds": [], "tenantId": ""
                    }
                }
            }
        }),
    )?;
    save(
        &private.join("secrets.json"),
        &json!({
            "apiVersion": "v1", "kind": "List", "items": [
                {"apiVersion":"v1","kind":"Secret","metadata":{"name":"adaptive-keycloak-admin","namespace":namespace},"stringData":{"username":"admin","password":admin}},
                {"apiVersion":"v1","kind":"Secret","metadata":{"name":"adaptive-keycloak-login-config","namespace":namespace},"stringData":{"client-secret":login}},
                {"apiVersion":"v1","kind":"Secret","metadata":{"name":"model-gateway-auth","namespace":namespace},"stringData":{"master-key":gateway,"credential":format!("Bearer {gateway}")}},
                {"apiVersion":"v1","kind":"Secret","type":"kubernetes.io/tls","metadata":{"name":"adaptive-ui-tls","namespace":namespace},"stringData":{"tls.crt":fs::read_to_string(&cert)?,"tls.key":fs::read_to_string(&key)?}}
            ]
        }),
    )?;
    ui::ok(&format!(
        "Native inputs ready in {}; existing credentials preserved",
        private.display()
    ));
    Ok(Prepared {
        private,
        environment,
    })
}

pub fn deploy(
    radius: &Path,
    file: &str,
    prepared: &Prepared,
    group: &str,
    parameters: &str,
) -> Result<()> {
    let status = Command::new("rad")
        .arg("deploy")
        .arg(radius.join(file))
        .args([
            "--group",
            group,
            "--environment",
            &prepared.environment,
            "--parameters",
        ])
        .arg(format!("@{}", prepared.private.join(parameters).display()))
        .status()?;
    if !status.success() {
        bail!("Radius deployment failed: {file}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_must_be_real_digest_references() {
        assert!(pinned(&format!("registry/agent@sha256:{}", "a".repeat(64))));
        assert!(!pinned("registry/agent:latest"));
        assert!(!pinned("registry/agent@sha256:short"));
        assert!(!pinned(&format!(
            "registry/agent@sha256:{}",
            "z".repeat(64)
        )));
    }

    #[test]
    fn config_rejects_unrecognized_secret_and_mode_fields() {
        assert!(serde_json::from_value::<Config>(json!({
            "recipeArchive":"https://example/recipes.tgz", "password":"do-not-inline"
        }))
        .is_err());
        let parsed: Config = serde_json::from_value(json!({
            "recipeArchive":"https://example/recipes.tgz"
        }))
        .unwrap();
        assert_eq!(parsed.image_tag, "dev");
        assert!(parsed.connected.is_none());
    }

    #[test]
    fn preparing_inputs_is_private_idempotent_and_namespace_scoped() {
        let root = std::env::temp_dir().join(format!(
            "ada-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let config = root.join("config.json");
        let images: BTreeMap<_, _> = COMPONENTS
            .into_iter()
            .map(|component| {
                (
                    component,
                    format!("registry/{component}@sha256:{}", "a".repeat(64)),
                )
            })
            .collect();
        fs::write(
            &config,
            serde_json::to_vec(&json!({
                "recipeArchive":"https://example.test/immutable/recipes.tgz", "images":images,
                "models": [{"name":"local-chat","properties":{"model":"local-chat","localService":{"name":"vllm","port":80,"model":"local-chat"}}}]
            }))
            .unwrap(),
        )
        .unwrap();
        let prepared = prepare(&config, &root, "demo-test", "demo", "adaptive").unwrap();
        let before = fs::read(prepared.private.join("secrets.json")).unwrap();
        prepare(&config, &root, "demo-test", "demo", "adaptive").unwrap();
        assert_eq!(
            before,
            fs::read(prepared.private.join("secrets.json")).unwrap()
        );
        let environment: Value = serde_json::from_slice(
            &fs::read(prepared.private.join("environment.parameters.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            environment["parameters"]["platform"]["value"]["keycloakUrl"],
            "http://demo-keycloak.demo-test.svc.cluster.local:8080"
        );
        assert_eq!(environment["parameters"]["connected"]["value"], false);
        assert!(prepare(&config, &root, "other", "demo", "adaptive").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(prepared.private.join("secrets.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(prepared.private.join("ui-tls.crt"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&prepared.private)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        let mut invalid: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        invalid["agentNames"] = json!(["a".repeat(33)]);
        fs::write(&config, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(prepare(&config, &root, "demo-test", "demo", "adaptive").is_err());
        invalid["agentNames"] = json!(["writer"]);
        invalid["models"][0]["properties"]["localService"]["cpuInference"] = json!(true);
        fs::write(&config, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(prepare(&config, &root, "demo-test", "demo", "adaptive")
            .err()
            .unwrap()
            .to_string()
            .contains("CPU inference"));
        invalid["models"] = json!([{"name":"cloud","properties":{"model":"cloud","azure":{"endpoint":"https://example.test","deployment":"chat"}}}]);
        fs::write(&config, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(prepare(&config, &root, "demo-test", "demo", "adaptive")
            .err()
            .unwrap()
            .to_string()
            .contains("modelGatewayIdentity"));
        fs::remove_dir_all(root).unwrap();
    }
}
