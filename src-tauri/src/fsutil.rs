//! std-only file-system helpers for monkeynotes (no tauri / serde), so the logic
//! can be unit-tested on its own:
//! `rustc --edition 2021 --test src/fsutil.rs -o /tmp/fsutil_test && /tmp/fsutil_test`
//!
//! Everything here is "pure" in the sense of taking paths and returning plain
//! values; `lib.rs` wraps the results in serde types and Tauri commands.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub type Res<T> = Result<T, String>;

pub const NOTE_EXTS: [&str; 3] = ["md", "markdown", "txt"];
pub const TRASH_DIR: &str = ".trash";
pub const META_FILE: &str = ".monkeynotes.json";
/// How deep folders are scanned and imported.
pub const MAX_DEPTH: u8 = 8;
/// Bigger files are left alone: they're almost certainly not notes.
pub const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;
/// Most text a single scan / import / export moves around at once.
pub const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Most notes a single scan / import / export handles at once.
pub const MAX_FILES: usize = 50_000;
/// Settings file cap.
pub const MAX_STATE_BYTES: u64 = 64 * 1024 * 1024;
/// A scan lists at most this many paths whose bodies were left out.
pub const MAX_UNLOADED_LISTED: usize = 10_000;
/// Error prefix the UI looks for to pick another name instead of overwriting.
pub const EEXIST: &str = "EEXIST";
/// Error prefix for "the file you're acting on isn't there (any more)".
pub const NOT_FOUND: &str = "NOT_FOUND";
/// Error prefix for "this is more than the app is willing to handle".
pub const TOO_LARGE: &str = "TOO_LARGE";
/// Files the OS drops into folders; they don't stop a folder from being deleted.
pub const JUNK_FILES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];
/// Leftover temp files younger than this may belong to a running write.
pub const STALE_TMP_AGE: Duration = Duration::from_secs(60 * 60);

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn is_note(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| NOTE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

pub fn millis(t: std::io::Result<SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

/// Refuse a single note body that is bigger than a note may be.
pub fn check_note_len(len: usize) -> Res<()> {
    if len as u64 > MAX_NOTE_BYTES {
        return Err(format!(
            "{TOO_LARGE}: a note can be at most {} MiB",
            mib(MAX_NOTE_BYTES)
        ));
    }
    Ok(())
}

/// Refuse a settings file that is absurdly large.
pub fn check_state_len(len: usize) -> Res<()> {
    if len as u64 > MAX_STATE_BYTES {
        return Err(format!(
            "{TOO_LARGE}: settings can be at most {} MiB",
            mib(MAX_STATE_BYTES)
        ));
    }
    Ok(())
}

// ------------------------------------------------------------------ budget

/// Aggregate cap on bytes and file count for one operation.
pub struct Budget {
    max_bytes: u64,
    max_files: usize,
    bytes: u64,
    files: usize,
    full: bool,
}

impl Budget {
    pub fn new(max_bytes: u64, max_files: usize) -> Self {
        Budget {
            max_bytes,
            max_files,
            bytes: 0,
            files: 0,
            full: false,
        }
    }

    pub fn standard() -> Self {
        Self::new(MAX_TOTAL_BYTES, MAX_FILES)
    }

    /// Reserve room for one more file of `len` bytes. Once a reservation has
    /// failed, every later one fails too (so what is left out is predictable).
    pub fn take(&mut self, len: u64) -> bool {
        if self.full || self.files >= self.max_files || self.bytes.saturating_add(len) > self.max_bytes {
            self.full = true;
            return false;
        }
        self.files += 1;
        self.bytes += len;
        true
    }

    pub fn error(&self) -> String {
        format!(
            "{TOO_LARGE}: more than {} MiB of notes or more than {} notes",
            mib(self.max_bytes),
            self.max_files
        )
    }
}

// ------------------------------------------------------------------ writing

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `.mn-<pid>-<n>.tmp` is the only shape of temp name that holds a half-written
/// copy of something (see `is_write_temp_name`); the startup sweep may delete these.
pub fn temp_beside(path: &Path) -> PathBuf {
    // A short fixed name in the same folder, so a note whose own name is close to
    // the file system's limit can still be saved.
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".mn-{}-{n}.tmp", std::process::id()))
}

/// A temp name for stepping a file or folder through a rename. Unlike
/// `temp_beside` this may hold the ONLY copy of someone's data if we crash, so
/// the sweep never deletes it.
pub fn rename_temp_beside(path: &Path) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".mn-mv-{}-{n}.tmp", std::process::id()))
}

/// Write `contents` to `tmp` and make sure it reached the disk.
pub fn write_temp(tmp: &Path, contents: &str) -> Res<()> {
    let mut f = File::create(tmp).map_err(err)?;
    f.write_all(contents.as_bytes()).map_err(err)?;
    f.sync_all().map_err(err)
}

/// Make a rename in `dir` survive a power cut (Unix; Windows has no equivalent).
pub fn sync_dir(dir: Option<&Path>) {
    #[cfg(unix)]
    if let Some(d) = dir.and_then(|d| File::open(d).ok()) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Give `tmp` the permissions of the file it is about to replace (best effort).
pub fn copy_permissions(existing: &Path, tmp: &Path) {
    if let Ok(m) = fs::metadata(existing) {
        if m.is_file() {
            let _ = fs::set_permissions(tmp, m.permissions());
        }
    }
}

/// Write via a synced temp file + rename so a crash never leaves a
/// half-written or empty note. The replaced file's permissions are kept.
pub fn write_atomic(path: &Path, contents: &str) -> Res<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = temp_beside(path);
    if let Err(e) = write_temp(&tmp, contents) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    copy_permissions(path, &tmp);
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err(e));
    }
    sync_dir(path.parent());
    Ok(())
}

/// Like write_atomic, but fails with EEXIST instead of replacing a file that
/// already exists. Uses a hard link, which can't replace anything, so even a
/// file that appears at the last moment (a sync client) is safe; on disks
/// without hard links it falls back to checking first.
pub fn write_new(path: &Path, contents: &str, label: &str) -> Res<()> {
    if path.exists() {
        return Err(format!("{EEXIST}: {label}"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = temp_beside(path);
    if let Err(e) = write_temp(&tmp, contents) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
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

// ------------------------------------------------------------------ reading

/// Read a text file the user picked, refusing huge or non-text files.
pub fn read_note_file(path: &Path) -> Res<String> {
    let len = fs::metadata(path).map_err(err)?.len();
    if len > MAX_NOTE_BYTES {
        return Err(format!("{} is too large to be a note", path.display()));
    }
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The metadata file, or None if it's missing, not a plain file, huge or unreadable:
/// a damaged metadata file must never stop the notes from loading, and a symlink
/// there must not be followed out of the notes folder.
pub fn read_meta(path: &Path) -> Option<String> {
    let m = fs::symlink_metadata(path).ok()?;
    if !m.file_type().is_file() || m.len() > MAX_NOTE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

pub enum TextRead {
    Missing,
    Text(String),
    /// Not valid UTF-8, or bigger than allowed.
    Unusable,
}

pub fn read_text(path: &Path, max_bytes: u64) -> Res<TextRead> {
    match fs::metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(TextRead::Missing),
        Err(e) => return Err(err(e)),
        Ok(m) if m.len() > max_bytes => return Ok(TextRead::Unusable),
        Ok(_) => {}
    }
    match fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8(bytes).map_or(TextRead::Unusable, TextRead::Text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(TextRead::Missing),
        Err(e) => Err(err(e)),
    }
}

/// Set a damaged file aside as "<name>.corrupt" (or ".corrupt.1" ... if taken).
pub fn quarantine(path: &Path) {
    for i in 0..100 {
        let mut name = path.as_os_str().to_owned();
        name.push(".corrupt");
        if i > 0 {
            name.push(format!(".{i}"));
        }
        let cand = PathBuf::from(name);
        if fs::symlink_metadata(&cand).is_err() {
            let _ = fs::rename(path, &cand);
            return;
        }
    }
}

/// Utf-8 file stem of a picked file, or None if the name isn't valid UTF-8.
pub fn utf8_stem(path: &Path) -> Option<String> {
    path.file_name()?.to_str()?;
    path.file_stem()?.to_str().map(str::to_owned)
}

// ------------------------------------------------------------------ scanning

pub struct ScanFile {
    pub path: String,
    /// None when the caller already has this version (same modified time).
    pub body: Option<String>,
    pub created: u64,
    pub modified: u64,
}

#[derive(Default)]
pub struct ScanOut {
    pub dirs: Vec<String>,
    pub files: Vec<ScanFile>,
    pub meta: Option<String>,
    /// Notes that exist but whose bodies were NOT loaded because the scan hit
    /// its size or count cap. They are not in `files`. (Listing is capped.)
    pub unloaded: Vec<String>,
    pub unloaded_count: u64,
}

fn join_rel(rel_dir: &str, name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_owned()
    } else {
        format!("{rel_dir}/{name}")
    }
}

fn dir_of(root: &Path, rel_dir: &str) -> PathBuf {
    if rel_dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel_dir)
    }
}

pub fn read_notes(
    root: &Path,
    rel_dir: &str,
    known: &HashMap<String, u64>,
    out: &mut ScanOut,
    budget: &mut Budget,
) -> Res<()> {
    let dir = dir_of(root, rel_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        // a subfolder we can't read (e.g. "System Volume Information") is skipped
        Err(e) if rel_dir.is_empty() => return Err(err(e)),
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Names that aren't valid UTF-8 can't be shown, saved or renamed
        // faithfully (and two of them could collapse into one): skip them.
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else { continue };
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false); // not through symlinks
        if is_hidden(name) || !is_file || !is_note(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_NOTE_BYTES {
            continue;
        }
        let modified = millis(meta.modified()).unwrap_or(0);
        let created = millis(meta.created()).unwrap_or(modified);
        let rel = join_rel(rel_dir, name);
        let unchanged = modified != 0 && known.get(&rel) == Some(&modified);
        // A caller-known body costs nothing but a slot; a new one costs its size.
        if !budget.take(if unchanged { 0 } else { meta.len() }) {
            out.unloaded_count += 1;
            if out.unloaded.len() < MAX_UNLOADED_LISTED {
                out.unloaded.push(rel);
            }
            continue;
        }
        let body = if unchanged {
            None
        } else {
            // Skip files that aren't valid UTF-8 rather than failing the whole scan.
            let Ok(text) = fs::read_to_string(&path) else { continue };
            Some(text)
        };
        out.files.push(ScanFile {
            path: rel,
            body,
            created,
            modified,
        });
    }
    Ok(())
}

/// Collect `rel_dir`'s subfolders (any depth, not following symlinks) and their notes.
pub fn scan_dirs(
    root: &Path,
    rel_dir: &str,
    depth: u8,
    known: &HashMap<String, u64>,
    out: &mut ScanOut,
    budget: &mut Budget,
) -> Res<()> {
    let dir = dir_of(root, rel_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if rel_dir.is_empty() => return Err(err(e)),
        Err(_) => return Ok(()), // unreadable subfolder: skip it, keep the rest
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else { continue }; // non-UTF-8 folder name: skip
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false); // symlinks are not dirs here
        if is_hidden(name) || !is_dir {
            continue;
        }
        let rel = join_rel(rel_dir, name);
        read_notes(root, &rel, known, out, budget)?;
        if depth > 1 {
            scan_dirs(root, &rel, depth - 1, known, out, budget)?;
        }
        out.dirs.push(rel);
    }
    Ok(())
}

pub fn scan_root_with(root: &Path, known: &HashMap<String, u64>, mut budget: Budget) -> Res<ScanOut> {
    let mut out = ScanOut::default();
    read_notes(root, "", known, &mut out, &mut budget)?;
    scan_dirs(root, "", MAX_DEPTH, known, &mut out, &mut budget)?;
    // a .trash that's a symlink would pull in notes from outside the folder
    let trash_is_dir = fs::symlink_metadata(root.join(TRASH_DIR)).is_ok_and(|m| m.is_dir());
    if trash_is_dir {
        read_notes(root, TRASH_DIR, known, &mut out, &mut budget)?;
    }
    out.dirs.sort_by_key(|d| d.to_lowercase());
    out.meta = read_meta(&root.join(META_FILE));
    Ok(out)
}

pub fn scan_root(root: &Path, known: &HashMap<String, u64>) -> Res<ScanOut> {
    scan_root_with(root, known, Budget::standard())
}

// ------------------------------------------------------------------ external folders (import)

pub struct ExtFile {
    pub name: String,
    pub body: String,
}

pub struct ExtDir {
    pub name: String,
    pub files: Vec<ExtFile>,
    pub dirs: Vec<ExtDir>,
}

/// Read a folder of notes. Entries with non-UTF-8 names are skipped. Going over
/// `budget` fails the whole import with a TOO_LARGE error.
pub fn read_ext_dir(path: &Path, depth: u8, budget: &mut Budget) -> Res<ExtDir> {
    let name = match path.file_name() {
        None => String::new(),
        Some(n) => n
            .to_str()
            .ok_or_else(|| format!("{} has a name that isn't valid UTF-8", path.display()))?
            .to_owned(),
    };
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in fs::read_dir(path).map_err(err)?.flatten() {
        let p = entry.path();
        let file_name = entry.file_name();
        let Some(entry_name) = file_name.to_str() else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        if is_hidden(entry_name) {
            continue;
        }
        if kind.is_dir() && depth > 0 {
            match read_ext_dir(&p, depth - 1, budget) {
                Ok(sub) => dirs.push(sub),
                Err(e) if e.starts_with(TOO_LARGE) => return Err(e),
                Err(_) => {} // unreadable subfolders are skipped
            }
        } else if kind.is_file() && is_note(&p) {
            let Some(stem) = utf8_stem(&p) else { continue };
            if let Ok(body) = read_note_file(&p) {
                if !budget.take(body.len() as u64) {
                    return Err(budget.error());
                }
                files.push(ExtFile { name: stem, body });
            }
        }
    }
    Ok(ExtDir { name, files, dirs })
}

// ------------------------------------------------------------------ renames

/// Rename `src` to `dst` where the two names differ only by case, by going
/// through `tmp`. Ok(true): renamed. Ok(false): `dst` is a different, existing
/// file; nothing changed. On failure the original name is restored if possible.
pub fn case_only_rename(src: &Path, dst: &Path, tmp: &Path) -> Res<bool> {
    fs::rename(src, tmp).map_err(err)?;
    if dst.exists() {
        let _ = fs::rename(tmp, src);
        return Ok(false);
    }
    match fs::rename(tmp, dst) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = fs::rename(tmp, src);
            Err(err(e))
        }
    }
}

/// Rename without ever replacing what's at `dst` (EEXIST). Files are moved with
/// a hard link + unlink, which can't replace anything even if `dst` appears at
/// the last moment; folders (and disks without hard links) check first.
pub fn rename_no_clobber(src: &Path, dst: &Path, from: &str, to: &str) -> Res<()> {
    if src == dst {
        return Ok(());
    }
    if fs::symlink_metadata(src).is_err() {
        return Err(format!("{NOT_FOUND}: {from}"));
    }
    if to.to_lowercase().starts_with(&format!("{}/", from.to_lowercase())) {
        return Err(format!("can't move {from} into itself"));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    if from.to_lowercase() == to.to_lowercase() {
        // Case-only rename ("notes" -> "Notes"). On a case-insensitive disk dst
        // "exists" because it's the same file; on a case-sensitive one it may be
        // a different file. Go through a temp name and check which it is.
        let tmp = rename_temp_beside(src);
        return match case_only_rename(src, dst, &tmp)? {
            true => Ok(()),
            false => Err(format!("{EEXIST}: {to}")),
        };
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

/// Move `dir/name` to a free "<stem>[ n].<ext>" in `dir`, never overwriting an
/// earlier backup. Does nothing if `dir/name` isn't there.
pub fn retire_backup(dir: &Path, name: &str, stem: &str, ext: &str) -> Res<()> {
    let old = dir.join(name);
    if fs::symlink_metadata(&old).is_err() {
        return Ok(());
    }
    for i in 1..1000 {
        let to = if i == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} {i}.{ext}")
        };
        match rename_no_clobber(&old, &dir.join(&to), name, &to) {
            Err(e) if e.starts_with(EEXIST) => continue,
            other => return other,
        }
    }
    Err(format!("too many backups of {name}"))
}

/// Remove a folder, only if it is empty apart from OS junk files.
pub fn remove_dir_if_empty(target: &Path) -> Res<()> {
    if let Ok(entries) = fs::read_dir(target) {
        let names: Vec<_> = entries.flatten().map(|e| e.file_name()).collect();
        if names.iter().all(|n| JUNK_FILES.iter().any(|j| n == *j)) {
            for n in &names {
                let _ = fs::remove_file(target.join(n));
            }
        }
    }
    match fs::remove_dir(target) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

// ------------------------------------------------------------------ history helpers

/// "1793740000000.md" -> 1793740000000 (digits only, canonical form)
pub fn version_of(name: &OsStr) -> Option<u64> {
    let digits = name.to_str()?.strip_suffix(".md")?;
    let n: u64 = digits.parse().ok()?;
    (n.to_string() == digits).then_some(n)
}

/// The first free "<at>.md" in `dir` at or after `at`.
pub fn free_version_name(dir: &Path, mut at: u64) -> PathBuf {
    while fs::symlink_metadata(dir.join(format!("{at}.md"))).is_ok() {
        at += 1;
    }
    dir.join(format!("{at}.md"))
}

/// Move a whole folder's history into `dst`, keeping everything: entries that
/// collide are merged (folders) or renumbered (versions). Only version files are
/// ever moved, and `src` is removed only if nothing but empty folders is left
/// (never recursively), so other files are never deleted.
pub fn merge_dir(src: &Path, dst: &Path) -> Res<()> {
    match fs::symlink_metadata(dst) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(err)?;
            }
            return fs::rename(src, dst).map_err(err);
        }
        Err(e) => return Err(err(e)),
        Ok(m) if !m.is_dir() => {
            return Err(format!("can't merge history into {}: it isn't a folder", dst.display()));
        }
        Ok(_) => {}
    }
    for entry in fs::read_dir(src).map_err(err)?.flatten() {
        let name = entry.file_name();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            merge_dir(&entry.path(), &dst.join(&name))?;
        } else if kind.is_file() {
            if let Some(at) = version_of(&name) {
                fs::rename(entry.path(), free_version_name(dst, at)).map_err(err)?;
            }
        }
    }
    let _ = fs::remove_dir(src); // only succeeds once empty
    Ok(())
}

// ------------------------------------------------------------------ export names

fn with_suffix(path: &str, n: usize) -> String {
    let name_start = path.rfind('/').map_or(0, |i| i + 1);
    match path[name_start..].rfind('.') {
        Some(d) if d > 0 => {
            let at = name_start + d;
            format!("{} {n}{}", &path[..at], &path[at..])
        }
        _ => format!("{path} {n}"),
    }
}

/// Make paths unique ignoring case ("a.md" / "A.md" collide on case-insensitive
/// disks): later duplicates become "A 2.md", "A 3.md" ...
pub fn dedup_ci(paths: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let mut cand = p.clone();
        let mut n = 1;
        while !seen.insert(cand.to_lowercase()) {
            n += 1;
            cand = with_suffix(p, n);
        }
        out.push(cand);
    }
    out
}

// ------------------------------------------------------------------ stale temp files

/// True for `.mn-<pid>-<n>.tmp`, the temp files of `write_atomic` / `write_new`.
pub fn is_write_temp_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".mn-").and_then(|r| r.strip_suffix(".tmp")) else {
        return false;
    };
    let mut parts = rest.split('-');
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match (parts.next(), parts.next(), parts.next()) {
        (Some(a), Some(b), None) => all_digits(a) && all_digits(b),
        _ => false,
    }
}

/// Delete leftover write temp files (plain files only, never symlinks, never
/// folders, never rename temps) older than `min_age` in `dir` and, up to
/// `max_depth` levels, below it. Returns how many were removed.
pub fn sweep_stale_tmp_at(dir: &Path, max_depth: u8, min_age: Duration, now: SystemTime) -> usize {
    let mut visited = 200_000usize;
    sweep_inner(dir, max_depth, min_age, now, &mut visited)
}

pub fn sweep_stale_tmp(dir: &Path, max_depth: u8) -> usize {
    sweep_stale_tmp_at(dir, max_depth, STALE_TMP_AGE, SystemTime::now())
}

fn sweep_inner(dir: &Path, depth: u8, min_age: Duration, now: SystemTime, visited: &mut usize) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        if *visited == 0 {
            break;
        }
        *visited -= 1;
        let Ok(kind) = entry.file_type() else { continue }; // does not follow symlinks
        if kind.is_dir() {
            if depth > 0 {
                removed += sweep_inner(&entry.path(), depth - 1, min_age, now, visited);
            }
        } else if kind.is_file() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else { continue };
            if !is_write_temp_name(name) {
                continue;
            }
            let old = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age >= min_age);
            if old && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    static N: AtomicU64 = AtomicU64::new(0);

    fn scratch(name: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("mn-fsutil-{name}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn budget_caps_bytes_and_count_and_stays_full() {
        let mut b = Budget::new(10, 3);
        assert!(b.take(4));
        assert!(b.take(6));
        assert!(!b.take(1)); // bytes
        assert!(!b.take(0)); // stays full
        let mut c = Budget::new(100, 2);
        assert!(c.take(0) && c.take(0));
        assert!(!c.take(0)); // count
        assert!(c.error().starts_with(TOO_LARGE));
    }

    #[test]
    fn note_and_state_length_checks() {
        assert!(check_note_len(MAX_NOTE_BYTES as usize).is_ok());
        assert!(check_note_len(MAX_NOTE_BYTES as usize + 1)
            .unwrap_err()
            .starts_with(TOO_LARGE));
        assert!(check_state_len(10).is_ok());
        assert!(check_state_len(MAX_STATE_BYTES as usize + 1).is_err());
    }

    #[test]
    fn version_names_are_canonical_digits() {
        assert_eq!(version_of(OsStr::new("123.md")), Some(123));
        assert_eq!(version_of(OsStr::new("0.md")), Some(0));
        for bad in ["+5.md", "007.md", "-1.md", "a.md", "12.txt", ".md", "12", "1 2.md"] {
            assert_eq!(version_of(OsStr::new(bad)), None, "{bad}");
        }
    }

    #[test]
    fn write_temp_names_are_recognised_but_rename_temps_are_not() {
        assert!(is_write_temp_name(".mn-123-4.tmp"));
        assert!(is_write_temp_name(
            &temp_beside(Path::new("/x/a.md")).file_name().unwrap().to_string_lossy()
        ));
        for bad in [
            ".mn-mv-1-2.tmp",
            ".mn-1.tmp",
            ".mn-1-2-3.tmp",
            ".mn--1.tmp",
            "mn-1-2.tmp",
            ".mn-1-2.txt",
            "x.md",
            ".mn-a-b.tmp",
        ] {
            assert!(!is_write_temp_name(bad), "{bad}");
        }
        let t = rename_temp_beside(Path::new("/x/a.md"));
        assert!(!is_write_temp_name(&t.file_name().unwrap().to_string_lossy()));
    }

    #[test]
    fn sweep_removes_only_old_write_temps_without_following_links() {
        let root = scratch("sweep");
        fs::create_dir_all(root.join("a/.monkeynotes/history/x.md")).unwrap();
        fs::write(root.join(".mn-1-1.tmp"), "x").unwrap();
        fs::write(root.join("a/.monkeynotes/history/x.md/.mn-2-2.tmp"), "x").unwrap();
        fs::write(root.join("keep.md"), "x").unwrap();
        fs::write(root.join(".mn-mv-1-1.tmp"), "precious").unwrap();
        fs::create_dir_all(root.join(".mn-3-3.tmp")).unwrap(); // a folder: never touched
        fs::write(root.join(".mn-3-3.tmp/inner.md"), "x").unwrap();
        let now = SystemTime::now();
        // too young: nothing goes
        assert_eq!(sweep_stale_tmp_at(&root, 8, STALE_TMP_AGE, now), 0);
        let later = now + Duration::from_secs(2 * 3600);
        // depth limit: only the top-level one
        assert_eq!(sweep_stale_tmp_at(&root, 0, STALE_TMP_AGE, later), 1);
        assert_eq!(sweep_stale_tmp_at(&root, 8, STALE_TMP_AGE, later), 1);
        assert!(root.join("keep.md").exists());
        assert!(root.join(".mn-mv-1-1.tmp").exists());
        assert!(root.join(".mn-3-3.tmp/inner.md").exists());
        #[cfg(unix)]
        {
            let outside = scratch("sweep-outside");
            fs::write(outside.join(".mn-9-9.tmp"), "outside").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.join(".mn-9-9.tmp"), root.join(".mn-8-8.tmp")).unwrap();
            assert_eq!(sweep_stale_tmp_at(&root, 8, STALE_TMP_AGE, later), 0);
            assert!(outside.join(".mn-9-9.tmp").exists());
            fs::remove_dir_all(&outside).unwrap();
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn dedup_is_case_insensitive_and_keeps_extensions() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            dedup_ci(&v(&["a.md", "A.md", "a.MD", "b.md", "x/a.md", "X/A.md"])),
            ["a.md", "A 2.md", "a 3.MD", "b.md", "x/a.md", "X/A 2.md"]
        );
        // a generated name that is itself taken
        assert_eq!(dedup_ci(&v(&["a.md", "a 2.md", "A.md"])), ["a.md", "a 2.md", "A 3.md"]);
        assert_eq!(
            dedup_ci(&v(&["dir.v1/noext", "DIR.V1/NOEXT"])),
            ["dir.v1/noext", "DIR.V1/NOEXT 2"]
        );
        assert_eq!(dedup_ci(&v(&[".md", ".MD"])), [".md", ".MD 2"]);
    }

    #[test]
    fn write_atomic_replaces_cleans_up_and_handles_long_names() {
        let root = scratch("atomic");
        let long = format!("{}.md", "a".repeat(240));
        let f = root.join(&long);
        write_atomic(&f, "one").unwrap();
        write_atomic(&f, "two").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "two");
        assert_eq!(names(&root), std::slice::from_ref(&long));
        // failure (target is a folder) leaves no temp file behind
        let d = root.join("dir.md");
        fs::create_dir(&d).unwrap();
        fs::write(d.join("x"), "x").unwrap();
        assert!(write_atomic(&d, "nope").is_err());
        assert_eq!(names(&root), [long, "dir.md".to_string()]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("perm");
        let f = root.join("a.md");
        fs::write(&f, "x").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&f, "y").unwrap();
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o640);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_new_never_overwrites() {
        let root = scratch("new");
        let f = root.join("a.md");
        write_new(&f, "first", "a.md").unwrap();
        assert!(write_new(&f, "second", "a.md").unwrap_err().starts_with(EEXIST));
        assert_eq!(fs::read_to_string(&f).unwrap(), "first");
        assert_eq!(names(&root), ["a.md"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_trash_is_not_read() {
        let root = scratch("trashlink");
        let outside = scratch("trashlink-outside");
        fs::write(outside.join("secret.md"), "outside").unwrap();
        std::os::unix::fs::symlink(&outside, root.join(TRASH_DIR)).unwrap();
        fs::write(root.join("a.md"), "a").unwrap();
        let out = scan_root(&root, &HashMap::new()).unwrap();
        let paths: Vec<_> = out.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.md"]);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn scan_skips_hidden_nested_and_reuses_known() {
        let root = scratch("scan");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join("top.md"), "top").unwrap();
        fs::write(root.join("a/b/deep.md"), "deep").unwrap();
        fs::write(root.join(".obsidian/app.md"), "hidden").unwrap();
        let first = scan_root(&root, &HashMap::new()).unwrap();
        assert_eq!(first.files.len(), 2);
        assert_eq!(first.dirs, ["a", "a/b"]);
        let known: HashMap<_, _> = first.files.iter().map(|f| (f.path.clone(), f.modified)).collect();
        let second = scan_root(&root, &known).unwrap();
        assert!(second.files.iter().all(|f| f.body.is_none()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scan_stops_loading_bodies_past_the_caps_and_lists_them() {
        let root = scratch("scancap");
        for i in 0..5 {
            fs::write(root.join(format!("n{i}.md")), "12345").unwrap();
        }
        // byte cap: room for 2 bodies of 5 bytes
        let out = scan_root_with(&root, &HashMap::new(), Budget::new(10, 100)).unwrap();
        assert_eq!(out.files.len(), 2);
        assert!(out.files.iter().all(|f| f.body.is_some()));
        assert_eq!(out.unloaded_count, 3);
        assert_eq!(out.unloaded.len(), 3);
        for u in &out.unloaded {
            assert!(!out.files.iter().any(|f| &f.path == u));
        }
        // count cap
        let out = scan_root_with(&root, &HashMap::new(), Budget::new(1000, 4)).unwrap();
        assert_eq!((out.files.len(), out.unloaded_count), (4, 1));
        // known bodies cost no bytes
        let full = scan_root(&root, &HashMap::new()).unwrap();
        let known: HashMap<_, _> = full.files.iter().map(|f| (f.path.clone(), f.modified)).collect();
        let out = scan_root_with(&root, &known, Budget::new(0, 100)).unwrap();
        assert_eq!((out.files.len(), out.unloaded_count), (5, 0));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_meta_file_gives_none() {
        let root = scratch("meta");
        fs::write(root.join("a.md"), "a").unwrap();
        assert!(scan_root(&root, &HashMap::new()).unwrap().meta.is_none());
        fs::write(root.join(META_FILE), "{\"pins\":[]}").unwrap();
        assert_eq!(
            scan_root(&root, &HashMap::new()).unwrap().meta.as_deref(),
            Some("{\"pins\":[]}")
        );
        fs::write(root.join(META_FILE), [0xff, 0xfe, 0x00]).unwrap(); // not UTF-8
        assert!(scan_root(&root, &HashMap::new()).unwrap().meta.is_none());
        fs::remove_file(root.join(META_FILE)).unwrap();
        fs::create_dir(root.join(META_FILE)).unwrap(); // not a file
        let scan = scan_root(&root, &HashMap::new()).unwrap();
        assert!(scan.meta.is_none());
        assert_eq!(scan.files.len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    // macOS file systems refuse names that aren't UTF-8, so there's nothing to skip there
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn non_utf8_names_are_skipped_everywhere() {
        use std::os::unix::ffi::OsStrExt;
        let root = scratch("nonutf8");
        let bad = OsStr::from_bytes(b"caf\xE9.md");
        let bad_dir = OsStr::from_bytes(b"d\xE9");
        fs::write(root.join(bad), "bad").unwrap();
        fs::write(root.join("good.md"), "good").unwrap();
        fs::create_dir(root.join(bad_dir)).unwrap();
        fs::write(root.join(bad_dir).join("inner.md"), "inner").unwrap();
        let out = scan_root(&root, &HashMap::new()).unwrap();
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].path, "good.md");
        assert!(out.dirs.is_empty());

        let ext = read_ext_dir(&root, 3, &mut Budget::standard()).unwrap();
        assert_eq!(ext.files.len(), 1);
        assert_eq!(ext.files[0].name, "good");
        assert!(ext.dirs.is_empty());

        assert!(utf8_stem(&root.join(bad)).is_none());
        assert_eq!(utf8_stem(&root.join("good.md")).as_deref(), Some("good"));
        // a non-UTF-8 import root is refused with a message
        assert!(read_ext_dir(&root.join(bad_dir), 3, &mut Budget::standard()).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn import_over_the_cap_fails_with_too_large() {
        let root = scratch("import");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "12345").unwrap();
        fs::write(root.join("sub/b.md"), "12345").unwrap();
        assert!(read_ext_dir(&root, 3, &mut Budget::new(100, 100)).is_ok());
        let e = read_ext_dir(&root, 3, &mut Budget::new(7, 100)).err().unwrap();
        assert!(e.starts_with(TOO_LARGE));
        let e = read_ext_dir(&root, 3, &mut Budget::new(100, 1)).err().unwrap();
        assert!(e.starts_with(TOO_LARGE));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_refuses_clobbering_missing_sources_and_descendants() {
        let root = scratch("rename");
        let e = rename_no_clobber(&root.join("gone.md"), &root.join("x.md"), "gone.md", "x.md").unwrap_err();
        assert!(e.starts_with(NOT_FOUND));
        fs::create_dir_all(root.join("a/sub")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        assert!(rename_no_clobber(&root.join("a"), &root.join("b"), "a", "b")
            .unwrap_err()
            .starts_with(EEXIST));
        let e = rename_no_clobber(&root.join("a"), &root.join("a/sub/a"), "a", "a/sub/a").unwrap_err();
        assert!(e.contains("into itself"), "{e}");
        let e = rename_no_clobber(&root.join("a"), &root.join("A/x"), "a", "A/x").unwrap_err();
        assert!(e.contains("into itself"), "{e}");
        assert!(root.join("a/sub").is_dir());
        fs::write(root.join("f.md"), "f").unwrap();
        fs::write(root.join("g.md"), "g").unwrap();
        assert!(
            rename_no_clobber(&root.join("f.md"), &root.join("g.md"), "f.md", "g.md")
                .unwrap_err()
                .starts_with(EEXIST)
        );
        rename_no_clobber(&root.join("f.md"), &root.join("h.md"), "f.md", "h.md").unwrap();
        assert!(!root.join("f.md").exists() && root.join("h.md").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn case_only_rename_restores_on_failure_and_leaves_no_temp() {
        let root = scratch("case");
        let src = root.join("notes.md");
        fs::write(&src, "lower").unwrap();
        let tmp = rename_temp_beside(&src);
        // dst's parent is missing: the final rename fails, and src comes back
        let dst = root.join("missing-dir/Notes.md");
        assert!(case_only_rename(&src, &dst, &tmp).is_err());
        assert_eq!(fs::read_to_string(&src).unwrap(), "lower");
        assert_eq!(names(&root), ["notes.md"]);
        // real case-only rename
        let dst = root.join("Notes.md");
        let sensitive = !root.join("NOTES.md").exists();
        let tmp = rename_temp_beside(&src);
        if sensitive {
            fs::write(&dst, "upper").unwrap();
            assert!(!case_only_rename(&src, &dst, &tmp).unwrap());
            assert_eq!(fs::read_to_string(&src).unwrap(), "lower");
            assert_eq!(fs::read_to_string(&dst).unwrap(), "upper");
        } else {
            assert!(case_only_rename(&src, &dst, &tmp).unwrap());
            assert_eq!(names(&root), ["Notes.md"]);
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn retire_backup_never_overwrites_an_earlier_backup() {
        let root = scratch("retire");
        retire_backup(&root, "notes.json", "notes.v1", "json").unwrap(); // nothing there: fine
        fs::write(root.join("notes.json"), "one").unwrap();
        retire_backup(&root, "notes.json", "notes.v1", "json").unwrap();
        fs::write(root.join("notes.json"), "two").unwrap();
        retire_backup(&root, "notes.json", "notes.v1", "json").unwrap();
        assert_eq!(fs::read_to_string(root.join("notes.v1.json")).unwrap(), "one");
        assert_eq!(fs::read_to_string(root.join("notes.v1 2.json")).unwrap(), "two");
        assert!(!root.join("notes.json").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn remove_dir_if_empty_ignores_junk_but_not_notes() {
        let root = scratch("rmdir");
        let d = root.join("d");
        fs::create_dir(&d).unwrap();
        fs::write(d.join(".DS_Store"), "j").unwrap();
        fs::write(d.join("Thumbs.db"), "j").unwrap();
        remove_dir_if_empty(&d).unwrap();
        assert!(!d.exists());
        fs::create_dir(&d).unwrap();
        fs::write(d.join(".DS_Store"), "j").unwrap();
        fs::write(d.join("a.md"), "keep").unwrap();
        assert!(remove_dir_if_empty(&d).is_err());
        assert!(d.join("a.md").exists());
        assert!(d.join(".DS_Store").exists(), "junk stays when real files are there");
        remove_dir_if_empty(&root.join("never-existed")).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn merge_dir_renumbers_collisions_and_keeps_foreign_files() {
        let root = scratch("merge");
        let (src, dst) = (root.join("src"), root.join("dst"));
        fs::create_dir_all(src.join("note.md")).unwrap();
        fs::create_dir_all(dst.join("note.md")).unwrap();
        fs::write(src.join("note.md/5.md"), "src5").unwrap();
        fs::write(dst.join("note.md/5.md"), "dst5").unwrap();
        fs::write(src.join("7.md"), "src7").unwrap();
        fs::write(src.join("README.txt"), "not a version").unwrap();
        merge_dir(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("note.md/5.md")).unwrap(), "dst5");
        assert_eq!(fs::read_to_string(dst.join("note.md/6.md")).unwrap(), "src5");
        assert_eq!(fs::read_to_string(dst.join("7.md")).unwrap(), "src7");
        // the foreign file survives, and so does the folder holding it
        assert_eq!(fs::read_to_string(src.join("README.txt")).unwrap(), "not a version");
        assert!(!src.join("note.md").exists(), "emptied folders are removed");

        // dst missing: plain move; dst a file: clear error
        let (s2, d2) = (root.join("s2"), root.join("deep/d2"));
        fs::create_dir_all(&s2).unwrap();
        fs::write(s2.join("1.md"), "x").unwrap();
        merge_dir(&s2, &d2).unwrap();
        assert!(d2.join("1.md").exists() && !s2.exists());
        let (s3, f3) = (root.join("s3"), root.join("file"));
        fs::create_dir_all(&s3).unwrap();
        fs::write(s3.join("1.md"), "x").unwrap();
        fs::write(&f3, "i am a file").unwrap();
        let e = merge_dir(&s3, &f3).unwrap_err();
        assert!(e.contains("isn't a folder"), "{e}");
        assert!(s3.join("1.md").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_text_and_quarantine_handle_bad_files() {
        let root = scratch("state");
        let f = root.join("state.json");
        assert!(matches!(read_text(&f, 100).unwrap(), TextRead::Missing));
        fs::write(&f, "{}").unwrap();
        assert!(matches!(read_text(&f, 100).unwrap(), TextRead::Text(s) if s == "{}"));
        assert!(matches!(read_text(&f, 1).unwrap(), TextRead::Unusable));
        fs::write(&f, [0xff, 0xfe]).unwrap();
        assert!(matches!(read_text(&f, 100).unwrap(), TextRead::Unusable));
        quarantine(&f);
        assert!(!f.exists() && root.join("state.json.corrupt").exists());
        fs::write(&f, [0xff]).unwrap();
        quarantine(&f);
        assert!(root.join("state.json.corrupt.1").exists());
        assert_eq!(fs::read(root.join("state.json.corrupt")).unwrap(), [0xff, 0xfe]);
        fs::remove_dir_all(&root).unwrap();
    }
}
