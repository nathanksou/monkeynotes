/**
 * Development only: a fake notes folder kept in localStorage, so the UI can run
 * in a plain browser (`npm run dev`) and be tested with Playwright without the
 * desktop shell. Never included in release builds (see createBackend).
 */
import type { Backend, ExtFile, Scan } from "./backend";

interface MemFile {
  body: string;
  created: number;
  modified: number;
}

export class BrowserBackend implements Backend {
  readonly desktop = false;
  private key = "monkeynotes:fs";
  private files: Record<string, MemFile> = {};
  private dirs: string[] = [];

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) ?? "null");
      if (raw) ({ files: this.files, dirs: this.dirs } = raw);
      this.history = JSON.parse(localStorage.getItem("monkeynotes:history") ?? "{}");
    } catch {
      /* start empty */
    }
  }

  private saveHistory(): void {
    localStorage.setItem("monkeynotes:history", JSON.stringify(this.history));
  }

  // version history: path -> { timestamp: text }
  history: Record<string, Record<number, string>> = {};
  async historySave(path: string, contents: string) {
    let at = Date.now();
    const h = (this.history[path] ??= {});
    while (h[at] !== undefined) at++;
    h[at] = contents;
    const keep = Object.keys(h).map(Number).sort((a, b) => b - a).slice(0, 50);
    for (const k of Object.keys(h).map(Number)) if (!keep.includes(k)) delete h[k];
    this.saveHistory();
    return at;
  }
  async historyList(path: string) {
    return Object.keys(this.history[path] ?? {}).map(Number).sort((a, b) => b - a);
  }
  async historyRead(path: string, at: number) {
    const v = this.history[path]?.[at];
    if (v === undefined) throw `no version ${at} of ${path}`;
    return v;
  }
  async historyMove(from: string, to: string, folder: boolean) {
    for (const p of Object.keys(this.history)) {
      const next = folder ? (p.startsWith(from + "/") ? to + p.slice(from.length) : p) : p === from ? to : p;
      if (next !== p) {
        this.history[next] = { ...this.history[p], ...(this.history[next] ?? {}) };
        delete this.history[p];
      }
    }
    this.saveHistory();
  }
  async historyDelete(path: string) {
    delete this.history[path];
    this.saveHistory();
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
