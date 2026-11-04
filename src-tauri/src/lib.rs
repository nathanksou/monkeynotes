//! File-system commands for monkeynotes.
//!
//! Notes are plain markdown files inside a "notes folder":
//!
//! ```text
//! <root>/                    the default "notes" folder
//! <root>/<folder>/.../*.md   folders, nested up to MAX_DEPTH
//! <root>/.trash/*.md         recently deleted
//! <root>/.monkeynotes.json   pins + trash metadata
//! ```
//!
//! Security model: the web UI never names an absolute path. The notes folder is
//! owned by this side (chosen through a native dialog and remembered here), note
//! paths from the UI are relative and validated so they can't escape it, and
//! files outside it are only read or written through native open/save dialogs.
//!
//! All commands are `async`, so they run off the main thread and file work never
//! freezes the window.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

type Res<T> = Result<T, String>;

const NOTE_EXTS: [&str; 3] = ["md", "markdown", "txt"];
const TRASH_DIR: &str = ".trash";
const META_FILE: &str = ".monkeynotes.json";
/// How deep folders are scanned and imported.
const MAX_DEPTH: u8 = 8;
/// Bigger files are left alone: they're almost certainly not notes.
const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;
/// Where note versions live, inside the notes folder.
const HISTORY_DIR: &str = ".monkeynotes/history";
/// Versions kept per note, and for how long.
const HISTORY_KEEP: usize = 50;
const HISTORY_MAX_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1000;
/// Error prefix the UI looks for to pick another name instead of overwriting.
const EEXIST: &str = "EEXIST";
/// Error prefix for "the file you're acting on isn't there (any more)".
const NOT_FOUND: &str = "NOT_FOUND";
/// Files the OS drops into folders; they don't stop a folder from being deleted.
const JUNK_FILES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ------------------------------------------------------------------ helpers

fn app_dir(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Join a relative path onto `root`, refusing anything that could escape it.
fn resolve(root: &Path, rel: &str) -> Res<PathBuf> {
    let rel_path = Path::new(rel);
    // On Windows "\\" is also a separator (it would slip past the "/" checks in
    // note_path) and ":" can address alternate data streams.
    if cfg!(windows) && rel.contains(['\\', ':']) {
        return Err(format!("invalid path: {rel}"));
    }
    // "a//b", "a/./b" and (on Windows) "a./b" or "a /b" are other spellings of real
    // paths; refuse them so every check below sees one canonical form.
    let aliased = rel
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || (cfg!(windows) && (seg.ends_with('.') || seg.ends_with(' '))));
    if aliased {
        return Err(format!("invalid path: {rel}"));
    }
    let safe = !rel.is_empty() && rel_path.components().all(|c| matches!(c, Component::Normal(_)));
    if !safe {
        return Err(format!("invalid path: {rel}"));
    }
    Ok(root.join(rel_path))
}

/// A note file inside the notes folder: a .md/.markdown/.txt file in a visible
/// folder, or directly inside `.trash/`. With `allow_meta`, also the app's own
/// metadata file. This keeps the UI away from things like `.git/hooks` or an
/// Obsidian vault's `.obsidian/plugins`, and from non-note files.
fn note_path(root: &Path, rel: &str, allow_meta: bool) -> Res<PathBuf> {
    let full = resolve(root, rel)?;
    no_symlinks(root, rel)?;
    if allow_meta && rel == META_FILE {
        return Ok(full);
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let (dirs, _) = parts.split_at(parts.len() - 1);
    let dirs_ok = match dirs {
        [first] if *first == TRASH_DIR => true,
        _ => dirs.iter().all(|d| !is_hidden(d)),
    };
    let name = parts[parts.len() - 1];
    if !dirs_ok || is_hidden(name) || !is_note(Path::new(name)) {
        return Err(format!("not a note path: {rel}"));
    }
    Ok(full)
}

/// Refuse paths that go through a symlink inside the notes folder: following
/// one would let a note operation act on files outside it.
fn no_symlinks(root: &Path, rel: &str) -> Res<()> {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
        match fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!("{rel} goes through a symlink, which isn't followed"))
            }
            Ok(_) => {}
            Err(_) => break, // doesn't exist yet: nothing further can be a link
        }
    }
    Ok(())
}

/// A folder inside the notes folder (no hidden folders, including `.trash`).
fn folder_path(root: &Path, rel: &str) -> Res<PathBuf> {
    let full = resolve(root, rel)?;
    no_symlinks(root, rel)?;
    if rel.split('/').any(is_hidden) {
        return Err(format!("not a notes folder: {rel}"));
    }
    Ok(full)
}

fn read_opt(path: &Path) -> Res<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temp file name next to `path` that no other write is using.
fn temp_beside(path: &Path) -> PathBuf {
    let mut t = path.as_os_str().to_owned();
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    t.push(format!(".{}-{n}.tmp", std::process::id()));
    PathBuf::from(t)
}

/// Write `contents` to `tmp` and make sure it reached the disk.
fn write_temp(tmp: &Path, contents: &str) -> Res<()> {
    let mut f = File::create(tmp).map_err(err)?;
    f.write_all(contents.as_bytes()).map_err(err)?;
    f.sync_all().map_err(err)
}

/// Make a rename in `dir` survive a power cut (Unix; Windows has no equivalent).
fn sync_dir(dir: Option<&Path>) {
    #[cfg(unix)]
    if let Some(d) = dir.and_then(|d| File::open(d).ok()) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Write via a synced temp file + rename so a crash never leaves a
/// half-written or empty note.
fn write_atomic(path: &Path, contents: &str) -> Res<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = temp_beside(path);
    write_temp(&tmp, contents).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })?;
    sync_dir(path.parent());
    Ok(())
}

/// Like write_atomic, but fails with EEXIST instead of replacing a file that
/// already exists. Uses a hard link, which can't replace anything, so even a
/// file that appears at the last moment (a sync client) is safe; on disks
/// without hard links it falls back to checking first.
fn write_new(path: &Path, contents: &str, label: &str) -> Res<()> {
    if path.exists() {
        return Err(format!("{EEXIST}: {label}"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = temp_beside(path);
    write_temp(&tmp, contents).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    let result = match fs::hard_link(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(format!("{EEXIST}: {label}")),
        Err(_) if path.exists() => Err(format!("{EEXIST}: {label}")),
        Err(_) => fs::rename(&tmp, path).map_err(err),
    };
    let _ = fs::remove_file(&tmp);
    sync_dir(path.parent());
    result
}

fn is_note(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| NOTE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn millis(t: std::io::Result<SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn dialog_path(picked: FilePath) -> Res<PathBuf> {
    picked.into_path().map_err(err)
}

/// Read a note file the user picked, refusing huge or non-text files.
fn read_note_file(path: &Path) -> Res<String> {
    let len = fs::metadata(path).map_err(err)?.len();
    if len > MAX_NOTE_BYTES {
        return Err(format!("{} is too large to be a note", path.display()));
    }
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

// ------------------------------------------------------------------ notes folder location

/// The current notes folder, and whether the user chose it (vs. the default).
struct NotesDir(Mutex<(PathBuf, bool)>);

impl NotesDir {
    fn root(&self) -> PathBuf {
        self.0.lock().unwrap().0.clone()
    }
}

fn default_root(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("monkeynotes")
}

fn root_setting_file(app: &AppHandle) -> Res<PathBuf> {
    Ok(app_dir(app)?.join("notes-dir.txt"))
}

fn load_notes_dir(app: &AppHandle) -> NotesDir {
    let saved = root_setting_file(app)
        .ok()
        .and_then(|f| fs::read_to_string(f).ok())
        .map(|s| PathBuf::from(s.trim_end_matches(['\n', '\r'])))
        .filter(|p| p.is_absolute());
    NotesDir(Mutex::new(match saved {
        Some(p) => (p, true),
        None => (default_root(app), false),
    }))
}

#[tauri::command]
async fn notes_dir(dir: State<'_, NotesDir>) -> Res<String> {
    Ok(dir.root().display().to_string())
}

/// Let the user pick a new notes folder. Returns the new path, or None if cancelled.
#[tauri::command]
async fn choose_notes_dir(app: AppHandle, dir: State<'_, NotesDir>) -> Res<Option<String>> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("choose a notes folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = dialog_path(picked)?;
    write_atomic(&root_setting_file(&app)?, &path.display().to_string())?;
    *dir.0.lock().unwrap() = (path.clone(), true);
    Ok(Some(path.display().to_string()))
}

/// Switch to the default notes folder. With `persist: false` it only lasts until
/// the app restarts (used when the chosen folder is temporarily missing).
#[tauri::command]
async fn reset_notes_dir(app: AppHandle, dir: State<'_, NotesDir>, persist: bool) -> Res<String> {
    let path = default_root(&app);
    if persist {
        match fs::remove_file(root_setting_file(&app)?) {
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(err(e)),
            _ => {}
        }
    }
    *dir.0.lock().unwrap() = (path.clone(), false);
    Ok(path.display().to_string())
}

// ------------------------------------------------------------------ app state

/// Settings and stats. A corrupt file is set aside instead of breaking startup.
#[tauri::command]
async fn load_state(app: AppHandle) -> Res<Option<String>> {
    let path = app_dir(&app)?.join("state.json");
    let Some(raw) = read_opt(&path)? else { return Ok(None) };
    if serde_json::from_str::<serde_json::Value>(&raw).is_ok() {
        return Ok(Some(raw));
    }
    let _ = fs::rename(&path, path.with_extension("json.corrupt"));
    Ok(None)
}

#[tauri::command]
async fn save_state(app: AppHandle, contents: String) -> Res<()> {
    serde_json::from_str::<serde_json::Value>(&contents).map_err(err)?;
    write_atomic(&app_dir(&app)?.join("state.json"), &contents)
}

/// The single-file database used by v0.1, if it is still around.
#[tauri::command]
async fn load_legacy(app: AppHandle) -> Res<Option<String>> {
    read_opt(&app_dir(&app)?.join("notes.json"))
}

/// Keep the v0.1 database as a backup once it has been migrated.
#[tauri::command]
async fn retire_legacy(app: AppHandle) -> Res<()> {
    let dir = app_dir(&app)?;
    let old = dir.join("notes.json");
    if old.exists() {
        fs::rename(&old, dir.join("notes.v1.json")).map_err(err)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ scanning

#[derive(Serialize)]
struct FileEntry {
    path: String,
    /// None when the caller already has this version (same modified time).
    body: Option<String>,
    created: u64,
    modified: u64,
}

#[derive(Serialize)]
struct Scan {
    dirs: Vec<String>,
    files: Vec<FileEntry>,
    meta: Option<String>,
}

fn read_notes(root: &Path, rel_dir: &str, known: &HashMap<String, u64>, out: &mut Vec<FileEntry>) -> Res<()> {
    let dir = if rel_dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel_dir)
    };
    let entries = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        // a subfolder we can't read (e.g. "System Volume Information") is skipped
        Err(e) if rel_dir.is_empty() => return Err(err(e)),
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false); // not through symlinks
        if is_hidden(&name) || !is_file || !is_note(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_NOTE_BYTES {
            continue;
        }
        let modified = millis(meta.modified()).unwrap_or(0);
        let created = millis(meta.created()).unwrap_or(modified);
        let rel = if rel_dir.is_empty() {
            name
        } else {
            format!("{rel_dir}/{name}")
        };
        let body = if modified != 0 && known.get(&rel) == Some(&modified) {
            None
        } else {
            // Skip files that aren't valid UTF-8 rather than failing the whole scan.
            let Ok(text) = fs::read_to_string(&path) else { continue };
            Some(text)
        };
        out.push(FileEntry {
            path: rel,
            body,
            created,
            modified,
        });
    }
    Ok(())
}

/// Collect `rel_dir`'s subfolders (any depth, not following symlinks) and their notes.
fn scan_dirs(
    root: &Path,
    rel_dir: &str,
    depth: u8,
    known: &HashMap<String, u64>,
    dirs: &mut Vec<String>,
    files: &mut Vec<FileEntry>,
) -> Res<()> {
    let dir = if rel_dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel_dir)
    };
    let entries = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if rel_dir.is_empty() => return Err(err(e)),
        Err(_) => return Ok(()), // unreadable subfolder: skip it, keep the rest
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false); // symlinks are not dirs here
        if is_hidden(&name) || !is_dir {
            continue;
        }
        let rel = if rel_dir.is_empty() {
            name
        } else {
            format!("{rel_dir}/{name}")
        };
        read_notes(root, &rel, known, files)?;
        if depth > 1 {
            scan_dirs(root, &rel, depth - 1, known, dirs, files)?;
        }
        dirs.push(rel);
    }
    Ok(())
}

fn scan_root(root: &Path, known: &HashMap<String, u64>) -> Res<Scan> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    read_notes(root, "", known, &mut files)?;
    scan_dirs(root, "", MAX_DEPTH, known, &mut dirs, &mut files)?;
    read_notes(root, TRASH_DIR, known, &mut files)?;
    dirs.sort_by_key(|d| d.to_lowercase());
    let meta = read_opt(&root.join(META_FILE))?;
    Ok(Scan { dirs, files, meta })
}

/// Read every note in the notes folder, its folders and the trash. Files whose
/// modified time matches `known` come back without a body.
#[tauri::command]
async fn scan(dir: State<'_, NotesDir>, known: Option<HashMap<String, u64>>) -> Res<Scan> {
    let (root, chosen) = dir.0.lock().unwrap().clone();
    if !root.is_dir() {
        if chosen {
            // An unplugged drive or unmounted volume: don't create a phantom folder.
            return Err(format!("NOT_FOUND: {}", root.display()));
        }
        fs::create_dir_all(&root).map_err(err)?;
    }
    scan_root(&root, &known.unwrap_or_default())
}

// ------------------------------------------------------------------ note files

/// Write a note. With `create_new`, refuses (EEXIST) to replace a file that
/// already exists, so a note never overwrites a file the app doesn't know about.
#[tauri::command]
async fn write_file(dir: State<'_, NotesDir>, path: String, contents: String, create_new: bool) -> Res<()> {
    let target = note_path(&dir.root(), &path, true)?;
    if create_new {
        write_new(&target, &contents, &path)
    } else {
        write_atomic(&target, &contents)
    }
}

/// Rename without ever replacing what's at `dst` (EEXIST). Files are moved with
/// a hard link + unlink, which can't replace anything even if `dst` appears at
/// the last moment; folders (and disks without hard links) check first.
fn rename_no_clobber(src: &Path, dst: &Path, from: &str, to: &str) -> Res<()> {
    if src == dst {
        return Ok(());
    }
    if fs::symlink_metadata(src).is_err() {
        return Err(format!("{NOT_FOUND}: {from}"));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    if from.to_lowercase() == to.to_lowercase() {
        // Case-only rename ("notes" -> "Notes"). On a case-insensitive disk dst
        // "exists" because it's the same file; on a case-sensitive one it may be
        // a different file. Go through a temp name and check which it is.
        let tmp = temp_beside(src);
        fs::rename(src, &tmp).map_err(err)?;
        if dst.exists() {
            let _ = fs::rename(&tmp, src);
            return Err(format!("{EEXIST}: {to}"));
        }
        return fs::rename(&tmp, dst).map_err(err);
    }
    if src.is_dir() {
        if dst.exists() {
            return Err(format!("{EEXIST}: {to}"));
        }
        return fs::rename(src, dst).map_err(err);
    }
    match fs::hard_link(src, dst) {
        Ok(()) => fs::remove_file(src).map_err(|e| {
            let _ = fs::remove_file(dst); // keep exactly one copy
            err(e)
        }),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(format!("{EEXIST}: {to}")),
        Err(_) if dst.exists() => Err(format!("{EEXIST}: {to}")),
        Err(_) => fs::rename(src, dst).map_err(err),
    }
}

/// Rename a note, or a folder. Never overwrites (EEXIST).
#[tauri::command]
async fn rename_path(dir: State<'_, NotesDir>, from: String, to: String) -> Res<()> {
    let root = dir.root();
    let (src, dst) = if resolve(&root, &from)?.is_dir() {
        (folder_path(&root, &from)?, folder_path(&root, &to)?)
    } else {
        (note_path(&root, &from, false)?, note_path(&root, &to, false)?)
    };
    rename_no_clobber(&src, &dst, &from, &to)
}

#[tauri::command]
async fn remove_file(dir: State<'_, NotesDir>, path: String) -> Res<()> {
    match fs::remove_file(note_path(&dir.root(), &path, false)?) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
async fn make_dir(dir: State<'_, NotesDir>, path: String) -> Res<()> {
    fs::create_dir_all(folder_path(&dir.root(), &path)?).map_err(err)
}

/// Remove a folder. Only succeeds when it is empty (apart from files like
/// .DS_Store the OS drops there), so real files are never lost.
#[tauri::command]
async fn remove_dir(dir: State<'_, NotesDir>, path: String) -> Res<()> {
    let target = folder_path(&dir.root(), &path)?;
    if let Ok(entries) = fs::read_dir(&target) {
        let names: Vec<_> = entries.flatten().map(|e| e.file_name()).collect();
        if names.iter().all(|n| JUNK_FILES.iter().any(|j| n == *j)) {
            for n in &names {
                let _ = fs::remove_file(target.join(n));
            }
        }
    }
    match fs::remove_dir(&target) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

// ------------------------------------------------------------------ version history
//
// <root>/.monkeynotes/history/<note path>/<unix ms>.md, e.g.
// .monkeynotes/history/ideas/app idea.md/1793740000000.md
// The note's own file name (with extension) is a folder here, so "a.md" and
// "a.txt" never share a history.

fn now_ms() -> u64 {
    millis(Ok(SystemTime::now())).unwrap_or(0)
}

/// The history folder for a note (validated as a note path) or, for folder
/// renames, a folder.
fn history_dir(root: &Path, rel: &str, folder: bool) -> Res<PathBuf> {
    if folder {
        folder_path(root, rel)?;
    } else {
        note_path(root, rel, false)?;
    }
    no_symlinks(root, &format!("{HISTORY_DIR}/{rel}"))?;
    Ok(root.join(HISTORY_DIR).join(rel))
}

/// "1793740000000.md" -> 1793740000000
fn version_of(name: &std::ffi::OsStr) -> Option<u64> {
    name.to_str()?.strip_suffix(".md")?.parse().ok()
}

/// Version timestamps directly in a history folder, newest first. (A note's
/// history folder can also hold folders, when a folder has the same name as
/// the note; those are someone else's history and are never touched here.)
fn versions_in(dir: &Path) -> Vec<u64> {
    let mut out: Vec<u64> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|e| version_of(&e.file_name()))
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_unstable_by(|a, b| b.cmp(a));
    out
}

/// Keep the newest HISTORY_KEEP versions younger than HISTORY_MAX_AGE_MS.
fn prune_history(dir: &Path, now: u64) {
    for (i, at) in versions_in(dir).into_iter().enumerate() {
        if i >= HISTORY_KEEP || now.saturating_sub(at) > HISTORY_MAX_AGE_MS {
            let _ = fs::remove_file(dir.join(format!("{at}.md")));
        }
    }
}

/// The first free "<at>.md" in `dir` at or after `at`.
fn free_version_name(dir: &Path, mut at: u64) -> PathBuf {
    while dir.join(format!("{at}.md")).exists() {
        at += 1;
    }
    dir.join(format!("{at}.md"))
}

fn save_version(root: &Path, path: &str, contents: &str, now: u64) -> Res<u64> {
    let dir = history_dir(root, path, false)?;
    let file = free_version_name(&dir, now);
    write_atomic(&file, contents)?;
    prune_history(&dir, now);
    Ok(version_of(file.file_name().unwrap_or_default()).unwrap_or(now))
}

/// Store `contents` as a version of the note at `path`. Returns its timestamp.
#[tauri::command]
async fn history_save(dir: State<'_, NotesDir>, path: String, contents: String) -> Res<u64> {
    save_version(&dir.root(), &path, &contents, now_ms())
}

/// A note's versions, newest first.
#[tauri::command]
async fn history_list(dir: State<'_, NotesDir>, path: String) -> Res<Vec<u64>> {
    Ok(versions_in(&history_dir(&dir.root(), &path, false)?))
}

#[tauri::command]
async fn history_read(dir: State<'_, NotesDir>, path: String, at: u64) -> Res<String> {
    let file = history_dir(&dir.root(), &path, false)?.join(format!("{at}.md"));
    fs::read_to_string(file).map_err(err)
}

/// Move version files (only) from one note's history folder to another's,
/// renumbering any that collide instead of dropping them.
fn move_versions(src: &Path, dst: &Path) -> Res<()> {
    fs::create_dir_all(dst).map_err(err)?;
    for at in versions_in(src) {
        fs::rename(src.join(format!("{at}.md")), free_version_name(dst, at)).map_err(err)?;
    }
    let _ = fs::remove_dir(src); // only if nothing else lives there
    Ok(())
}

/// Move a whole folder's history into `dst`, keeping everything: entries that
/// collide are merged (folders) or renumbered (versions).
fn merge_dir(src: &Path, dst: &Path) -> Res<()> {
    if !dst.exists() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        return fs::rename(src, dst).map_err(err);
    }
    for entry in fs::read_dir(src).map_err(err)?.flatten() {
        let name = entry.file_name();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            merge_dir(&entry.path(), &dst.join(&name))?;
        } else if let Some(at) = version_of(&name) {
            fs::rename(entry.path(), free_version_name(dst, at)).map_err(err)?;
        }
    }
    let _ = fs::remove_dir_all(src);
    Ok(())
}

fn move_history(root: &Path, from: &str, to: &str, folder: bool) -> Res<()> {
    let src = history_dir(root, from, folder)?;
    let dst = history_dir(root, to, folder)?;
    if !src.exists() || src == dst {
        return Ok(());
    }
    // A case-only rename ("ideas" -> "Ideas"): on a case-insensitive disk src and
    // dst are the same folder, so step through a temp name first.
    let src = if from.to_lowercase() == to.to_lowercase() {
        let tmp = temp_beside(&src);
        fs::rename(&src, &tmp).map_err(err)?;
        tmp
    } else {
        src
    };
    if folder {
        merge_dir(&src, &dst)
    } else {
        move_versions(&src, &dst)
    }
}

/// Move a note's history after it was renamed (or a folder's, with `folder`).
#[tauri::command]
async fn history_move(dir: State<'_, NotesDir>, from: String, to: String, folder: bool) -> Res<()> {
    move_history(&dir.root(), &from, &to, folder)
}

/// Remove versions saved at or after `since` (all of them when None). With
/// `recursive`, also inside every folder below (a whole folder's or all
/// history); without, only the versions directly in `dir` (one note's).
/// Returns how many were (or, with `dry_run`, would be) removed. Folders left
/// empty are removed too.
fn clear_versions(dir: &Path, since: Option<u64>, dry_run: bool, recursive: bool) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if recursive {
                removed += clear_versions(&path, since, dry_run, true);
            }
            continue;
        }
        let Some(at) = version_of(&entry.file_name()) else {
            continue;
        };
        if since.map_or(true, |s| at >= s) && (dry_run || fs::remove_file(&path).is_ok()) {
            removed += 1;
        }
    }
    if !dry_run {
        let _ = fs::remove_dir(dir); // only succeeds once empty
    }
    removed
}

/// Clear version history for some notes (by path), from `since` on (or all
/// time). With `dry_run`, only counts.
#[tauri::command]
async fn history_clear(dir: State<'_, NotesDir>, paths: Vec<String>, since: Option<u64>, dry_run: bool) -> Res<u64> {
    let root = dir.root();
    let mut removed = 0;
    for p in paths {
        removed += clear_versions(&history_dir(&root, &p, false)?, since, dry_run, false);
    }
    Ok(removed)
}

/// Clear version history for every note, from `since` on (or all time).
#[tauri::command]
async fn history_clear_all(dir: State<'_, NotesDir>, since: Option<u64>, dry_run: bool) -> Res<u64> {
    Ok(clear_versions(&dir.root().join(HISTORY_DIR), since, dry_run, true))
}

/// Forget a note's history (when the note is deleted for good, or a new note
/// takes a path that still has someone else's old history).
#[tauri::command]
async fn history_delete(dir: State<'_, NotesDir>, path: String) -> Res<()> {
    clear_versions(&history_dir(&dir.root(), &path, false)?, None, false, false);
    Ok(())
}

// ------------------------------------------------------------------ import / export

#[derive(Serialize)]
struct ExtFile {
    name: String,
    body: String,
}

#[derive(Serialize)]
struct ExtDir {
    name: String,
    files: Vec<ExtFile>,
    dirs: Vec<ExtDir>,
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn read_ext_dir(path: &Path, depth: u8) -> Res<ExtDir> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in fs::read_dir(path).map_err(err)?.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        if is_hidden(&name) {
            continue;
        }
        if kind.is_dir() && depth > 0 {
            if let Ok(sub) = read_ext_dir(&p, depth - 1) {
                dirs.push(sub); // unreadable subfolders are skipped
            }
        } else if kind.is_file() && is_note(&p) {
            if let Ok(body) = read_note_file(&p) {
                files.push(ExtFile { name: stem(&p), body });
            }
        }
    }
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(ExtDir { name, files, dirs })
}

/// Ask for note files to import and return their contents.
#[tauri::command]
async fn import_files(app: AppHandle) -> Res<Option<Vec<ExtFile>>> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("import notes")
        .add_filter("notes", &NOTE_EXTS)
        .blocking_pick_files()
    else {
        return Ok(None);
    };
    let mut out = Vec::new();
    let mut failed = Vec::new();
    for p in picked {
        let path = dialog_path(p)?;
        match read_note_file(&path) {
            Ok(body) => out.push(ExtFile {
                name: stem(&path),
                body,
            }),
            Err(e) => failed.push(e), // e.g. not UTF-8: skip it, import the rest
        }
    }
    if out.is_empty() && !failed.is_empty() {
        return Err(failed.join("; "));
    }
    Ok(Some(out))
}

/// Ask for a folder to import and return its notes, including subfolders.
#[tauri::command]
async fn import_dir(app: AppHandle) -> Res<Option<ExtDir>> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("import a folder of notes")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    read_ext_dir(&dialog_path(picked)?, MAX_DEPTH).map(Some)
}

/// Save one note wherever the user chooses. Returns false if cancelled.
#[tauri::command]
async fn export_note(app: AppHandle, name: String, contents: String) -> Res<bool> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("export note")
        .set_file_name(format!("{name}.md"))
        .add_filter("markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    write_atomic(&dialog_path(picked)?, &contents)?;
    Ok(true)
}

#[derive(Deserialize)]
struct ExportFile {
    path: String,
    body: String,
}

/// Copy notes into a brand-new "monkeynotes-export-<date>" folder inside a
/// folder the user chooses. The folder name is made here, never by the UI; the
/// folder must not exist yet ("... 2" etc. otherwise); and only note files are
/// written into it, never replacing anything. Returns where they went, or None
/// if cancelled.
#[tauri::command]
async fn export_all(app: AppHandle, date: String, files: Vec<ExportFile>) -> Res<Option<String>> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("export all notes into...")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let parent = dialog_path(picked)?;
    let date: String = date
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '-')
        .take(10)
        .collect();
    let dest = (1..1000)
        .map(|i| {
            let suffix = if i > 1 { format!(" {i}") } else { String::new() };
            parent.join(format!("monkeynotes-export-{date}{suffix}"))
        })
        .find(|d| fs::create_dir(d).is_ok())
        .ok_or_else(|| format!("couldn't create an export folder in {}", parent.display()))?;
    for f in files {
        write_new(&note_path(&dest, &f.path, false)?, &f.body, &f.path)?;
    }
    Ok(Some(dest.display().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = load_notes_dir(app.handle());
            app.manage(dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_dir,
            choose_notes_dir,
            reset_notes_dir,
            load_state,
            save_state,
            load_legacy,
            retire_legacy,
            scan,
            write_file,
            rename_path,
            remove_file,
            make_dir,
            remove_dir,
            import_files,
            import_dir,
            export_note,
            export_all,
            history_save,
            history_list,
            history_read,
            history_move,
            history_delete,
            history_clear,
            history_clear_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running monkeynotes");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("monkeynotes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn resolve_accepts_plain_relative_paths() {
        let root = Path::new("/notes");
        assert!(resolve(root, "a.md").is_ok());
        assert!(resolve(root, "ideas/sub/a.md").is_ok());
        assert!(resolve(root, ".trash/a.md").is_ok());
    }

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("/notes");
        for bad in [
            "",
            "..",
            "../a.md",
            "ideas/../../a.md",
            "/etc/passwd",
            "./a.md",
            "a//b.md",
            "a/./b.md",
            "a/",
        ] {
            assert!(resolve(root, bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn note_paths_stay_on_notes() {
        let root = Path::new("/notes");
        for ok in ["a.md", "ideas/b.txt", "x/y/z.markdown", ".trash/old.md"] {
            assert!(note_path(root, ok, false).is_ok(), "{ok} should be allowed");
        }
        for bad in [
            ".git/hooks/pre-commit",
            ".obsidian/plugins/x/main.js",
            "ideas/.hidden.md",
            ".trash/sub/a.md",
            "image.png",
            "script.sh",
            ".monkeynotes.json",
            "a/.git/config.md",
        ] {
            assert!(note_path(root, bad, false).is_err(), "{bad} should be rejected");
        }
        assert!(note_path(root, ".monkeynotes.json", true).is_ok());
        assert!(folder_path(root, "projects/2026").is_ok());
        assert!(folder_path(root, ".git").is_err());
        assert!(folder_path(root, ".trash").is_err());
        assert!(folder_path(root, "a/.obsidian").is_err());
    }

    #[test]
    fn scan_reads_nested_folders_skips_hidden_and_reuses_known_bodies() {
        let root = temp_root("scan");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join("top.md"), "top").unwrap();
        fs::write(root.join("a/b/deep.md"), "deep").unwrap();
        fs::write(root.join(".obsidian/app.md"), "hidden").unwrap();
        fs::write(root.join("a/image.png"), "not a note").unwrap();

        let first = scan_root(&root, &HashMap::new()).unwrap();
        let mut paths: Vec<_> = first.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["a/b/deep.md", "top.md"]);
        assert_eq!(first.dirs, ["a", "a/b"]);
        assert!(first.files.iter().all(|f| f.body.is_some()));

        let known: HashMap<_, _> = first.files.iter().map(|f| (f.path.clone(), f.modified)).collect();
        let second = scan_root(&root, &known).unwrap();
        assert!(second.files.iter().all(|f| f.body.is_none()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn history_saves_lists_prunes_and_moves() {
        let root = temp_root("history");
        let day = 24 * 60 * 60 * 1000;
        let now = 1_000 * day;
        // 55 versions, one an hour; plus one that's too old
        save_version(&root, "ideas/a.md", "ancient", now - 100 * day).unwrap();
        for i in 0..55u64 {
            save_version(&root, "ideas/a.md", &format!("v{i}"), now - (55 - i) * 3_600_000).unwrap();
        }
        let dir = history_dir(&root, "ideas/a.md", false).unwrap();
        let list = versions_in(&dir);
        assert_eq!(list.len(), HISTORY_KEEP);
        assert_eq!(fs::read_to_string(dir.join(format!("{}.md", list[0]))).unwrap(), "v54");

        move_history(&root, "ideas/a.md", "ideas/b.md", false).unwrap();
        assert!(!dir.exists());
        assert_eq!(
            versions_in(&history_dir(&root, "ideas/b.md", false).unwrap()).len(),
            HISTORY_KEEP
        );

        move_history(&root, "ideas", "work", true).unwrap();
        assert_eq!(
            versions_in(&history_dir(&root, "work/b.md", false).unwrap()).len(),
            HISTORY_KEEP
        );

        // clearing: count first, then only the recent ones, then everything
        let work = root.join(HISTORY_DIR).join("work");
        let all = clear_versions(&work, None, true, true);
        assert_eq!(all, HISTORY_KEEP as u64);
        let newest = versions_in(&history_dir(&root, "work/b.md", false).unwrap())[0];
        assert_eq!(clear_versions(&work, Some(newest), false, true), 1);
        assert_eq!(clear_versions(&work, None, false, true), (HISTORY_KEEP - 1) as u64);
        assert!(!work.exists());

        assert!(history_dir(&root, "../escape.md", false).is_err());
        assert!(history_dir(&root, ".git/x.md", false).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_new_never_overwrites_and_write_atomic_replaces() {
        let root = temp_root("write");
        let f = root.join("a.md");
        write_new(&f, "first", "a.md").unwrap();
        assert!(write_new(&f, "second", "a.md").unwrap_err().starts_with(EEXIST));
        assert_eq!(fs::read_to_string(&f).unwrap(), "first");
        write_atomic(&f, "replaced").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "replaced");
        // no temp files left behind
        let names: Vec<_> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, ["a.md"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn renames_report_missing_sources_and_never_overwrite_folders() {
        let root = temp_root("rename2");
        let err = rename_no_clobber(&root.join("gone.md"), &root.join("x.md"), "gone.md", "x.md").unwrap_err();
        assert!(err.starts_with(NOT_FOUND));
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        assert!(rename_no_clobber(&root.join("a"), &root.join("b"), "a", "b")
            .unwrap_err()
            .starts_with(EEXIST));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_the_notes_folder_are_refused() {
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(note_path(&root, "link/x.md", false).is_err());
        assert!(folder_path(&root, "link").is_err());
        assert!(note_path(&root, "real/x.md", false).is_ok());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn note_history_never_touches_a_same_named_folders_history() {
        let root = temp_root("history-collide");
        // a note "x.md" and a folder "x.md" with a note inside
        save_version(&root, "x.md", "note version", 1_000).unwrap();
        save_version(&root, "x.md/inner.md", "folder note version", 1_000).unwrap();
        let note_dir = history_dir(&root, "x.md", false).unwrap();
        assert_eq!(clear_versions(&note_dir, None, true, false), 1);
        clear_versions(&note_dir, None, false, false);
        assert_eq!(
            versions_in(&history_dir(&root, "x.md/inner.md", false).unwrap()).len(),
            1
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn moving_history_keeps_colliding_versions_and_handles_case_only_renames() {
        let root = temp_root("history-move");
        save_version(&root, "a.md", "from a", 5_000).unwrap();
        save_version(&root, "b.md", "already at b", 5_000).unwrap();
        move_history(&root, "a.md", "b.md", false).unwrap();
        let b = history_dir(&root, "b.md", false).unwrap();
        assert_eq!(versions_in(&b), [5_001, 5_000]);
        move_history(&root, "b.md", "B.md", false).unwrap();
        let big = history_dir(&root, "B.md", false).unwrap();
        assert_eq!(versions_in(&big).len(), 2, "a case-only rename must keep the history");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn history_prunes_by_age_even_below_the_count_limit() {
        let root = temp_root("history-age");
        let day = 24 * 60 * 60 * 1000;
        save_version(&root, "a.md", "old", 1_000 * day).unwrap();
        save_version(&root, "a.md", "new", 1_000 * day + 91 * day).unwrap();
        let dir = history_dir(&root, "a.md", false).unwrap();
        assert_eq!(versions_in(&dir), [1_000 * day + 91 * day]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_never_overwrites() {
        let root = temp_root("rename");
        fs::write(root.join("a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        let res = rename_no_clobber(&root.join("a.md"), &root.join("b.md"), "a.md", "b.md");
        assert!(res.unwrap_err().starts_with(EEXIST));
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "b");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "a");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn case_only_rename_keeps_a_different_file() {
        let root = temp_root("case");
        fs::write(root.join("notes.md"), "lower").unwrap();
        let sensitive = !root.join("NOTES.md").exists();
        if sensitive {
            // Case-sensitive disk: Notes.md is a separate file and must survive.
            fs::write(root.join("Notes.md"), "upper").unwrap();
            let res = rename_no_clobber(&root.join("notes.md"), &root.join("Notes.md"), "notes.md", "Notes.md");
            assert!(res.unwrap_err().starts_with(EEXIST));
            assert_eq!(fs::read_to_string(root.join("Notes.md")).unwrap(), "upper");
            assert_eq!(fs::read_to_string(root.join("notes.md")).unwrap(), "lower");
        } else {
            rename_no_clobber(&root.join("notes.md"), &root.join("Notes.md"), "notes.md", "Notes.md").unwrap();
            let names: Vec<_> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
            assert_eq!(names, ["Notes.md"], "the stored name must change case");
        }
        fs::remove_dir_all(&root).unwrap();
    }
}
