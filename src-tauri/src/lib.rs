//! File-system commands for monkeynotes.
//!
//! Notes are plain markdown files inside a "notes folder" the user picks:
//!
//! ```text
//! <root>/                    the default "notes" folder
//! <root>/<folder>/*.md       one level of folders
//! <root>/.trash/*.md         recently deleted
//! <root>/.monkeynotes.json   pins + trash metadata
//! ```
//!
//! App settings live separately in the app data dir as `state.json`.
//! Paths passed from the UI are relative to the root and are validated so they
//! can never escape it.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

type Res<T> = Result<T, String>;

const NOTE_EXTS: [&str; 3] = ["md", "markdown", "txt"];
const TRASH_DIR: &str = ".trash";
const META_FILE: &str = ".monkeynotes.json";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn app_dir(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Join a relative path onto `root`, refusing anything that could escape it.
fn resolve(root: &str, rel: &str) -> Res<PathBuf> {
    let rel_path = Path::new(rel);
    let safe = !rel.is_empty() && rel_path.components().all(|c| matches!(c, Component::Normal(_)));
    if !safe {
        return Err(format!("invalid path: {rel}"));
    }
    Ok(Path::new(root).join(rel_path))
}

fn read_opt(path: &Path) -> Res<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// Write via a temp file + rename so a crash never leaves a half-written note.
fn write_atomic(path: &Path, contents: &str) -> Res<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
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

// ------------------------------------------------------------------ app state

#[tauri::command]
fn load_state(app: AppHandle) -> Res<Option<String>> {
    read_opt(&app_dir(&app)?.join("state.json"))
}

#[tauri::command]
fn save_state(app: AppHandle, contents: String) -> Res<()> {
    serde_json::from_str::<serde_json::Value>(&contents).map_err(err)?;
    write_atomic(&app_dir(&app)?.join("state.json"), &contents)
}

/// The single-file database used by v0.1, if it is still around.
#[tauri::command]
fn load_legacy(app: AppHandle) -> Res<Option<String>> {
    read_opt(&app_dir(&app)?.join("notes.json"))
}

/// Keep the v0.1 database as a backup once it has been migrated.
#[tauri::command]
fn retire_legacy(app: AppHandle) -> Res<()> {
    let dir = app_dir(&app)?;
    let old = dir.join("notes.json");
    if old.exists() {
        fs::rename(&old, dir.join("notes.v1.json")).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn default_root(app: AppHandle) -> Res<String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(err)?;
    Ok(base.join("monkeynotes").display().to_string())
}

// ------------------------------------------------------------------ notes folder

#[derive(Serialize)]
struct FileEntry {
    path: String,
    body: String,
    created: u64,
    modified: u64,
}

#[derive(Serialize)]
struct Scan {
    dirs: Vec<String>,
    files: Vec<FileEntry>,
    meta: Option<String>,
}

fn read_notes(root: &Path, rel_dir: &str, out: &mut Vec<FileEntry>) -> Res<()> {
    let dir = if rel_dir.is_empty() { root.to_path_buf() } else { root.join(rel_dir) };
    let entries = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) || !path.is_file() || !is_note(&path) {
            continue;
        }
        // Skip files that aren't valid UTF-8 rather than failing the whole scan.
        let Ok(body) = fs::read_to_string(&path) else { continue };
        let meta = entry.metadata().map_err(err)?;
        let modified = millis(meta.modified()).unwrap_or(0);
        let created = millis(meta.created()).unwrap_or(modified);
        let rel = if rel_dir.is_empty() { name } else { format!("{rel_dir}/{name}") };
        out.push(FileEntry { path: rel, body, created, modified });
    }
    Ok(())
}

/// Read every note in the root, its folders and the trash.
#[tauri::command]
fn scan(root: String) -> Res<Scan> {
    let root_path = PathBuf::from(&root);
    fs::create_dir_all(&root_path).map_err(err)?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    read_notes(&root_path, "", &mut files)?;
    for entry in fs::read_dir(&root_path).map_err(err)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) || !entry.path().is_dir() {
            continue;
        }
        read_notes(&root_path, &name, &mut files)?;
        dirs.push(name);
    }
    read_notes(&root_path, TRASH_DIR, &mut files)?;
    dirs.sort_by_key(|d| d.to_lowercase());
    let meta = read_opt(&root_path.join(META_FILE))?;
    Ok(Scan { dirs, files, meta })
}

#[tauri::command]
fn write_file(root: String, path: String, contents: String) -> Res<()> {
    write_atomic(&resolve(&root, &path)?, &contents)
}

/// Rename a note or folder. Refuses to overwrite, except for case-only renames.
#[tauri::command]
fn rename_path(root: String, from: String, to: String) -> Res<()> {
    let (src, dst) = (resolve(&root, &from)?, resolve(&root, &to)?);
    if src == dst {
        return Ok(());
    }
    let case_only = from.to_lowercase() == to.to_lowercase();
    if dst.exists() && !case_only {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::rename(&src, &dst).map_err(err)
}

#[tauri::command]
fn remove_file(root: String, path: String) -> Res<()> {
    match fs::remove_file(resolve(&root, &path)?) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[tauri::command]
fn make_dir(root: String, path: String) -> Res<()> {
    fs::create_dir_all(resolve(&root, &path)?).map_err(err)
}

/// Remove a folder. Only succeeds when it is empty, so non-note files are never lost.
#[tauri::command]
fn remove_dir(root: String, path: String) -> Res<()> {
    match fs::remove_dir(resolve(&root, &path)?) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
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
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Read files the user picked to import.
#[tauri::command]
fn read_external(paths: Vec<String>) -> Res<Vec<ExtFile>> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let body = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            Ok(ExtFile { name: stem(path), body })
        })
        .collect()
}

fn read_ext_dir(path: &Path, depth: u8) -> Res<ExtDir> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in fs::read_dir(path).map_err(err)?.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        if p.is_dir() && depth > 0 {
            dirs.push(read_ext_dir(&p, depth - 1)?);
        } else if p.is_file() && is_note(&p) {
            if let Ok(body) = fs::read_to_string(&p) {
                files.push(ExtFile { name: stem(&p), body });
            }
        }
    }
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(ExtDir { name, files, dirs })
}

/// Read a folder the user picked to import: its notes plus one level of subfolders.
#[tauri::command]
fn read_external_dir(path: String) -> Res<ExtDir> {
    read_ext_dir(Path::new(&path), 1)
}

/// Write a file to a location the user picked in a save / folder dialog.
#[tauri::command]
fn write_external(path: String, contents: String) -> Res<()> {
    write_atomic(Path::new(&path), &contents)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            load_legacy,
            retire_legacy,
            default_root,
            scan,
            write_file,
            rename_path,
            remove_file,
            make_dir,
            remove_dir,
            read_external,
            read_external_dir,
            write_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running monkeynotes");
}
