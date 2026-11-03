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

  importFiles = () => invoke<ExtFile[] | null>("import_files");
  importDir = () => invoke<ExtDir | null>("import_dir");
  exportNote = (name: string, contents: string) => invoke<boolean>("export_note", { name, contents });
  exportAll = (files: { path: string; body: string }[]) =>
    invoke<string | null>("export_all", {
      folderName: `monkeynotes-export-${new Date().toISOString().slice(0, 10)}`,
      files,
    });
}

// ------------------------------------------------------------------ browser (dev)

interface MemFile {
  body: string;
  created: number;
  modified: number;
}

class BrowserBackend implements Backend {
  readonly desktop = false;
  private key = "monkeynotes:fs";
  private files: Record<string, MemFile> = {};
  private dirs: string[] = [];

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) ?? "null");
      if (raw) ({ files: this.files, dirs: this.dirs } = raw);
    } catch {
      /* start empty */
    }
  }

  private persist(): void {
    localStorage.setItem(this.key, JSON.stringify({ files: this.files, dirs: this.dirs }));
  }

  async loadState() {
    return localStorage.getItem("monkeynotes:state");
  }
  async saveState(contents: string) {
    localStorage.setItem("monkeynotes:state", contents);
  }
  async loadLegacy() {
    return localStorage.getItem("monkeynotes:db");
  }
  async retireLegacy() {
    localStorage.removeItem("monkeynotes:db");
  }
  async notesDir() {
    return "browser storage";
  }
  async chooseNotesDir() {
    return null;
  }
  async resetNotesDir() {
    return "browser storage";
  }

  async scan(known: Record<string, number> = {}): Promise<Scan> {
    const files = Object.entries(this.files)
      .filter(([p]) => p !== ".monkeynotes.json")
      .map(([path, f]) => ({ path, ...f, body: known[path] === f.modified ? null : f.body }));
    return { dirs: [...this.dirs].sort(), files, meta: this.files[".monkeynotes.json"]?.body ?? null };
  }
  async write(path: string, body: string, createNew: boolean) {
    if (createNew && this.files[path]) throw `EEXIST: ${path}`;
    const now = Date.now();
    this.files[path] = { body, created: this.files[path]?.created ?? now, modified: now };
    this.persist();
  }
  async rename(from: string, to: string) {
    const swap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    if (this.dirs.includes(from)) {
      if (this.dirs.includes(to)) throw `EEXIST: ${to}`;
      this.dirs = this.dirs.map(swap);
      for (const p of Object.keys(this.files)) {
        const next = swap(p);
        if (next !== p) {
          this.files[next] = this.files[p];
          delete this.files[p];
        }
      }
    } else {
      if (this.files[to] && from !== to) throw `EEXIST: ${to}`;
      this.files[to] = this.files[from];
      delete this.files[from];
    }
    this.persist();
  }
  async remove(path: string) {
    delete this.files[path];
    this.persist();
  }
  async mkdir(path: string) {
    if (path.startsWith(".")) return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.dirs.includes(dir)) this.dirs.push(dir);
    }
    this.persist();
  }
  async rmdir(path: string) {
    const inside = (p: string) => p.startsWith(path + "/");
    if (Object.keys(this.files).some(inside) || this.dirs.some(inside)) throw new Error("folder not empty");
    this.dirs = this.dirs.filter((d) => d !== path);
    this.persist();
  }

  importFiles(): Promise<ExtFile[] | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".md,.markdown,.txt,text/plain,text/markdown";
      input.addEventListener("change", async () => {
        const list = [...(input.files ?? [])];
        resolve(
          list.length
            ? await Promise.all(list.map(async (f) => ({ name: f.name.replace(/\.[^.]+$/, ""), body: await f.text() })))
            : null,
        );
      });
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  }
  async importDir() {
    return null;
  }
  async exportNote(name: string, body: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
    a.download = `${name}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  }
  async exportAll() {
    return null;
  }
}

export const backend: Backend = "__TAURI_INTERNALS__" in window ? new TauriBackend() : new BrowserBackend();
