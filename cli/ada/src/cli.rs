use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::commands::{agents_config, bootstrap, home_cmd, oidc, package, skill};

#[derive(Debug, Parser)]
#[command(
    name = "ada",
    about = "Adaptive Apps CLI",
    long_about = "ada bootstraps and manages adaptive-app platform portfolios \
                  (min, min-ai, core, core-ai, ent, ent-ai) across target \
                  contexts (k3s, k8s, aks, arc, azure-local).",
    version
)]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Initialize installed assets or prepare project-local native-agent inputs.
    Init(home_cmd::InitArgs),

    /// Create or update a public native-agent configuration for this checkout.
    AgentsConfig(agents_config::AgentsConfigArgs),

    /// Install or upgrade a portfolio onto the current Kubernetes context.
    Bootstrap(Box<bootstrap::BootstrapArgs>),

    /// Analyze an app source folder and emit a Radius app.bicep file.
    Package(package::PackageArgs),

    /// Manage external agent-skill packs used by `ada package`.
    Skill(skill::SkillArgs),

    /// Manage OIDC clients and native demo users in the shared Keycloak.
    Oidc(oidc::OidcArgs),

    /// Inspect the bundled Radius artifacts under `$ADA_HOME/radius`.
    Radius(home_cmd::RadiusArgs),
}

impl Cli {
    pub fn run(self) -> Result<()> {
        match self.command {
            Command::Init(args) => home_cmd::run_init(args),
            Command::AgentsConfig(args) => agents_config::run(args),
            Command::Bootstrap(args) => bootstrap::run(*args),
            Command::Package(args) => package::run(args),
            Command::Skill(args) => skill::run(args),
            Command::Oidc(args) => oidc::run(args),
            Command::Radius(args) => home_cmd::run_radius(args),
        }
    }
}
