import type { Backend, Scan } from "../src/backend";

/** An in-memory notes folder for tests. Mirrors the Rust commands' rules. */
export class MemoryBackend implements Backend {
  readonly desktop = false;
  files = new Map<string, { body: string; created: number; modified: number }>();
  dirs = new Set<string>();
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
    return {
      dirs: [...this.dirs].sort(),
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
    if (!f) throw `${from} missing`;
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
