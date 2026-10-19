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

    /// Full Git commit SHA used by an existing recipes release. Defaults to the newest published release.
    #[arg(long)]
    commit: Option<String>,

    /// Pull the selected agent images into local K3s containerd.
    #[arg(long)]
    import_images: bool,

    /// Clear model declarations, including from an existing configuration.
    #[arg(
        long,
        conflicts_with_all = ["with_kaito_model", "with_openai_model"]
    )]
    without_models: bool,

    /// Install the example KAITO/vLLM local model declaration.
    #[arg(
        long,
        conflicts_with_all = ["without_models", "with_openai_model"]
    )]
    with_kaito_model: bool,

    /// Configure public OpenAI for both native agents and the trading application.
    #[arg(
        long,
        conflicts_with_all = ["without_models", "with_kaito_model"]
    )]
    with_openai_model: bool,

    /// Private file containing the OpenAI API key.
    #[arg(long)]
    openai_api_key_file: Option<PathBuf>,

    /// OpenAI model name. Defaults to gpt-4o.
    #[arg(long)]
    openai_model: Option<String>,

    /// OpenAI-compatible API endpoint. Defaults to the public OpenAI endpoint.
    #[arg(long)]
    openai_endpoint: Option<String>,
}

struct OpenAiModelInput {
    api_key_file: PathBuf,
    endpoint: String,
    model: String,
}

pub fn run(args: AgentsConfigArgs) -> Result<()> {
    let repository = match args.repository {
        Some(repository) => validate_repository(&repository)?,
        None => {
            let remote = git_output(&["config", "--get", "remote.origin.url"])?;
            repository_from_remote(&remote)?
        }
    };
    let commit = resolve_recipe_commit(&repository, args.commit.as_deref())?;
    let template = match args.template {
        Some(template) => template,
        None => default_template()?,
    };
    let has_openai_options = args.openai_api_key_file.is_some()
        || args.openai_model.is_some()
        || args.openai_endpoint.is_some();
    if !args.with_openai_model && has_openai_options {
        bail!("OpenAI options require --with-openai-model");
    }
    let openai = args
        .with_openai_model
        .then(|| -> Result<OpenAiModelInput> {
            Ok(OpenAiModelInput {
                api_key_file: args
                    .openai_api_key_file
                    .context("--with-openai-model requires --openai-api-key-file")?,
                endpoint: args
                    .openai_endpoint
                    .unwrap_or_else(|| "https://api.openai.com/v1".into()),
                model: args.openai_model.unwrap_or_else(|| "gpt-4o".into()),
            })
        })
        .transpose()?;

    write_config(
        &args.output,
        &template,
        &repository,
        &commit,
        args.without_models,
        args.with_kaito_model,
        openai.as_ref(),
    )?;
    ui::heading("ada agents-config");
    ui::detail("repository", &repository);
    ui::detail("recipe commit", &commit);
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

fn resolve_recipe_commit(repository: &str, requested: Option<&str>) -> Result<String> {
    let requested = requested.map(validate_commit).transpose()?;
    let url = format!("https://api.github.com/repos/{repository}/releases?per_page=100");
    let mut request = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "adaptive-apps-ada");
    if let Ok(token) = std::env::var("GH_TOKEN") {
        if !token.trim().is_empty() {
            request = request.set("Authorization", &format!("Bearer {}", token.trim()));
        }
    }
    let response = request.call().map_err(|error| match error {
        ureq::Error::Status(code, response) => anyhow::anyhow!(
            "GitHub releases query for {repository} returned HTTP {code}: {}",
            response.status_text()
        ),
        error => anyhow::anyhow!("GitHub releases query for {repository} failed: {error}"),
    })?;
    let releases: Value = response
        .into_json()
        .context("GitHub releases response was not valid JSON")?;
    let commits = published_recipe_commits(&releases)?;
    if let Some(commit) = requested {
        if commits.iter().any(|published| published == &commit) {
            return Ok(commit);
        }
        bail!(
                "recipes-{commit} is not published in {repository}; publish that commit or omit --commit to use the newest published recipes"
            );
    }
    commits.into_iter().next().with_context(|| {
        format!("No published recipes-<commit> release with recipes.tgz exists in {repository}")
    })
}

fn published_recipe_commits(releases: &Value) -> Result<Vec<String>> {
    let releases = releases
        .as_array()
        .context("GitHub releases response must be an array")?;
    let mut commits = Vec::new();
    for release in releases {
        let Some(tag) = release["tag_name"].as_str() else {
            continue;
        };
        let Some(commit) = tag.strip_prefix("recipes-") else {
            continue;
        };
        let Ok(commit) = validate_commit(commit) else {
            continue;
        };
        let has_archive = release["assets"]
            .as_array()
            .is_some_and(|assets| assets.iter().any(|asset| asset["name"] == "recipes.tgz"));
        if has_archive {
            let published = release["published_at"].as_str().unwrap_or_default();
            commits.push((published.to_owned(), commit));
        }
    }
    commits.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(commits.into_iter().map(|(_, commit)| commit).collect())
}

fn write_config(
    output: &Path,
    template: &Path,
    repository: &str,
    commit: &str,
    without_models: bool,
    with_kaito_model: bool,
    openai: Option<&OpenAiModelInput>,
) -> Result<()> {
    if output.is_symlink() {
        bail!("refusing a symlink output: {}", output.display());
    }
    let output_exists = output.exists();
    let source = if output_exists { output } else { template };
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
    if let Some(openai) = openai {
        object.insert("agentModel".into(), Value::String("openai-chat".into()));
        object.insert(
            "openaiApiKeyFile".into(),
            Value::String(openai.api_key_file.to_string_lossy().into_owned()),
        );
        object.insert(
            "models".into(),
            serde_json::json!([{
                "name": "openai-chat",
                "properties": {
                    "model": openai.model,
                    "openai": {
                        "endpoint": openai.endpoint,
                        "model": openai.model
                    }
                }
            }]),
        );
    } else if with_kaito_model && output_exists {
        let template_config: Value = serde_json::from_slice(
            &fs::read(template)
                .with_context(|| format!("failed to read {}", template.display()))?,
        )
        .with_context(|| format!("invalid JSON in {}", template.display()))?;
        let models = template_config
            .get("models")
            .and_then(Value::as_array)
            .filter(|models| !models.is_empty())
            .cloned()
            .with_context(|| {
                format!(
                    "{} does not contain an example KAITO model",
                    template.display()
                )
            })?;
        let selected = models[0]["name"]
            .as_str()
            .context("example KAITO model requires a name")?
            .to_owned();
        object.insert("agentModel".into(), Value::String(selected));
        object.remove("openaiApiKeyFile");
        object.insert("models".into(), Value::Array(models));
    } else if without_models || (!output_exists && !with_kaito_model) {
        object.remove("openaiApiKeyFile");
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
    let inventory = Command::new("sudo")
        .args(["k3s", "ctr", "-n", "k8s.io", "images", "list"])
        .output()
        .context("failed to resolve imported K3s image digests")?;
    if !inventory.status.success() {
        bail!(
            "failed to resolve imported K3s image digests: {}",
            String::from_utf8_lossy(&inventory.stderr).trim()
        );
    }
    let inventory =
        String::from_utf8(inventory.stdout).context("K3s image inventory was not UTF-8")?;
    let pinned = resolved_image_map(&config, &inventory)?;
    persist_image_map(config_path, &pinned)?;
    ui::ok(&format!(
        "required agent images are available and pinned in {}",
        config_path.display()
    ));
    Ok(())
}

fn resolved_image_map(
    config: &agents::Config,
    inventory: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    agents::COMPONENTS
        .into_iter()
        .map(|component| {
            if let Some(image) = config.images.get(component) {
                if !agents::pinned(image) {
                    bail!("config.images must use immutable sha256 references: {image}");
                }
                return Ok((component.to_owned(), image.clone()));
            }
            let tag = format!(
                "{}/{}:{}",
                config.image_registry, component, config.image_tag
            );
            let columns = inventory
                .lines()
                .map(|line| line.split_whitespace().collect::<Vec<_>>())
                .find(|columns| columns.first() == Some(&tag.as_str()))
                .with_context(|| format!("imported image is missing from K3s inventory: {tag}"))?;
            let digest = columns
                .get(2)
                .with_context(|| format!("K3s inventory has no digest for {tag}"))?;
            let pinned = format!("{}/{}@{}", config.image_registry, component, digest);
            if !agents::pinned(&pinned) {
                bail!("K3s returned an invalid image digest for {tag}: {digest}");
            }
            Ok((component.to_owned(), pinned))
        })
        .collect()
}

fn persist_image_map(
    config_path: &Path,
    images: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    if config_path.is_symlink() {
        bail!("refusing a symlink output: {}", config_path.display());
    }
    let mut config: Value = serde_json::from_slice(&fs::read(config_path)?)
        .with_context(|| format!("invalid JSON in {}", config_path.display()))?;
    config
        .as_object_mut()
        .context("agents config must be a JSON object")?
        .insert("images".into(), serde_json::to_value(images)?);
    let mut rendered = serde_json::to_vec_pretty(&config)?;
    rendered.push(b'\n');
    fs::write(config_path, rendered)
        .with_context(|| format!("failed to write {}", config_path.display()))
}

fn missing_image_references(images: Vec<String>, inventory: &str) -> Vec<String> {
    let imported: std::collections::BTreeSet<_> = inventory.lines().collect();
    images
        .into_iter()
        .filter(|image| !imported.contains(image.as_str()))
        .collect()
}

fn image_references(config: &agents::Config) -> Result<Vec<String>> {
    let images: Vec<_> = agents::COMPONENTS
        .into_iter()
        .map(|component| {
            Ok(match config.images.get(component) {
                Some(image) if agents::pinned(image) => image.clone(),
                Some(image) => {
                    bail!("config.images must use immutable sha256 references: {image}")
                }
                None => format!(
                    "{}/{}:{}",
                    config.image_registry, component, config.image_tag
                ),
            })
        })
        .collect::<Result<_>>()?;
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
            false,
            None,
        )
        .unwrap();
        let mut existing: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        existing["agentNames"] = json!(["reviewed-agent"]);
        existing["images"] =
            json!({"prompt-agent": format!("example/prompt@sha256:{}", "b".repeat(64))});
        existing["models"] = json!([{
            "name": "reviewed-model",
            "properties": {
                "model": "reviewed-model",
                "localService": {"name": "reviewed-service"}
            }
        }]);
        fs::write(&output, serde_json::to_vec(&existing).unwrap()).unwrap();

        write_config(
            &output,
            &template,
            "NewOwner/NewRepo",
            &"c".repeat(40),
            false,
            false,
            None,
        )
        .unwrap();
        let updated: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(updated["agentNames"], json!(["reviewed-agent"]));
        assert_eq!(updated["images"], existing["images"]);
        assert_eq!(updated["models"], existing["models"]);
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
            false,
            None,
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(config["models"], json!([]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_configuration_requires_explicit_kaito_opt_in() {
        let root = temp_dir("kaito-opt-in");
        fs::create_dir(&root).unwrap();
        let template = root.join("template.json");
        fs::write(
            &template,
            serde_json::to_vec(&json!({
                "recipeArchive": "placeholder",
                "models": [{
                    "name": "local-chat",
                    "recipe": "kaito",
                    "properties": {
                        "model": "local-chat",
                        "localWorkspace": {
                            "source": "Qwen/Qwen3-0.6B",
                            "revision": "c1899de289a04d12100db370d81485cdf75e47ca",
                            "image": format!("vllm/vllm-openai@sha256:{}", "a".repeat(64))
                        }
                    }
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let model_free = root.join("model-free.json");
        write_config(
            &model_free,
            &template,
            "Example/Adaptive-Apps",
            &"a".repeat(40),
            false,
            false,
            None,
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&model_free).unwrap()).unwrap();
        assert_eq!(config["models"], json!([]));

        write_config(
            &model_free,
            &template,
            "Example/Adaptive-Apps",
            &"a".repeat(40),
            false,
            true,
            None,
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&model_free).unwrap()).unwrap();
        assert_eq!(config["models"][0]["recipe"], "kaito");

        let kaito = root.join("kaito.json");
        write_config(
            &kaito,
            &template,
            "Example/Adaptive-Apps",
            &"a".repeat(40),
            false,
            true,
            None,
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&kaito).unwrap()).unwrap();
        assert_eq!(config["models"][0]["recipe"], "kaito");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicitly_configures_openai_as_the_selected_model() {
        let root = temp_dir("openai");
        fs::create_dir(&root).unwrap();
        let template = root.join("template.json");
        let output = root.join("agents.json");
        let key = root.join("openai.key");
        fs::write(
            &template,
            serde_json::to_vec(&json!({
                "recipeArchive": "placeholder",
                "agentModel": "local-chat",
                "models": []
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(&key, "not-read-by-agents-config").unwrap();
        let openai = OpenAiModelInput {
            api_key_file: key.clone(),
            endpoint: "https://api.openai.com/v1".into(),
            model: "gpt-4o".into(),
        };

        write_config(
            &output,
            &template,
            "Example/Adaptive-Apps",
            &"a".repeat(40),
            false,
            false,
            Some(&openai),
        )
        .unwrap();

        let config: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(config["agentModel"], "openai-chat");
        assert_eq!(config["openaiApiKeyFile"], key.to_string_lossy().as_ref());
        assert_eq!(config["models"][0]["name"], "openai-chat");
        assert_eq!(config["models"][0]["properties"]["model"], "gpt-4o");
        assert_eq!(
            config["models"][0]["properties"]["openai"]["endpoint"],
            "https://api.openai.com/v1"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn requires_an_immutable_commit() {
        assert!(validate_commit("abc123").is_err());
        assert_eq!(validate_commit(&"A".repeat(40)).unwrap(), "a".repeat(40));
    }

    #[test]
    fn selects_only_recipe_releases_with_archives() {
        let first = "a".repeat(40);
        let second = "b".repeat(40);
        let releases = json!([
            {
                "tag_name": format!("recipes-{first}"),
                "published_at": "2026-10-16T17:00:00Z",
                "assets": [{"name": "recipes.tgz"}]
            },
            {
                "tag_name": format!("recipes-{second}"),
                "published_at": "2026-10-16T18:00:00Z",
                "assets": [{"name": "recipes.tgz"}]
            },
            {"tag_name": format!("recipes-{}", "c".repeat(40)), "assets": [{"name": "notes.txt"}]},
            {"tag_name": "recipes-not-a-commit", "assets": [{"name": "recipes.tgz"}]},
            {"tag_name": "v1.0.0", "assets": [{"name": "recipes.tgz"}]}
        ]);
        assert_eq!(
            published_recipe_commits(&releases).unwrap(),
            vec![second, first]
        );
    }

    #[test]
    fn selects_tags_and_preserves_explicit_immutable_images() {
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
        assert_eq!(image_references(&pinned).unwrap().len(), 7);

        let incomplete: agents::Config = serde_json::from_value(json!({
            "recipeArchive": "https://example.test/recipes.tgz",
            "imageRegistry": "ghcr.io/example/project",
            "imageTag": "release",
            "images": {"prompt-agent": format!("image@sha256:{}", "a".repeat(64))}
        }))
        .unwrap();
        let references = image_references(&incomplete).unwrap();
        assert_eq!(references[0], format!("image@sha256:{}", "a".repeat(64)));
        assert_eq!(references[1], "ghcr.io/example/project/editor:release");
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

    #[test]
    fn imported_tags_resolve_to_a_persistent_immutable_map() {
        let config: agents::Config = serde_json::from_value(json!({
            "recipeArchive": "https://example.test/recipes.tgz",
            "imageRegistry": "registry/project",
            "imageTag": "latest"
        }))
        .unwrap();
        let inventory = agents::COMPONENTS
            .into_iter()
            .enumerate()
            .map(|(index, component)| {
                format!(
                    "registry/project/{component}:latest application/vnd.oci.image.manifest.v1+json sha256:{} 1.0MiB linux/amd64 -",
                    format!("{index:x}").repeat(64)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let images = resolved_image_map(&config, &inventory).unwrap();
        for (index, component) in agents::COMPONENTS.into_iter().enumerate() {
            assert_eq!(
                images[component],
                format!(
                    "registry/project/{component}@sha256:{}",
                    format!("{index:x}").repeat(64)
                )
            );
        }
    }
}
