use clap::{Parser, Subcommand};
use serde::Serialize;
use std::path::PathBuf;
use sync_core::{export_ops, import_ops, init_sync, status};

#[derive(Parser)]
#[command(name = "sync-core")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Init {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        sync_dir: Option<PathBuf>,
        #[arg(long)]
        device_label: String,
    },
    Export {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        sync_dir: Option<PathBuf>,
    },
    Import {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        sync_dir: Option<PathBuf>,
    },
    Status {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        sync_dir: Option<PathBuf>,
    },
}

#[derive(Serialize)]
struct ErrorOutput {
    error: String,
    message: String,
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Init {
            home,
            sync_dir,
            device_label,
        } => init_sync(&home, sync_dir.as_deref(), &device_label),
        Command::Export { home, sync_dir } => export_ops(&home, sync_dir.as_deref()),
        Command::Import { home, sync_dir } => import_ops(&home, sync_dir.as_deref()),
        Command::Status { home, sync_dir } => status(&home, sync_dir.as_deref()),
    };

    match result {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serialize output")
        ),
        Err(error) => {
            let output = ErrorOutput {
                error: error.code().to_string(),
                message: error.to_string(),
            };
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&output).expect("serialize error")
            );
            std::process::exit(1);
        }
    }
}
