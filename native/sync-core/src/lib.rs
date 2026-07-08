use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

const DB_FILE: &str = "yachiyo.sqlite";
const SETTINGS_FILE: &str = "config.toml";
const FORMAT_VERSION: u32 = 2;
const META_UNIVERSE: &str = "universe_id";
const META_SETTINGS_HASH: &str = "settings_export_hash";
const OPS_DIR_V1: &str = "ops";
const OPS_DIR_V2: &str = "ops-v2";

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

struct ImportFile {
    path: PathBuf,
    key: String,
    signature: ImportFileSignature,
}

struct ImportPlan {
    files: Vec<ImportFile>,
    backfill_paths: Vec<PathBuf>,
}

#[derive(Clone, Copy)]
struct ImportFileSignature {
    size: i64,
    modified_millis: i64,
}

enum ApplyOutcome {
    Counted,
    Skipped,
    Deferred,
}

struct OpsFileWriter {
    target: PathBuf,
    tmp: PathBuf,
    file: BufWriter<File>,
    count: usize,
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

fn settings_table_header(line: &str) -> bool {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("[[") {
        return rest.contains("]]");
    }
    trimmed
        .strip_prefix('[')
        .is_some_and(|rest| rest.contains(']'))
}

fn local_only_settings_header(line: &str) -> bool {
    let trimmed = line.trim_start();
    let (rest, closing) = if let Some(rest) = trimmed.strip_prefix("[[") {
        (rest, "]]")
    } else if let Some(rest) = trimmed.strip_prefix('[') {
        (rest, "]")
    } else {
        return false;
    };
    let Some(end) = rest.find(closing) else {
        return false;
    };
    let name = rest[..end].trim();
    name == "sync" || name.starts_with("sync.")
}

fn strip_local_only_settings_tables(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut skipping = false;
    for line in text.split_inclusive('\n') {
        if settings_table_header(line) {
            skipping = local_only_settings_header(line);
            if skipping {
                continue;
            }
        }
        if !skipping {
            output.push_str(line);
        }
    }
    output
}

fn extract_local_only_settings_tables(text: &str) -> String {
    let mut output = String::new();
    let mut keeping = false;
    for line in text.split_inclusive('\n') {
        if settings_table_header(line) {
            keeping = local_only_settings_header(line);
        }
        if keeping {
            output.push_str(line);
        }
    }
    output
}

fn merge_local_only_settings_tables(remote_text: &str, local_text: &str) -> String {
    let local_only = extract_local_only_settings_tables(local_text);
    let mut merged = strip_local_only_settings_tables(remote_text);
    if local_only.trim().is_empty() {
        return merged;
    }
    if !merged.is_empty() {
        if !merged.ends_with('\n') {
            merged.push('\n');
        }
        merged.push('\n');
    }
    merged.push_str(local_only.trim_matches('\n'));
    if !merged.ends_with('\n') {
        merged.push('\n');
    }
    merged
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
fn device_ops_dir(sync_dir: &Path, device_id: &str, ops_dir: &str) -> PathBuf {
    device_dir(sync_dir, device_id).join(ops_dir)
}

fn open_db(home: &Path) -> Result<Connection, SyncError> {
    let conn = Connection::open(db_path(home))?;
    // The app holds write locks on the same DB (e.g. completing a run); without a
    // busy timeout rusqlite fails immediately with SQLITE_BUSY instead of waiting.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
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
         CREATE TABLE IF NOT EXISTS sync_applied_ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, entity_type TEXT, entity_id TEXT, applied_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_imported_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified_millis INTEGER NOT NULL, imported_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_deferred_ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, op_json TEXT NOT NULL, deferred_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_skipped_schedule_threads (thread_id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, op_id TEXT NOT NULL, device_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, local_hash TEXT NOT NULL, remote_hash TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT);
         CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    )?;
    ensure_change_tracking(&conn)?;
    Ok(conn)
}

fn sync_applied_ops_tracks_entities(conn: &Connection) -> Result<bool, SyncError> {
    let columns = table_columns(conn, "sync_applied_ops")?;
    Ok(columns.contains("entity_type") && columns.contains("entity_id"))
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
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('thread', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_threads_ad AFTER DELETE ON threads
             WHEN OLD.sync_origin_device_id IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('thread', OLD.id); END;",
        )?;
    }
    if table_exists(conn, "messages")? {
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS sync_dirty_messages_ai AFTER INSERT ON messages
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('message', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_messages_au AFTER UPDATE ON messages
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('message', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_messages_ad AFTER DELETE ON messages
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = OLD.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('message', OLD.id); END;",
        )?;
    }
    if table_exists(conn, "tool_calls")? {
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS sync_dirty_tool_calls_ai AFTER INSERT ON tool_calls
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('toolcall', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_tool_calls_au AFTER UPDATE ON tool_calls
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = NEW.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('toolcall', NEW.id); END;
             CREATE TRIGGER IF NOT EXISTS sync_dirty_tool_calls_ad AFTER DELETE ON tool_calls
             WHEN (SELECT sync_origin_device_id FROM threads WHERE id = OLD.thread_id) IS NULL
             BEGIN INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id) VALUES ('toolcall', OLD.id); END;",
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

fn write_universe(sync_dir: &Path, universe: &Universe) -> Result<(), SyncError> {
    atomic_write(
        &sync_dir.join("universe.json"),
        &serde_json::to_string_pretty(universe)?,
    )
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
        Some(mut universe) => {
            if universe.format_version > FORMAT_VERSION {
                return Err(SyncError::Message(format!(
                    "Sync directory requires format version {}, but this sync-core supports {}.",
                    universe.format_version, FORMAT_VERSION
                )));
            }
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
            if universe.format_version < FORMAT_VERSION {
                universe.format_version = FORMAT_VERSION;
                write_universe(sync_dir, &universe)?;
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
            write_universe(sync_dir, &universe)?;
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

impl OpsFileWriter {
    fn create(target: &Path) -> Result<Self, SyncError> {
        let parent = target
            .parent()
            .ok_or_else(|| SyncError::Message("path has no parent".to_string()))?;
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(
            "{}.tmp-{}-{}",
            target.file_name().unwrap().to_string_lossy(),
            std::process::id(),
            Uuid::new_v4()
        ));
        let file = File::create(&tmp)?;
        Ok(Self {
            target: target.to_path_buf(),
            tmp,
            file: BufWriter::new(file),
            count: 0,
        })
    }

    fn write_op(&mut self, op: &SyncOp) -> Result<(), SyncError> {
        serde_json::to_writer(&mut self.file, op)?;
        self.file.write_all(b"\n")?;
        self.count += 1;
        Ok(())
    }

    fn commit(mut self) -> Result<(), SyncError> {
        self.file.flush()?;
        self.file.get_ref().sync_all()?;
        drop(self.file);
        fs::rename(self.tmp, self.target)?;
        Ok(())
    }

    fn discard(self) -> Result<(), SyncError> {
        drop(self.file);
        match fs::remove_file(self.tmp) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(SyncError::Io(error)),
        }
    }
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
    fs::create_dir_all(device_ops_dir(&sync_dir, &device_id, OPS_DIR_V1))?;
    fs::create_dir_all(device_ops_dir(&sync_dir, &device_id, OPS_DIR_V2))?;
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

fn refresh_local_manifest(sync_dir: &Path, device_id: &str, label: &str) -> Result<(), SyncError> {
    let existing = read_manifest(sync_dir, device_id);
    let published_seq = next_export_seq(sync_dir, device_id)? - 1;
    let seq = existing
        .as_ref()
        .map(|manifest| manifest.last_exported_seq.max(published_seq))
        .unwrap_or(published_seq);
    let exported_at = existing.and_then(|manifest| manifest.last_exported_at);
    write_manifest(sync_dir, device_id, label, seq, exported_at)
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
    refresh_local_manifest(&sync_dir, &device_id, &label)?;
    let exported_at = now();
    let seq = next_export_seq(&sync_dir, &device_id)?;

    // No published ops files (first export, or the sync dir was wiped): re-enqueue
    // every local row so a fresh/recovering peer gets the full archive. In steady
    // state (seq > 1) we emit only what changed since the last export.
    let full_resync = seq == 1;
    if full_resync {
        backfill_dirty(&conn)?;
    }

    let ops_v1_path = device_dir(&sync_dir, &device_id)
        .join(OPS_DIR_V1)
        .join(format!("{seq:016}.jsonl"));
    let ops_v2_path = device_dir(&sync_dir, &device_id)
        .join(OPS_DIR_V2)
        .join(format!("{seq:016}.jsonl"));
    let mut ops_v1 = OpsFileWriter::create(&ops_v1_path)?;
    let mut ops_v2 = OpsFileWriter::create(&ops_v2_path)?;
    let settings_text = fs::read_to_string(settings_path(home))
        .ok()
        .map(|text| strip_local_only_settings_tables(&text));
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
            ops_v1.write_op(&make_op(
                &device_id,
                seq,
                "settings.snapshot",
                "settings",
                "config.toml",
                payload,
            )?)?;
        }
    }

    let processed_dirty = export_dirty_ops(&conn, &device_id, seq, |op| {
        if op_requires_v2_dir(&op) {
            ops_v2.write_op(&op)
        } else {
            ops_v1.write_op(&op)
        }
    })?;

    // Publish a delta file only when there's something to ship. An empty `ops`
    // here means the queue held only skippable rows (deleted before export, or
    // synced archives) — we still clear them below so create/delete churn can't
    // accumulate.
    let ops_v1_count = ops_v1.count;
    let ops_v2_count = ops_v2.count;
    let exported_count = ops_v1_count + ops_v2_count;
    let last_exported_at = if exported_count == 0 {
        ops_v1.discard()?;
        ops_v2.discard()?;
        None
    } else {
        if ops_v1_count == 0 {
            ops_v1.discard()?;
        } else {
            ops_v1.commit()?;
        }
        if ops_v2_count == 0 {
            ops_v2.discard()?;
        } else {
            ops_v2.commit()?;
        }
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

    // Clear every dirty row we processed (emitted or intentionally skipped) only
    // after publish succeeds. Tombstones waiting for old peers stay queued.
    for dirty_seq in processed_dirty {
        conn.execute("DELETE FROM sync_dirty WHERE seq = ?1", [dirty_seq])?;
    }

    output(
        home,
        &sync_dir,
        Some(device_id),
        "ready",
        exported_count,
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

fn op_requires_v2_dir(op: &SyncOp) -> bool {
    matches!(
        op.kind.as_str(),
        "thread.archive.delete" | "message.archive.delete" | "toolcall.archive.delete"
    )
}

fn is_non_null_field(payload: &Value, field: &str) -> bool {
    payload.get(field).is_some_and(|value| !value.is_null())
}

fn thread_payload_should_not_export(payload: &Value) -> bool {
    is_non_null_field(payload, "sync_origin_device_id")
        || is_non_null_field(payload, "created_from_schedule_id")
}

fn is_fresh_empty_thread(payload: &Value) -> bool {
    payload.get("head_message_id").is_none_or(|v| v.is_null())
        && payload.get("title").and_then(Value::as_str) == Some("New Chat")
        && payload
            .get("created_at")
            .and_then(Value::as_str)
            .is_some_and(|created_at| {
                payload.get("updated_at").and_then(Value::as_str) == Some(created_at)
            })
}

fn child_belongs_to_non_exportable_thread(
    conn: &Connection,
    payload: &Value,
) -> Result<bool, SyncError> {
    let thread_id = payload
        .get("thread_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if thread_id.is_empty() {
        return Ok(true);
    }
    let Some(thread_payload) = fetch_row_json(conn, "threads", thread_id)? else {
        return Ok(true);
    };
    Ok(thread_payload_should_not_export(&thread_payload))
}

/// Content fingerprint of an export, independent of op_id / seq / timestamps, so
/// an unchanged settings+threads snapshot yields the same value every time. Used
/// to skip re-exporting identical data on every auto-sync cycle.
/// Drain the dirty queue into upsert/delete ops. Returns dirty sequence ids that
/// were emitted or intentionally skipped and can be cleared after publish.
fn export_dirty_ops(
    conn: &Connection,
    device_id: &str,
    seq: i64,
    mut emit: impl FnMut(SyncOp) -> Result<(), SyncError>,
) -> Result<Vec<i64>, SyncError> {
    let mut stmt =
        conn.prepare("SELECT seq, entity_type, entity_id FROM sync_dirty ORDER BY seq ASC")?;
    let dirty: Vec<(i64, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    let mut processed = Vec::new();
    for (dirty_seq, entity_type, entity_id) in dirty {
        let (table, upsert_kind, delete_kind) = match entity_type.as_str() {
            "thread" => ("threads", "thread.archive.upsert", "thread.archive.delete"),
            "message" => (
                "messages",
                "message.archive.upsert",
                "message.archive.delete",
            ),
            "toolcall" => (
                "tool_calls",
                "toolcall.archive.upsert",
                "toolcall.archive.delete",
            ),
            _ => continue,
        };
        if !table_exists(conn, table)? {
            processed.push(dirty_seq);
            continue;
        }
        let Some(mut payload) = fetch_row_json(conn, table, &entity_id)? else {
            emit(make_op(
                device_id,
                seq,
                delete_kind,
                &entity_type,
                &entity_id,
                json!({ "id": entity_id }),
            )?)?;
            processed.push(dirty_seq);
            continue;
        };
        // Defense in depth: never export threads that are not part of the normal
        // cross-device archive. Imported archives are read-only mirrors, and
        // schedule-created run threads are device-local history entries.
        if entity_type == "thread" && thread_payload_should_not_export(&payload) {
            processed.push(dirty_seq);
            continue;
        }
        if entity_type != "thread" && child_belongs_to_non_exportable_thread(conn, &payload)? {
            processed.push(dirty_seq);
            continue;
        }
        // Untouched "New Chat" placeholders have never existed on peers, so do
        // not publish a delete tombstone before the first real message/title/icon
        // update has a chance to export.
        if entity_type == "thread" && is_fresh_empty_thread(&payload) {
            processed.push(dirty_seq);
            continue;
        }
        // Other empty local threads export as delete tombstones. A thread emptied
        // by deleting its last message clears the previously imported archive row.
        if entity_type == "thread" && payload.get("head_message_id").is_none_or(|v| v.is_null()) {
            emit(make_op(
                device_id,
                seq,
                delete_kind,
                &entity_type,
                &entity_id,
                json!({ "id": entity_id }),
            )?)?;
            processed.push(dirty_seq);
            continue;
        }
        // Drop the heaviest message column from the archive. `response_messages` is
        // the raw provider transcript (the dominant ~500MB of a full DB) — it only
        // feeds run resume and the renderer's tool raw-input/output trace. On a
        // read-only mirror that can't be re-run, the renderer gracefully falls back
        // to the synced `tool_calls` summaries/details, so dropping it keeps ops
        // files from ballooning to GB scale. `turn_context` is intentionally KEPT:
        // it's tiny (~9MB) and `turnContext.hiddenRequestKind` drives timeline
        // grouping of hidden steer/follow-up turns on the archive.
        if entity_type == "message" {
            strip_heavy_archive_message_columns(&mut payload);
        }
        emit(make_op(
            device_id,
            seq,
            upsert_kind,
            &entity_type,
            &entity_id,
            payload,
        )?)?;
        processed.push(dirty_seq);
    }
    Ok(processed)
}

/// Message columns dropped from the read-only archive export. `response_messages`
/// is the raw provider transcript and by far the largest contributor to DB/ops
/// size; on a mirror it only powers run resume + the tool raw-IO trace, both of
/// which degrade gracefully (the renderer falls back to synced tool_calls
/// summaries/details). Kept deliberately small to avoid dropping display data —
/// notably `turn_context` stays, since hiddenRequestKind drives timeline grouping.
const HEAVY_ARCHIVE_MESSAGE_COLUMNS: &[&str] = &["response_messages"];

fn strip_heavy_archive_message_columns(payload: &mut Value) {
    if let Some(object) = payload.as_object_mut() {
        for column in HEAVY_ARCHIVE_MESSAGE_COLUMNS {
            object.remove(*column);
        }
    }
}

fn fetch_row_json(conn: &Connection, table: &str, id: &str) -> Result<Option<Value>, SyncError> {
    let sql = format!("SELECT * FROM {table} WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], row_to_json_object).optional()?)
}

fn next_export_seq(sync_dir: &Path, device_id: &str) -> Result<i64, SyncError> {
    let mut max_seq = 0;
    for ops_dir_name in [OPS_DIR_V1, OPS_DIR_V2] {
        let ops_dir = device_ops_dir(sync_dir, device_id, ops_dir_name);
        fs::create_dir_all(&ops_dir)?;
        for entry in fs::read_dir(ops_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".jsonl") {
                max_seq = max_seq.max(stem.parse::<i64>().unwrap_or(0));
            }
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
    if !local_device.is_empty() {
        let label = get_device_label(&conn, &local_device)?;
        refresh_local_manifest(&sync_dir, &local_device, &label)?;
    }
    let paths = op_files(&sync_dir)?;
    let plan = import_files_to_scan(&conn, &sync_dir, paths, &local_device)?;
    backfill_applied_op_entities(&conn, &plan.backfill_paths)?;
    let mut schedule_thread_ids = load_skipped_schedule_thread_ids(&conn)?;
    schedule_thread_ids.extend(schedule_created_thread_ids_in_ops(&plan.files)?);
    let mut imported = 0;
    let mut transient_error: Option<String> = None;
    let mut blocked_devices = HashSet::new();
    for file in plan.files {
        let file_device = import_key_device_seq(&file.key).map(|(device_id, _)| device_id);
        if file_device
            .as_ref()
            .is_some_and(|device_id| blocked_devices.contains(device_id))
        {
            continue;
        }
        // A file that fails to read is likely still downloading from iCloud:
        // skip it (don't record it as applied) and report a transient error.
        let result = for_each_op_in_file(&file.path, |op| {
            // Business write + applied-ops bookkeeping commit together, so a
            // crash mid-import can never leave an op half-applied.
            let tx = conn.unchecked_transaction()?;
            let outcome = apply_op(home, &tx, &op, &schedule_thread_ids)?;
            match outcome {
                ApplyOutcome::Counted => {
                    clear_deferred_op(&tx, &op.op_id)?;
                    imported += 1;
                }
                ApplyOutcome::Skipped => clear_deferred_op(&tx, &op.op_id)?,
                ApplyOutcome::Deferred => record_deferred_op(&tx, &op)?,
            }
            tx.commit()?;
            Ok(())
        });
        match result {
            Ok(()) => {
                mark_import_file_complete(&conn, &file.key, file.signature)?;
            }
            Err(SyncError::Io(error)) => {
                if let Some(device_id) = file_device {
                    blocked_devices.insert(device_id);
                }
                transient_error = Some(format!(
                    "Could not read {} (still downloading?): {error}",
                    file.path.display()
                ));
                continue;
            }
            Err(SyncError::Json(error)) => {
                if let Some(device_id) = file_device {
                    blocked_devices.insert(device_id);
                }
                transient_error = Some(format!(
                    "Could not parse {} (still downloading?): {error}",
                    file.path.display()
                ));
                continue;
            }
            Err(error) => {
                return Err(error);
            }
        }
    }
    retry_deferred_ops(home, &conn, &schedule_thread_ids, &mut imported)?;
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

fn backfill_applied_op_entities(conn: &Connection, paths: &[PathBuf]) -> Result<(), SyncError> {
    if !sync_applied_ops_tracks_entities(conn)? {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT op_id FROM sync_applied_ops WHERE entity_type IS NULL OR entity_id IS NULL",
    )?;
    let missing = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<String>, _>>()?;
    if missing.is_empty() {
        return Ok(());
    }
    for path in paths {
        let result = for_each_op_in_file(path, |op| {
            if missing.contains(&op.op_id) {
                conn.execute(
                    "UPDATE sync_applied_ops SET entity_type = ?2, entity_id = ?3 WHERE op_id = ?1",
                    params![op.op_id, op.entity_type, op.entity_id],
                )?;
            }
            Ok(())
        });
        match result {
            Ok(()) => {}
            Err(SyncError::Io(_)) => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn op_files(sync_dir: &Path) -> Result<Vec<PathBuf>, SyncError> {
    let mut files = Vec::new();
    let devices = sync_dir.join("devices");
    if !devices.exists() {
        return Ok(files);
    }
    for device in fs::read_dir(devices)? {
        let device_path = device?.path();
        for ops_dir_name in [OPS_DIR_V1, OPS_DIR_V2] {
            let ops = device_path.join(ops_dir_name);
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
    }
    files.sort_by_key(|path| {
        import_file_device_seq(sync_dir, path)
            .map(|(device_id, seq)| (device_id, seq))
            .unwrap_or_else(|| (path.display().to_string(), i64::MAX))
    });
    Ok(files)
}

fn import_files_to_scan(
    conn: &Connection,
    sync_dir: &Path,
    paths: Vec<PathBuf>,
    local_device: &str,
) -> Result<ImportPlan, SyncError> {
    let mut files = Vec::new();
    let mut backfill_paths = Vec::new();
    let mut next_seq_by_device: HashMap<String, i64> = HashMap::new();
    for path in paths {
        let Some((device_id, seq)) = import_file_device_seq(sync_dir, &path) else {
            continue;
        };
        if device_id == local_device {
            continue;
        }
        let expected_seq = match next_seq_by_device.get(&device_id).copied() {
            Some(seq) => seq,
            None => {
                let seq = next_import_seq(conn, &device_id)?;
                next_seq_by_device.insert(device_id.clone(), seq);
                seq
            }
        };
        if seq > expected_seq {
            continue;
        }
        let signature = import_file_signature(&path)?;
        let key = import_file_key(sync_dir, &path);
        if import_file_is_complete(conn, &key, signature)? {
            backfill_paths.push(path);
            if seq == expected_seq {
                next_seq_by_device.insert(device_id, expected_seq + 1);
            }
            continue;
        }
        files.push(ImportFile {
            path,
            key,
            signature,
        });
        if seq == expected_seq {
            next_seq_by_device.insert(device_id, expected_seq + 1);
        }
    }
    Ok(ImportPlan {
        files,
        backfill_paths,
    })
}

fn import_file_device_seq(sync_dir: &Path, path: &Path) -> Option<(String, i64)> {
    let relative = path.strip_prefix(sync_dir).ok()?;
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    if parts.len() != 4
        || parts[0] != "devices"
        || (parts[2] != OPS_DIR_V1 && parts[2] != OPS_DIR_V2)
    {
        return None;
    }
    let seq = parts[3].strip_suffix(".jsonl")?.parse::<i64>().ok()?;
    Some((parts[1].clone(), seq))
}

fn import_key_device_seq(key: &str) -> Option<(String, i64)> {
    let parts = key.split('/').collect::<Vec<_>>();
    if parts.len() != 4
        || parts[0] != "devices"
        || (parts[2] != OPS_DIR_V1 && parts[2] != OPS_DIR_V2)
    {
        return None;
    }
    let seq = parts[3].strip_suffix(".jsonl")?.parse::<i64>().ok()?;
    Some((parts[1].to_string(), seq))
}

fn next_import_seq(conn: &Connection, device_id: &str) -> Result<i64, SyncError> {
    let mut stmt = conn.prepare("SELECT path FROM sync_imported_files")?;
    let completed = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|row| row.ok())
        .filter_map(|key| import_key_device_seq(&key))
        .filter_map(|(key_device_id, seq)| (key_device_id == device_id).then_some(seq))
        .collect::<HashSet<_>>();
    let mut next = 1;
    while completed.contains(&next) {
        next += 1;
    }
    Ok(next)
}

fn import_file_key(sync_dir: &Path, path: &Path) -> String {
    path.strip_prefix(sync_dir)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn import_file_signature(path: &Path) -> Result<ImportFileSignature, SyncError> {
    let metadata = fs::metadata(path)?;
    let modified_millis = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    Ok(ImportFileSignature {
        size: metadata.len() as i64,
        modified_millis,
    })
}

fn import_file_is_complete(
    conn: &Connection,
    key: &str,
    signature: ImportFileSignature,
) -> Result<bool, SyncError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sync_imported_files WHERE path = ?1 AND size = ?2 AND modified_millis = ?3",
            params![key, signature.size, signature.modified_millis],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn mark_import_file_complete(
    conn: &Connection,
    key: &str,
    signature: ImportFileSignature,
) -> Result<(), SyncError> {
    conn.execute(
        "INSERT INTO sync_imported_files (path, size, modified_millis, imported_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, modified_millis = excluded.modified_millis, imported_at = excluded.imported_at",
        params![key, signature.size, signature.modified_millis, now()],
    )?;
    Ok(())
}

fn record_deferred_op(conn: &Connection, op: &SyncOp) -> Result<(), SyncError> {
    conn.execute(
        "INSERT INTO sync_deferred_ops (op_id, device_id, seq, entity_type, entity_id, op_json, deferred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(op_id) DO UPDATE SET op_json = excluded.op_json, deferred_at = excluded.deferred_at",
        params![
            op.op_id,
            op.device_id,
            op.seq,
            op.entity_type,
            op.entity_id,
            serde_json::to_string(op)?,
            now()
        ],
    )?;
    Ok(())
}

fn clear_deferred_op(conn: &Connection, op_id: &str) -> Result<(), SyncError> {
    conn.execute("DELETE FROM sync_deferred_ops WHERE op_id = ?1", [op_id])?;
    Ok(())
}

fn load_deferred_ops(conn: &Connection) -> Result<Vec<SyncOp>, SyncError> {
    let mut stmt = conn.prepare("SELECT op_json FROM sync_deferred_ops ORDER BY device_id, seq")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|text| serde_json::from_str(&text).map_err(SyncError::Json))
        .collect()
}

fn retry_deferred_ops(
    home: &Path,
    conn: &Connection,
    schedule_thread_ids: &HashSet<String>,
    imported: &mut usize,
) -> Result<(), SyncError> {
    for op in load_deferred_ops(conn)? {
        let tx = conn.unchecked_transaction()?;
        let outcome = apply_op(home, &tx, &op, schedule_thread_ids)?;
        match outcome {
            ApplyOutcome::Counted => {
                clear_deferred_op(&tx, &op.op_id)?;
                *imported += 1;
            }
            ApplyOutcome::Skipped => clear_deferred_op(&tx, &op.op_id)?,
            ApplyOutcome::Deferred => record_deferred_op(&tx, &op)?,
        }
        tx.commit()?;
    }
    Ok(())
}

fn for_each_op_in_file(
    path: &Path,
    mut visit: impl FnMut(SyncOp) -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }
        visit(serde_json::from_str(&line)?)?;
    }
}

fn schedule_created_thread_ids_in_ops(files: &[ImportFile]) -> Result<HashSet<String>, SyncError> {
    let mut ids = HashSet::new();
    for file in files {
        let result = for_each_op_in_file(&file.path, |op| {
            if op.kind == "thread.archive.upsert"
                && is_non_null_field(&op.payload, "created_from_schedule_id")
            {
                ids.insert(op.entity_id);
            }
            Ok(())
        });
        match result {
            Ok(()) => {}
            Err(SyncError::Io(_) | SyncError::Json(_)) => continue,
            Err(error) => {
                return Err(error);
            }
        }
    }
    Ok(ids)
}

fn load_skipped_schedule_thread_ids(conn: &Connection) -> Result<HashSet<String>, SyncError> {
    let mut stmt = conn.prepare("SELECT thread_id FROM sync_skipped_schedule_threads")?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<String>, _>>()?;
    Ok(ids)
}

fn mark_schedule_thread_skipped(conn: &Connection, thread_id: &str) -> Result<(), SyncError> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_skipped_schedule_threads (thread_id, recorded_at) VALUES (?1, ?2)",
        params![thread_id, now()],
    )?;
    Ok(())
}

fn op_belongs_to_schedule_thread(op: &SyncOp, schedule_thread_ids: &HashSet<String>) -> bool {
    if op.kind == "thread.archive.upsert" {
        return is_non_null_field(&op.payload, "created_from_schedule_id");
    }
    if op.kind == "message.archive.upsert" || op.kind == "toolcall.archive.upsert" {
        return op
            .payload
            .get("thread_id")
            .and_then(Value::as_str)
            .is_some_and(|thread_id| schedule_thread_ids.contains(thread_id));
    }
    false
}

fn mark_op_applied(conn: &Connection, op: &SyncOp) -> Result<(), SyncError> {
    if sync_applied_ops_tracks_entities(conn)? {
        conn.execute("INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, seq, entity_type, entity_id, applied_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![op.op_id, op.device_id, op.seq, op.entity_type, op.entity_id, now()])?;
        conn.execute(
            "UPDATE sync_applied_ops SET entity_type = COALESCE(entity_type, ?2), entity_id = COALESCE(entity_id, ?3) WHERE op_id = ?1",
            params![op.op_id, op.entity_type, op.entity_id],
        )?;
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES (?1, ?2, ?3, ?4)",
        params![op.op_id, op.device_id, op.seq, now()],
    )?;
    Ok(())
}

fn has_newer_applied_op_for_entity(conn: &Connection, op: &SyncOp) -> Result<bool, SyncError> {
    if !sync_applied_ops_tracks_entities(conn)? {
        return Ok(false);
    }
    Ok(conn
        .query_row(
            "SELECT 1 FROM sync_applied_ops WHERE device_id = ?1 AND seq > ?2 AND entity_type = ?3 AND entity_id = ?4 LIMIT 1",
            params![op.device_id, op.seq, op.entity_type, op.entity_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn apply_op(
    home: &Path,
    conn: &Connection,
    op: &SyncOp,
    schedule_thread_ids: &HashSet<String>,
) -> Result<ApplyOutcome, SyncError> {
    let is_schedule_thread = op.kind == "thread.archive.upsert"
        && is_non_null_field(&op.payload, "created_from_schedule_id");
    if is_schedule_thread {
        mark_schedule_thread_skipped(conn, &op.entity_id)?;
    }
    if conn
        .query_row(
            "SELECT 1 FROM sync_applied_ops WHERE op_id = ?1",
            [&op.op_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(ApplyOutcome::Skipped);
    }
    if has_newer_applied_op_for_entity(conn, op)? {
        mark_op_applied(conn, op)?;
        return Ok(ApplyOutcome::Skipped);
    }
    if op_belongs_to_schedule_thread(op, schedule_thread_ids) {
        mark_op_applied(conn, op)?;
        return Ok(ApplyOutcome::Skipped);
    }
    match op.kind.as_str() {
        "settings.snapshot" => apply_settings(home, conn, op)?,
        "thread.archive.upsert" => {
            insert_json_row(conn, "threads", &op.payload, Some((&op.device_id, now())))?
        }
        "thread.archive.delete" => delete_imported_thread(conn, &op.entity_id, &op.device_id)?,
        "message.archive.upsert" => {
            if !parent_thread_exists(conn, &op.payload)? {
                // Parent thread hasn't been imported yet; defer without marking
                // applied so a later import (after the thread op arrives) retries.
                return Ok(ApplyOutcome::Deferred);
            }
            insert_json_row(conn, "messages", &op.payload, Some((&op.device_id, now())))?
        }
        "message.archive.delete" => {
            delete_imported_child_row(conn, "messages", &op.entity_id, &op.device_id)?
        }
        "toolcall.archive.upsert" => {
            if !parent_thread_exists(conn, &op.payload)? {
                // Same deferral as messages: wait until the owning thread exists.
                return Ok(ApplyOutcome::Deferred);
            }
            insert_json_row(
                conn,
                "tool_calls",
                &op.payload,
                Some((&op.device_id, now())),
            )?
        }
        "toolcall.archive.delete" => {
            delete_imported_child_row(conn, "tool_calls", &op.entity_id, &op.device_id)?
        }
        _ => {}
    }
    mark_op_applied(conn, op)?;
    Ok(ApplyOutcome::Counted)
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

fn thread_origin_matches(
    conn: &Connection,
    thread_id: &str,
    device_id: &str,
) -> Result<bool, SyncError> {
    Ok(conn
        .query_row(
            "SELECT sync_origin_device_id FROM threads WHERE id = ?1",
            [thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .is_some_and(|origin| origin == device_id))
}

fn child_origin_matches(
    conn: &Connection,
    table: &str,
    id: &str,
    device_id: &str,
) -> Result<bool, SyncError> {
    let thread_id = conn
        .query_row(
            &format!("SELECT thread_id FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match thread_id {
        Some(thread_id) => thread_origin_matches(conn, &thread_id, device_id),
        None => Ok(false),
    }
}

fn payload_thread_origin_matches(
    conn: &Connection,
    payload: &Value,
    device_id: &str,
) -> Result<bool, SyncError> {
    let thread_id = payload
        .get("thread_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if thread_id.is_empty() {
        return Ok(false);
    }
    thread_origin_matches(conn, thread_id, device_id)
}

fn can_update_imported_row(
    conn: &Connection,
    table: &str,
    id: &str,
    payload: &Value,
    device_id: &str,
) -> Result<bool, SyncError> {
    match table {
        "threads" => thread_origin_matches(conn, id, device_id),
        "messages" | "tool_calls" => payload_thread_origin_matches(conn, payload, device_id),
        _ => Ok(false),
    }
}

fn delete_imported_thread(
    conn: &Connection,
    thread_id: &str,
    device_id: &str,
) -> Result<(), SyncError> {
    if !thread_origin_matches(conn, thread_id, device_id)? {
        return Ok(());
    }
    conn.execute("DELETE FROM tool_calls WHERE thread_id = ?1", [thread_id])?;
    conn.execute("DELETE FROM messages WHERE thread_id = ?1", [thread_id])?;
    conn.execute(
        "DELETE FROM threads WHERE id = ?1 AND sync_origin_device_id = ?2",
        params![thread_id, device_id],
    )?;
    Ok(())
}

fn delete_imported_child_row(
    conn: &Connection,
    table: &str,
    id: &str,
    device_id: &str,
) -> Result<(), SyncError> {
    if !child_origin_matches(conn, table, id, device_id)? {
        return Ok(());
    }
    if table == "messages" {
        conn.execute(
            "DELETE FROM tool_calls WHERE request_message_id = ?1 OR assistant_message_id = ?1",
            [id],
        )?;
    }
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])?;
    Ok(())
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
    let local_hash = hash_text(&strip_local_only_settings_tables(&local_text));
    // Both sides already agree — nothing to write and never a conflict. Without
    // this, a re-exported but byte-identical snapshot would record a phantom
    // conflict on every import.
    if path.exists() && local_hash == remote_hash {
        return Ok(());
    }
    if !path.exists() || local_hash == base_hash {
        atomic_write(
            &path,
            &merge_local_only_settings_tables(remote_text, &local_text),
        )?;
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
    let remote_device_id = remote.as_ref().map(|(device_id, _)| *device_id);
    let local_columns = table_columns(conn, table)?;
    if exists.is_some() {
        let Some(device_id) = remote_device_id else {
            return Ok(());
        };
        if !can_update_imported_row(conn, table, id, payload, device_id)? {
            return Ok(());
        }
        let mut columns: Vec<String> = object.keys().cloned().collect();
        columns.retain(|name| {
            name != "id"
                && name != "sync_origin_device_id"
                && name != "sync_imported_at"
                && local_columns.contains(name)
        });
        let mut values: Vec<Value> = columns
            .iter()
            .map(|name| object.get(name).cloned().unwrap_or(Value::Null))
            .collect();
        if table == "threads" {
            columns.push("sync_imported_at".to_string());
            let (_, imported_at) = remote.unwrap();
            values.push(json!(imported_at));
        }
        if columns.is_empty() {
            return Ok(());
        }
        let assignments = columns
            .iter()
            .enumerate()
            .map(|(index, name)| format!("{name} = ?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        values.push(json!(id));
        let sql = format!(
            "UPDATE {table} SET {assignments} WHERE id = ?{}",
            values.len()
        );
        let params = rusqlite::params_from_iter(values.iter().map(json_to_sql));
        conn.execute(&sql, params)?;
        return Ok(());
    }
    // Only insert columns that physically exist on the local table. A peer on a
    // newer schema may export extra columns (e.g. a future `model_id`); dropping
    // them keeps import forward-compatible instead of failing the whole sync.
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
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, icon TEXT, created_at TEXT, updated_at TEXT, head_message_id TEXT, created_from_schedule_id TEXT, sync_origin_device_id TEXT, sync_imported_at TEXT);
             CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT, created_at TEXT, response_messages TEXT, turn_context TEXT);
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

    fn set_manifest_format(sync_dir: &Path, device_id: &str, format_version: u32) {
        let mut manifest = read_manifest(sync_dir, device_id).unwrap();
        manifest.format_version = format_version;
        atomic_write(
            &device_dir(sync_dir, device_id).join("manifest.json"),
            &serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn count_op_files(sync_dir: &Path, device_id: &str) -> usize {
        [OPS_DIR_V1, OPS_DIR_V2]
            .into_iter()
            .map(|ops_dir| {
                let ops = device_ops_dir(sync_dir, device_id, ops_dir);
                if !ops.exists() {
                    return 0;
                }
                fs::read_dir(ops)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
                    .count()
            })
            .sum()
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
        let path = op_file_path(sync_dir, device_id, seq);
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn read_op_file_lines(sync_dir: &Path, device_id: &str, seq: i64) -> Vec<String> {
        let path = op_file_path(sync_dir, device_id, seq);
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn op_file_path(sync_dir: &Path, device_id: &str, seq: i64) -> PathBuf {
        let path = [OPS_DIR_V2, OPS_DIR_V1]
            .into_iter()
            .map(|ops_dir| {
                device_ops_dir(sync_dir, device_id, ops_dir).join(format!("{seq:016}.jsonl"))
            })
            .find(|path| path.exists())
            .unwrap();
        path
    }

    fn delete_message(home: &Path, message_id: &str) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .unwrap();
    }

    fn clear_thread_head(home: &Path, thread_id: &str) {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.execute(
            "UPDATE threads SET head_message_id = NULL WHERE id = ?1",
            params![thread_id],
        )
        .unwrap();
    }

    fn message_body(home: &Path, message_id: &str) -> Option<String> {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.query_row(
            "SELECT body FROM messages WHERE id = ?1",
            [message_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    fn thread_title(home: &Path, thread_id: &str) -> Option<String> {
        let conn = Connection::open(home.join(DB_FILE)).unwrap();
        conn.query_row(
            "SELECT title FROM threads WHERE id = ?1",
            [thread_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
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
    fn ordinary_exports_remain_visible_in_v1_ops_dir() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-a");
        seed_thread(home.path(), "t1", "m1");
        init_sync(home.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home.path());

        export_ops(home.path(), Some(sync.path())).unwrap();

        let legacy_path =
            device_ops_dir(sync.path(), &device, OPS_DIR_V1).join("0000000000000001.jsonl");
        let v2_path =
            device_ops_dir(sync.path(), &device, OPS_DIR_V2).join("0000000000000001.jsonl");
        assert!(
            legacy_path.exists(),
            "v1 peers must still see ordinary exports"
        );
        assert!(
            !v2_path.exists(),
            "v2-only files should be reserved for ops that old clients must not consume"
        );
        let kinds = fs::read_to_string(legacy_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<SyncOp>(line).unwrap().kind)
            .collect::<HashSet<_>>();
        assert!(kinds.contains("thread.archive.upsert"));
        assert!(kinds.contains("message.archive.upsert"));
    }

    #[cfg(unix)]
    #[test]
    fn import_skips_cached_completed_ops_files() {
        use std::os::unix::fs::PermissionsExt;

        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        let first = import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert!(first.imported_ops >= 2);
        assert_eq!(first.last_error, None);

        let device_a = device_id_of(home_a.path());
        let path = op_file_path(sync.path(), &device_a, 1);
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut unreadable_permissions = original_permissions.clone();
        unreadable_permissions.set_mode(0o000);
        fs::set_permissions(&path, unreadable_permissions).unwrap();

        let second = import_ops(home_b.path(), Some(sync.path())).unwrap();
        fs::set_permissions(&path, original_permissions).unwrap();

        assert_eq!(second.imported_ops, 0);
        assert_eq!(second.last_error, None);
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
                "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params!["empty", "New Chat", "1", "1"],
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

        let device = device_id_of(home_a.path());
        let v2_path =
            device_ops_dir(sync.path(), &device, OPS_DIR_V2).join("0000000000000001.jsonl");
        assert!(
            !v2_path.exists(),
            "fresh empty threads must not publish a delete tombstone before their first message"
        );
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
                "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params!["t1", "New Chat", "1", "1"],
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
                "UPDATE threads SET head_message_id = ?1, title = ?2, icon = ?3, updated_at = ?4 WHERE id = ?5",
                params!["m1", "Electron Utility Process", "⚙️", "2", "t1"],
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
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let icon: Option<String> = conn
            .query_row("SELECT icon FROM threads WHERE id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(icon.as_deref(), Some("⚙️"));
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
                "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params!["t1", "New Chat", "1", "1"],
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
    fn schedule_created_threads_are_not_exported_as_normal_archives() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        {
            let conn = Connection::open(home_a.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, created_at, head_message_id, created_from_schedule_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["schedule-thread", "Schedule: Daily sync", "1", "schedule-message", "schedule-1"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, thread_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    "schedule-message",
                    "schedule-thread",
                    "scheduled result",
                    "2"
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tool_calls (id, thread_id, assistant_message_id, tool_name, status, input_summary, started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "schedule-tool-call",
                    "schedule-thread",
                    "schedule-message",
                    "reportScheduleResult",
                    "completed",
                    "success",
                    "3"
                ],
            )
            .unwrap();
        }
        seed_thread(home_a.path(), "normal-thread", "normal-message");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();

        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let schedule_thread_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM threads WHERE id = 'schedule-thread'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let schedule_message_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE thread_id = 'schedule-thread'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let schedule_tool_call_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tool_calls WHERE thread_id = 'schedule-thread'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let normal_thread_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM threads WHERE id = 'normal-thread'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(
            schedule_thread_count, 0,
            "schedule-created threads must stay device-local"
        );
        assert_eq!(
            schedule_message_count, 0,
            "messages from schedule-created threads must not be exported"
        );
        assert_eq!(
            schedule_tool_call_count, 0,
            "tool calls from schedule-created threads must not be exported"
        );
        assert_eq!(normal_thread_count, 1, "normal threads must still sync");
    }

    #[test]
    fn import_skips_previously_exported_schedule_threads_and_children() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-b");
        init_sync(home.path(), Some(sync.path()), "B").unwrap();
        let thread_op = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "schedule-thread",
            json!({
                "id": "schedule-thread",
                "title": "Schedule: Daily sync",
                "created_at": "1",
                "head_message_id": "schedule-message",
                "created_from_schedule_id": "schedule-1"
            }),
        )
        .unwrap();
        let message_op = make_op(
            "remote-device",
            1,
            "message.archive.upsert",
            "message",
            "schedule-message",
            json!({
                "id": "schedule-message",
                "thread_id": "schedule-thread",
                "body": "scheduled result",
                "created_at": "2"
            }),
        )
        .unwrap();
        let tool_call_op = make_op(
            "remote-device",
            1,
            "toolcall.archive.upsert",
            "toolcall",
            "schedule-tool-call",
            json!({
                "id": "schedule-tool-call",
                "thread_id": "schedule-thread",
                "assistant_message_id": "schedule-message",
                "tool_name": "reportScheduleResult",
                "status": "completed",
                "input_summary": "success",
                "started_at": "3"
            }),
        )
        .unwrap();
        let normal_thread_op = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "normal-thread",
            json!({
                "id": "normal-thread",
                "title": "Hello",
                "created_at": "1",
                "head_message_id": "normal-message"
            }),
        )
        .unwrap();
        let normal_message_op = make_op(
            "remote-device",
            1,
            "message.archive.upsert",
            "message",
            "normal-message",
            json!({
                "id": "normal-message",
                "thread_id": "normal-thread",
                "body": "hi",
                "created_at": "2"
            }),
        )
        .unwrap();
        let schedule_thread_op_id = thread_op.op_id.clone();
        let schedule_message_op_id = message_op.op_id.clone();
        let schedule_tool_call_op_id = tool_call_op.op_id.clone();
        write_ops_file(
            sync.path(),
            "remote-device",
            1,
            &[
                message_op,
                tool_call_op,
                thread_op,
                normal_thread_op,
                normal_message_op,
            ],
        );

        let result = import_ops(home.path(), Some(sync.path())).unwrap();

        assert_eq!(count_rows(home.path(), "threads"), 1);
        assert_eq!(count_rows(home.path(), "messages"), 1);
        assert_eq!(count_rows(home.path(), "tool_calls"), 0);
        assert_eq!(
            result.imported_ops, 2,
            "only normal thread/message ops should count as imported"
        );
        let conn = Connection::open(home.path().join(DB_FILE)).unwrap();
        let schedule_applied_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_applied_ops WHERE op_id IN (?1, ?2, ?3)",
                params![
                    schedule_thread_op_id,
                    schedule_message_op_id,
                    schedule_tool_call_op_id
                ],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            schedule_applied_count, 3,
            "skipped schedule ops must still be marked applied"
        );
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
    fn imported_archive_updates_when_origin_reexports_row() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(message_body(home_b.path(), "m1").as_deref(), Some("hi"));

        let conn_a = Connection::open(home_a.path().join(DB_FILE)).unwrap();
        conn_a
            .execute("UPDATE messages SET body = 'corrected' WHERE id = 'm1'", [])
            .unwrap();

        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            message_body(home_b.path(), "m1").as_deref(),
            Some("corrected")
        );
    }

    #[test]
    fn imported_archive_deletes_message_when_origin_deletes_message() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(count_rows(home_b.path(), "messages"), 1);

        delete_message(home_a.path(), "m1");
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(count_rows(home_b.path(), "messages"), 0);
    }

    #[test]
    fn deleting_last_message_removes_imported_archive_thread() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(count_rows(home_b.path(), "threads"), 1);

        delete_message(home_a.path(), "m1");
        clear_thread_head(home_a.path(), "t1");
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(count_rows(home_b.path(), "messages"), 0);
        assert_eq!(count_rows(home_b.path(), "threads"), 0);
    }

    #[test]
    fn older_remote_op_does_not_overwrite_newer_archive_row() {
        let sync = tempfile::tempdir().unwrap();
        let home_b = setup_home("config-b");
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let newer = make_op(
            "remote-device",
            2,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "New title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 2, &[newer]);

        let first = import_ops(home_b.path(), Some(sync.path())).unwrap();
        assert_eq!(
            first.imported_ops, 0,
            "seq 2 must wait until seq 1 is visible"
        );
        assert_eq!(count_rows(home_b.path(), "threads"), 0);

        let older = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "Old title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[older]);

        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            thread_title(home_b.path(), "t1").as_deref(),
            Some("New title")
        );
    }

    #[test]
    fn older_unrelated_op_imports_after_newer_device_op_was_applied() {
        let sync = tempfile::tempdir().unwrap();
        let home_b = setup_home("config-b");
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let newer = make_op(
            "remote-device",
            2,
            "settings.snapshot",
            "settings",
            "config.toml",
            json!({"text": "config-b", "baseHash": hash_text(""), "contentHash": hash_text("config-b")}),
        )
        .unwrap();
        {
            let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
            mark_op_applied(&conn, &newer).unwrap();
        }
        let older_unrelated = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "Missing thread", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[older_unrelated]);

        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            thread_title(home_b.path(), "t1").as_deref(),
            Some("Missing thread")
        );
    }

    #[test]
    fn older_same_entity_op_does_not_replace_newer_applied_archive_row() {
        let sync = tempfile::tempdir().unwrap();
        let home_b = setup_home("config-b");
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let newer = make_op(
            "remote-device",
            2,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "New title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        {
            let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
            insert_json_row(
                &conn,
                "threads",
                &newer.payload,
                Some((&newer.device_id, now())),
            )
            .unwrap();
            mark_op_applied(&conn, &newer).unwrap();
        }
        let older = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "Old title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[older]);

        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            thread_title(home_b.path(), "t1").as_deref(),
            Some("New title")
        );
    }

    #[test]
    fn backfill_ignores_future_invalid_ops_file_until_sequence_is_eligible() {
        let sync = tempfile::tempdir().unwrap();
        let home_b = setup_home("config-b");
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        {
            let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES ('legacy-missing', 'remote-device', 2, '2')",
                [],
            )
            .unwrap();
        }
        let current = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "Current title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[current]);
        let future_path = device_dir(sync.path(), "remote-device")
            .join("ops")
            .join("0000000000000003.jsonl");
        fs::write(future_path, "{not json\n").unwrap();

        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            thread_title(home_b.path(), "t1").as_deref(),
            Some("Current title")
        );
    }

    #[test]
    fn completed_in_window_file_backfills_legacy_applied_entity_metadata() {
        let sync = tempfile::tempdir().unwrap();
        let home_b = setup_home("config-b");
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let newer = make_op(
            "remote-device",
            2,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "New title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(
            sync.path(),
            "remote-device",
            2,
            std::slice::from_ref(&newer),
        );
        let newer_path = device_dir(sync.path(), "remote-device")
            .join("ops")
            .join("0000000000000002.jsonl");
        {
            let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
            insert_json_row(
                &conn,
                "threads",
                &newer.payload,
                Some((&newer.device_id, now())),
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES (?1, ?2, ?3, ?4)",
                params![newer.op_id, newer.device_id, newer.seq, "2"],
            )
            .unwrap();
            mark_import_file_complete(
                &conn,
                &import_file_key(sync.path(), &newer_path),
                import_file_signature(&newer_path).unwrap(),
            )
            .unwrap();
        }
        let older = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "Old title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[older]);

        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            thread_title(home_b.path(), "t1").as_deref(),
            Some("New title")
        );
    }

    #[test]
    fn open_db_does_not_mutate_legacy_applied_ops_schema() {
        let home = setup_home("config");
        {
            let conn = Connection::open(home.path().join(DB_FILE)).unwrap();
            conn.execute(
                "CREATE TABLE sync_applied_ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, applied_at TEXT NOT NULL)",
                [],
            )
            .unwrap();
        }

        let conn = open_db(home.path()).unwrap();
        let columns = table_columns(&conn, "sync_applied_ops").unwrap();

        assert!(!columns.contains("entity_type"));
        assert!(!columns.contains("entity_id"));
    }

    #[test]
    fn legacy_applied_ops_schema_imports_without_entity_columns() {
        let sync = tempfile::tempdir().unwrap();
        let home_b = setup_home("config-b");
        {
            let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
            conn.execute(
                "CREATE TABLE sync_applied_ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, seq INTEGER NOT NULL, applied_at TEXT NOT NULL)",
                [],
            )
            .unwrap();
        }
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let op = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "Imported title", "created_at": "1", "head_message_id": "m1"}),
        )
        .unwrap();
        let op_id = op.op_id.clone();
        write_ops_file(sync.path(), "remote-device", 1, &[op]);

        let output = import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(output.imported_ops, 1);
        assert_eq!(
            thread_title(home_b.path(), "t1").as_deref(),
            Some("Imported title")
        );
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let columns = table_columns(&conn, "sync_applied_ops").unwrap();
        assert!(!columns.contains("entity_type"));
        assert!(!columns.contains("entity_id"));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sync_applied_ops WHERE op_id = ?1",
                [op_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn dirty_entries_for_deleted_rows_are_cleared() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home_a.path());
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert_eq!(count_dirty(home_a.path()), 0);

        // Insert then delete a row before the next export: the same dirty entry
        // turns into a delete tombstone. That is harmless for peers that never saw
        // the row, and necessary for peers that imported an earlier version.
        insert_message(home_a.path(), "m2", "t1");
        delete_message(home_a.path(), "m2");
        assert_eq!(count_dirty(home_a.path()), 1, "trigger enqueued the insert");

        let out = export_ops(home_a.path(), Some(sync.path())).unwrap();
        assert_eq!(out.exported_ops, 1);
        let delta = read_ops_file(sync.path(), &device, 2);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].kind, "message.archive.delete");
        assert_eq!(delta[0].entity_id, "m2");
        assert_eq!(
            count_dirty(home_a.path()),
            0,
            "exported tombstones must be cleared"
        );
    }

    #[test]
    fn exported_delete_file_remains_v1_readable() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let device = device_id_of(home_a.path());
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        insert_message(home_a.path(), "m2", "t1");
        delete_message(home_a.path(), "m2");
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        let lines = read_op_file_lines(sync.path(), &device, 2);
        assert_eq!(lines.len(), 1);
        let op: SyncOp = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(op.kind, "message.archive.delete");
        assert_eq!(op.entity_id, "m2");
    }

    #[test]
    fn delete_tombstones_are_not_published_to_v1_ops_dir() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home_a.path());
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        insert_message(home_a.path(), "m2", "t1");
        delete_message(home_a.path(), "m2");
        export_ops(home_a.path(), Some(sync.path())).unwrap();

        assert!(
            !device_dir(sync.path(), &device)
                .join("ops")
                .join("0000000000000002.jsonl")
                .exists(),
            "v1 importers must not see delete tombstones as unknown applied ops"
        );
        let lines = fs::read_to_string(
            device_dir(sync.path(), &device)
                .join("ops-v2")
                .join("0000000000000002.jsonl"),
        )
        .unwrap();
        let op: SyncOp = serde_json::from_str(lines.trim()).unwrap();
        assert_eq!(op.kind, "message.archive.delete");
        assert_eq!(op.entity_id, "m2");
    }

    #[test]
    fn delete_tombstone_with_known_v1_peer_uses_v2_ops_dir() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let device_a = device_id_of(home_a.path());
        let device_b = device_id_of(home_b.path());
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        set_manifest_format(sync.path(), &device_b, 1);

        delete_message(home_a.path(), "m1");
        clear_thread_head(home_a.path(), "t1");
        let exported = export_ops(home_a.path(), Some(sync.path())).unwrap();

        assert_eq!(exported.exported_ops, 2);
        assert_eq!(count_dirty(home_a.path()), 0);
        assert!(!device_ops_dir(sync.path(), &device_a, OPS_DIR_V1)
            .join("0000000000000002.jsonl")
            .exists());
        let delta = read_ops_file(sync.path(), &device_a, 2);
        let mut kinds = delta.iter().map(|op| op.kind.as_str()).collect::<Vec<_>>();
        kinds.sort_unstable();
        assert_eq!(
            kinds,
            vec!["message.archive.delete", "thread.archive.delete"]
        );
    }

    #[test]
    fn idle_upgraded_peer_refreshes_manifest_for_delete_tombstones() {
        let sync = tempfile::tempdir().unwrap();
        let home_a = setup_home("config-a");
        let home_b = setup_home("config-b");
        seed_thread(home_a.path(), "t1", "m1");
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();
        let device_a = device_id_of(home_a.path());
        let device_b = device_id_of(home_b.path());
        export_ops(home_a.path(), Some(sync.path())).unwrap();
        export_ops(home_b.path(), Some(sync.path())).unwrap();
        set_manifest_format(sync.path(), &device_b, 1);

        let idle = export_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(idle.exported_ops, 0);
        assert_eq!(
            read_manifest(sync.path(), &device_b)
                .unwrap()
                .format_version,
            FORMAT_VERSION
        );

        delete_message(home_a.path(), "m1");
        clear_thread_head(home_a.path(), "t1");
        let exported = export_ops(home_a.path(), Some(sync.path())).unwrap();

        assert_eq!(exported.exported_ops, 2);
        assert_eq!(count_dirty(home_a.path()), 0);
        let delta = read_ops_file(sync.path(), &device_a, 2);
        let mut kinds = delta.iter().map(|op| op.kind.as_str()).collect::<Vec<_>>();
        kinds.sort_unstable();
        assert_eq!(
            kinds,
            vec!["message.archive.delete", "thread.archive.delete"]
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

    fn config_with_sync_dir(theme_id: &str, sync_dir: &str) -> String {
        format!("[general]\nthemeId = \"{theme_id}\"\n\n[sync]\nsyncDir = \"{sync_dir}\"\n")
    }

    #[test]
    fn settings_sync_dir_is_local_only_on_import() {
        let sync = tempfile::tempdir().unwrap();
        let local_config = config_with_sync_dir("ume", "/local/sync");
        let remote_config = config_with_sync_dir("ume", "/remote/sync");
        let home_a = setup_home(&remote_config);
        let home_b = setup_home(&local_config);
        init_sync(home_a.path(), Some(sync.path()), "A").unwrap();
        init_sync(home_b.path(), Some(sync.path()), "B").unwrap();

        export_ops(home_a.path(), Some(sync.path())).unwrap();
        import_ops(home_b.path(), Some(sync.path())).unwrap();

        assert_eq!(
            fs::read_to_string(home_b.path().join(SETTINGS_FILE)).unwrap(),
            local_config,
            "syncDir is local device configuration and must not be imported"
        );
        let conn = Connection::open(home_b.path().join(DB_FILE)).unwrap();
        let conflicts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(conflicts, 0, "syncDir-only differences must not conflict");
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
    fn export_is_skipped_when_only_sync_dir_changed() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home(&config_with_sync_dir("ume", "/first/sync"));
        init_sync(home.path(), Some(sync.path()), "A").unwrap();
        let device = device_id_of(home.path());

        let first = export_ops(home.path(), Some(sync.path())).unwrap();
        assert!(first.exported_ops >= 1);
        assert_eq!(count_op_files(sync.path(), &device), 1);

        fs::write(
            home.path().join(SETTINGS_FILE),
            config_with_sync_dir("ume", "/second/sync"),
        )
        .unwrap();
        let second = export_ops(home.path(), Some(sync.path())).unwrap();
        assert_eq!(
            second.exported_ops, 0,
            "local syncDir edits must not publish a settings snapshot"
        );
        assert_eq!(count_op_files(sync.path(), &device), 1);
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
        fs::remove_dir_all(device_ops_dir(sync.path(), &device, OPS_DIR_V1)).unwrap();
        fs::remove_dir_all(device_ops_dir(sync.path(), &device, OPS_DIR_V2)).unwrap();
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
    fn orphan_child_op_does_not_block_later_device_files() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-b");
        init_sync(home.path(), Some(sync.path()), "B").unwrap();
        let orphan_op = make_op(
            "remote-device",
            1,
            "message.archive.upsert",
            "message",
            "m1",
            json!({"id": "m1", "thread_id": "deleted-thread", "body": "stale", "created_at": "1"}),
        )
        .unwrap();
        let later_op = make_op(
            "remote-device",
            2,
            "thread.archive.upsert",
            "thread",
            "t2",
            json!({"id": "t2", "title": "Later", "created_at": "2", "head_message_id": null}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[orphan_op]);
        write_ops_file(sync.path(), "remote-device", 2, &[later_op]);

        let output = import_ops(home.path(), Some(sync.path())).unwrap();

        assert_eq!(output.imported_ops, 1);
        assert_eq!(message_body(home.path(), "m1"), None);
        assert_eq!(thread_title(home.path(), "t2").as_deref(), Some("Later"));
    }

    #[test]
    fn unreadable_import_file_blocks_later_files_from_same_device() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-b");
        init_sync(home.path(), Some(sync.path()), "B").unwrap();
        let remote_ops_dir = device_dir(sync.path(), "remote-device").join("ops");
        fs::create_dir_all(remote_ops_dir.join("0000000000000001.jsonl")).unwrap();
        let second_op = make_op(
            "remote-device",
            2,
            "thread.archive.upsert",
            "thread",
            "t2",
            json!({"id": "t2", "title": "Second", "created_at": "2", "head_message_id": null}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 2, &[second_op]);

        let blocked = import_ops(home.path(), Some(sync.path())).unwrap();

        assert_eq!(blocked.imported_ops, 0);
        assert!(
            blocked.last_error.is_some(),
            "unreadable first file should surface a transient import error"
        );
        assert_eq!(thread_title(home.path(), "t2"), None);

        fs::remove_dir_all(remote_ops_dir.join("0000000000000001.jsonl")).unwrap();
        let first_op = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "First", "created_at": "1", "head_message_id": null}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[first_op]);

        let imported = import_ops(home.path(), Some(sync.path())).unwrap();

        assert_eq!(imported.imported_ops, 2);
        assert_eq!(thread_title(home.path(), "t1").as_deref(), Some("First"));
        assert_eq!(thread_title(home.path(), "t2").as_deref(), Some("Second"));
    }

    #[test]
    fn metadata_backfill_does_not_parse_later_ineligible_file() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config-b");
        init_sync(home.path(), Some(sync.path()), "B").unwrap();
        let conn = Connection::open(home.path().join(DB_FILE)).unwrap();
        conn.execute(
            "INSERT INTO sync_applied_ops (op_id, device_id, seq, applied_at) VALUES ('legacy-missing', 'remote-device', 0, 'old')",
            [],
        )
        .unwrap();
        let first_op = make_op(
            "remote-device",
            1,
            "thread.archive.upsert",
            "thread",
            "t1",
            json!({"id": "t1", "title": "First", "created_at": "1", "head_message_id": null}),
        )
        .unwrap();
        write_ops_file(sync.path(), "remote-device", 1, &[first_op]);
        let later_path = device_dir(sync.path(), "remote-device")
            .join("ops")
            .join("0000000000000002.jsonl");
        fs::write(later_path, "{not-json\n").unwrap();

        let output = import_ops(home.path(), Some(sync.path())).unwrap();

        assert_eq!(output.imported_ops, 1);
        assert!(
            output.last_error.is_some(),
            "the later truncated file should be reported as transient"
        );
        assert_eq!(thread_title(home.path(), "t1").as_deref(), Some("First"));
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

    #[test]
    fn export_strips_response_messages_but_keeps_display_columns() {
        let sync = tempfile::tempdir().unwrap();
        let home = setup_home("config");
        {
            let conn = Connection::open(home.path().join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, created_at, head_message_id) VALUES ('t1','Hello','1','m1')",
                [],
            )
            .unwrap();
            // Message carries the heavy run-only columns plus a normal display column.
            conn.execute(
                "INSERT INTO messages (id, thread_id, body, created_at, response_messages, turn_context) VALUES ('m1','t1','hi','1',?1,?2)",
                params![r#"[{"role":"assistant","huge":"payload"}]"#, r#"{"hint":"x"}"#],
            )
            .unwrap();
        }
        init_sync(home.path(), Some(sync.path()), "A").unwrap();
        export_ops(home.path(), Some(sync.path())).unwrap();

        let device = device_id_of(home.path());
        let mut message_op_seen = false;
        for ops_dir in [OPS_DIR_V1, OPS_DIR_V2] {
            let ops_dir = device_ops_dir(sync.path(), &device, ops_dir);
            if !ops_dir.exists() {
                continue;
            }
            for entry in fs::read_dir(&ops_dir).unwrap() {
                let path = entry.unwrap().path();
                if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                for line in fs::read_to_string(&path).unwrap().lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let op: SyncOp = serde_json::from_str(line).unwrap();
                    if op.kind == "message.archive.upsert" && op.entity_id == "m1" {
                        message_op_seen = true;
                        let obj = op.payload.as_object().unwrap();
                        assert!(
                            !obj.contains_key("response_messages"),
                            "response_messages (raw transcript) must be stripped from the export"
                        );
                        assert_eq!(
                            obj.get("turn_context").and_then(|v| v.as_str()),
                            Some(r#"{"hint":"x"}"#),
                            "turn_context must be KEPT (drives timeline grouping on archives)"
                        );
                        assert_eq!(
                            obj.get("body").and_then(|v| v.as_str()),
                            Some("hi"),
                            "display columns must survive the strip"
                        );
                    }
                }
            }
        }
        assert!(message_op_seen, "the message op should have been exported");
    }
}
