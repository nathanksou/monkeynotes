/**
 * Everything that touches the disk. The desktop app talks to the Rust commands
 * in src-tauri/src/lib.rs; `npm run dev` in a browser uses a small in-memory
 * file system persisted to localStorage so the UI can be worked on without Tauri.
 */
import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  path: string;
  body: string;
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
  defaultRoot(): Promise<string>;

  scan(root: string): Promise<Scan>;
  write(root: string, path: string, contents: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  remove(root: string, path: string): Promise<void>;
  mkdir(root: string, path: string): Promise<void>;
  rmdir(root: string, path: string): Promise<void>;

  /** Ask the user for note files to import. Null if cancelled. */
  pickImportFiles(): Promise<ExtFile[] | null>;
  /** Ask the user for a folder to import. Null if cancelled (or unsupported). */
  pickImportDir(): Promise<ExtDir | null>;
  /** Save one note somewhere the user chooses. Returns false if cancelled. */
  exportNote(suggestedName: string, body: string): Promise<boolean>;
  /** Copy every note into a folder the user chooses. Null if cancelled. */
  exportAll(files: { path: string; body: string }[]): Promise<string | null>;
  /** Ask the user for a new notes folder. */
  pickNotesDir(): Promise<string | null>;
}

// ------------------------------------------------------------------ desktop

class TauriBackend implements Backend {
  readonly desktop = true;

  loadState = () => invoke<string | null>("load_state");
  saveState = (contents: string) => invoke<void>("save_state", { contents });
  loadLegacy = () => invoke<string | null>("load_legacy");
  retireLegacy = () => invoke<void>("retire_legacy");
  defaultRoot = () => invoke<string>("default_root");

  scan = (root: string) => invoke<Scan>("scan", { root });
  write = (root: string, path: string, contents: string) => invoke<void>("write_file", { root, path, contents });
  rename = (root: string, from: string, to: string) => invoke<void>("rename_path", { root, from, to });
  remove = (root: string, path: string) => invoke<void>("remove_file", { root, path });
  mkdir = (root: string, path: string) => invoke<void>("make_dir", { root, path });
  rmdir = (root: string, path: string) => invoke<void>("remove_dir", { root, path });

  async pickImportFiles(): Promise<ExtFile[] | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      title: "import notes",
      filters: [{ name: "notes", extensions: ["md", "markdown", "txt"] }],
    });
    if (!picked || !picked.length) return null;
    return invoke<ExtFile[]>("read_external", { paths: picked });
  }

  async pickImportDir(): Promise<ExtDir | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: "import a folder of notes" });
    if (!picked) return null;
    return invoke<ExtDir>("read_external_dir", { path: picked });
  }

  async exportNote(suggestedName: string, body: string): Promise<boolean> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "export note",
      defaultPath: `${suggestedName}.md`,
      filters: [{ name: "markdown", extensions: ["md"] }],
    });
    if (!path) return false;
    await invoke("write_external", { path, contents: body });
    return true;
  }

  async exportAll(files: { path: string; body: string }[]): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dest = await open({ directory: true, title: "export all notes into..." });
    if (!dest) return null;
    const stamp = new Date().toISOString().slice(0, 10);
    const sep = dest.includes("\\") && !dest.includes("/") ? "\\" : "/";
    const base = `${dest}${sep}monkeynotes-export-${stamp}`;
    for (const f of files) {
      await invoke("write_external", { path: `${base}${sep}${f.path.split("/").join(sep)}`, contents: f.body });
    }
    return base;
  }

  async pickNotesDir(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    return (await open({ directory: true, title: "choose a notes folder" })) ?? null;
  }
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
  async defaultRoot() {
    return "browser";
  }

  async scan(): Promise<Scan> {
    const files = Object.entries(this.files)
      .filter(([p]) => p !== ".monkeynotes.json")
      .map(([path, f]) => ({ path, ...f }));
    return { dirs: [...this.dirs].sort(), files, meta: this.files[".monkeynotes.json"]?.body ?? null };
  }
  async write(_root: string, path: string, body: string) {
    const now = Date.now();
    this.files[path] = { body, created: this.files[path]?.created ?? now, modified: now };
    this.persist();
  }
  async rename(_root: string, from: string, to: string) {
    if (this.dirs.includes(from)) {
      const swap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
      this.dirs = this.dirs.map(swap);
      for (const p of Object.keys(this.files)) {
        const next = swap(p);
        if (next !== p) {
          this.files[next] = this.files[p];
          delete this.files[p];
        }
      }
    } else {
      if (this.files[to] && from.toLowerCase() !== to.toLowerCase()) throw new Error(`${to} already exists`);
      this.files[to] = this.files[from];
      delete this.files[from];
    }
    this.persist();
  }
  async remove(_root: string, path: string) {
    delete this.files[path];
    this.persist();
  }
  async mkdir(_root: string, path: string) {
    if (path.startsWith(".")) return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.dirs.includes(dir)) this.dirs.push(dir);
    }
    this.persist();
  }
  async rmdir(_root: string, path: string) {
    const inside = (p: string) => p.startsWith(path + "/");
    if (Object.keys(this.files).some(inside) || this.dirs.some(inside)) throw new Error("folder not empty");
    this.dirs = this.dirs.filter((d) => d !== path);
    this.persist();
  }

  pickImportFiles(): Promise<ExtFile[] | null> {
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
  async pickImportDir() {
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
  async pickNotesDir() {
    return null;
  }
}

export const backend: Backend = "__TAURI_INTERNALS__" in window ? new TauriBackend() : new BrowserBackend();
