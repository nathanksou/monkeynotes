/**
 * The notes folder, held in memory and kept in sync with the disk.
 *
 * Changes are applied to memory right away (so the UI never waits) and the
 * matching file operations run one at a time on a queue. Notes made in the app
 * are named after their title and renamed as the title changes; files that came
 * from elsewhere keep whatever name they had.
 */
import type { Backend, ExtDir, ExtFile, FileEntry, Scan } from "./backend";
import { type Folder, META_FILE, type Note, ROOT, TRASH_DIR, TRASH_TTL_MS, titleLine, uid } from "./model";

interface Meta {
  pinned?: string[];
  /** Keyed by file name inside .trash/. */
  trash?: Record<string, { from: string; deletedAt: number }>;
}

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Turn a title into something every OS accepts as a file or folder name. */
export function safeName(title: string, fallback = "untitled"): string {
  let name = title.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "").slice(0, 80).trim();
  if (!name) name = fallback;
  if (RESERVED.test(name)) name += "_";
  return name;
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ROOT);
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stemOf = (path: string) => baseOf(path).replace(/\.[^.]+$/, "");
const extOf = (path: string) => (/\.[^./]+$/.exec(path)?.[0] ?? ".md");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export class Vault {
  folders: Folder[] = [];
  notes: Note[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = new Set<Note>();
  private timer = 0;
  private lastMeta = "";
  /** Title notes by file name instead of first line (see setTitleFromFile). */
  titleFromFile = false;
  /** Called with a message when a file operation fails. */
  onError: (msg: string) => void = (m) => console.error(m);

  constructor(
    private be: Backend,
    readonly root: string,
  ) {}

  // ---------------------------------------------------------------- loading

  async load(): Promise<void> {
    const scan = await this.be.scan(this.root);
    this.folders = this.foldersFrom(scan);
    const meta = this.parseMeta(scan.meta);
    const pinned = new Set(meta.pinned ?? []);
    this.notes = scan.files.map((f) => this.fromFile(f, meta, pinned));
    // Recently deleted notes are purged after 30 days, but only ones this app put
    // there: another app's .trash (Obsidian uses one too) is never purged.
    const cutoff = Date.now() - TRASH_TTL_MS;
    for (const n of this.notes.filter((x) => x.deletedAt && !x.foreignTrash && x.deletedAt < cutoff)) {
      this.destroy(n);
    }
    this.lastMeta = JSON.stringify(this.buildMeta());
  }

  /**
   * Pick up changes made outside the app (another editor, a sync client).
   * Returns true if the given note's text changed on disk.
   */
  async reload(openId: string | null): Promise<boolean> {
    await this.flush();
    const scan = await this.be.scan(this.root);
    this.folders = this.foldersFrom(scan);
    const byPath = new Map(this.notes.filter((n) => n.path).map((n) => [n.path, n]));
    let openChanged = false;
    const seen = new Set<Note>();
    const meta = this.parseMeta(scan.meta);
    for (const f of scan.files) {
      const existing = byPath.get(f.path);
      if (existing) {
        seen.add(existing);
        if (existing.body !== f.body && !this.dirty.has(existing)) {
          existing.body = f.body;
          existing.updatedAt = f.modified;
          if (existing.id === openId) openChanged = true;
        }
      } else {
        const n = this.fromFile(f, meta, new Set());
        this.notes.push(n);
        seen.add(n);
      }
    }
    // Files that disappeared; unsaved new notes stay.
    this.notes = this.notes.filter((n) => !n.path || seen.has(n) || this.dirty.has(n));
    return openChanged;
  }

  private fromFile(f: FileEntry, meta: Meta, pinned: Set<string>): Note {
    const inTrash = dirOf(f.path) === TRASH_DIR;
    const t = inTrash ? meta.trash?.[baseOf(f.path)] : undefined;
    return {
      id: uid(),
      path: f.path,
      folderId: inTrash ? (t?.from ?? ROOT) : dirOf(f.path),
      body: f.body,
      createdAt: f.created,
      updatedAt: f.modified,
      pinned: pinned.has(f.path) || undefined,
      deletedAt: inTrash ? (t?.deletedAt ?? f.modified) : undefined,
      foreignTrash: inTrash && !t ? true : undefined,
      autoName: this.followsTitle(f.path, f.body),
    };
  }

  /** Whether a file's name should keep tracking its title. */
  private followsTitle(path: string, body: string): boolean {
    return !this.titleFromFile && stemOf(path) === safeName(titleLine(body));
  }

  /**
   * In "file name" title mode existing files are never renamed automatically,
   * so links from other apps (like Obsidian's [[links]]) keep working.
   */
  setTitleFromFile(on: boolean): void {
    this.titleFromFile = on;
    for (const n of this.notes) if (n.path) n.autoName = this.followsTitle(n.path, n.body);
  }

  /** Give a note's file a name of the user's choosing; it stops following the title. */
  renameNote(n: Note, name: string): void {
    const dir = n.deletedAt ? TRASH_DIR : n.folderId;
    const target = this.uniquePath(dir, safeName(name), n.path ? extOf(n.path) : ".md", n);
    const from = n.path;
    const body = n.body;
    n.autoName = false;
    n.path = target;
    this.dirty.delete(n);
    if (from && from !== target) this.run("rename", () => this.be.rename(this.root, from, target));
    this.run("save", () => this.be.write(this.root, target, body));
    this.schedule(); // pins / trash metadata are keyed by path
  }

  private foldersFrom(scan: Scan): Folder[] {
    return [{ id: ROOT, name: "notes" }, ...scan.dirs.map((d) => ({ id: d, name: d }))];
  }

  private parseMeta(raw: string | null): Meta {
    try {
      return raw ? (JSON.parse(raw) as Meta) : {};
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------------- queue

  private run(label: string, op: () => Promise<unknown>): Promise<void> {
    const p = this.queue.then(op).catch((e) => this.onError(`${label}: ${e}`));
    this.queue = p;
    return p as Promise<void>;
  }

  /** Write everything pending and wait for the disk to catch up. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    for (const n of [...this.dirty]) this.saveNote(n);
    this.dirty.clear();
    this.saveMeta();
    await this.queue;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 400);
  }

  // ---------------------------------------------------------------- naming

  /** A free path in `dir` for `stem`, ignoring `self`'s current path. */
  private uniquePath(dir: string, stem: string, ext: string, self?: Note): string {
    const taken = new Set(this.notes.filter((n) => n !== self && n.path).map((n) => n.path.toLowerCase()));
    for (let i = 1; ; i++) {
      const p = join(dir, `${stem}${i > 1 ? ` ${i}` : ""}${ext}`);
      if (!taken.has(p.toLowerCase())) return p;
    }
  }

  private wantedPath(n: Note): string {
    const dir = n.deletedAt ? TRASH_DIR : n.folderId;
    const ext = n.path ? extOf(n.path) : ".md";
    if (n.path && !n.autoName && dirOf(n.path) === dir) return n.path;
    const stem = n.autoName || !n.path ? safeName(titleLine(n.body)) : stemOf(n.path);
    const current = n.path && dirOf(n.path) === dir && stemOf(n.path).replace(/ \d+$/, "") === stem;
    return current ? n.path : this.uniquePath(dir, stem, ext, n);
  }

  /** Queue whatever file operations bring `n` up to date on disk. */
  private saveNote(n: Note): void {
    if (!this.notes.includes(n)) return;
    if (!n.path && n.body.trim() === "") return; // a brand-new empty note isn't a file yet
    const target = this.wantedPath(n);
    const from = n.path;
    const body = n.body;
    n.path = target;
    if (from && from !== target) this.run("rename", () => this.be.rename(this.root, from, target));
    this.run("save", () => this.be.write(this.root, target, body));
  }

  private buildMeta(): Meta {
    const trash: Meta["trash"] = {};
    for (const n of this.notes) {
      if (n.deletedAt && n.path && !n.foreignTrash) trash[baseOf(n.path)] = { from: n.folderId, deletedAt: n.deletedAt };
    }
    return { pinned: this.notes.filter((n) => n.pinned && n.path).map((n) => n.path), trash };
  }

  private saveMeta(): void {
    const json = JSON.stringify(this.buildMeta());
    if (json === this.lastMeta) return;
    this.lastMeta = json;
    this.run("save metadata", () => this.be.write(this.root, META_FILE, JSON.stringify(JSON.parse(json), null, 2)));
  }

  // ---------------------------------------------------------------- notes

  get(id: string | null): Note | undefined {
    return id ? this.notes.find((n) => n.id === id) : undefined;
  }

  findByPath(path: string | null): Note | undefined {
    return path ? this.notes.find((n) => n.path === path) : undefined;
  }

  create(folderId: string, body = "", nameHint?: string): Note {
    const now = Date.now();
    const n: Note = { id: uid(), path: "", folderId, body, createdAt: now, updatedAt: now, autoName: true };
    if (nameHint !== undefined) {
      n.autoName = safeName(nameHint) === safeName(titleLine(body));
      n.path = this.uniquePath(folderId, safeName(nameHint), ".md");
      this.notes.push(n);
      const { path } = n;
      this.run("import", () => this.be.write(this.root, path, body));
      return n;
    }
    this.notes.push(n);
    if (body) this.touch(n);
    return n;
  }

  setBody(n: Note, body: string): void {
    if (n.deletedAt) return;
    n.body = body;
    n.updatedAt = Date.now();
    this.touch(n);
  }

  private touch(n: Note): void {
    this.dirty.add(n);
    this.schedule();
  }

  /** Forget an empty note that was never saved. */
  discardIfBlank(n: Note | undefined): boolean {
    if (!n || n.path || n.body.trim() !== "") return false;
    this.notes = this.notes.filter((x) => x !== n);
    this.dirty.delete(n);
    return true;
  }

  move(n: Note, folderId: string): void {
    if (n.deletedAt || n.folderId === folderId) return;
    n.folderId = folderId;
    this.touch(n);
  }

  togglePin(n: Note): void {
    n.pinned = !n.pinned || undefined;
    this.schedule();
  }

  trash(n: Note): void {
    if (this.discardIfBlank(n)) return;
    n.deletedAt = Date.now();
    n.pinned = undefined;
    this.touch(n);
  }

  restore(n: Note): void {
    if (!n.deletedAt) return;
    n.deletedAt = undefined;
    n.foreignTrash = undefined;
    if (!this.folders.some((f) => f.id === n.folderId)) n.folderId = ROOT;
    this.touch(n);
  }

  destroy(n: Note): void {
    this.notes = this.notes.filter((x) => x !== n);
    this.dirty.delete(n);
    if (n.path) {
      const { path } = n;
      this.run("delete", () => this.be.remove(this.root, path));
    }
    this.schedule();
  }

  emptyTrash(): void {
    for (const n of this.notes.filter((x) => x.deletedAt)) this.destroy(n);
  }

  // ---------------------------------------------------------------- folders

  private uniqueFolder(name: string, self?: string): string {
    const taken = new Set(this.folders.filter((f) => f.id !== self).map((f) => f.id.toLowerCase()));
    for (let i = 1; ; i++) {
      const id = `${name}${i > 1 ? ` ${i}` : ""}`;
      if (!taken.has(id.toLowerCase()) && id !== TRASH_DIR) return id;
    }
  }

  createFolder(name: string): Folder {
    const id = this.uniqueFolder(safeName(name, "folder"));
    const f = { id, name: id };
    this.folders.push(f);
    this.folders.sort((a, b) => (a.id === ROOT ? -1 : b.id === ROOT ? 1 : a.name.localeCompare(b.name)));
    this.run("create folder", () => this.be.mkdir(this.root, id));
    return f;
  }

  renameFolder(id: string, name: string): string {
    const f = this.folders.find((x) => x.id === id);
    if (!f || id === ROOT) return id;
    const next = this.uniqueFolder(safeName(name, "folder"), id);
    if (next === id) return id;
    f.id = f.name = next;
    for (const n of this.notes) {
      if (n.folderId !== id) continue;
      n.folderId = next;
      if (!n.deletedAt && n.path) n.path = join(next, baseOf(n.path));
    }
    this.run("rename folder", () => this.be.rename(this.root, id, next));
    this.schedule(); // trash metadata may point at the old name
    return next;
  }

  /** Moves the folder's notes to recently deleted, then removes the folder if it is empty. */
  deleteFolder(id: string): void {
    if (id === ROOT) return;
    for (const n of this.notes.filter((x) => x.folderId === id)) {
      if (!n.deletedAt) this.trash(n);
      n.folderId = ROOT;
    }
    this.folders = this.folders.filter((f) => f.id !== id);
    void this.flush().then(() =>
      this.run("remove folder", () =>
        this.be.rmdir(this.root, id).catch(() => {
          /* folder still holds non-note files; leave it */
        }),
      ),
    );
  }

  // ---------------------------------------------------------------- import

  importFiles(folderId: string, files: ExtFile[]): Note[] {
    return files.map((f) => this.create(folderId, f.body, f.name));
  }

  importDir(dir: ExtDir): { folder: Folder; count: number } {
    const folder = this.createFolder(dir.name || "imported");
    let count = this.importFiles(folder.id, dir.files).length;
    for (const sub of dir.dirs) {
      const f = this.createFolder(sub.name);
      count += this.importFiles(f.id, sub.files).length;
    }
    return { folder, count };
  }
}
