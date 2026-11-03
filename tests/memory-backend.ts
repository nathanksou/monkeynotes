import type { Backend, Scan } from "../src/backend";

/** An in-memory notes folder for tests. */
export class MemoryBackend implements Backend {
  readonly desktop = false;
  files = new Map<string, { body: string; created: number; modified: number }>();
  dirs = new Set<string>();
  ops: string[] = [];

  constructor(seed: Record<string, string> = {}, modified = Date.now()) {
    for (const [path, body] of Object.entries(seed)) {
      this.files.set(path, { body, created: modified, modified });
      const parts = path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (!d.startsWith(".")) this.dirs.add(d);
      }
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
  async defaultRoot() {
    return "/notes";
  }

  async scan(): Promise<Scan> {
    return {
      dirs: [...this.dirs].sort(),
      files: [...this.files].filter(([p]) => p !== ".monkeynotes.json").map(([path, f]) => ({ path, ...f })),
      meta: this.files.get(".monkeynotes.json")?.body ?? null,
    };
  }
  async write(_r: string, path: string, body: string) {
    this.ops.push(`write ${path}`);
    const now = Date.now();
    this.files.set(path, { body, created: this.files.get(path)?.created ?? now, modified: now });
  }
  async rename(_r: string, from: string, to: string) {
    this.ops.push(`rename ${from} -> ${to}`);
    if (this.dirs.has(from)) {
      const swap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
      this.dirs = new Set([...this.dirs].map(swap));
      this.files = new Map([...this.files].map(([p, f]) => [swap(p), f]));
      return;
    }
    if (this.files.has(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`${to} exists`);
    const f = this.files.get(from);
    if (!f) throw new Error(`${from} missing`);
    this.files.delete(from);
    this.files.set(to, f);
  }
  async remove(_r: string, path: string) {
    this.ops.push(`remove ${path}`);
    this.files.delete(path);
  }
  async mkdir(_r: string, path: string) {
    this.dirs.add(path);
  }
  async rmdir(_r: string, path: string) {
    const inside = (p: string) => p.startsWith(path + "/");
    if ([...this.files.keys()].some(inside) || [...this.dirs].some(inside)) throw new Error("not empty");
    this.dirs.delete(path);
  }
  async pickImportFiles() {
    return null;
  }
  async pickImportDir() {
    return null;
  }
  async exportNote() {
    return false;
  }
  async exportAll() {
    return null;
  }
  async pickNotesDir() {
    return null;
  }
}
