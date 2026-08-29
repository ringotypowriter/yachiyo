use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use command_group::AsyncCommandGroup;
use process_host::protocol::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
use tokio::fs::{create_dir_all, remove_file, File};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinSet;
use tokio::time::{interval, Instant, MissedTickBehavior};

const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_BATCH_BYTES: usize = 64 * 1024;
const IO_CHANNEL_CAPACITY: usize = 32;
const SERVER_CHANNEL_CAPACITY: usize = 256;

#[cfg(windows)]
fn configure_platform_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_platform_command(_command: &mut Command) {}

type JobControls = Arc<Mutex<HashMap<String, mpsc::Sender<JobCommand>>>>;

#[derive(Debug)]
struct JobSpec {
    job_id: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    log_path: String,
    timeout: Option<Duration>,
    keep_running_on_timeout: bool,
    retain_log: bool,
    spill_threshold_chars: usize,
}

#[derive(Debug)]
enum JobCommand {
    Cancel,
}

#[derive(Debug)]
enum IoEvent {
    Chunk {
        stream: &'static str,
        bytes: Vec<u8>,
    },
    End {
        stream: &'static str,
    },
    Failed {
        stream: &'static str,
        message: String,
    },
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, chunk: &[u8], finished: bool) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut output = String::new();
        let mut offset = 0;

        while offset < bytes.len() {
            match std::str::from_utf8(&bytes[offset..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    offset = bytes.len();
                }
                Err(error) => {
                    let valid_end = offset + error.valid_up_to();
                    if valid_end > offset {
                        output.push_str(
                            std::str::from_utf8(&bytes[offset..valid_end])
                                .expect("UTF-8 validator returned an invalid prefix"),
                        );
                    }
                    offset = valid_end;

                    match error.error_len() {
                        Some(invalid_len) => {
                            output.push('\u{fffd}');
                            offset += invalid_len;
                        }
                        None if finished => {
                            output.push('\u{fffd}');
                            offset = bytes.len();
                        }
                        None => {
                            self.pending.extend_from_slice(&bytes[offset..]);
                            offset = bytes.len();
                        }
                    }
                }
            }
        }

        output
    }
}

#[derive(Default)]
struct OutputBatch {
    chunks: VecDeque<(String, String)>,
    bytes: usize,
    truncated: bool,
}

impl OutputBatch {
    fn push(&mut self, stream: &str, text: String) {
        if text.is_empty() {
            return;
        }

        self.bytes += text.len();
        if let Some((last_stream, last_text)) = self.chunks.back_mut() {
            if last_stream == stream {
                last_text.push_str(&text);
            } else {
                self.chunks.push_back((stream.to_string(), text));
            }
        } else {
            self.chunks.push_back((stream.to_string(), text));
        }
        self.trim_to_limit();
    }

    fn trim_to_limit(&mut self) {
        while self.bytes > MAX_BATCH_BYTES {
            let excess = self.bytes - MAX_BATCH_BYTES;
            let Some((_, first_text)) = self.chunks.front_mut() else {
                self.bytes = 0;
                return;
            };
            if first_text.len() <= excess {
                self.bytes -= first_text.len();
                self.chunks.pop_front();
                self.truncated = true;
                continue;
            }

            let mut cut = excess;
            while !first_text.is_char_boundary(cut) {
                cut += 1;
            }
            first_text.drain(..cut);
            self.bytes -= cut;
            self.truncated = true;
        }
    }

    fn take(&mut self) -> (Vec<(String, String)>, bool) {
        self.bytes = 0;
        let truncated = std::mem::take(&mut self.truncated);
        (
            std::mem::take(&mut self.chunks).into_iter().collect(),
            truncated,
        )
    }

    fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }
}

struct StartedJob {
    pid: u32,
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let (server_tx, server_rx) = mpsc::channel(SERVER_CHANNEL_CAPACITY);
    let writer = tokio::spawn(write_server_messages(server_rx));
    server_tx
        .send(ServerMessage::Ready {
            protocol_version: PROTOCOL_VERSION,
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "parent stdout closed"))?;

    let controls: JobControls = Arc::new(Mutex::new(HashMap::new()));
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut jobs = JoinSet::new();
    let mut shutting_down = false;

    while !shutting_down {
        tokio::select! {
            line = lines.next_line() => {
                match line? {
                    Some(line) if !line.trim().is_empty() => {
                        let message = match serde_json::from_str::<ClientMessage>(&line) {
                            Ok(message) => message,
                            Err(error) => {
                                send_message(&server_tx, ServerMessage::Error {
                                    request_id: None,
                                    job_id: None,
                                    code: "invalidMessage".to_string(),
                                    message: error.to_string(),
                                }).await?;
                                continue;
                            }
                        };
                        shutting_down = handle_client_message(
                            message,
                            &server_tx,
                            &controls,
                            &mut jobs,
                        ).await?;
                    }
                    Some(_) => {}
                    None => shutting_down = true,
                }
            }
            joined = jobs.join_next(), if !jobs.is_empty() => {
                if let Some(Err(error)) = joined {
                    eprintln!("[process-host] job task panicked: {error}");
                }
            }
        }
    }

    cancel_all_jobs(&controls).await;
    while let Some(result) = jobs.join_next().await {
        if let Err(error) = result {
            eprintln!("[process-host] job task panicked during shutdown: {error}");
        }
    }

    drop(server_tx);
    writer
        .await
        .map_err(|error| io::Error::other(format!("writer task panicked: {error}")))??;
    Ok(())
}

async fn handle_client_message(
    message: ClientMessage,
    server_tx: &mpsc::Sender<ServerMessage>,
    controls: &JobControls,
    jobs: &mut JoinSet<()>,
) -> io::Result<bool> {
    match message {
        ClientMessage::Start {
            request_id,
            job_id,
            executable,
            args,
            cwd,
            env,
            log_path,
            timeout_ms,
            keep_running_on_timeout,
            retain_log,
            spill_threshold_chars,
        } => {
            let (control_tx, control_rx) = mpsc::channel(4);
            {
                let mut active = controls.lock().await;
                if active.contains_key(&job_id) {
                    send_message(
                        server_tx,
                        ServerMessage::Error {
                            request_id: Some(request_id),
                            job_id: Some(job_id),
                            code: "duplicateJob".to_string(),
                            message: "A process job with this id is already active.".to_string(),
                        },
                    )
                    .await?;
                    return Ok(false);
                }
                active.insert(job_id.clone(), control_tx);
            }

            let spec = JobSpec {
                job_id: job_id.clone(),
                executable,
                args,
                cwd,
                env,
                log_path,
                timeout: timeout_ms.map(Duration::from_millis),
                keep_running_on_timeout,
                retain_log,
                spill_threshold_chars,
            };
            let (started_tx, started_rx) = oneshot::channel();
            let (begin_tx, begin_rx) = oneshot::channel();
            let task_server_tx = server_tx.clone();
            let task_controls = Arc::clone(controls);
            jobs.spawn(async move {
                run_job(
                    spec,
                    control_rx,
                    task_server_tx,
                    task_controls,
                    started_tx,
                    begin_rx,
                )
                .await;
            });

            match started_rx.await {
                Ok(Ok(started)) => {
                    send_message(
                        server_tx,
                        ServerMessage::Started {
                            request_id,
                            job_id,
                            pid: started.pid,
                        },
                    )
                    .await?;
                    let _ = begin_tx.send(());
                }
                Ok(Err(message)) => {
                    controls.lock().await.remove(&job_id);
                    send_message(
                        server_tx,
                        ServerMessage::Error {
                            request_id: Some(request_id),
                            job_id: Some(job_id),
                            code: "spawnFailed".to_string(),
                            message,
                        },
                    )
                    .await?;
                }
                Err(_) => {
                    controls.lock().await.remove(&job_id);
                    send_message(
                        server_tx,
                        ServerMessage::Error {
                            request_id: Some(request_id),
                            job_id: Some(job_id),
                            code: "spawnFailed".to_string(),
                            message: "Process job ended before reporting its pid.".to_string(),
                        },
                    )
                    .await?;
                }
            }
            Ok(false)
        }
        ClientMessage::Cancel { request_id, job_id } => {
            let sender = controls.lock().await.get(&job_id).cloned();
            let accepted = match sender {
                Some(sender) => sender.send(JobCommand::Cancel).await.is_ok(),
                None => false,
            };
            send_message(
                server_tx,
                ServerMessage::Ack {
                    request_id,
                    accepted,
                },
            )
            .await?;
            Ok(false)
        }
        ClientMessage::Shutdown { request_id } => {
            send_message(
                server_tx,
                ServerMessage::Ack {
                    request_id,
                    accepted: true,
                },
            )
            .await?;
            Ok(true)
        }
    }
}

async fn run_job(
    spec: JobSpec,
    mut control_rx: mpsc::Receiver<JobCommand>,
    server_tx: mpsc::Sender<ServerMessage>,
    controls: JobControls,
    started_tx: oneshot::Sender<Result<StartedJob, String>>,
    begin_rx: oneshot::Receiver<()>,
) {
    let job_id = spec.job_id.clone();
    if let Err(error) = run_job_inner(spec, &mut control_rx, &server_tx, started_tx, begin_rx).await
    {
        eprintln!("[process-host] job {job_id} failed: {error}");
    }
    controls.lock().await.remove(&job_id);
}

async fn run_job_inner(
    spec: JobSpec,
    control_rx: &mut mpsc::Receiver<JobCommand>,
    server_tx: &mpsc::Sender<ServerMessage>,
    started_tx: oneshot::Sender<Result<StartedJob, String>>,
    begin_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let log_parent = Path::new(&spec.log_path)
        .parent()
        .ok_or_else(|| format!("Log path has no parent: {}", spec.log_path))?;
    create_dir_all(log_parent)
        .await
        .map_err(|error| format!("Create log directory: {error}"))?;
    let log_file = File::create(&spec.log_path)
        .await
        .map_err(|error| format!("Create log file: {error}"))?;
    let mut log = BufWriter::new(log_file);

    let mut command = Command::new(&spec.executable);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_platform_command(&mut command);

    let mut child = match command.group().kill_on_drop(true).spawn() {
        Ok(child) => child,
        Err(error) => {
            drop(log);
            let _ = remove_file(&spec.log_path).await;
            let _ = started_tx.send(Err(error.to_string()));
            return Ok(());
        }
    };
    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let _ = started_tx.send(Err("Spawned process has no pid.".to_string()));
            let _ = child.start_kill();
            return Ok(());
        }
    };
    let stdout = child
        .inner()
        .stdout
        .take()
        .ok_or_else(|| "Spawned process has no stdout pipe.".to_string())?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .ok_or_else(|| "Spawned process has no stderr pipe.".to_string())?;

    started_tx
        .send(Ok(StartedJob { pid }))
        .map_err(|_| "Parent stopped waiting for process startup.".to_string())?;
    if begin_rx.await.is_err() {
        let _ = child.start_kill();
        return Ok(());
    }

    let (io_tx, mut io_rx) = mpsc::channel(IO_CHANNEL_CAPACITY);
    let stdout_reader = tokio::spawn(read_pipe(stdout, "stdout", io_tx.clone()));
    let stderr_reader = tokio::spawn(read_pipe(stderr, "stderr", io_tx.clone()));
    drop(io_tx);

    let started_at = Instant::now();
    let mut poll_timer = interval(PROCESS_POLL_INTERVAL);
    poll_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut flush_timer = interval(OUTPUT_FLUSH_INTERVAL);
    flush_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut stdout_decoder = Utf8StreamDecoder::default();
    let mut stderr_decoder = Utf8StreamDecoder::default();
    let mut output_batch = OutputBatch::default();
    let mut sequence = 0_u32;
    let mut total_bytes = 0_u64;
    // JavaScript truncation uses String.length, so spill decisions use UTF-16 code units too.
    let mut total_utf16_units = 0_usize;
    let mut ended_streams = 0_u8;
    let mut status: Option<ExitStatus> = None;
    let mut timed_out = false;
    let mut cancelled = false;
    let mut retain_log = spec.retain_log;
    let mut terminal_error: Option<String> = None;

    loop {
        tokio::select! {
            event = io_rx.recv() => {
                match event {
                    Some(IoEvent::Chunk { stream, bytes }) => {
                        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
                        if let Err(error) = log.write_all(&bytes).await {
                            terminal_error = Some(format!("Write process log: {error}"));
                            let _ = child.start_kill();
                            continue;
                        }
                        let text = if stream == "stdout" {
                            stdout_decoder.push(&bytes, false)
                        } else {
                            stderr_decoder.push(&bytes, false)
                        };
                        total_utf16_units =
                            total_utf16_units.saturating_add(text.encode_utf16().count());
                        output_batch.push(stream, text);
                    }
                    Some(IoEvent::End { stream }) => {
                        let text = if stream == "stdout" {
                            stdout_decoder.push(&[], true)
                        } else {
                            stderr_decoder.push(&[], true)
                        };
                        total_utf16_units =
                            total_utf16_units.saturating_add(text.encode_utf16().count());
                        output_batch.push(stream, text);
                        ended_streams = ended_streams.saturating_add(1);
                    }
                    Some(IoEvent::Failed { stream, message }) => {
                        terminal_error = Some(format!("Read {stream}: {message}"));
                        let _ = child.start_kill();
                    }
                    None => ended_streams = 2,
                }
            }
            _ = flush_timer.tick() => {
                if !output_batch.is_empty() {
                    if let Err(error) = log.flush().await {
                        terminal_error = Some(format!("Flush running process log: {error}"));
                        let _ = child.start_kill();
                    }
                    flush_output(
                        server_tx,
                        &spec.job_id,
                        &mut sequence,
                        total_bytes,
                        &mut output_batch,
                    ).await?;
                }
            }
            command = control_rx.recv() => {
                if matches!(command, Some(JobCommand::Cancel)) && status.is_none() {
                    match child.try_wait() {
                        Ok(Some(exit_status)) => status = Some(exit_status),
                        Ok(None) => match child.start_kill() {
                            Ok(()) => cancelled = true,
                            Err(error) => {
                                terminal_error = Some(format!("Cancel process group: {error}"));
                            }
                        },
                        Err(error) => {
                            terminal_error = Some(format!("Check process before cancellation: {error}"));
                        }
                    }
                }
            }
            _ = poll_timer.tick() => {
                if !timed_out {
                    if let Some(timeout) = spec.timeout {
                        if started_at.elapsed() >= timeout {
                            timed_out = true;
                            retain_log = retain_log || spec.keep_running_on_timeout;
                            if !output_batch.is_empty() {
                                if let Err(error) = log.flush().await {
                                    terminal_error = Some(format!("Flush timed-out process log: {error}"));
                                    let _ = child.start_kill();
                                }
                                flush_output(
                                    server_tx,
                                    &spec.job_id,
                                    &mut sequence,
                                    total_bytes,
                                    &mut output_batch,
                                ).await?;
                            }
                            send_message(server_tx, ServerMessage::TimedOut {
                                job_id: spec.job_id.clone(),
                            }).await.map_err(|error| error.to_string())?;
                            if !spec.keep_running_on_timeout {
                                if let Err(error) = child.start_kill() {
                                    terminal_error = Some(format!("Terminate timed-out process group: {error}"));
                                }
                            }
                        }
                    }
                }

                if status.is_none() {
                    match child.try_wait() {
                        Ok(next_status) => status = next_status,
                        Err(error) => {
                            terminal_error = Some(format!("Wait for process group: {error}"));
                            let _ = child.start_kill();
                        }
                    }
                }
            }
        }

        if status.is_some() && ended_streams >= 2 {
            break;
        }
    }

    let _ = stdout_reader.await;
    let _ = stderr_reader.await;
    if let Err(error) = log.flush().await {
        terminal_error = Some(format!("Flush process log: {error}"));
    }
    flush_output(
        server_tx,
        &spec.job_id,
        &mut sequence,
        total_bytes,
        &mut output_batch,
    )
    .await?;
    drop(log);

    let mut spilled =
        retain_log || total_utf16_units >= spec.spill_threshold_chars || terminal_error.is_some();
    if !spilled {
        match remove_file(&spec.log_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                terminal_error = Some(format!("Remove inline-only process log: {error}"));
                spilled = true;
            }
        }
    }

    let exit_code = status
        .and_then(|status| status.code())
        .unwrap_or(if timed_out {
            124
        } else if cancelled {
            130
        } else {
            1
        });
    send_message(
        server_tx,
        ServerMessage::Exited {
            job_id: spec.job_id,
            exit_code,
            timed_out,
            cancelled,
            spilled,
            total_bytes,
            error: terminal_error,
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

async fn read_pipe<R>(mut reader: R, stream: &'static str, sender: mpsc::Sender<IoEvent>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                let _ = sender.send(IoEvent::End { stream }).await;
                return;
            }
            Ok(read) => {
                if sender
                    .send(IoEvent::Chunk {
                        stream,
                        bytes: buffer[..read].to_vec(),
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(error) => {
                let _ = sender
                    .send(IoEvent::Failed {
                        stream,
                        message: error.to_string(),
                    })
                    .await;
                return;
            }
        }
    }
}

async fn flush_output(
    server_tx: &mpsc::Sender<ServerMessage>,
    job_id: &str,
    sequence: &mut u32,
    total_bytes: u64,
    batch: &mut OutputBatch,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let (chunks, truncated) = batch.take();
    let current_sequence = *sequence;
    *sequence = sequence.wrapping_add(1);
    send_message(
        server_tx,
        ServerMessage::Output {
            job_id: job_id.to_string(),
            sequence: current_sequence,
            chunks,
            truncated,
            total_bytes,
        },
    )
    .await
    .map_err(|error| error.to_string())
}

async fn cancel_all_jobs(controls: &JobControls) {
    let senders = controls.lock().await.values().cloned().collect::<Vec<_>>();
    for sender in senders {
        let _ = sender.send(JobCommand::Cancel).await;
    }
}

async fn send_message(
    sender: &mpsc::Sender<ServerMessage>,
    message: ServerMessage,
) -> io::Result<()> {
    sender
        .send(message)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "parent stopped reading stdout"))
}

async fn write_server_messages(mut receiver: mpsc::Receiver<ServerMessage>) -> io::Result<()> {
    let mut stdout = BufWriter::new(tokio::io::stdout());
    while let Some(message) = receiver.recv().await {
        let encoded = serde_json::to_vec(&message)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        stdout.write_all(&encoded).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_decoder_preserves_characters_split_across_chunks() {
        let mut decoder = Utf8StreamDecoder::default();
        let bytes = "八千代".as_bytes();

        assert_eq!(decoder.push(&bytes[..2], false), "");
        assert_eq!(decoder.push(&bytes[2..5], false), "八");
        assert_eq!(decoder.push(&bytes[5..], true), "千代");
    }

    #[test]
    fn utf8_decoder_replaces_invalid_and_incomplete_sequences() {
        let mut decoder = Utf8StreamDecoder::default();

        assert_eq!(decoder.push(&[b'a', 0xff, 0xe3], false), "a\u{fffd}");
        assert_eq!(decoder.push(&[], true), "\u{fffd}");
    }

    #[test]
    fn output_batch_coalesces_adjacent_chunks_from_the_same_stream() {
        let mut batch = OutputBatch::default();
        batch.push("stdout", "a".to_string());
        batch.push("stdout", "b".to_string());
        batch.push("stderr", "c".to_string());

        assert_eq!(
            batch.take(),
            (
                vec![
                    ("stdout".to_string(), "ab".to_string()),
                    ("stderr".to_string(), "c".to_string())
                ],
                false
            )
        );
    }

    #[test]
    fn output_batch_keeps_only_a_bounded_utf8_tail() {
        let mut batch = OutputBatch::default();
        batch.push("stdout", "八".repeat(MAX_BATCH_BYTES).to_string());

        let (chunks, truncated) = batch.take();
        assert!(truncated);
        let retained = &chunks[0].1;
        assert_eq!(
            retained.len(),
            MAX_BATCH_BYTES - (MAX_BATCH_BYTES % "八".len())
        );
        assert!(retained.chars().all(|character| character == '八'));
    }
}
