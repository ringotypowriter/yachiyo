use super::{atomic_write_bytes, get_meta, hash_value, make_op, now, set_meta, SyncError, SyncOp};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

const META_EXPORT_MANIFEST: &str = "skills_export_manifest";
const META_EXECUTABLE_MANIFEST: &str = "skills_executable_manifest";
const META_EXPORT_GENERATIONS: &str = "skills_export_generations";
const META_PENDING_UPSERTS: &str = "skills_pending_upserts";
const META_EXPORT_TOMBSTONES: &str = "skills_export_tombstones";
const META_PENDING_TOMBSTONES: &str = "skills_pending_tombstones";
const META_RETIRED_TOMBSTONES: &str = "skills_retired_tombstones";
const META_DISCLOSURE: &str = "skills_disclosure_v1";
const MISSING_HASH: &str = "missing";

struct SkillFileSnapshot {
    bytes: Vec<u8>,
    executable: bool,
    hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillUpsertState {
    generation_id: String,
    base_hash: String,
    recovery_base_hash: Option<String>,
    #[serde(default)]
    retired_tombstone_ids: BTreeSet<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillTombstoneTarget {
    base_generation_id: String,
    base_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillTombstone {
    generation_id: String,
    base_generation_id: String,
    base_hash: String,
}

type SkillGenerationMap = BTreeMap<String, String>;
type PendingSkillUpsertMap = BTreeMap<String, SkillUpsertState>;
pub(super) type SkillTombstoneMap = BTreeMap<String, BTreeMap<String, SkillTombstoneTarget>>;
type RetiredSkillTombstoneMap = BTreeMap<String, BTreeSet<String>>;

pub(super) struct SkillExportPlan {
    pub(super) ops: Vec<SyncOp>,
    pub(super) manifest: BTreeMap<String, String>,
    pub(super) executable_manifest: BTreeMap<String, bool>,
    pub(super) generations: SkillGenerationMap,
    pub(super) pending_upserts: PendingSkillUpsertMap,
    pub(super) tombstones: SkillTombstoneMap,
    pub(super) pending_tombstones: SkillTombstoneMap,
    pub(super) retired_tombstones: RetiredSkillTombstoneMap,
}

enum CustomSkillChange {
    Upsert { bytes: Vec<u8>, executable: bool },
    Delete,
}

struct ParsedCustomSkillOp {
    relative: String,
    base_hash: String,
    recovery_base_hash: Option<String>,
    remote_hash: String,
    upsert_generation_id: Option<String>,
    delete_tombstones: BTreeMap<String, SkillTombstoneTarget>,
    retired_tombstone_ids: BTreeSet<String>,
    change: CustomSkillChange,
}

fn validated_root(home: &Path) -> Result<PathBuf, SyncError> {
    let skills = home.join("skills");
    let custom = skills.join("custom");
    for path in [&skills, &custom] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(SyncError::Message(format!(
                    "custom skills root crosses a non-directory or symlink: {}",
                    path.display()
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(SyncError::Io(error)),
        }
    }
    Ok(custom)
}

fn hash_file(bytes: &[u8], executable: bool) -> String {
    let mut digest = Sha256::new();
    digest.update([u8::from(executable)]);
    digest.update(bytes);
    format!("sha256:{:x}", digest.finalize())
}

fn select_executable(
    filesystem_supports_executable: bool,
    filesystem_value: bool,
    synced_value: Option<bool>,
) -> bool {
    if filesystem_supports_executable {
        filesystem_value
    } else {
        synced_value.unwrap_or(false)
    }
}

fn portable_path_key(component: &str) -> String {
    component.to_lowercase().nfc().collect()
}

fn portable_components_collide(existing: &str, incoming: &str) -> bool {
    existing != incoming && portable_path_key(existing) == portable_path_key(incoming)
}

fn validate_casefolded_paths<'a>(
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<(), SyncError> {
    let mut seen = BTreeMap::<String, String>::new();
    for path in paths {
        let mut original_prefix = String::new();
        let mut folded_prefix = String::new();
        for component in path.split('/') {
            if !original_prefix.is_empty() {
                original_prefix.push('/');
                folded_prefix.push('/');
            }
            original_prefix.push_str(component);
            folded_prefix.push_str(&portable_path_key(component));
            if let Some(existing) = seen.get(&folded_prefix) {
                if existing != &original_prefix {
                    return Err(SyncError::Message(format!(
                        "custom skill path prefixes differ only by case: {existing} and {original_prefix}"
                    )));
                }
            } else {
                seen.insert(folded_prefix.clone(), original_prefix.clone());
            }
        }
    }
    Ok(())
}

fn scan(
    home: &Path,
    executable_manifest: &BTreeMap<String, bool>,
) -> Result<BTreeMap<String, SkillFileSnapshot>, SyncError> {
    fn visit(
        root: &Path,
        directory: &Path,
        executable_manifest: &BTreeMap<String, bool>,
        files: &mut BTreeMap<String, SkillFileSnapshot>,
    ) -> Result<(), SyncError> {
        if !directory.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".DS_Store" || name == ".git" || name == "node_modules" {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                visit(root, &path, executable_manifest, files)?;
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = path.strip_prefix(root).map_err(|_| {
                SyncError::Message(format!(
                    "custom skill path escaped its root: {}",
                    path.display()
                ))
            })?;
            let relative = relative
                .components()
                .map(|component| {
                    component.as_os_str().to_str().ok_or_else(|| {
                        SyncError::Message(format!(
                            "custom skill path is not valid UTF-8: {}",
                            path.display()
                        ))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            validate_relative_path(&relative)?;
            #[cfg(unix)]
            let filesystem_executable = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let filesystem_executable = false;
            let executable = select_executable(
                cfg!(unix),
                filesystem_executable,
                executable_manifest.get(&relative).copied(),
            );
            let bytes = fs::read(&path)?;
            files.insert(
                relative,
                SkillFileSnapshot {
                    hash: hash_file(&bytes, executable),
                    bytes,
                    executable,
                },
            );
        }
        Ok(())
    }

    let root = validated_root(home)?;
    let mut files = BTreeMap::new();
    visit(&root, &root, executable_manifest, &mut files)?;
    validate_casefolded_paths(files.keys().map(String::as_str))?;
    Ok(files)
}

fn load_manifest(conn: &Connection) -> Result<BTreeMap<String, String>, SyncError> {
    match get_meta(conn, META_EXPORT_MANIFEST)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn load_executable_manifest(conn: &Connection) -> Result<BTreeMap<String, bool>, SyncError> {
    match get_meta(conn, META_EXECUTABLE_MANIFEST)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn load_generations(conn: &Connection) -> Result<SkillGenerationMap, SyncError> {
    match get_meta(conn, META_EXPORT_GENERATIONS)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn load_pending_upserts(conn: &Connection) -> Result<PendingSkillUpsertMap, SyncError> {
    match get_meta(conn, META_PENDING_UPSERTS)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn load_tombstones(conn: &Connection) -> Result<SkillTombstoneMap, SyncError> {
    match get_meta(conn, META_EXPORT_TOMBSTONES)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn load_pending_tombstones(conn: &Connection) -> Result<SkillTombstoneMap, SyncError> {
    match get_meta(conn, META_PENDING_TOMBSTONES)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn load_retired_tombstones(conn: &Connection) -> Result<RetiredSkillTombstoneMap, SyncError> {
    match get_meta(conn, META_RETIRED_TOMBSTONES)? {
        Some(text) => Ok(serde_json::from_str(&text)?),
        None => Ok(BTreeMap::new()),
    }
}

fn update_tombstone_entry(
    conn: &Connection,
    path: &str,
    candidates: &BTreeMap<String, SkillTombstoneTarget>,
) -> Result<(), SyncError> {
    let mut tombstones = load_tombstones(conn)?;
    let mut pending_tombstones = load_pending_tombstones(conn)?;
    let retired_tombstones = load_retired_tombstones(conn)?;
    let retired = retired_tombstones.get(path);
    let active = tombstones.entry(path.to_string()).or_default();
    let newly_seen = candidates
        .iter()
        .filter(|(generation_id, target)| {
            target.base_hash != MISSING_HASH
                && retired.is_none_or(|known| !known.contains(*generation_id))
                && !active.contains_key(*generation_id)
        })
        .map(|(generation_id, target)| (generation_id.clone(), target.clone()))
        .collect::<BTreeMap<_, _>>();
    if newly_seen.is_empty() {
        return Ok(());
    }
    active.extend(
        newly_seen
            .iter()
            .map(|(id, target)| (id.clone(), target.clone())),
    );
    pending_tombstones
        .entry(path.to_string())
        .or_default()
        .extend(newly_seen);
    save_export_tombstone_state(conn, &tombstones, &pending_tombstones, &retired_tombstones)
}

fn retire_tombstone_entries(
    conn: &Connection,
    path: &str,
    generation_ids: &BTreeSet<String>,
) -> Result<(), SyncError> {
    if generation_ids.is_empty() {
        return Ok(());
    }
    let mut tombstones = load_tombstones(conn)?;
    let mut pending_tombstones = load_pending_tombstones(conn)?;
    let mut retired_tombstones = load_retired_tombstones(conn)?;
    if let Some(active) = tombstones.get_mut(path) {
        active.retain(|generation_id, _| !generation_ids.contains(generation_id));
        if active.is_empty() {
            tombstones.remove(path);
        }
    }
    if let Some(pending) = pending_tombstones.get_mut(path) {
        pending.retain(|generation_id, _| !generation_ids.contains(generation_id));
        if pending.is_empty() {
            pending_tombstones.remove(path);
        }
    }
    retired_tombstones
        .entry(path.to_string())
        .or_default()
        .extend(generation_ids.iter().cloned());
    save_export_tombstone_state(conn, &tombstones, &pending_tombstones, &retired_tombstones)
}

fn adopt_absent_delete(
    conn: &Connection,
    path: &str,
    tombstones: &BTreeMap<String, SkillTombstoneTarget>,
) -> Result<(), SyncError> {
    remove_manifest_entry(conn, path)?;
    update_tombstone_entry(conn, path, tombstones)
}

pub(super) fn save_export_upsert_state(
    conn: &Connection,
    generations: &SkillGenerationMap,
    pending_upserts: &PendingSkillUpsertMap,
) -> Result<(), SyncError> {
    set_meta(
        conn,
        META_EXPORT_GENERATIONS,
        &serde_json::to_string(generations)?,
    )?;
    set_meta(
        conn,
        META_PENDING_UPSERTS,
        &serde_json::to_string(pending_upserts)?,
    )
}

pub(super) fn save_export_tombstone_state(
    conn: &Connection,
    tombstones: &SkillTombstoneMap,
    pending_tombstones: &SkillTombstoneMap,
    retired_tombstones: &RetiredSkillTombstoneMap,
) -> Result<(), SyncError> {
    set_meta(
        conn,
        META_EXPORT_TOMBSTONES,
        &serde_json::to_string(tombstones)?,
    )?;
    set_meta(
        conn,
        META_PENDING_TOMBSTONES,
        &serde_json::to_string(pending_tombstones)?,
    )?;
    set_meta(
        conn,
        META_RETIRED_TOMBSTONES,
        &serde_json::to_string(retired_tombstones)?,
    )
}

pub(super) fn save_export_state(
    conn: &Connection,
    manifest: &BTreeMap<String, String>,
    executable_manifest: &BTreeMap<String, bool>,
) -> Result<(), SyncError> {
    set_meta(
        conn,
        META_EXPORT_MANIFEST,
        &serde_json::to_string(manifest)?,
    )?;
    set_meta(
        conn,
        META_EXECUTABLE_MANIFEST,
        &serde_json::to_string(executable_manifest)?,
    )
}

pub(super) fn plan_export(
    home: &Path,
    conn: &Connection,
    device_id: &str,
    seq: i64,
    full_resync: bool,
) -> Result<SkillExportPlan, SyncError> {
    let previous = load_manifest(conn)?;
    let previous_executable = load_executable_manifest(conn)?;
    let previous_generations = load_generations(conn)?;
    let mut pending_upserts = load_pending_upserts(conn)?;
    let current = scan(home, &previous_executable)?;
    let mut tombstones = load_tombstones(conn)?;
    let mut pending_tombstones = load_pending_tombstones(conn)?;
    let mut retired_tombstones = load_retired_tombstones(conn)?;
    let manifest = current
        .iter()
        .map(|(path, snapshot)| (path.clone(), snapshot.hash.clone()))
        .collect::<BTreeMap<_, _>>();
    let executable_manifest = current
        .iter()
        .map(|(path, snapshot)| (path.clone(), snapshot.executable))
        .collect::<BTreeMap<_, _>>();
    let mut generations = BTreeMap::new();
    let mut ops = Vec::new();
    let mut deletions = if full_resync {
        tombstones.clone()
    } else {
        pending_tombstones.clone()
    };
    // Structural conversions need their old leaves removed before new parents or
    // children are created (file -> directory and directory -> file).
    for (path, previous_hash) in &previous {
        if current.contains_key(path) {
            continue;
        }
        let base_generation_id = previous_generations.get(path).ok_or_else(|| {
            SyncError::Message(format!(
                "custom skill {path} has no persisted upsert generation"
            ))
        })?;
        let generation_id = uuid::Uuid::new_v4().to_string();
        deletions.entry(path.clone()).or_default().insert(
            generation_id.clone(),
            SkillTombstoneTarget {
                base_generation_id: base_generation_id.clone(),
                base_hash: previous_hash.clone(),
            },
        );
        tombstones.entry(path.clone()).or_default().insert(
            generation_id,
            SkillTombstoneTarget {
                base_generation_id: base_generation_id.clone(),
                base_hash: previous_hash.clone(),
            },
        );
        pending_upserts.remove(path);
    }
    for (path, candidates) in &deletions {
        let first_target = candidates
            .values()
            .next()
            .expect("skill tombstone candidates must not be empty");
        let tombstone_payload = candidates
            .iter()
            .map(|(generation_id, target)| SkillTombstone {
                generation_id: generation_id.clone(),
                base_generation_id: target.base_generation_id.clone(),
                base_hash: target.base_hash.clone(),
            })
            .collect::<Vec<_>>();
        ops.push(make_op(
            device_id,
            seq,
            "skill.file.delete",
            "skill",
            path,
            json!({
                "path": path,
                "deleted": true,
                "baseHash": first_target.base_hash,
                "tombstones": tombstone_payload,
                "contentHash": MISSING_HASH,
            }),
        )?);
    }
    for path in deletions.keys() {
        pending_tombstones.remove(path);
    }
    for (path, snapshot) in &current {
        let locally_changed =
            previous.get(path) != Some(&snapshot.hash) || !previous_generations.contains_key(path);
        let mut retired_on_upsert = retired_tombstones.get(path).cloned().unwrap_or_default();
        let generation_id = if locally_changed {
            uuid::Uuid::new_v4().to_string()
        } else {
            previous_generations
                .get(path)
                .expect("unchanged custom skill must have an upsert generation")
                .clone()
        };
        generations.insert(path.clone(), generation_id.clone());
        if locally_changed {
            let generation_ids = tombstones
                .remove(path)
                .map(|active| active.into_keys().collect::<BTreeSet<_>>())
                .unwrap_or_default();
            if let Some(pending) = pending_tombstones.get_mut(path) {
                pending.retain(|generation_id, _| !generation_ids.contains(generation_id));
                if pending.is_empty() {
                    pending_tombstones.remove(path);
                }
            }
            retired_tombstones
                .entry(path.clone())
                .or_default()
                .extend(generation_ids.iter().cloned());
            retired_on_upsert.extend(generation_ids);
            pending_upserts.remove(path);
        } else if let Some(pending) = pending_upserts.get(path) {
            if pending.generation_id == generation_id {
                retired_on_upsert.extend(pending.retired_tombstone_ids.iter().cloned());
            }
        }
        let pending_relay = pending_upserts
            .get(path)
            .is_some_and(|pending| pending.generation_id == generation_id);
        if !full_resync && !locally_changed && !pending_relay {
            continue;
        }
        let previous_hash = previous.get(path).map(String::as_str);
        let (base_hash, recovery_base_hash) = if full_resync {
            (MISSING_HASH, previous_hash)
        } else if pending_relay {
            let pending = pending_upserts
                .get(path)
                .expect("pending relay must have upsert state");
            (
                pending.base_hash.as_str(),
                pending.recovery_base_hash.as_deref(),
            )
        } else {
            (previous_hash.unwrap_or(MISSING_HASH), None)
        };
        ops.push(make_op(
            device_id,
            seq,
            "skill.file.upsert",
            "skill",
            path,
            json!({
                "path": path,
                "generationId": generation_id,
                "encoding": "base64",
                "content": BASE64.encode(&snapshot.bytes),
                "executable": snapshot.executable,
                "baseHash": base_hash,
                "recoveryBaseHash": recovery_base_hash,
                "retiredTombstoneIds": retired_on_upsert,
                "contentHash": snapshot.hash,
            }),
        )?);
        pending_upserts.remove(path);
    }
    Ok(SkillExportPlan {
        ops,
        manifest,
        executable_manifest,
        generations,
        pending_upserts,
        tombstones,
        pending_tombstones,
        retired_tombstones,
    })
}

pub(super) fn needs_disclosure(conn: &Connection) -> Result<bool, SyncError> {
    Ok(get_meta(conn, META_DISCLOSURE)?.as_deref() != Some("shown"))
}

pub(super) fn mark_disclosure_shown(conn: &Connection) -> Result<(), SyncError> {
    set_meta(conn, META_DISCLOSURE, "shown")
}

fn validate_relative_path(relative: &str) -> Result<(), SyncError> {
    fn invalid_component(component: &str) -> bool {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with([' ', '.'])
            || component.chars().any(|character| {
                character <= '\u{1f}'
                    || matches!(character, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')
            })
        {
            return true;
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or(component)
            .to_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$") {
            return true;
        }
        ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    }

    if relative.is_empty()
        || relative.starts_with('/')
        || relative.ends_with('/')
        || relative.split('/').any(invalid_component)
    {
        return Err(SyncError::Message(format!(
            "invalid custom skill path: {relative}"
        )));
    }
    Ok(())
}

fn local_hash(path: &Path, synced_executable: Option<bool>) -> Result<String, SyncError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MISSING_HASH.to_string())
        }
        Err(error) => return Err(SyncError::Io(error)),
    };
    if metadata.file_type().is_symlink() {
        return Ok("local:symlink".to_string());
    }
    if !metadata.is_file() {
        return Ok("local:non-file".to_string());
    }
    #[cfg(unix)]
    let filesystem_executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let filesystem_executable = false;
    let executable = select_executable(cfg!(unix), filesystem_executable, synced_executable);
    Ok(hash_file(&fs::read(path)?, executable))
}

fn blocking_parent(root: &Path, target: &Path) -> Result<Option<PathBuf>, SyncError> {
    if let Ok(metadata) = fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(SyncError::Message(format!(
                "custom skills root is not a real directory: {}",
                root.display()
            )));
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| SyncError::Message("custom skill path has no parent".to_string()))?;
    let relative_parent = parent.strip_prefix(root).map_err(|_| {
        SyncError::Message(format!(
            "custom skill path escaped its root: {}",
            target.display()
        ))
    })?;
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Ok(Some(current))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(SyncError::Io(error)),
        }
    }
    Ok(None)
}

fn case_colliding_prefix(root: &Path, relative: &str) -> Result<Option<PathBuf>, SyncError> {
    let mut current = root.to_path_buf();
    for component in relative.split('/') {
        let mut exact = None;
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.kind() == std::io::ErrorKind::NotADirectory =>
            {
                return Ok(None)
            }
            Err(error) => return Err(SyncError::Io(error)),
        };
        for entry in entries {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name == component {
                exact = Some(entry.path());
            } else if portable_components_collide(&name, component) {
                return Ok(Some(entry.path()));
            }
        }
        let Some(next) = exact else {
            return Ok(None);
        };
        current = next;
    }
    Ok(None)
}

fn remove_blocker(path: &Path) -> Result<(), SyncError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn write_file(
    root: &Path,
    target: &Path,
    bytes: &[u8],
    executable: bool,
    replace_non_file: bool,
) -> Result<(), SyncError> {
    if let Some(blocker) = blocking_parent(root, target)? {
        if !replace_non_file {
            return Err(SyncError::Message(format!(
                "custom skill parent is not a directory: {}",
                blocker.display()
            )));
        }
        remove_blocker(&blocker)?;
    }
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| SyncError::Message("custom skill path has no parent".to_string()))?,
    )?;
    if let Ok(metadata) = fs::symlink_metadata(target) {
        if metadata.file_type().is_symlink() {
            if !replace_non_file {
                return Err(SyncError::Message(format!(
                    "custom skill target is a symlink: {}",
                    target.display()
                )));
            }
            fs::remove_file(target)?;
        } else if metadata.is_dir() {
            if !replace_non_file {
                return Err(SyncError::Message(format!(
                    "custom skill target is a directory: {}",
                    target.display()
                )));
            }
            fs::remove_dir_all(target)?;
        }
    }
    atomic_write_bytes(target, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            target,
            fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
        )?;
    }
    Ok(())
}

fn prune_empty_directories(root: &Path, start: &Path) -> Result<(), SyncError> {
    let mut current = start.to_path_buf();
    while current != root {
        match fs::remove_dir(&current) {
            Ok(()) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::DirectoryNotEmpty
                    || error.kind() == std::io::ErrorKind::NotFound =>
            {
                break
            }
            Err(error) => return Err(SyncError::Io(error)),
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent.to_path_buf();
    }
    Ok(())
}

fn adopt_upsert_entry(
    conn: &Connection,
    executable: bool,
    parsed: &ParsedCustomSkillOp,
) -> Result<(), SyncError> {
    let path = &parsed.relative;
    let hash = &parsed.remote_hash;
    let generation_id = parsed
        .upsert_generation_id
        .as_deref()
        .expect("parsed upsert must have a generation id");
    let mut manifest = load_manifest(conn)?;
    let mut executable_manifest = load_executable_manifest(conn)?;
    let mut generations = load_generations(conn)?;
    let mut pending_upserts = load_pending_upserts(conn)?;
    if generations
        .get(path)
        .is_some_and(|known| known == generation_id)
    {
        if manifest.get(path).is_some_and(|known| known != hash) {
            return Err(SyncError::Message(format!(
                "custom skill upsert generation changed content: {generation_id}"
            )));
        }
    } else {
        pending_upserts.insert(
            path.to_string(),
            SkillUpsertState {
                generation_id: generation_id.to_string(),
                base_hash: MISSING_HASH.to_string(),
                recovery_base_hash: parsed
                    .recovery_base_hash
                    .as_deref()
                    .or_else(|| {
                        (parsed.base_hash != MISSING_HASH).then_some(parsed.base_hash.as_str())
                    })
                    .map(str::to_string),
                retired_tombstone_ids: parsed.retired_tombstone_ids.clone(),
            },
        );
    }
    manifest.insert(path.to_string(), hash.to_string());
    executable_manifest.insert(path.to_string(), executable);
    generations.insert(path.to_string(), generation_id.to_string());
    save_export_state(conn, &manifest, &executable_manifest)?;
    save_export_upsert_state(conn, &generations, &pending_upserts)
}

fn remove_manifest_entry(conn: &Connection, path: &str) -> Result<(), SyncError> {
    let mut manifest = load_manifest(conn)?;
    let mut executable_manifest = load_executable_manifest(conn)?;
    let mut generations = load_generations(conn)?;
    let mut pending_upserts = load_pending_upserts(conn)?;
    manifest.remove(path);
    executable_manifest.remove(path);
    generations.remove(path);
    pending_upserts.remove(path);
    save_export_state(conn, &manifest, &executable_manifest)?;
    save_export_upsert_state(conn, &generations, &pending_upserts)
}

fn rebase_manifest_entry(
    conn: &Connection,
    path: &str,
    hash: &str,
    generation_id: Option<&str>,
) -> Result<(), SyncError> {
    let mut manifest = load_manifest(conn)?;
    manifest.insert(path.to_string(), hash.to_string());
    let executable_manifest = load_executable_manifest(conn)?;
    let mut generations = load_generations(conn)?;
    let mut pending_upserts = load_pending_upserts(conn)?;
    match generation_id {
        Some(generation_id) => {
            generations.insert(path.to_string(), generation_id.to_string());
        }
        None => {
            generations.remove(path);
        }
    }
    pending_upserts.remove(path);
    save_export_state(conn, &manifest, &executable_manifest)?;
    save_export_upsert_state(conn, &generations, &pending_upserts)
}

fn record_conflict(
    conn: &Connection,
    op: &SyncOp,
    local_hash: &str,
    remote_hash: &str,
) -> Result<(), SyncError> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_conflicts (id, op_id, device_id, entity_type, entity_id, local_hash, remote_hash, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![uuid::Uuid::new_v4().to_string(), op.op_id, op.device_id, op.entity_type, op.entity_id, local_hash, remote_hash, serde_json::to_string(&op.payload)?, now()],
    )?;
    Ok(())
}

fn supersede_older_conflicts(conn: &Connection, op: &SyncOp) -> Result<(), SyncError> {
    conn.execute(
        "UPDATE sync_conflicts
         SET resolved_at = ?1, resolution = 'superseded'
         WHERE resolved_at IS NULL
           AND device_id = ?2
           AND entity_type = 'skill'
           AND entity_id = ?3
           AND op_id IN (
             SELECT op_id FROM sync_applied_ops WHERE device_id = ?2 AND seq < ?4
           )",
        params![now(), op.device_id, op.entity_id, op.seq],
    )?;
    Ok(())
}

fn supersede_targeted_upsert_conflicts(
    conn: &Connection,
    path: &str,
    base_generation_ids: &BTreeSet<String>,
) -> Result<(), SyncError> {
    if base_generation_ids.is_empty() {
        return Ok(());
    }
    let mut statement = conn.prepare(
        "SELECT id, payload_json FROM sync_conflicts
         WHERE resolved_at IS NULL AND entity_type = 'skill' AND entity_id = ?1",
    )?;
    let rows = statement
        .query_map([path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut conflict_ids = Vec::new();
    for (conflict_id, payload_json) in rows {
        let payload: Value = serde_json::from_str(&payload_json)?;
        if payload
            .get("generationId")
            .and_then(Value::as_str)
            .is_some_and(|generation_id| base_generation_ids.contains(generation_id))
        {
            conflict_ids.push(conflict_id);
        }
    }
    let resolved_at = now();
    for conflict_id in conflict_ids {
        conn.execute(
            "UPDATE sync_conflicts SET resolved_at = ?2, resolution = 'superseded'
             WHERE id = ?1 AND resolved_at IS NULL",
            params![conflict_id, resolved_at],
        )?;
    }
    Ok(())
}

fn upsert_generation_is_deleted(
    conn: &Connection,
    path: &str,
    generation_id: &str,
) -> Result<bool, SyncError> {
    Ok(load_tombstones(conn)?.get(path).is_some_and(|tombstones| {
        tombstones
            .values()
            .any(|target| target.base_generation_id == generation_id)
    }))
}

fn upsert_generation_is_current(
    conn: &Connection,
    path: &str,
    generation_id: &str,
    remote_hash: &str,
) -> Result<bool, SyncError> {
    if load_generations(conn)?.get(path).map(String::as_str) != Some(generation_id) {
        return Ok(false);
    }
    let known_hash = load_manifest(conn)?.get(path).cloned().ok_or_else(|| {
        SyncError::Message(format!(
            "custom skill upsert generation has no manifest entry: {generation_id}"
        ))
    })?;
    if known_hash != remote_hash {
        return Err(SyncError::Message(format!(
            "custom skill upsert generation changed content: {generation_id}"
        )));
    }
    Ok(true)
}

fn parse_op(op: &SyncOp) -> Result<ParsedCustomSkillOp, SyncError> {
    if op.entity_type != "skill" {
        return Err(SyncError::Message(
            "custom skill op has the wrong entity type".to_string(),
        ));
    }
    let relative = op
        .payload
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| SyncError::Message("custom skill op has no path".to_string()))?;
    validate_relative_path(relative)?;
    if relative != op.entity_id {
        return Err(SyncError::Message(
            "custom skill payload path does not match its entity id".to_string(),
        ));
    }
    let base_hash = op
        .payload
        .get("baseHash")
        .and_then(Value::as_str)
        .ok_or_else(|| SyncError::Message("custom skill op has no base hash".to_string()))?;
    let recovery_base_hash = op
        .payload
        .get("recoveryBaseHash")
        .and_then(Value::as_str)
        .map(str::to_string);
    let remote_hash = op
        .payload
        .get("contentHash")
        .and_then(Value::as_str)
        .ok_or_else(|| SyncError::Message("custom skill op has no content hash".to_string()))?;
    let mut upsert_generation_id = None;
    let mut delete_tombstones = BTreeMap::new();
    let mut retired_tombstone_ids = BTreeSet::new();
    let change = if op.kind == "skill.file.upsert" {
        let generation_id = op
            .payload
            .get("generationId")
            .and_then(Value::as_str)
            .filter(|generation_id| !generation_id.is_empty())
            .ok_or_else(|| {
                SyncError::Message("custom skill upsert has no generation id".to_string())
            })?;
        upsert_generation_id = Some(generation_id.to_string());
        if op.payload.get("encoding").and_then(Value::as_str) != Some("base64") {
            return Err(SyncError::Message(
                "custom skill content must use base64 encoding".to_string(),
            ));
        }
        let content = op
            .payload
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| SyncError::Message("custom skill op has no content".to_string()))?;
        let bytes = BASE64.decode(content).map_err(|error| {
            SyncError::Message(format!("custom skill content is not valid base64: {error}"))
        })?;
        let executable = op
            .payload
            .get("executable")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                SyncError::Message("custom skill op has no executable flag".to_string())
            })?;
        if hash_file(&bytes, executable) != remote_hash {
            return Err(SyncError::Message(
                "custom skill content hash does not match its payload".to_string(),
            ));
        }
        if let Some(value) = op.payload.get("retiredTombstoneIds") {
            let ids = value.as_array().ok_or_else(|| {
                SyncError::Message("custom skill retired tombstones are invalid".to_string())
            })?;
            for id in ids {
                let id = id.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
                    SyncError::Message("custom skill retired tombstones are invalid".to_string())
                })?;
                retired_tombstone_ids.insert(id.to_string());
            }
        }
        CustomSkillChange::Upsert { bytes, executable }
    } else if op.kind == "skill.file.delete" {
        if op.payload.get("deleted").and_then(Value::as_bool) != Some(true)
            || remote_hash != MISSING_HASH
            || base_hash == MISSING_HASH
        {
            return Err(SyncError::Message(
                "custom skill delete payload is invalid".to_string(),
            ));
        }
        let value = op.payload.get("tombstones").ok_or_else(|| {
            SyncError::Message("custom skill delete has no tombstones".to_string())
        })?;
        let tombstones: Vec<SkillTombstone> = serde_json::from_value(value.clone())?;
        for tombstone in tombstones {
            if tombstone.generation_id.is_empty()
                || tombstone.base_generation_id.is_empty()
                || tombstone.base_hash == MISSING_HASH
            {
                return Err(SyncError::Message(
                    "custom skill delete tombstones are invalid".to_string(),
                ));
            }
            let target = SkillTombstoneTarget {
                base_generation_id: tombstone.base_generation_id,
                base_hash: tombstone.base_hash,
            };
            if delete_tombstones
                .insert(tombstone.generation_id, target.clone())
                .is_some_and(|existing| {
                    existing.base_generation_id != target.base_generation_id
                        || existing.base_hash != target.base_hash
                })
            {
                return Err(SyncError::Message(
                    "custom skill delete tombstone generation is ambiguous".to_string(),
                ));
            }
        }
        if !delete_tombstones
            .values()
            .any(|target| target.base_hash == base_hash)
        {
            return Err(SyncError::Message(
                "custom skill delete base hash has no tombstone".to_string(),
            ));
        }
        CustomSkillChange::Delete
    } else {
        return Err(SyncError::Message(format!(
            "unsupported custom skill op kind: {}",
            op.kind
        )));
    };
    Ok(ParsedCustomSkillOp {
        relative: relative.to_string(),
        base_hash: base_hash.to_string(),
        recovery_base_hash,
        remote_hash: remote_hash.to_string(),
        upsert_generation_id,
        delete_tombstones,
        retired_tombstone_ids,
        change,
    })
}

pub(super) fn apply(home: &Path, conn: &Connection, op: &SyncOp) -> Result<(), SyncError> {
    apply_with_policy(home, conn, op, false)
}

fn apply_with_policy(
    home: &Path,
    conn: &Connection,
    op: &SyncOp,
    force_remote: bool,
) -> Result<(), SyncError> {
    let mut parsed = parse_op(op)?;
    supersede_older_conflicts(conn, op)?;
    if matches!(&parsed.change, CustomSkillChange::Delete) {
        let base_generation_ids = parsed
            .delete_tombstones
            .values()
            .map(|target| target.base_generation_id.clone())
            .collect::<BTreeSet<_>>();
        supersede_targeted_upsert_conflicts(conn, &parsed.relative, &base_generation_ids)?;
        if let Some(retired) = load_retired_tombstones(conn)?.get(&parsed.relative) {
            parsed
                .delete_tombstones
                .retain(|generation_id, _| !retired.contains(generation_id));
        }
        if parsed.delete_tombstones.is_empty() {
            return Ok(());
        }
    } else {
        let generation_id = parsed
            .upsert_generation_id
            .as_deref()
            .expect("parsed upsert must have a generation id");
        if upsert_generation_is_current(conn, &parsed.relative, generation_id, &parsed.remote_hash)?
        {
            retire_tombstone_entries(conn, &parsed.relative, &parsed.retired_tombstone_ids)?;
            return Ok(());
        }
        if upsert_generation_is_deleted(conn, &parsed.relative, generation_id)? {
            return Ok(());
        }
    }
    let root = validated_root(home)?;
    let path = root.join(&parsed.relative);
    if let Some(collision) = case_colliding_prefix(&root, &parsed.relative)? {
        if matches!(&parsed.change, CustomSkillChange::Delete) {
            adopt_absent_delete(conn, &parsed.relative, &parsed.delete_tombstones)?;
            return Ok(());
        }
        if !force_remote {
            record_conflict(conn, op, "local:path-case-collision", &parsed.remote_hash)?;
            return Ok(());
        }
        remove_blocker(&collision)?;
    }
    if let Some(blocker) = blocking_parent(&root, &path)? {
        if matches!(&parsed.change, CustomSkillChange::Delete) {
            adopt_absent_delete(conn, &parsed.relative, &parsed.delete_tombstones)?;
            return Ok(());
        }
        if !force_remote {
            record_conflict(conn, op, "local:path-blocked", &parsed.remote_hash)?;
            return Ok(());
        }
        remove_blocker(&blocker)?;
    }
    let executable_manifest = load_executable_manifest(conn)?;
    let local_hash = local_hash(&path, executable_manifest.get(&parsed.relative).copied())?;
    if matches!(&parsed.change, CustomSkillChange::Delete) && local_hash.starts_with("local:") {
        adopt_absent_delete(conn, &parsed.relative, &parsed.delete_tombstones)?;
        return Ok(());
    }
    let current_generation = load_generations(conn)?.get(&parsed.relative).cloned();
    if matches!(&parsed.change, CustomSkillChange::Delete)
        && !force_remote
        && current_generation.as_ref().is_some_and(|generation_id| {
            parsed
                .delete_tombstones
                .values()
                .all(|target| &target.base_generation_id != generation_id)
        })
    {
        update_tombstone_entry(conn, &parsed.relative, &parsed.delete_tombstones)?;
        return Ok(());
    }
    if local_hash == parsed.remote_hash {
        match &parsed.change {
            CustomSkillChange::Upsert { executable, .. } => {
                adopt_upsert_entry(conn, *executable, &parsed)?;
                retire_tombstone_entries(conn, &parsed.relative, &parsed.retired_tombstone_ids)?;
            }
            CustomSkillChange::Delete => {
                adopt_absent_delete(conn, &parsed.relative, &parsed.delete_tombstones)?;
            }
        }
        return Ok(());
    }
    if force_remote
        || (matches!(&parsed.change, CustomSkillChange::Delete)
            && parsed.delete_tombstones.values().any(|target| {
                current_generation.as_deref() == Some(target.base_generation_id.as_str())
                    && target.base_hash == local_hash
            }))
        || (matches!(&parsed.change, CustomSkillChange::Upsert { .. })
            && local_hash == parsed.base_hash)
        || parsed.recovery_base_hash.as_deref() == Some(local_hash.as_str())
    {
        match &parsed.change {
            CustomSkillChange::Upsert { bytes, executable } => {
                write_file(&root, &path, bytes, *executable, force_remote)?;
                adopt_upsert_entry(conn, *executable, &parsed)?;
                retire_tombstone_entries(conn, &parsed.relative, &parsed.retired_tombstone_ids)?;
            }
            CustomSkillChange::Delete => {
                fs::remove_file(&path)?;
                if let Some(parent) = path.parent() {
                    prune_empty_directories(&root, parent)?;
                }
                remove_manifest_entry(conn, &parsed.relative)?;
                update_tombstone_entry(conn, &parsed.relative, &parsed.delete_tombstones)?;
            }
        }
        return Ok(());
    }
    record_conflict(conn, op, &local_hash, &parsed.remote_hash)
}

pub(super) fn resolve_conflict(
    home: &Path,
    conn: &Connection,
    conflict_id: &str,
    resolution: &str,
) -> Result<(), SyncError> {
    if resolution != "keep_local" && resolution != "use_remote" {
        return Err(SyncError::Message(
            "custom skill conflicts support only keep_local or use_remote".to_string(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let row = tx
        .query_row(
            "SELECT c.op_id, c.device_id, c.entity_id, c.payload_json, a.seq
             FROM sync_conflicts c
             JOIN sync_applied_ops a ON a.op_id = c.op_id
             WHERE c.id = ?1 AND c.entity_type = 'skill' AND c.resolved_at IS NULL",
            [conflict_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| SyncError::Message("pending custom skill conflict not found".to_string()))?;
    let has_newer_conflict = tx
        .query_row(
            "SELECT 1
             FROM sync_conflicts c
             JOIN sync_applied_ops a ON a.op_id = c.op_id
             WHERE c.device_id = ?1 AND c.entity_type = 'skill' AND c.entity_id = ?2 AND a.seq > ?3
             LIMIT 1",
            params![row.1, row.2, row.4],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if has_newer_conflict {
        tx.execute(
            "UPDATE sync_conflicts SET resolved_at = ?2, resolution = 'superseded'
             WHERE id = ?1 AND resolved_at IS NULL",
            params![conflict_id, now()],
        )?;
        tx.commit()?;
        return Err(SyncError::Message(
            "custom skill conflict was superseded by a newer operation".to_string(),
        ));
    }
    let payload: Value = serde_json::from_str(&row.3)?;
    let kind = if payload.get("deleted").and_then(Value::as_bool) == Some(true) {
        "skill.file.delete"
    } else {
        "skill.file.upsert"
    };
    let op = SyncOp {
        op_id: row.0,
        device_id: row.1,
        seq: 0,
        created_at: now(),
        kind: kind.to_string(),
        entity_type: "skill".to_string(),
        entity_id: row.2,
        payload_hash: hash_value(&payload)?,
        payload,
    };
    let parsed = parse_op(&op)?;
    if resolution == "use_remote" {
        apply_with_policy(home, &tx, &op, true)?;
    } else {
        let retired_tombstone_ids = match &parsed.change {
            CustomSkillChange::Upsert { .. } => parsed.retired_tombstone_ids.clone(),
            CustomSkillChange::Delete => parsed.delete_tombstones.keys().cloned().collect(),
        };
        retire_tombstone_entries(&tx, &parsed.relative, &retired_tombstone_ids)?;
        rebase_manifest_entry(
            &tx,
            &parsed.relative,
            &parsed.remote_hash,
            parsed.upsert_generation_id.as_deref(),
        )?;
    }
    tx.execute(
        "UPDATE sync_conflicts SET resolved_at = ?2, resolution = ?3
         WHERE id = ?1 AND resolved_at IS NULL",
        params![conflict_id, now(), resolution],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filesystems_without_executable_bits_preserve_synced_intent() {
        assert!(select_executable(false, false, Some(true)));
        assert!(!select_executable(false, false, None));
        assert!(!select_executable(true, false, Some(true)));
        assert!(select_executable(true, true, Some(false)));
    }

    #[test]
    fn paths_follow_the_windows_filename_contract_on_every_platform() {
        for path in [
            "bad?/SKILL.md",
            "bad*/SKILL.md",
            "bad\"/SKILL.md",
            "bad</SKILL.md",
            "bad>/SKILL.md",
            "bad|/SKILL.md",
            "CON/SKILL.md",
            "con.txt/SKILL.md",
            "COM1/SKILL.md",
            "lpt9.log/SKILL.md",
            "trailing./SKILL.md",
            "trailing /SKILL.md",
        ] {
            assert!(
                validate_relative_path(path).is_err(),
                "Windows-invalid path must be rejected: {path}"
            );
        }
        assert!(validate_relative_path("valid-skill/.hidden file.md").is_ok());
    }

    #[test]
    fn case_colliding_paths_are_rejected_before_export() {
        assert!(validate_casefolded_paths(["Tool/SKILL.md", "tool/SKILL.md"]).is_err());
        assert!(validate_casefolded_paths(["Tool", "tool/SKILL.md"]).is_err());
        assert!(validate_casefolded_paths(["Tool/a", "tool/b"]).is_err());
        assert!(validate_casefolded_paths(["caf\u{e9}/a", "cafe\u{301}/b"]).is_err());
        assert!(validate_casefolded_paths(["tool/SKILL.md", "tool/assets/Icon.png"]).is_ok());
    }

    #[test]
    fn portable_component_comparison_normalizes_unicode() {
        assert!(portable_components_collide("caf\u{e9}", "cafe\u{301}"));
        assert!(portable_components_collide("Tool", "tool"));
        assert!(!portable_components_collide("tool", "tool"));
    }
}
