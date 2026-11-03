use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// Whether we've already taken this launch's backup of notes.json.
static BACKED_UP: AtomicBool = AtomicBool::new(false);

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("notes.json"))
}

/// Returns the raw notes file, or `None` on first launch.
#[tauri::command]
fn load_db(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(db_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomically replaces the notes file. The first save of each launch keeps
/// the previous file as notes.json.bak.
#[tauri::command]
fn save_db(app: AppHandle, contents: String) -> Result<(), String> {
    // Refuse to write something that isn't valid JSON.
    serde_json::from_str::<serde_json::Value>(&contents).map_err(|e| e.to_string())?;

    let path = db_path(&app)?;
    if path.exists() && !BACKED_UP.swap(true, Ordering::SeqCst) {
        fs::copy(&path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Where notes live on disk, for the "show data folder" command.
#[tauri::command]
fn data_dir(app: AppHandle) -> Result<String, String> {
    let path = db_path(&app)?;
    Ok(path.parent().unwrap_or(&path).display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_db, save_db, data_dir])
        .run(tauri::generate_context!())
        .expect("error while running monkeynotes");
}
