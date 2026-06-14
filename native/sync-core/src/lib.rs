use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fmt;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const DB_FILE: &str = "yachiyo.sqlite";
const SETTINGS_FILE: &str = "config.toml";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug)]
pub enum SyncError {
    ICloudUnavailable(PathBuf),
    NotInitialized(PathBuf),
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
    pub remote_device_count: usize,
    pub exported_ops: usize,
    pub imported_ops: usize,
    pub pending_conflict_count: usize,
    pub last_exported_at: Option<String>,
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

pub fn resolve_default_sync_dir() -> Result<PathBuf, SyncError> {
    let home = env::var("HOME").map_err(|_| SyncError::Message("HOME is not set".to_string()))?;
    let root = Path::new(&home).join("Library/Mobile Documents/com~apple~CloudDocs");
    if !root.exists() {
        return Err(SyncError::ICloudUnavailable(root));
    }
    Ok(root.join("Documents/Yachiyo/Sync"))
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
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_devices (device_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, label TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_applied_ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, applied_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, op_id TEXT NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, local_hash TEXT NOT NULL, remote_hash TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT);"
    )?;
    Ok(conn)
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
    let universe_path = sync_dir.join("universe.json");
    if !universe_path.exists() {
        let universe = Universe {
            universe_id: Uuid::new_v4().to_string(),
            created_at: now(),
            format_version: FORMAT_VERSION,
        };
        atomic_write(&universe_path, &serde_json::to_string_pretty(&universe)?)?;
    }
    let conn = open_db(home)?;
    let device_id = get_or_create_device(&conn, device_label)?;
    fs::create_dir_all(device_dir(&sync_dir, &device_id).join("ops"))?;
    write_manifest(&sync_dir, &device_id, device_label, 0, None)?;
    output(home, &sync_dir, Some(device_id), "ready", 0, 0, None)
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
        format_version: FORMAT_VERSION,
    };
    atomic_write(
        &device_dir(sync_dir, device_id).join("manifest.json"),
        &serde_json::to_string_pretty(&manifest)?,
    )
}

pub fn export_ops(
    home: &Path,
    sync_dir_override: Option<&Path>,
) -> Result<CommandOutput, SyncError> {
    let sync_dir = resolve_sync_dir(sync_dir_override)?;
    if !sync_dir.join("universe.json").exists() {
        return Err(SyncError::NotInitialized(sync_dir));
    }
    let conn = open_db(home)?;
    let device_id = get_device(&conn)?
        .ok_or_else(|| SyncError::Message("device is not initialized".to_string()))?;
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
        "Yachiyo",
        seq,
        Some(exported_at.clone()),
    )?;
    output(
        home,
        &sync_dir,
        Some(device_id),
        "ready",
        ops.len(),
        0,
        Some(exported_at),
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
    if !sync_dir.join("universe.json").exists() {
        return Err(SyncError::NotInitialized(sync_dir));
    }
    let conn = open_db(home)?;
    let local_device = get_device(&conn)?.unwrap_or_default();
    let mut imported = 0;
    for path in op_files(&sync_dir)? {
        if path
            .to_string_lossy()
            .contains(&format!("/devices/{}/", local_device))
        {
            continue;
        }
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        for line in BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let op: SyncOp = serde_json::from_str(&line)?;
            if apply_op(home, &conn, &op)? {
                imported += 1;
            }
        }
    }
    output(
        home,
        &sync_dir,
        Some(local_device),
        "ready",
        0,
        imported,
        None,
    )
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
        "message.archive.upsert" => insert_json_row(conn, "messages", &op.payload, None)?,
        _ => {}
    }
    conn.execute("INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES (?1, ?2, ?3, ?4)", params![op.op_id, op.device_id, op.seq, now()])?;
    Ok(true)
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
        .unwrap_or_else(|| op.payload_hash.as_str());
    let path = settings_path(home);
    let local_text = fs::read_to_string(&path).unwrap_or_default();
    let local_hash = hash_text(&local_text);
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
    if !sync_dir.join("universe.json").exists() {
        return output(home, &sync_dir, None, "not_initialized", 0, 0, None);
    }
    let conn = open_db(home)?;
    output(home, &sync_dir, get_device(&conn)?, "ready", 0, 0, None)
}

fn output(
    home: &Path,
    sync_dir: &Path,
    device_id: Option<String>,
    state: &str,
    exported_ops: usize,
    imported_ops: usize,
    last_exported_at: Option<String>,
) -> Result<CommandOutput, SyncError> {
    let conn = open_db(home)?;
    let pending_conflict_count: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;
    let remote_device_count = fs::read_dir(sync_dir.join("devices"))
        .map(|entries| entries.filter_map(Result::ok).count())
        .unwrap_or(0);
    Ok(CommandOutput {
        ok: true,
        state: if pending_conflict_count > 0 {
            "needs_attention".to_string()
        } else {
            state.to_string()
        },
        sync_dir: sync_dir.display().to_string(),
        device_id,
        remote_device_count,
        exported_ops,
        imported_ops,
        pending_conflict_count,
        last_exported_at,
        last_error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
