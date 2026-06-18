use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fmt;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const DB_FILE: &str = "yachiyo.sqlite";
const SETTINGS_FILE: &str = "config.toml";
const FORMAT_VERSION: u32 = 1;
const META_UNIVERSE: &str = "universe_id";
const META_EXPORT_FINGERPRINT: &str = "export_fingerprint";

#[derive(Debug)]
pub enum SyncError {
    ICloudUnavailable(PathBuf),
    NotInitialized(PathBuf),
    UniverseMismatch { local: String, remote: String },
    Io(std::io::Error),
    Sql(rusqlite::Error),
    Json(serde_json::Error),
    Message(String),
}

impl SyncError {
    pub fn code(&self) -> &'static str {
        match self {
            SyncError::ICloudUnavailable(_) => "icloud_unavailable",
            SyncError::NotInitialized(_) => "not_initialized",
            SyncError::UniverseMismatch { .. } => "universe_mismatch",
            SyncError::Io(_) => "io_error",
            SyncError::Sql(_) => "sqlite_error",
            SyncError::Json(_) => "json_error",
            SyncError::Message(_) => "sync_error",
        }
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::ICloudUnavailable(path) => {
                write!(f, "iCloud Drive is unavailable at {}", path.display())
            }
            SyncError::NotInitialized(path) => {
                write!(f, "Sync is not initialized at {}", path.display())
            }
            SyncError::UniverseMismatch { local, remote } => write!(
                f,
                "Sync directory belongs to a different universe (local {local}, remote {remote}). Keep only one Sync folder."
            ),
            SyncError::Io(error) => write!(f, "{error}"),
            SyncError::Sql(error) => write!(f, "{error}"),
            SyncError::Json(error) => write!(f, "{error}"),
            SyncError::Message(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<std::io::Error> for SyncError {
    fn from(value: std::io::Error) -> Self {
        SyncError::Io(value)
    }
}
impl From<rusqlite::Error> for SyncError {
    fn from(value: rusqlite::Error) -> Self {
        SyncError::Sql(value)
    }
}
impl From<serde_json::Error> for SyncError {
    fn from(value: serde_json::Error) -> Self {
        SyncError::Json(value)
    }
}

#[derive(Serialize)]
pub struct CommandOutput {
    pub ok: bool,
    pub state: String,
    pub sync_dir: String,
    pub device_id: Option<String>,
    pub device_count: usize,
    pub exported_ops: usize,
    pub imported_ops: usize,
    pub last_exported_seq: i64,
    pub applied_op_count: usize,
    pub pending_op_count: usize,
    pub pending_conflict_count: usize,
    pub last_exported_at: Option<String>,
    pub last_imported_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Universe {
    #[serde(rename = "universeId")]
    universe_id: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "formatVersion")]
    format_version: u32,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    #[serde(rename = "deviceId")]
    device_id: String,
    label: String,
    #[serde(rename = "lastExportedSeq")]
    last_exported_seq: i64,
    #[serde(rename = "lastExportedAt")]
    last_exported_at: Option<String>,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "formatVersion")]
    format_version: u32,
}

#[derive(Serialize, Deserialize)]
struct SyncOp {
    #[serde(rename = "opId")]
    op_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    seq: i64,
    #[serde(rename = "createdAt")]
    created_at: String,
    kind: String,
    #[serde(rename = "entityType")]
    entity_type: String,
    #[serde(rename = "entityId")]
    entity_id: String,
    payload: Value,
    #[serde(rename = "payloadHash")]
    payload_hash: String,
}

fn icloud_root(home: &Path) -> PathBuf {
    home.join("Library/Mobile Documents/com~apple~CloudDocs")
}

fn default_sync_dir(home: &Path) -> Result<PathBuf, SyncError> {
    let root = icloud_root(home);
    if !root.exists() {
        return Err(SyncError::ICloudUnavailable(root));
    }
    Ok(root.join("Documents/Yachiyo/Sync"))
}

pub fn resolve_default_sync_dir() -> Result<PathBuf, SyncError> {
    let home = env::var("HOME").map_err(|_| SyncError::Message("HOME is not set".to_string()))?;
    default_sync_dir(Path::new(&home))
}

fn resolve_sync_dir(override_dir: Option<&Path>) -> Result<PathBuf, SyncError> {
    match override_dir {
        Some(path) => Ok(path.to_path_buf()),
        None => resolve_default_sync_dir(),
    }
}

fn now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}")
}

fn app_version() -> String {
    env::var("YACHIYO_APP_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

fn hash_text(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}

fn hash_value(value: &Value) -> Result<String, SyncError> {
    Ok(hash_text(&serde_json::to_string(value)?))
}

fn db_path(home: &Path) -> PathBuf {
    home.join(DB_FILE)
}
fn settings_path(home: &Path) -> PathBuf {
    home.join(SETTINGS_FILE)
}
fn device_dir(sync_dir: &Path, device_id: &str) -> PathBuf {
    sync_dir.join("devices").join(device_id)
}

fn open_db(home: &Path) -> Result<Connection, SyncError> {
    let conn = Connection::open(db_path(home))?;
    // sync-core imports a partial, read-only archive. Exported thread/message rows
    // legitimately reference device-local entities that are never synced — folders,
    // channel users/groups, branch/handoff sources, parent messages. Enforcing the
    // app's full FK graph here would reject those valid archive rows, so disable FK
    // checks on this connection. The main app keeps its own FK-enforcing connection.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    // These mirror the app's Drizzle-owned tables; CREATE IF NOT EXISTS is a
    // safety net for standalone runs/tests. In production the migration wins.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_devices (device_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, label TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_applied_ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, applied_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, op_id TEXT NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, local_hash TEXT NOT NULL, remote_hash TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT);
         CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    )?;
    Ok(conn)
}

fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, SyncError> {
    Ok(conn
        .query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), SyncError> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn get_or_create_device(conn: &Connection, label: &str) -> Result<String, SyncError> {
    if let Some(id) = conn
        .query_row("SELECT device_id FROM sync_devices LIMIT 1", [], |row| {
            row.get(0)
        })
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sync_devices (device_id, created_at, label) VALUES (?1, ?2, ?3)",
        params![id, now(), label],
    )?;
    Ok(id)
}

fn get_device(conn: &Connection) -> Result<Option<String>, SyncError> {
    Ok(conn
        .query_row("SELECT device_id FROM sync_devices LIMIT 1", [], |row| {
            row.get(0)
        })
        .optional()?)
}

fn get_device_label(conn: &Connection, device_id: &str) -> Result<String, SyncError> {
    Ok(conn
        .query_row(
            "SELECT label FROM sync_devices WHERE device_id = ?1",
            [device_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "Yachiyo".to_string()))
}

fn read_universe(sync_dir: &Path) -> Result<Option<Universe>, SyncError> {
    match fs::read_to_string(sync_dir.join("universe.json")) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(SyncError::Io(error)),
    }
}

/// Resolve the universe this device belongs to. Records the joined universe id
/// locally on first contact and refuses to operate when the sync dir's universe
/// id no longer matches it (the "two universes" split the plan warns about).
fn ensure_universe(
    conn: &Connection,
    sync_dir: &Path,
    create_if_missing: bool,
) -> Result<String, SyncError> {
    let local = get_meta(conn, META_UNIVERSE)?;
    match read_universe(sync_dir)? {
        Some(universe) => {
            match &local {
                Some(local_id) if local_id != &universe.universe_id => {
                    return Err(SyncError::UniverseMismatch {
                        local: local_id.clone(),
                        remote: universe.universe_id,
                    });
                }
                Some(_) => {}
                None => set_meta(conn, META_UNIVERSE, &universe.universe_id)?,
            }
            Ok(universe.universe_id)
        }
        None => {
            if !create_if_missing {
                return Err(SyncError::NotInitialized(sync_dir.to_path_buf()));
            }
            let universe = Universe {
                universe_id: Uuid::new_v4().to_string(),
                created_at: now(),
                format_version: FORMAT_VERSION,
            };
            atomic_write(
                &sync_dir.join("universe.json"),
                &serde_json::to_string_pretty(&universe)?,
            )?;
            set_meta(conn, META_UNIVERSE, &universe.universe_id)?;
            Ok(universe.universe_id)
        }
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<(), SyncError> {
    let parent = path
        .parent()
        .ok_or_else(|| SyncError::Message("path has no parent".to_string()))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        "{}.tmp-{}-{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id(),
        Uuid::new_v4()
    ));
    {
        let mut file = File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn init_sync(
    home: &Path,
    sync_dir_override: Option<&Path>,
    device_label: &str,
) -> Result<CommandOutput, SyncError> {
    let sync_dir = resolve_sync_dir(sync_dir_override)?;
    fs::create_dir_all(&sync_dir)?;
    let conn = open_db(home)?;
    ensure_universe(&conn, &sync_dir, true)?;
    let device_id = get_or_create_device(&conn, device_label)?;
    fs::create_dir_all(device_dir(&sync_dir, &device_id).join("ops"))?;
    let label = get_device_label(&conn, &device_id)?;
    // Don't reset export progress if this device already published before.
    let existing = read_manifest(&sync_dir, &device_id);
    let (seq, exported_at) = existing
        .map(|m| (m.last_exported_seq, m.last_exported_at))
        .unwrap_or((0, None));
    write_manifest(&sync_dir, &device_id, &label, seq, exported_at)?;
    output(
        home,
        &sync_dir,
        Some(device_id),
        "ready",
        0,
        0,
        None,
        None,
        None,
    )
}

fn write_manifest(
    sync_dir: &Path,
    device_id: &str,
    label: &str,
    seq: i64,
    exported_at: Option<String>,
) -> Result<(), SyncError> {
    let manifest = Manifest {
        device_id: device_id.to_string(),
        label: label.to_string(),
        last_exported_seq: seq,
        last_exported_at: exported_at,
        app_version: app_version(),
        format_version: FORMAT_VERSION,
    };
    atomic_write(
        &device_dir(sync_dir, device_id).join("manifest.json"),
        &serde_json::to_string_pretty(&manifest)?,
    )
}

fn read_manifest(sync_dir: &Path, device_id: &str) -> Option<Manifest> {
    let text = fs::read_to_string(device_dir(sync_dir, device_id).join("manifest.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn export_ops(
    home: &Path,
    sync_dir_override: Option<&Path>,
) -> Result<CommandOutput, SyncError> {
    let sync_dir = resolve_sync_dir(sync_dir_override)?;
    let conn = open_db(home)?;
    ensure_universe(&conn, &sync_dir, false)?;
    let device_id = get_device(&conn)?
        .ok_or_else(|| SyncError::Message("device is not initialized".to_string()))?;
    let label = get_device_label(&conn, &device_id)?;
    let exported_at = now();
    let seq = next_export_seq(&sync_dir, &device_id)?;
    let mut ops = Vec::new();
    if let Ok(text) = fs::read_to_string(settings_path(home)) {
        let payload =
            json!({ "text": text, "baseHash": hash_text(""), "contentHash": hash_text(&text) });
        ops.push(make_op(
            &device_id,
            seq,
            "settings.snapshot",
            "settings",
            "config.toml",
            payload,
        )?);
    }
    export_threads(&conn, &device_id, seq, &mut ops)?;

    // Nothing changed since the last export — skip writing a fresh ops file so
    // auto-sync doesn't accumulate identical snapshots (and re-trigger remote
    // conflicts) on every cycle. seq isn't bumped, so the next real change reuses
    // it.
    let fingerprint = export_fingerprint(&ops);
    if get_meta(&conn, META_EXPORT_FINGERPRINT)?.as_deref() == Some(fingerprint.as_str()) {
        return output(
            home,
            &sync_dir,
            Some(device_id),
            "ready",
            0,
            0,
            None,
            None,
            None,
        );
    }

    let content = ops
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()?
        .join("\n")
        + "\n";
    atomic_write(
        &device_dir(&sync_dir, &device_id)
            .join("ops")
            .join(format!("{seq:016}.jsonl")),
        &content,
    )?;
    write_manifest(
        &sync_dir,
        &device_id,
        &label,
        seq,
        Some(exported_at.clone()),
    )?;
    set_meta(&conn, META_EXPORT_FINGERPRINT, &fingerprint)?;
    output(
        home,
        &sync_dir,
        Some(device_id),
        "ready",
        ops.len(),
        0,
        Some(exported_at),
        None,
        None,
    )
}

fn make_op(
    device_id: &str,
    seq: i64,
    kind: &str,
    entity_type: &str,
    entity_id: &str,
    payload: Value,
) -> Result<SyncOp, SyncError> {
    Ok(SyncOp {
        op_id: format!("{}:{}:{}", device_id, seq, Uuid::new_v4()),
        device_id: device_id.to_string(),
        seq,
        created_at: now(),
        kind: kind.to_string(),
        entity_type: entity_type.to_string(),
        entity_id: entity_id.to_string(),
        payload_hash: hash_value(&payload)?,
        payload,
    })
}

/// Content fingerprint of an export, independent of op_id / seq / timestamps, so
/// an unchanged settings+threads snapshot yields the same value every time. Used
/// to skip re-exporting identical data on every auto-sync cycle.
fn export_fingerprint(ops: &[SyncOp]) -> String {
    let mut parts: Vec<String> = ops
        .iter()
        .map(|op| format!("{}\u{0}{}\u{0}{}", op.kind, op.entity_id, op.payload_hash))
        .collect();
    parts.sort();
    hash_text(&parts.join("\n"))
}

fn next_export_seq(sync_dir: &Path, device_id: &str) -> Result<i64, SyncError> {
    let ops_dir = device_dir(sync_dir, device_id).join("ops");
    fs::create_dir_all(&ops_dir)?;
    let mut max_seq = 0;
    for entry in fs::read_dir(ops_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".jsonl") {
            max_seq = max_seq.max(stem.parse::<i64>().unwrap_or(0));
        }
    }
    Ok(max_seq + 1)
}

fn export_threads(
    conn: &Connection,
    device_id: &str,
    seq: i64,
    ops: &mut Vec<SyncOp>,
) -> Result<(), SyncError> {
    let mut stmt = conn.prepare("SELECT * FROM threads WHERE sync_origin_device_id IS NULL")?;
    let rows = stmt.query_map([], |row| {
        let names = row.as_ref().column_names();
        let mut map = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(i)?;
            map.insert((*name).to_string(), sqlite_value(value));
        }
        Ok(Value::Object(map))
    })?;
    let mut thread_ids = Vec::new();
    for row in rows {
        let payload = row?;
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        thread_ids.push(id.clone());
        ops.push(make_op(
            device_id,
            seq,
            "thread.archive.upsert",
            "thread",
            &id,
            payload,
        )?);
    }
    let mut message_stmt =
        conn.prepare("SELECT * FROM messages WHERE thread_id = ?1 ORDER BY created_at ASC")?;
    for thread_id in thread_ids {
        let messages = message_stmt.query_map([thread_id], |row| {
            let names = row.as_ref().column_names();
            let mut map = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value: rusqlite::types::Value = row.get(i)?;
                map.insert((*name).to_string(), sqlite_value(value));
            }
            Ok(Value::Object(map))
        })?;
        for message in messages {
            let payload = message?;
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            ops.push(make_op(
                device_id,
                seq,
                "message.archive.upsert",
                "message",
                &id,
                payload,
            )?);
        }
    }
    Ok(())
}

fn sqlite_value(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(v) => json!(v),
        rusqlite::types::Value::Real(v) => json!(v),
        rusqlite::types::Value::Text(v) => json!(v),
        rusqlite::types::Value::Blob(_) => Value::Null,
    }
}

pub fn import_ops(
    home: &Path,
    sync_dir_override: Option<&Path>,
) -> Result<CommandOutput, SyncError> {
    let sync_dir = resolve_sync_dir(sync_dir_override)?;
    let conn = open_db(home)?;
    ensure_universe(&conn, &sync_dir, false)?;
    let local_device = get_device(&conn)?.unwrap_or_default();
    let mut imported = 0;
    let mut transient_error: Option<String> = None;
    for path in op_files(&sync_dir)? {
        if path_belongs_to_device(&path, &local_device) {
            continue;
        }
        // A file that fails to read is likely still downloading from iCloud:
        // skip it (don't record it as applied) and report a transient error.
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) => {
                transient_error = Some(format!(
                    "Could not read {} (still downloading?): {error}",
                    path.display()
                ));
                continue;
            }
        };
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let op: SyncOp = serde_json::from_str(line)?;
            // Business write + applied-ops bookkeeping commit together, so a
            // crash mid-import can never leave an op half-applied.
            let tx = conn.unchecked_transaction()?;
            let applied = apply_op(home, &tx, &op)?;
            tx.commit()?;
            if applied {
                imported += 1;
            }
        }
    }
    let last_imported_at = if imported > 0 { Some(now()) } else { None };
    output(
        home,
        &sync_dir,
        Some(local_device),
        "ready",
        0,
        imported,
        None,
        last_imported_at,
        transient_error,
    )
}

/// True when `path` lives under `sync_dir/devices/<device_id>/...`. Component-based
/// so it works regardless of the platform path separator.
fn path_belongs_to_device(path: &Path, device_id: &str) -> bool {
    if device_id.is_empty() {
        return false;
    }
    let components: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    components
        .windows(2)
        .any(|pair| pair[0] == "devices" && pair[1] == device_id)
}

fn op_files(sync_dir: &Path) -> Result<Vec<PathBuf>, SyncError> {
    let mut files = Vec::new();
    let devices = sync_dir.join("devices");
    if !devices.exists() {
        return Ok(files);
    }
    for device in fs::read_dir(devices)? {
        let ops = device?.path().join("ops");
        if !ops.exists() {
            continue;
        }
        for entry in fs::read_dir(ops)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn apply_op(home: &Path, conn: &Connection, op: &SyncOp) -> Result<bool, SyncError> {
    if conn
        .query_row(
            "SELECT 1 FROM sync_applied_ops WHERE op_id = ?1",
            [&op.op_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(false);
    }
    match op.kind.as_str() {
        "settings.snapshot" => apply_settings(home, conn, op)?,
        "thread.archive.upsert" => {
            insert_json_row(conn, "threads", &op.payload, Some((&op.device_id, now())))?
        }
        "message.archive.upsert" => {
            if !message_parent_exists(conn, &op.payload)? {
                // Parent thread hasn't been imported yet; defer without marking
                // applied so a later import (after the thread op arrives) retries.
                return Ok(false);
            }
            insert_json_row(conn, "messages", &op.payload, None)?
        }
        _ => {}
    }
    conn.execute("INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES (?1, ?2, ?3, ?4)", params![op.op_id, op.device_id, op.seq, now()])?;
    Ok(true)
}

fn message_parent_exists(conn: &Connection, payload: &Value) -> Result<bool, SyncError> {
    let thread_id = payload
        .get("thread_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if thread_id.is_empty() {
        return Ok(false);
    }
    Ok(conn
        .query_row("SELECT 1 FROM threads WHERE id = ?1", [thread_id], |_| {
            Ok(())
        })
        .optional()?
        .is_some())
}

fn apply_settings(home: &Path, conn: &Connection, op: &SyncOp) -> Result<(), SyncError> {
    let remote_text = op
        .payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let base_hash = op
        .payload
        .get("baseHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let remote_hash = op
        .payload
        .get("contentHash")
        .and_then(Value::as_str)
        .unwrap_or(op.payload_hash.as_str());
    let path = settings_path(home);
    let local_text = fs::read_to_string(&path).unwrap_or_default();
    let local_hash = hash_text(&local_text);
    // Both sides already agree — nothing to write and never a conflict. Without
    // this, a re-exported but byte-identical snapshot would record a phantom
    // conflict on every import.
    if path.exists() && local_hash == remote_hash {
        return Ok(());
    }
    if !path.exists() || local_hash == base_hash {
        atomic_write(&path, remote_text)?;
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO sync_conflicts (id, op_id, device_id, entity_type, entity_id, local_hash, remote_hash, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![Uuid::new_v4().to_string(), op.op_id, op.device_id, op.entity_type, op.entity_id, local_hash, remote_hash, serde_json::to_string(&op.payload)?, now()],
    )?;
    Ok(())
}

fn insert_json_row(
    conn: &Connection,
    table: &str,
    payload: &Value,
    remote: Option<(&str, String)>,
) -> Result<(), SyncError> {
    let object = payload
        .as_object()
        .ok_or_else(|| SyncError::Message("row payload must be an object".to_string()))?;
    let id = object.get("id").and_then(Value::as_str).unwrap_or_default();
    let exists: Option<i64> = conn
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Ok(());
    }
    let mut columns: Vec<String> = object.keys().cloned().collect();
    columns.retain(|name| name != "sync_origin_device_id" && name != "sync_imported_at");
    let mut values: Vec<Value> = columns
        .iter()
        .map(|name| object.get(name).cloned().unwrap_or(Value::Null))
        .collect();
    if table == "threads" {
        columns.push("sync_origin_device_id".to_string());
        columns.push("sync_imported_at".to_string());
        let (device_id, imported_at) = remote.unwrap();
        values.push(json!(device_id));
        values.push(json!(imported_at));
    }
    let placeholders = (1..=columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        columns.join(", "),
        placeholders
    );
    let params = rusqlite::params_from_iter(values.iter().map(json_to_sql));
    conn.execute(&sql, params)?;
    Ok(())
}

fn json_to_sql(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(v) => rusqlite::types::Value::Integer(if *v { 1 } else { 0 }),
        Value::Number(v) => v
            .as_i64()
            .map(rusqlite::types::Value::Integer)
            .unwrap_or_else(|| rusqlite::types::Value::Real(v.as_f64().unwrap_or_default())),
        Value::String(v) => rusqlite::types::Value::Text(v.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

pub fn status(home: &Path, sync_dir_override: Option<&Path>) -> Result<CommandOutput, SyncError> {
    let sync_dir = resolve_sync_dir(sync_dir_override)?;
    let conn = open_db(home)?;
    let device_id = get_device(&conn)?;
    // A synced universe.json alone does NOT mean this device joined sync — a second
    // device only sees it because iCloud copied it over. Until this device runs init
    // (creating its own device row), report not_initialized so the UI offers to enable
    // sync rather than letting export/import fail with "device is not initialized".
    if device_id.is_none() {
        return output(
            home,
            &sync_dir,
            None,
            "not_initialized",
            0,
            0,
            None,
            None,
            None,
        );
    }
    match ensure_universe(&conn, &sync_dir, false) {
        Ok(_) => output(home, &sync_dir, device_id, "ready", 0, 0, None, None, None),
        Err(SyncError::NotInitialized(_)) => output(
            home,
            &sync_dir,
            device_id,
            "not_initialized",
            0,
            0,
            None,
            None,
            None,
        ),
        Err(error @ SyncError::UniverseMismatch { .. }) => output(
            home,
            &sync_dir,
            device_id,
            "needs_attention",
            0,
            0,
            None,
            None,
            Some(error.to_string()),
        ),
        Err(error) => Err(error),
    }
}

fn count_scalar(conn: &Connection, sql: &str) -> usize {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as usize
}

/// Total devices in the sync universe, including this one. Each device owns one
/// directory under `devices/`; skip non-directories (e.g. macOS `.DS_Store`) and
/// dotfiles so stray files never inflate the count.
fn count_devices(sync_dir: &Path) -> usize {
    let entries = match fs::read_dir(sync_dir.join("devices")) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .count()
}

#[allow(clippy::too_many_arguments)]
fn output(
    home: &Path,
    sync_dir: &Path,
    device_id: Option<String>,
    state: &str,
    exported_ops: usize,
    imported_ops: usize,
    last_exported_at: Option<String>,
    last_imported_at: Option<String>,
    last_error: Option<String>,
) -> Result<CommandOutput, SyncError> {
    let conn = open_db(home)?;
    let pending_conflict_count = count_scalar(
        &conn,
        "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL",
    );
    let applied_op_count = count_scalar(&conn, "SELECT COUNT(*) FROM sync_applied_ops");
    // Local ops queued for the next export. v1 re-exports from scratch, so this
    // is 0 unless the app starts capturing incremental ops into sync_local_ops.
    let pending_op_count = count_scalar(
        &conn,
        "SELECT COUNT(*) FROM sync_local_ops WHERE exported_at IS NULL",
    );
    let device_count = count_devices(sync_dir);
    let last_exported_seq = device_id
        .as_deref()
        .and_then(|id| read_manifest(sync_dir, id))
        .map(|m| m.last_exported_seq)
        .unwrap_or(0);
    let state = if last_error.is_some() || pending_conflict_count > 0 {
        "needs_attention".to_string()
    } else {
        state.to_string()
    };
    Ok(CommandOutput {
        ok: true,
        state,
        sync_dir: sync_dir.display().to_string(),
        device_id,
        device_count,
        exported_ops,
        imported_ops,
        last_exported_seq,
        applied_op_count,
        pending_op_count,
        pending_conflict_count,
        last_exported_at,
        last_imported_at,
        last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_home(config: &str) -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), config).unwrap();
        let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, sync_origin_device_id TEXT, sync_imported_at TEXT);
             CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT, created_at TEXT);",
        )
        .unwrap();
        dir
    }

    fn seed_thread(home: &Path, thread_id: &str, message_id: &str) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, created_at) VALUES (?1, ?2, ?3)",
            params![thread_id, "Hello", "1"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, thread_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![message_id, thread_id, "hi", "1"],
        )
        .unwrap();
    }

    fn count_rows(home: &Path, table: &str) -> i64 {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn device_id_of(home: &Path) -> String {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        get_device(&conn).unwrap().unwrap()
    }

    fn count_op_files(sync_dir: &Path, device_id: &str) -> usize {
        let ops = device_dir(sync_dir, device_id).join("ops");
        if !ops.exists() {
            return 0;
        }
        fs::read_dir(ops)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
            .count()
    }

    fn write_ops_file(sync_dir: &Path, device_id: &str, seq: i64, ops: &[SyncOp]) {
        let content = ops
            .iter()
            .map(|op| serde_json::to_string(op).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let path = device_dir(sync_dir, device_id)
            .join("ops")
            .join(format!("{seq:016}.jsonl"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn hash_is_stable() {
        assert_eq!(hash_text("hello"), hash_text("hello"));
        assert_ne!(hash_text("hello"), hash_text("world"));
    }

    #[test]
    fn atomic_write_replaces_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.jsonl");
        atomic_write(&path, "one").unwrap();
        atomic_write(&path, "two").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "two");
    }

    #[test]
    fn default_sync_dir_requires_icloud_root() {
        let home = tempfile::tempdir().unwrap();
        assert!(matches!(
            default_sync_dir(home.path()),
            Err(SyncError::ICloudUnavailable(_))
        ));
        fs::create_dir_all(
            home.path()
                .join("Library/Mobile Documents/com~apple~CloudDocs"),
        )
        .unwrap();
        let dir = default_sync_dir(home.path()).unwrap();
        assert!(dir.ends_with("Documents/Yachiyo/Sync"));
    }

    #[test]
    fn op_files_ignores_tmp_files() {
        let sync = tempfile::tempdir().unwrap();
        let ops = device_dir(sync.path(), "d1").join("ops");
        fs::create_dir_all(&ops).unwrap();
        fs::write(ops.join("0000000000000001.jsonl"), "{}\n").unwrap();
        fs::write(ops.join("0000000000000002.jsonl.tmp-1-abc"), "garbage").unwrap();
        let files = op_files(sync.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].extension().and_then(|e| e.to_str()), Some("jsonl"));
    }

    #[test]
    fn op_round_trips_through_json() {
        let op = make_op(
            "dev",
            7,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1"}),
        )
        .unwrap();
        let text = serde_json::to_string(&op).unwrap();
        let parsed: SyncOp = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.op_id, op.op_id);
        assert_eq!(parsed.payload_hash, op.payload_hash);
        assert_eq!(parsed.entity_id, "t1");
    }

    #[test]
    fn import_marks_origin_and_is_idempotent() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        let first = import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert!(first.imported_ops >= 2);

        {
            let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
            let origin: Option<String> = conn
                .query_row(
                    "SELECT sync_origin_device_id FROM threads WHERE id = 't1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(origin.is_some(), "imported thread must carry origin device");
        }
        assert_eq!(count_rows(home_b.path(), "messages"), 1);

        let second = import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(second.imported_ops, 0, "re-import must be a no-op");
        assert_eq!(count_rows(home_b.path(), "threads"), 1);
    }

    #[test]
    fn settings_conflict_keeps_local() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            fs::read_to_string(home_b.path().join(SETTINGS_FILE)).unwrap(),
            "config-b",
            "local settings must win"
        );
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let conflicts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn export_is_skipped_when_unchanged() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-a");
        init_sync(home.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home.path());

        let first = export_ops(home.path(), Some(sync.path())).unwrap();
        assert!(first.exported_ops >= 1);
        assert_eq!(count_op_files(sync.path(), &device), 1);

        // Re-exporting unchanged data must not write another ops file.
        let second = export_ops(home.path(), Some(sync.path())).unwrap();
        assert_eq!(second.exported_ops, 0, "unchanged export must be skipped");
        assert_eq!(count_op_files(sync.path(), &device), 1);

        // A real change exports again.
        fs::write(home.path().join(SETTINGS_FILE), "config-changed").unwrap();
        let third = export_ops(home.path(), Some(sync.path())).unwrap();
        assert!(third.exported_ops >= 1, "changed export must run");
        assert_eq!(count_op_files(sync.path(), &device), 2);
    }

    #[test]
    fn identical_settings_do_not_conflict() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("same-config");
        let home_b = setup_home("same-config");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            fs::read_to_string(home_b.path().join(SETTINGS_FILE)).unwrap(),
            "same-config"
        );
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let conflicts: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_conflicts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(conflicts, 0, "identical settings must not conflict");
    }

    #[test]
    fn settings_overwrites_when_local_missing() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        fs::remove_file(home_b.path().join(SETTINGS_FILE)).unwrap();
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(
            fs::read_to_string(home_b.path().join(SETTINGS_FILE)).unwrap(),
            "config-a"
        );
    }

    #[test]
    fn message_without_parent_is_deferred_then_applied() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-b");
        init_sync(home.path(), Some(sync.path()), "B").unwrap();
        let message_op = make_op(
            "remote-device",
            1,
            "message.archive.upsert",
            "message",
            "m1",
            json!({"id": "m1", "thread_id": "t1", "body": "hi", "created_at": "1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[message_op]);

        let first = import_ops(home.path(), Some(sync.path())).unwrap();
        assert_eq!(first.imported_ops, 0, "orphan message must defer");
        assert_eq!(count_rows(home.path(), "messages"), 0);

        // Parent thread becomes available locally; the deferred message now applies.
        {
            let conn = Connection::open(home.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, created_at) VALUES ('t1', 'Hi', '1')",
                [],
            )
            .unwrap();
        }
        let second = import_ops(home.path(), Some(sync.path())).unwrap();
        assert_eq!(second.imported_ops, 1);
        assert_eq!(count_rows(home.path(), "messages"), 1);
    }

    #[test]
    fn universe_mismatch_is_detected() {
        let sync1 = tempfile::tempdir().unwrap();
        let sync2 = tempfile::tempdir().unwrap();
        let home = setup_home("config");
        init_sync(home.path(), Some(sync1.path()), "A").unwrap();

        let other = Universe {
            universe_id: "other-universe".to_string(),
            created_at: now(),
            format_version: FORMAT_VERSION,
        };
        atomic_write(
            &sync2.path().join("universe.json"),
            &serde_json::to_string_pretty(&other).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            export_ops(home.path(), Some(sync2.path())),
            Err(SyncError::UniverseMismatch { .. })
        ));
    }

    #[test]
    fn status_is_not_initialized_when_device_absent_despite_synced_universe() {
        let sync = tempfile::tempdir().unwrap();
        // Device A enables sync, creating universe.json + its own device dir.
        let home_a = setup_home("config-a");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();

        // Device B only sees the synced universe (iCloud copied it over) but never
        // ran init locally — it must report not_initialized, not "ready".
        let home_b = setup_home("config-b");
        assert!(sync.path().join("universe.json").exists());
        let before = status(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(before.state, "not_initialized");
        assert!(before.device_id.is_none());

        // After B joins, it adopts A's universe and reports ready.
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let after = status(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(after.state, "ready");
        assert!(after.device_id.is_some());
    }

    #[test]
    fn open_db_disables_foreign_keys() {
        let home = tempfile::tempdir().unwrap();
        let conn = open_db(home.path()).unwrap();
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            fk, 0,
            "sync-core must not enforce the app FK graph while importing"
        );
    }

    #[test]
    fn import_tolerates_dangling_device_local_references() {
        let sync = tempfile::tempdir().unwrap();
        // Schema with real FK columns: a thread filed in a folder, and self-referencing
        // messages — mirroring the app tables that broke real two-device import.
        let make = |config: &str| {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join(SETTINGS_FILE), config).unwrap();
            let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
            conn.execute_batch(
                "CREATE TABLE folders (id TEXT PRIMARY KEY);
                 CREATE TABLE threads (id TEXT PRIMARY KEY, folder_id TEXT REFERENCES folders(id), created_at TEXT, sync_origin_device_id TEXT, sync_imported_at TEXT);
                 CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), parent_message_id TEXT REFERENCES messages(id), created_at TEXT);",
            )
            .unwrap();
            dir
        };
        let home_a = make("config-a");
        let home_b = make("config-b");
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute("INSERT INTO folders (id) VALUES ('f1')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO threads (id, folder_id, created_at) VALUES ('t1', 'f1', '1')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, thread_id, parent_message_id, created_at) VALUES ('m1','t1',NULL,'1')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, thread_id, parent_message_id, created_at) VALUES ('m2','t1','m1','2')",
                [],
            )
            .unwrap();
        }
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        // B has no folder 'f1'; import must still succeed despite the dangling ref.
        let result = import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert!(result.imported_ops >= 3);
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let folder_id: Option<String> = conn
            .query_row("SELECT folder_id FROM threads WHERE id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            folder_id.as_deref(),
            Some("f1"),
            "dangling ref kept as historical value"
        );
        let messages: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(messages, 2);
    }
}
