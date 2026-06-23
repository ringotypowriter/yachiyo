use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
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
const META_SETTINGS_HASH: &str = "settings_export_hash";

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
    ensure_change_tracking(&conn)?;
    Ok(conn)
}

/// Install incremental change capture: a `sync_dirty` queue plus AFTER INSERT/UPDATE
/// triggers on each synced table that enqueue the touched row. The `WHEN` guards skip
/// rows belonging to imported (read-only) synced archives, so applying remote ops never
/// echoes back into the export queue. Triggers fire for every connection (app + sync-core),
/// so this captures the app's writes without touching app code. Idempotent.
fn ensure_change_tracking(conn: &Connection) -> Result<(), SyncError> {
    // `seq` is a monotonic cursor: export deletes only rows it has already emitted
    // (seq <= high-water mark), so a concurrent re-dirty during export survives.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_dirty (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            UNIQUE (entity_type, entity_id)
        );",
    )?;
    if table_exists(conn, "threads")? {
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS sync_dirty_threads_ai AFTER INSERT ON threads
             WHEN NEW.sync_origin_device_id IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('thread', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_threads_au AFTER UPDATE ON threads
             WHEN NEW.sync_origin_device_id IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('thread', NEW.id); END;",
        )?;
    }
    if table_exists(conn, "messages")? {
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS sync_dirty_messages_ai AFTER INSERT ON messages
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('message', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_messages_au AFTER UPDATE ON messages
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('message', NEW.id); END;",
        )?;
    }
    if table_exists(conn, "tool_calls")? {
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS sync_dirty_tool_calls_ai AFTER INSERT ON tool_calls
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('toolcall', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_tool_calls_au AFTER UPDATE ON tool_calls
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('toolcall', NEW.id); END;",
        )?;
    }
    Ok(())
}

/// Re-enqueue every local row. Used when there are no published ops files yet
/// (first export, or the sync dir was wiped) so a fresh/recovering peer still
/// receives the full archive before incremental deltas take over.
fn backfill_dirty(conn: &Connection) -> Result<(), SyncError> {
    if table_exists(conn, "threads")? {
        conn.execute(
            "INSERT OR IGNORE INTO sync_dirty (entity_type, entity_id)
             SELECT 'thread', id FROM threads WHERE sync_origin_device_id IS NULL",
            [],
        )?;
    }
    if table_exists(conn, "messages")? {
        conn.execute(
            "INSERT OR IGNORE INTO sync_dirty (entity_type, entity_id)
             SELECT 'message', m.id FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE t.sync_origin_device_id IS NULL",
            [],
        )?;
    }
    if table_exists(conn, "tool_calls")? {
        conn.execute(
            "INSERT OR IGNORE INTO sync_dirty (entity_type, entity_id)
             SELECT 'toolcall', tc.id FROM tool_calls tc JOIN threads t ON t.id = tc.thread_id
             WHERE t.sync_origin_device_id IS NULL",
            [],
        )?;
    }
    Ok(())
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

    // No published ops files (first export, or the sync dir was wiped): re-enqueue
    // every local row so a fresh/recovering peer gets the full archive. In steady
    // state (seq > 1) we emit only what changed since the last export.
    let full_resync = seq == 1;
    if full_resync {
        backfill_dirty(&conn)?;
    }

    let mut ops = Vec::new();
    let settings_text = fs::read_to_string(settings_path(home)).ok();
    let settings_hash = settings_text.as_deref().map(hash_text);
    let settings_changed = match &settings_hash {
        Some(hash) => {
            full_resync || get_meta(&conn, META_SETTINGS_HASH)?.as_deref() != Some(hash.as_str())
        }
        None => false,
    };
    if settings_changed {
        if let Some(text) = &settings_text {
            let payload =
                json!({ "text": text, "baseHash": hash_text(""), "contentHash": hash_text(text) });
            ops.push(make_op(
                &device_id,
                seq,
                "settings.snapshot",
                "settings",
                "config.toml",
                payload,
            )?);
        }
    }

    let high_water = export_dirty_ops(&conn, &device_id, seq, &mut ops)?;

    // Publish a delta file only when there's something to ship. An empty `ops`
    // here means the queue held only skippable rows (deleted before export, or
    // synced archives) — we still clear them below so create/delete churn can't
    // accumulate.
    let last_exported_at = if ops.is_empty() {
        None
    } else {
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
        if settings_changed {
            if let Some(hash) = &settings_hash {
                set_meta(&conn, META_SETTINGS_HASH, hash)?;
            }
        }
        Some(exported_at)
    };

    // Clear every dirty row we processed (emitted or skipped) up to the high-water
    // mark — but only after any publish above succeeded, so a failed write is
    // retried. Rows re-dirtied concurrently kept a higher seq and survive.
    if let Some(high_water) = high_water {
        conn.execute("DELETE FROM sync_dirty WHERE seq <= ?1", [high_water])?;
    }

    output(
        home,
        &sync_dir,
        Some(device_id),
        "ready",
        ops.len(),
        0,
        last_exported_at,
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
/// Drain the dirty queue into upsert ops. Returns the highest `sync_dirty.seq`
/// seen (the high-water mark the caller deletes up to), or None if the queue was
/// empty. Rows that were deleted before export, or that belong to imported
/// archives, are skipped but still cleared.
fn export_dirty_ops(
    conn: &Connection,
    device_id: &str,
    seq: i64,
    ops: &mut Vec<SyncOp>,
) -> Result<Option<i64>, SyncError> {
    let mut stmt =
        conn.prepare("SELECT seq, entity_type, entity_id FROM sync_dirty ORDER BY seq ASC")?;
    let dirty: Vec<(i64, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut high_water: Option<i64> = None;
    for (dirty_seq, entity_type, entity_id) in dirty {
        // Track every row we've seen so the caller clears it, even when skipped.
        high_water = Some(high_water.map_or(dirty_seq, |m| m.max(dirty_seq)));
        let (table, kind) = match entity_type.as_str() {
            "thread" => ("threads", "thread.archive.upsert"),
            "message" => ("messages", "message.archive.upsert"),
            "toolcall" => ("tool_calls", "toolcall.archive.upsert"),
            _ => continue,
        };
        if !table_exists(conn, table)? {
            continue;
        }
        let Some(payload) = fetch_row_json(conn, table, &entity_id)? else {
            continue; // deleted before export — v1 doesn't propagate deletions
        };
        // Defense in depth: never re-export an imported (read-only) archive even if
        // one slipped into the queue past the trigger guards.
        if entity_type == "thread"
            && payload
                .get("sync_origin_device_id")
                .is_some_and(|v| !v.is_null())
        {
            continue;
        }
        // Skip empty threads: a freshly created "New Chat" with no messages carries
        // nothing worth mirroring, and syncing it strands a read-only blank archive
        // on the peer that can also hijack its new-chat slot. Emptiness is read from
        // the same payload we'd serialize (head_message_id is set atomically with the
        // first message), so a message committing mid-export can't strand a stale
        // blank row — the thread re-dirties and exports with its head set next cycle.
        if entity_type == "thread" && payload.get("head_message_id").is_none_or(|v| v.is_null()) {
            continue;
        }
        ops.push(make_op(
            device_id,
            seq,
            kind,
            &entity_type,
            &entity_id,
            payload,
        )?);
    }
    Ok(high_water)
}

fn fetch_row_json(conn: &Connection, table: &str, id: &str) -> Result<Option<Value>, SyncError> {
    let sql = format!("SELECT * FROM {table} WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], row_to_json_object).optional()?)
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

fn sqlite_value(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(v) => json!(v),
        rusqlite::types::Value::Real(v) => json!(v),
        rusqlite::types::Value::Text(v) => json!(v),
        rusqlite::types::Value::Blob(_) => Value::Null,
    }
}

/// Snapshot a full row as a JSON object keyed by column name. Schema-agnostic so
/// the same helper serializes threads, messages, and tool calls without knowing
/// their columns up front.
fn row_to_json_object(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let names = row.as_ref().column_names();
    let mut map = serde_json::Map::new();
    for (i, name) in names.iter().enumerate() {
        let value: rusqlite::types::Value = row.get(i)?;
        map.insert((*name).to_string(), sqlite_value(value));
    }
    Ok(Value::Object(map))
}

/// Whether `table` exists in this database. Lets export tolerate schema versions
/// (and minimal test fixtures) that predate a synced table like `tool_calls`.
fn table_exists(conn: &Connection, table: &str) -> Result<bool, SyncError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Columns that physically exist on the local table. Used to drop unknown keys
/// from an incoming payload so a peer on a newer schema (extra columns) cannot
/// brick import on an older peer — readers ignore fields they don't know.
fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, SyncError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<String>, _>>()?;
    Ok(names)
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
            if !parent_thread_exists(conn, &op.payload)? {
                // Parent thread hasn't been imported yet; defer without marking
                // applied so a later import (after the thread op arrives) retries.
                return Ok(false);
            }
            insert_json_row(conn, "messages", &op.payload, None)?
        }
        "toolcall.archive.upsert" => {
            if !parent_thread_exists(conn, &op.payload)? {
                // Same deferral as messages: wait until the owning thread exists.
                return Ok(false);
            }
            insert_json_row(conn, "tool_calls", &op.payload, None)?
        }
        _ => {}
    }
    conn.execute("INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES (?1, ?2, ?3, ?4)", params![op.op_id, op.device_id, op.seq, now()])?;
    Ok(true)
}

/// Whether the thread a message/tool-call payload belongs to is already imported.
fn parent_thread_exists(conn: &Connection, payload: &Value) -> Result<bool, SyncError> {
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
    // Only insert columns that physically exist on the local table. A peer on a
    // newer schema may export extra columns (e.g. a future `model_id`); dropping
    // them keeps import forward-compatible instead of failing the whole sync.
    let local_columns = table_columns(conn, table)?;
    let mut columns: Vec<String> = object.keys().cloned().collect();
    columns.retain(|name| {
        name != "sync_origin_device_id"
            && name != "sync_imported_at"
            && local_columns.contains(name)
    });
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
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, head_message_id TEXT, sync_origin_device_id TEXT, sync_imported_at TEXT);
             CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT, created_at TEXT);
             CREATE TABLE tool_calls (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, request_message_id TEXT, assistant_message_id TEXT, run_id TEXT, tool_name TEXT, status TEXT, input_summary TEXT, started_at TEXT);",
        )
        .unwrap();
        dir
    }

    fn seed_thread(home: &Path, thread_id: &str, message_id: &str) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        // A real thread points its head at the message — mirrors the app, which sets
        // head_message_id atomically with the first message insert.
        conn.execute(
            "INSERT INTO threads (id, title, created_at, head_message_id) VALUES (?1, ?2, ?3, ?4)",
            params![thread_id, "Hello", "1", message_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, thread_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![message_id, thread_id, "hi", "1"],
        )
        .unwrap();
    }

    fn seed_tool_call(
        home: &Path,
        tool_call_id: &str,
        thread_id: &str,
        assistant_message_id: &str,
    ) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.execute(
            "INSERT INTO tool_calls (id, thread_id, request_message_id, assistant_message_id, run_id, tool_name, status, input_summary, started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                tool_call_id,
                thread_id,
                assistant_message_id,
                assistant_message_id,
                "run-local",
                "read",
                "completed",
                "README.md",
                "1"
            ],
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

    fn insert_message(home: &Path, message_id: &str, thread_id: &str) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.execute(
            "INSERT INTO messages (id, thread_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![message_id, thread_id, "hi", "2"],
        )
        .unwrap();
    }

    fn read_ops_file(sync_dir: &Path, device_id: &str, seq: i64) -> Vec<SyncOp> {
        let path = device_dir(sync_dir, device_id)
            .join("ops")
            .join(format!("{seq:016}.jsonl"));
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn delete_message(home: &Path, message_id: &str) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .unwrap();
    }

    fn count_dirty(home: &Path) -> i64 {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.query_row("SELECT COUNT(*) FROM sync_dirty", [], |r| r.get(0))
            .unwrap()
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
    fn tool_calls_are_synced_with_message_binding() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        seed_tool_call(home_a.path(), "tc1", "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(count_rows(home_b.path(), "tool_calls"), 1);
        // The assistant binding must survive so the renderer can fold tool calls
        // into a work summary without the (unsynced) run record.
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let assistant_id: Option<String> = conn
            .query_row(
                "SELECT assistant_message_id FROM tool_calls WHERE id = 'tc1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(assistant_id.as_deref(), Some("m1"));
    }

    #[test]
    fn empty_threads_are_not_exported() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");

        // An empty "New Chat": a thread row with no messages.
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, created_at) VALUES (?1, ?2, ?3)",
                params!["empty", "New Chat", "1"],
            )
            .unwrap();
        }
        // A real conversation alongside it.
        seed_thread(home_a.path(), "t1", "m1");

        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        // The empty thread must not cross the sync boundary; the real one must.
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let empty_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads WHERE id = 'empty'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(empty_count, 0, "empty thread must not be exported");
        let real_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads WHERE id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(real_count, 1, "non-empty thread must still export");
    }

    #[test]
    fn empty_thread_exports_once_it_gets_a_message() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");

        // Start as an empty "New Chat", export (nothing should cross yet).
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, created_at) VALUES (?1, ?2, ?3)",
                params!["t1", "New Chat", "1"],
            )
            .unwrap();
        }
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(count_rows(home_b.path(), "threads"), 0);

        // The thread gets its first message. In the app the same write sets the
        // thread's head pointer (atomic with the message insert), which re-dirties
        // the now-non-empty thread; mirror that so it is re-queued for export.
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO messages (id, thread_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params!["m1", "t1", "hi", "2"],
            )
            .unwrap();
            conn.execute(
                "UPDATE threads SET head_message_id = ?1 WHERE id = ?2",
                params!["m1", "t1"],
            )
            .unwrap();
        }
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        // The thread now carries content, so it crosses the sync boundary.
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(count_rows(home_b.path(), "threads"), 1);
        // Its first message lands once the peer's next import cycle drains the
        // deferred-op queue — the same out-of-order delivery path sync already
        // relies on across devices. Auto-sync supplies that follow-up cycle.
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(count_rows(home_b.path(), "messages"), 1);
    }

    #[test]
    fn thread_emptiness_follows_head_pointer_not_message_count() {
        // Guards the export TOCTOU: emptiness must be read from the thread payload
        // (head_message_id), not a separate message-count query. Here a message row
        // exists but the thread's head pointer is still null — the window where the
        // first message has committed but the thread's head update has not. Exporting
        // the thread now would ship a blank payload that the insert-only import can
        // never repair, so it must be skipped until its head is set.
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, created_at) VALUES (?1, ?2, ?3)",
                params!["t1", "New Chat", "1"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, thread_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params!["m1", "t1", "hi", "2"],
            )
            .unwrap();
        }
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        // No blank thread on the peer despite the orphan message row on A.
        assert_eq!(count_rows(home_b.path(), "threads"), 0);
    }

    #[test]
    fn import_drops_unknown_columns_from_newer_peer() {
        // Peer A runs a newer schema whose tool_calls has an extra `model_id`
        // column. Peer B does not. Import must drop the unknown column instead
        // of failing with "table tool_calls has no column named model_id".
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute("ALTER TABLE tool_calls ADD COLUMN model_id TEXT", [])
                .unwrap();
            conn.execute(
                "INSERT INTO tool_calls (id, thread_id, assistant_message_id, tool_name, status, input_summary, started_at, model_id) VALUES ('tc1', 't1', 'm1', 'read', 'completed', 'README.md', '1', 'claude-opus-4-8')",
                [],
            )
            .unwrap();
        }
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(count_rows(home_b.path(), "tool_calls"), 1);
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let tool_name: Option<String> = conn
            .query_row(
                "SELECT tool_name FROM tool_calls WHERE id = 'tc1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tool_name.as_deref(), Some("read"));
    }

    #[test]
    fn incremental_export_emits_only_changed_rows() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home_a.path());

        // First export has no published files (seq 1), so it backfills the whole
        // archive: settings + thread + message.
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert!(read_ops_file(sync.path(), &device, 1).len() >= 3);

        // A new local message is captured by the AFTER INSERT trigger.
        insert_message(home_a.path(), "m2", "t1");
        assert_eq!(
            count_dirty(home_a.path()),
            1,
            "trigger should enqueue the new row"
        );

        // The next export ships only that row — not the full snapshot — and drains
        // the queue.
        let out = export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert_eq!(out.exported_ops, 1);
        let delta = read_ops_file(sync.path(), &device, 2);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].entity_id, "m2");
        assert_eq!(
            count_dirty(home_a.path()),
            0,
            "emitted rows must be cleared"
        );

        // With nothing left dirty, a further export writes no file at all.
        let idle = export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert_eq!(idle.exported_ops, 0);
        assert_eq!(count_op_files(sync.path(), &device), 2);
    }

    #[test]
    fn imported_archive_is_not_requeued_for_reexport() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        // The imported thread/message are read-only archives on B: the trigger
        // WHEN guards keep them out of B's dirty queue, so B never echoes A's rows
        // back into the sync dir.
        assert_eq!(count_rows(home_b.path(), "threads"), 1);
        assert_eq!(count_dirty(home_b.path()), 0);
    }

    #[test]
    fn dirty_entries_for_deleted_rows_are_cleared() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert_eq!(count_dirty(home_a.path()), 0);

        // Insert then delete a row before the next export: the trigger enqueued it,
        // but it's gone by export time, so export emits nothing for it.
        insert_message(home_a.path(), "m2", "t1");
        delete_message(home_a.path(), "m2");
        assert_eq!(count_dirty(home_a.path()), 1, "trigger enqueued the insert");

        // The export ships no ops — but it must still drain the stale entry instead
        // of rescanning it forever (create/delete churn must not accumulate).
        let out = export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert_eq!(out.exported_ops, 0);
        assert_eq!(
            count_dirty(home_a.path()),
            0,
            "skipped rows must be cleared"
        );
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
    fn export_republishes_when_ops_files_missing() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-a");
        init_sync(home.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home.path());

        export_ops(home.path(), Some(sync.path())).unwrap();
        assert_eq!(count_op_files(sync.path(), &device), 1);

        // iCloud (or the user) wiped this device's published ops, but the local DB
        // and its export fingerprint survive.
        fs::remove_dir_all(device_dir(sync.path(), &device).join("ops")).unwrap();
        assert_eq!(count_op_files(sync.path(), &device), 0);

        // Unchanged settings must still republish so other devices can recover.
        let again = export_ops(home.path(), Some(sync.path())).unwrap();
        assert!(
            again.exported_ops >= 1,
            "must republish when snapshot is gone"
        );
        assert_eq!(count_op_files(sync.path(), &device), 1);
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
                 CREATE TABLE threads (id TEXT PRIMARY KEY, folder_id TEXT REFERENCES folders(id), created_at TEXT, head_message_id TEXT, sync_origin_device_id TEXT, sync_imported_at TEXT);
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
                "INSERT INTO threads (id, folder_id, created_at, head_message_id) VALUES ('t1', 'f1', '1', 'm2')",
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
