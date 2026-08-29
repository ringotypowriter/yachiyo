use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::{Config, TS};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(rename_all = "camelCase")]
pub enum ClientMessage {
    Start {
        request_id: String,
        job_id: String,
        executable: String,
        args: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        log_path: String,
        #[ts(type = "number | null")]
        timeout_ms: Option<u64>,
        keep_running_on_timeout: bool,
        retain_log: bool,
        spill_threshold_chars: usize,
    },
    Cancel {
        request_id: String,
        job_id: String,
    },
    Shutdown {
        request_id: String,
    },
}

#[derive(Debug, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(rename_all = "camelCase")]
pub enum ServerMessage {
    Ready {
        protocol_version: u32,
    },
    Started {
        request_id: String,
        job_id: String,
        pid: u32,
    },
    Output {
        job_id: String,
        sequence: u32,
        chunks: Vec<(String, String)>,
        truncated: bool,
        #[ts(type = "number")]
        total_bytes: u64,
    },
    TimedOut {
        job_id: String,
    },
    Exited {
        job_id: String,
        exit_code: i32,
        timed_out: bool,
        cancelled: bool,
        spilled: bool,
        #[ts(type = "number")]
        total_bytes: u64,
        error: Option<String>,
    },
    Ack {
        request_id: String,
        accepted: bool,
    },
    Error {
        request_id: Option<String>,
        job_id: Option<String>,
        code: String,
        message: String,
    },
}

pub fn typescript_bindings() -> String {
    let config = Config::default();
    format!(
        "/* eslint-disable */\n// Generated from native/process-host/src/protocol.rs. Do not edit.\n\nexport const PROCESS_HOST_PROTOCOL_VERSION = {PROTOCOL_VERSION} as const\n\n{}\n\n{}\n",
        ClientMessage::export_to_string(&config)
            .expect("export ClientMessage TypeScript binding"),
        ServerMessage::export_to_string(&config)
            .expect("export ServerMessage TypeScript binding")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_server_messages_with_camel_case_fields() {
        let message = ServerMessage::Started {
            request_id: "request-1".to_string(),
            job_id: "job-1".to_string(),
            pid: 42,
        };

        assert_eq!(
            serde_json::to_value(message).expect("serialize server message"),
            serde_json::json!({
                "type": "started",
                "requestId": "request-1",
                "jobId": "job-1",
                "pid": 42
            })
        );
    }

    #[test]
    fn deserializes_start_requests_from_the_generated_shape() {
        let message: ClientMessage = serde_json::from_value(serde_json::json!({
            "type": "start",
            "requestId": "request-1",
            "jobId": "job-1",
            "executable": "/bin/zsh",
            "args": ["-lc", "printf ok"],
            "cwd": "/tmp",
            "env": {"PATH": "/usr/bin"},
            "logPath": "/tmp/job-1.log",
            "timeoutMs": 1000,
            "keepRunningOnTimeout": false,
            "retainLog": false,
            "spillThresholdChars": 20000
        }))
        .expect("deserialize client message");

        match message {
            ClientMessage::Start {
                job_id, timeout_ms, ..
            } => {
                assert_eq!(job_id, "job-1");
                assert_eq!(timeout_ms, Some(1000));
            }
            _ => panic!("expected start message"),
        }
    }

    #[test]
    fn generated_typescript_bindings_are_current() {
        let generated_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../packages/runtime/src/services/processBroker/processHostProtocol.generated.ts",
        );
        let committed = std::fs::read_to_string(&generated_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", generated_path.display()));
        assert_eq!(
            committed,
            typescript_bindings(),
            "run pnpm process-host:build to refresh generated bindings"
        );
    }
}
