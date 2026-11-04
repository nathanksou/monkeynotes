/**
 * Everything that touches the disk. The desktop app talks to the Rust commands
 * in src-tauri/src/lib.rs; `npm run dev` in a browser uses a small in-memory
 * file system persisted to localStorage so the UI can be worked on without Tauri.
 *
 * Paths here are always relative to the notes folder. The notes folder itself,
 * and any file outside it, is chosen through native dialogs on the Rust side.
 */
import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  path: string;
  /** null when the file hasn't changed since the modified time we passed in */
  body: string | null;
  created: number;
  modified: number;
}

export interface Scan {
  dirs: string[];
  files: FileEntry[];
  meta: string | null;
}

/** A file brought in by an import. */
export interface ExtFile {
  name: string;
  body: string;
}

export interface ExtDir {
  name: string;
  files: ExtFile[];
  dirs: ExtDir[];
}

export interface Backend {
  readonly desktop: boolean;
  loadState(): Promise<string | null>;
  saveState(contents: string): Promise<void>;
  loadLegacy(): Promise<string | null>;
  retireLegacy(): Promise<void>;

  notesDir(): Promise<string>;
  /** Ask the user for a new notes folder. Null if cancelled. */
  chooseNotesDir(): Promise<string | null>;
  /** Go back to the default folder (only until restart if `persist` is false). */
  resetNotesDir(persist: boolean): Promise<string>;

  /** `known` maps paths to modified times; matching files come back without a body. */
  scan(known?: Record<string, number>): Promise<Scan>;
  /** With `createNew`, fails with EEXIST instead of replacing an existing file. */
  write(path: string, contents: string, createNew: boolean): Promise<void>;
  /** Fails with EEXIST instead of replacing an existing file. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;

  /** Store a version of the note at `path`; returns its timestamp. */
  historySave(path: string, contents: string): Promise<number>;
  /** Version timestamps for the note at `path`, newest first. */
  historyList(path: string): Promise<number[]>;
  historyRead(path: string, at: number): Promise<string>;
  /** Move history after a note (or, with `folder`, a folder) was renamed. */
  historyMove(from: string, to: string, folder: boolean): Promise<void>;
  historyDelete(path: string): Promise<void>;

  /** Ask the user for note files to import. Null if cancelled. */
  importFiles(): Promise<ExtFile[] | null>;
  /** Ask the user for a folder to import. Null if cancelled (or unsupported). */
  importDir(): Promise<ExtDir | null>;
  /** Save one note somewhere the user chooses. Returns false if cancelled. */
  exportNote(name: string, body: string): Promise<boolean>;
  /** Copy notes into a new folder the user chooses. Null if cancelled (or unsupported). */
  exportAll(files: { path: string; body: string }[]): Promise<string | null>;
}

// ------------------------------------------------------------------ desktop

class TauriBackend implements Backend {
  readonly desktop = true;

  loadState = () => invoke<string | null>("load_state");
  saveState = (contents: string) => invoke<void>("save_state", { contents });
  loadLegacy = () => invoke<string | null>("load_legacy");
  retireLegacy = () => invoke<void>("retire_legacy");

  notesDir = () => invoke<string>("notes_dir");
  chooseNotesDir = () => invoke<string | null>("choose_notes_dir");
  resetNotesDir = (persist: boolean) => invoke<string>("reset_notes_dir", { persist });

  scan = (known?: Record<string, number>) => invoke<Scan>("scan", { known: known ?? null });
  write = (path: string, contents: string, createNew: boolean) =>
    invoke<void>("write_file", { path, contents, createNew });
  rename = (from: string, to: string) => invoke<void>("rename_path", { from, to });
  remove = (path: string) => invoke<void>("remove_file", { path });
  mkdir = (path: string) => invoke<void>("make_dir", { path });
  rmdir = (path: string) => invoke<void>("remove_dir", { path });

  historySave = (path: string, contents: string) => invoke<number>("history_save", { path, contents });
  historyList = (path: string) => invoke<number[]>("history_list", { path });
  historyRead = (path: string, at: number) => invoke<string>("history_read", { path, at });
  historyMove = (from: string, to: string, folder: boolean) => invoke<void>("history_move", { from, to, folder });
  historyDelete = (path: string) => invoke<void>("history_delete", { path });

  importFiles = () => invoke<ExtFile[] | null>("import_files");
  importDir = () => invoke<ExtDir | null>("import_dir");
  exportNote = (name: string, contents: string) => invoke<boolean>("export_note", { name, contents });
  exportAll = (files: { path: string; body: string }[]) =>
    invoke<string | null>("export_all", {
      folderName: `monkeynotes-export-${new Date().toISOString().slice(0, 10)}`,
      files,
    });
}

// ------------------------------------------------------------------ choosing one

/** Thrown when the app is opened somewhere other than the desktop shell. */
export class NotDesktopError extends Error {}

/**
 * The desktop backend, or, in development builds only, the in-browser one used
 * by `npm run dev` and the UI tests. Release builds don't contain it at all:
 * `import.meta.env.DEV` is false there, so the bundler drops the import.
 */
export async function createBackend(): Promise<Backend> {
  if ("__TAURI_INTERNALS__" in window) return new TauriBackend();
  if (import.meta.env.DEV) {
    const { BrowserBackend } = await import("./backend-browser");
    return new BrowserBackend();
  }
  throw new NotDesktopError("monkeynotes is a desktop app");
}
