import type { Backend, Scan } from "../src/backend";

/** An in-memory notes folder for tests. Mirrors the Rust commands' rules. */
export class MemoryBackend implements Backend {
  readonly desktop = false;
  files = new Map<string, { body: string; created: number; modified: number }>();
  dirs = new Set<string>();
  /** Runs in the middle of a scan, to simulate the user acting while it reads. */
  duringScan: (() => void) | null = null;
  /** Make the next write to a path fail, as a full disk or locked file would. */
  failWrites = new Set<string>();
  private clock = 1_000_000;

  constructor(seed: Record<string, string> = {}, modified?: number) {
    for (const [path, body] of Object.entries(seed)) this.put(path, body, modified);
  }

  /** Simulate another program changing the folder. */
  put(path: string, body: string, modified = ++this.clock): void {
    this.files.set(path, { body, created: modified, modified });
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!d.startsWith(".")) this.dirs.add(d);
    }
  }

  paths(): string[] {
    return [...this.files.keys()].filter((p) => p !== ".monkeynotes.json").sort();
  }

  async loadState() {
    return null;
  }
  async saveState() {}
  async loadLegacy() {
    return null;
  }
  async retireLegacy() {}
  async notesDir() {
    return "/notes";
  }
  async chooseNotesDir() {
    return null;
  }
  async resetNotesDir() {
    return "/notes";
  }

  async scan(known: Record<string, number> = {}): Promise<Scan> {
    const snapshot = new Map(this.files);
    const dirs = [...this.dirs].sort();
    const hook = this.duringScan;
    this.duringScan = null;
    hook?.();
    await new Promise((r) => setTimeout(r, 0)); // let anything the hook queued try to run
    const files = this.files;
    this.files = snapshot; // report what was on disk when the scan started
    try {
      return this.result(known, dirs);
    } finally {
      this.files = files;
    }
  }

  private result(known: Record<string, number>, dirs: string[]): Scan {
    return {
      dirs,
      files: [...this.files]
        .filter(([p]) => p !== ".monkeynotes.json")
        .map(([path, f]) => ({ path, ...f, body: known[path] === f.modified ? null : f.body })),
      meta: this.files.get(".monkeynotes.json")?.body ?? null,
    };
  }
  async write(path: string, body: string, createNew: boolean) {
    if (this.failWrites.delete(path)) throw "disk full";
    if (createNew && this.files.has(path)) throw `EEXIST: ${path}`;
    this.put(path, body);
  }
  async rename(from: string, to: string) {
    const swap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    if (this.dirs.has(from)) {
      if (this.dirs.has(to)) throw `EEXIST: ${to}`;
      this.dirs = new Set([...this.dirs].map(swap));
      this.files = new Map([...this.files].map(([p, f]) => [swap(p), f]));
      return;
    }
    if (this.files.has(to)) throw `EEXIST: ${to}`;
    const f = this.files.get(from);
    if (!f) throw `NOT_FOUND: ${from}`;
    this.files.delete(from);
    this.files.set(to, f);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async mkdir(path: string) {
    this.dirs.add(path);
  }
  async rmdir(path: string) {
    const inside = (p: string) => p.startsWith(path + "/");
    if ([...this.files.keys()].some(inside) || [...this.dirs].some(inside)) throw "not empty";
    this.dirs.delete(path);
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
    
  }
  async historyClear(paths: string[] | null, since: number | null, dryRun: boolean) {
    let removed = 0;
    for (const [path, versions] of Object.entries(this.history)) {
      if (paths && !paths.includes(path)) continue;
      for (const at of Object.keys(versions).map(Number)) {
        if (since !== null && at < since) continue;
        removed++;
        if (!dryRun) delete versions[at];
      }
      if (!dryRun && !Object.keys(versions).length) delete this.history[path];
    }
    return removed;
  }
  async historyDelete(path: string) {
    delete this.history[path];
    
  }
  async importFiles() {
    return null;
  }
  async importDir() {
    return null;
  }
  async exportNote() {
    return false;
  }
  async exportAll() {
    return null;
  }
}
