use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "qodex-core", version, about = "Qodex Rust core bridge")]
struct Args {
    #[arg(long, default_value = "./qodex.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    qodex_core::run(&args.config).await
}
