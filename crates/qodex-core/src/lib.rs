pub mod api;
pub mod backend;
pub mod codex;
pub mod config;
pub mod db;
pub mod opencode;
pub mod protocol;
pub mod service;

use anyhow::Result;
use config::Config;
use std::collections::HashMap;
use tracing_subscriber::{fmt, EnvFilter};

use crate::{db::Database, service::AppService};

pub async fn run(config_path: &std::path::Path) -> Result<()> {
    let config = Config::load(config_path)?;
    init_tracing(&config.logging.rust)?;

    let db = Database::connect(&config.database.path).await?;
    let service = AppService::new(config.clone(), db, HashMap::new()).await?;
    service.start_backend_event_loop();

    tracing::info!(bind = %config.server.bind, "starting qodex-core server");
    api::serve(service, &config.server.bind).await
}

fn init_tracing(filter: &str) -> Result<()> {
    let env_filter = EnvFilter::try_new(filter).or_else(|_| EnvFilter::try_new("info"))?;
    let _ = fmt().with_env_filter(env_filter).try_init();
    Ok(())
}
