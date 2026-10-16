//! Generate the public native-agent configuration from repository metadata.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use clap::Args;
use serde_json::Value;

use crate::commands::agents;
use crate::{home, ui};

#[derive(Debug, Args)]
pub struct AgentsConfigArgs {
    /// Configuration to create or update.
    #[arg(long, default_value = "agents.json")]
    output: PathBuf,

    /// Example to use when the output does not exist.
    #[arg(long)]
    template: Option<PathBuf>,

    /// GitHub repository in OWNER/REPOSITORY form. Defaults to origin.
    #[arg(long)]
    repository: Option<String>,

    /// Full Git commit SHA used by the recipes release. Defaults to HEAD.
    #[arg(long)]
    commit: Option<String>,

    /// Pull the selected agent images into local K3s containerd.
    #[arg(long)]
    import_images: bool,

    /// Configure the platform without deploying a model yet.
    #[arg(long)]
    without_models: bool,
}

pub fn run(args: AgentsConfigArgs) -> Result<()> {
    let repository = match args.repository {
        Some(repository) => validate_repository(&repository)?,
        None => {
            let remote = git_output(&["config", "--get", "remote.origin.url"])?;
            repository_from_remote(&remote)?
        }
    };
    let commit = match args.commit {
        Some(commit) => validate_commit(&commit)?,
        None => validate_commit(&git_output(&["rev-parse", "HEAD"])?)?,
    };
    let template = match args.template {
        Some(template) => template,
        None => default_template()?,
    };

    write_config(
        &args.output,
        &template,
        &repository,
        &commit,
        args.without_models,
    )?;
    ui::heading("ada agents-config");
    ui::detail("repository", &repository);
    ui::detail("commit", &commit);
    ui::ok(&format!("wrote {}", args.output.display()));
    if args.import_images {
        import_images(&args.output)?;
    }
    Ok(())
}

fn default_template() -> Result<PathBuf> {
    if let Ok(root) = git_output(&["rev-parse", "--show-toplevel"]) {
        let candidate = PathBuf::from(root)
            .join("radius")
            .join("agents.example.json");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Ok(home::radius_root()?.join("agents.example.json"))
}

fn git_output(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .with_context(|| format!("failed to run git {}", args.join(" ")))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        bail!("git {} failed: {}", args.join(" "), error.trim());
    }
    Ok(String::from_utf8(output.stdout)
        .context("git returned non-UTF-8 output")?
        .trim()
        .to_owned())
}

fn repository_from_remote(remote: &str) -> Result<String> {
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("http://github.com/"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "origin is not a GitHub repository: {remote}; pass --repository OWNER/REPOSITORY"
            )
        })?
        .trim_end_matches(".git")
        .trim_end_matches('/');
    validate_repository(path)
}

fn validate_repository(repository: &str) -> Result<String> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        bail!("repository must use OWNER/REPOSITORY form");
    }
    if !owner
        .bytes()
        .chain(name.bytes())
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("repository contains unsupported characters");
    }
    Ok(format!("{owner}/{name}"))
}

fn validate_commit(commit: &str) -> Result<String> {
    let commit = commit.trim();
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("commit must be a full 40-character Git SHA");
    }
    Ok(commit.to_ascii_lowercase())
}

fn write_config(
    output: &Path,
    template: &Path,
    repository: &str,
    commit: &str,
    without_models: bool,
) -> Result<()> {
    if output.is_symlink() {
        bail!("refusing a symlink output: {}", output.display());
    }
    let source = if output.exists() { output } else { template };
    let bytes = fs::read(source)
        .with_context(|| format!("failed to read agents config source {}", source.display()))?;
    let mut config: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid JSON in {}", source.display()))?;
    let object = config
        .as_object_mut()
        .context("agents config must be a JSON object")?;
    let (owner, name) = repository
        .split_once('/')
        .context("repository must use OWNER/REPOSITORY form")?;
    let registry_path = format!(
        "{}/{}",
        owner.to_ascii_lowercase(),
        name.to_ascii_lowercase()
    );

    object.insert(
        "recipeArchive".into(),
        Value::String(format!(
            "https://github.com/{repository}/releases/download/recipes-{commit}/recipes.tgz"
        )),
    );
    object.insert(
        "recipeRegistry".into(),
        Value::String(format!("ghcr.io/{registry_path}/recipes")),
    );
    object.insert(
        "imageRegistry".into(),
        Value::String(format!("ghcr.io/{registry_path}")),
    );
    if without_models {
        object.insert("models".into(), Value::Array(Vec::new()));
    }
    serde_json::from_value::<agents::Config>(config.clone())
        .context("generated agents configuration is invalid")?;

    let mut rendered = serde_json::to_vec_pretty(&config)?;
    rendered.push(b'\n');
    fs::write(output, rendered).with_context(|| format!("failed to write {}", output.display()))?;
    Ok(())
}

fn import_images(config_path: &Path) -> Result<()> {
    let config: agents::Config = serde_json::from_slice(
        &fs::read(config_path)
            .with_context(|| format!("failed to read {}", config_path.display()))?,
    )
    .with_context(|| format!("invalid agents configuration in {}", config_path.display()))?;
    let images = image_references(&config)?;
    let inventory = Command::new("sudo")
        .args(["k3s", "ctr", "-n", "k8s.io", "images", "list", "-q"])
        .output()
        .context("failed to read the local K3s image inventory")?;
    if !inventory.status.success() {
        bail!(
            "failed to read the local K3s image inventory: {}",
            String::from_utf8_lossy(&inventory.stderr).trim()
        );
    }
    let inventory =
        String::from_utf8(inventory.stdout).context("K3s image inventory was not UTF-8")?;

    for image in missing_image_references(images, &inventory) {
        ui::detail("importing", &image);
        let status = Command::new("sudo")
            .args(["k3s", "ctr", "-n", "k8s.io", "images", "pull"])
            .arg(&image)
            .status()
            .with_context(|| format!("failed to start K3s image import for {image}"))?;
        if !status.success() {
            bail!("K3s image import failed for {image}");
        }
    }
    ui::ok("required agent images are available in local K3s");
    Ok(())
}

fn missing_image_references(images: Vec<String>, inventory: &str) -> Vec<String> {
    let imported: std::collections::BTreeSet<_> = inventory.lines().collect();
    images
        .into_iter()
        .filter(|image| !imported.contains(image.as_str()))
        .collect()
}

fn image_references(config: &agents::Config) -> Result<Vec<String>> {
    if config.images.is_empty() {
        return Ok(agents::COMPONENTS
            .into_iter()
            .map(|component| {
                format!(
                    "{}/{}:{}",
                    config.image_registry, component, config.image_tag
                )
            })
            .collect());
    }

    let images: Vec<_> = agents::COMPONENTS
        .into_iter()
        .map(|component| {
            config
                .images
                .get(component)
                .cloned()
                .with_context(|| format!("config.images is missing {component}"))
        })
        .collect::<Result<_>>()?;
    if let Some(image) = images.iter().find(|image| !agents::pinned(image)) {
        bail!("config.images must use immutable sha256 references: {image}");
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ada-agents-config-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn parses_common_github_remote_formats() {
        for remote in [
            "git@github.com:Example/Adaptive-Apps.git",
            "https://github.com/Example/Adaptive-Apps.git",
            "ssh://git@github.com/Example/Adaptive-Apps",
        ] {
            assert_eq!(
                repository_from_remote(remote).unwrap(),
                "Example/Adaptive-Apps"
            );
        }
        assert!(repository_from_remote("https://example.test/owner/repo.git").is_err());
    }

    #[test]
    fn updates_locations_without_replacing_reviewed_inputs() {
        let root = temp_dir("update");
        fs::create_dir(&root).unwrap();
        let template = root.join("example.json");
        let output = root.join("agents.json");
        fs::write(
            &template,
            serde_json::to_vec(&json!({
                "recipeArchive": "placeholder",
                "models": [{
                    "name": "local-chat",
                    "properties": {
                        "model": "local-chat",
                        "localService": {"name": "vllm", "port": 80, "model": "local-chat"}
                    }
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        write_config(
            &output,
            &template,
            "Example/Adaptive-Apps",
            &"a".repeat(40),
            false,
        )
        .unwrap();
        let mut existing: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        existing["agentNames"] = json!(["reviewed-agent"]);
        existing["images"] =
            json!({"prompt-agent": format!("example/prompt@sha256:{}", "b".repeat(64))});
        fs::write(&output, serde_json::to_vec(&existing).unwrap()).unwrap();

        write_config(
            &output,
            &template,
            "NewOwner/NewRepo",
            &"c".repeat(40),
            false,
        )
        .unwrap();
        let updated: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(updated["agentNames"], json!(["reviewed-agent"]));
        assert_eq!(updated["images"], existing["images"]);
        assert_eq!(
            updated["recipeArchive"],
            format!(
                "https://github.com/NewOwner/NewRepo/releases/download/recipes-{}/recipes.tgz",
                "c".repeat(40)
            )
        );
        assert_eq!(
            updated["recipeRegistry"],
            "ghcr.io/newowner/newrepo/recipes"
        );
        assert_eq!(updated["imageRegistry"], "ghcr.io/newowner/newrepo");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn can_explicitly_prepare_a_model_free_configuration() {
        let root = temp_dir("without-models");
        fs::create_dir(&root).unwrap();
        let template = root.join("template.json");
        let output = root.join("agents.json");
        fs::write(
            &template,
            serde_json::to_vec(&json!({
                "recipeArchive": "placeholder",
                "models": [{
                    "name": "local-chat",
                    "properties": {
                        "model": "local-chat",
                        "localService": {"name": "vllm"}
                    }
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        write_config(
            &output,
            &template,
            "Example/Adaptive-Apps",
            &"a".repeat(40),
            true,
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(config["models"], json!([]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn requires_an_immutable_commit() {
        assert!(validate_commit("abc123").is_err());
        assert_eq!(validate_commit(&"A".repeat(40)).unwrap(), "a".repeat(40));
    }

    #[test]
    fn selects_tags_or_complete_immutable_image_map() {
        let tagged: agents::Config = serde_json::from_value(json!({
            "recipeArchive": "https://example.test/recipes.tgz",
            "imageRegistry": "ghcr.io/example/project",
            "imageTag": "release"
        }))
        .unwrap();
        assert_eq!(
            image_references(&tagged).unwrap(),
            agents::COMPONENTS
                .map(|component| format!("ghcr.io/example/project/{component}:release"))
        );

        let images: std::collections::BTreeMap<_, _> = agents::COMPONENTS
            .into_iter()
            .map(|component| {
                (
                    component,
                    format!(
                        "ghcr.io/example/project/{component}@sha256:{}",
                        "a".repeat(64)
                    ),
                )
            })
            .collect();
        let pinned: agents::Config = serde_json::from_value(json!({
            "recipeArchive": "https://example.test/recipes.tgz",
            "images": images
        }))
        .unwrap();
        assert_eq!(image_references(&pinned).unwrap().len(), 6);

        let incomplete: agents::Config = serde_json::from_value(json!({
            "recipeArchive": "https://example.test/recipes.tgz",
            "images": {"prompt-agent": format!("image@sha256:{}", "a".repeat(64))}
        }))
        .unwrap();
        assert!(image_references(&incomplete)
            .unwrap_err()
            .to_string()
            .contains("editor"));
    }

    #[test]
    fn image_import_skips_exact_references_already_in_k3s() {
        let images = vec![
            "registry/prompt-agent:latest".to_owned(),
            "registry/agent-gateway:latest".to_owned(),
        ];
        let missing =
            missing_image_references(images, "registry/agent-gateway:latest\nsha256:abc\n");
        assert_eq!(missing, vec!["registry/prompt-agent:latest"]);
    }
}
