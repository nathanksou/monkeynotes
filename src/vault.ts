/**
 * The notes folder, held in memory and kept in sync with the disk.
 *
 * Changes are applied to memory right away (so the UI never waits) and the
 * matching file operations run one at a time on a queue. Each queued operation
 * decides file names when it runs, from the state of the disk at that moment,
 * and `Note.path` only changes once the disk has actually changed.
 *
 * Safety rules:
 * - a new or renamed note never replaces an existing file (the backend refuses
 *   with EEXIST and we pick another name);
 * - a save that fails stays pending, so a later reload can't replace the
 *   unsaved text with the stale copy on disk.
 *
 * Notes made in the app are named after their title and renamed as the title
 * changes; files that came from elsewhere keep whatever name they had.
 */
import type { Backend, ExtDir, ExtFile, FileEntry, Scan } from "./backend";
import { isExists } from "./errors";
import { baseOf, dirOf, extOf, join, stemOf, swapPrefix } from "./paths";
import { type Folder, META_FILE, type Note, ROOT, TRASH_DIR, TRASH_TTL_MS, titleLine, uid } from "./model";

interface Meta {
  pinned?: string[];
  /** Keyed by file name inside .trash/. */
  trash?: Record<string, { from: string; deletedAt: number }>;
}

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** How many other names to try when one is taken on disk. */
const MAX_NAME_TRIES = 50;

/** Turn a title into something every OS accepts as a file or folder name. */
export function safeName(title: string, fallback = "untitled"): string {
  let name = title.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "").slice(0, 80).trim();
  if (!name) name = fallback;
  if (RESERVED.test(name)) name += "_";
  return name;
}

/** Root first, then depth-first alphabetical, so children follow their parent. */
export function sortFolders(folders: Folder[]): Folder[] {
  const key = (id: string) => id.toLowerCase().split("/").join("\u0001");
  return [...folders].sort((a, b) => (a.id === ROOT ? -1 : b.id === ROOT ? 1 : key(a.id) < key(b.id) ? -1 : 1));
}

export class Vault {
  folders: Folder[] = [];
  notes: Note[] = [];
  /** Title notes by file name instead of first line (see setTitleFromFile). */
  titleFromFile = false;
  /** Called with a message when a file operation fails. */
  onError: (msg: string) => void = (m) => console.error(m);
  /** Number of failed file operations so far (lets callers check a batch succeeded). */
  failures = 0;

  private queue: Promise<unknown> = Promise.resolve();
  private dirty = new Set<Note>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastMeta = "";
  private metaDirty = false;
  /** Lower-cased paths we found to exist on disk without being one of our notes. */
  private occupied = new Set<string>();
  /** File modified times from the last scan, so unchanged files aren't re-read. */
  private mtimes = new Map<string, number>();
  /** Folder renames queued but not yet done on disk, as [old id, new id]. */
  private pendingRenames: [string, string][] = [];
  /** Folders created / deleted in memory whose disk operation hasn't run yet. */
  private pendingCreates = new Set<string>();
  private pendingDeletes = new Set<string>();
  /** Bumped on every in-memory edit; `edited` remembers each note's last bump. */
  private clock = 0;
  private edited = new WeakMap<Note, number>();
  /** Called when a folder rename fails on disk and is undone (old id, new id). */
  onFolderRenameReverted: (from: string, to: string) => void = () => {};
  /** Requested file names for imported notes that haven't been written yet. */
  private nameHints = new WeakMap<Note, string>();

  constructor(private be: Backend) {}

  // ---------------------------------------------------------------- loading

  async load(): Promise<void> {
    const scan = await this.be.scan();
    this.folders = this.foldersFrom(scan);
    const meta = this.parseMeta(scan.meta);
    const pinned = new Set(meta.pinned ?? []);
    this.notes = scan.files.map((f) => this.fromFile(f, f.body ?? "", meta, pinned));
    this.rememberTimes(scan);
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
   * Only files whose modified time changed are re-read. Returns true if
   * `openId`'s text changed.
   *
   * The scan runs on the file queue, so no save, rename or delete can happen
   * while it reads; paths in memory match the disk it saw. Notes edited while
   * it was reading always keep their in-memory text.
   */
  async reload(openId: string | null): Promise<boolean> {
    await this.flush();
    const mark = this.clock;
    const result = this.queue.then(async () => {
      const scan = await this.be.scan(Object.fromEntries(this.mtimes));
      return this.reconcile(scan, openId, mark);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private reconcile(scan: Scan, openId: string | null, mark: number): boolean {
    const editedSince = (n: Note) => (this.edited.get(n) ?? 0) > mark;
    this.folders = this.foldersFrom(scan);
    this.occupied.clear();
    const byPath = new Map(this.notes.filter((n) => n.path).map((n) => [n.path, n]));
    const meta = this.parseMeta(scan.meta);
    const seen = new Set<Note>();
    let openChanged = false;
    for (const f of scan.files) {
      const existing = byPath.get(f.path);
      if (existing) {
        seen.add(existing);
        if (f.body !== null && existing.body !== f.body && !this.dirty.has(existing) && !editedSince(existing)) {
          existing.body = f.body;
          existing.updatedAt = f.modified;
          if (existing.id === openId) openChanged = true;
        }
      } else if (f.body !== null) {
        const n = this.fromFile(f, f.body, meta, new Set());
        n.folderId = this.memoryFolder(n.folderId);
        this.notes.push(n);
        seen.add(n);
      }
    }
    // Files that disappeared; notes not yet on disk, failing to save or just edited stay.
    this.notes = this.notes.filter((n) => !n.path || seen.has(n) || this.dirty.has(n) || editedSince(n));
    this.rememberTimes(scan);
    return openChanged;
  }

  private rememberTimes(scan: Scan): void {
    this.mtimes = new Map(scan.files.map((f) => [f.path, f.modified]));
  }

  private fromFile(f: FileEntry, body: string, meta: Meta, pinned: Set<string>): Note {
    const inTrash = dirOf(f.path) === TRASH_DIR;
    const t = inTrash ? meta.trash?.[baseOf(f.path)] : undefined;
    return {
      id: uid(),
      path: f.path,
      folderId: inTrash ? (t?.from ?? ROOT) : dirOf(f.path),
      body,
      createdAt: f.created,
      updatedAt: f.modified,
      pinned: pinned.has(f.path) || undefined,
      deletedAt: inTrash ? (t?.deletedAt ?? f.modified) : undefined,
      foreignTrash: inTrash && !t ? true : undefined,
      autoName: this.followsTitle(f.path, body),
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

  /**
   * Folders as the app should show them: what the disk has, with folder
   * creates, renames and deletes that are still queued applied on top.
   */
  private foldersFrom(scan: Scan): Folder[] {
    const ids = new Set<string>();
    for (const d of scan.dirs) {
      const id = this.memoryFolder(d);
      if (![...this.pendingDeletes].some((x) => id === x || id.startsWith(x + "/"))) ids.add(id);
    }
    for (const id of this.pendingCreates) ids.add(id);
    return sortFolders([{ id: ROOT, name: "notes" }, ...[...ids].map((id) => ({ id, name: baseOf(id) }))]);
  }

  /** A folder id as found on disk, with queued folder renames applied (the reverse of diskFolder). */
  private memoryFolder(id: string): string {
    for (const [from, to] of this.pendingRenames) id = swapPrefix(id, from, to);
    return id;
  }

  private parseMeta(raw: string | null): Meta {
    try {
      return raw ? (JSON.parse(raw) as Meta) : {};
    } catch {
      return {};
    }
  }

  // ---------------------------------------------------------------- queue

  /** Run `op` after everything already queued. Failures are reported, never thrown. */
  private run(label: string, op: () => Promise<unknown>, onFail?: () => void): Promise<void> {
    const p = this.queue.then(op).then(
      () => undefined,
      (e) => {
        this.failures++;
        onFail?.();
        this.onError(`${label} failed: ${e}`);
      },
    );
    this.queue = p;
    return p;
  }

  /**
   * Write everything pending and wait for the disk to catch up. Keeps going
   * until nothing is left, since a queued save can itself make the metadata
   * stale (e.g. by renaming a pinned note). Stops early if something failed, so
   * a broken disk doesn't spin forever (the failed notes stay pending).
   */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const failuresBefore = this.failures;
    for (;;) {
      const pending = [...this.dirty];
      this.dirty.clear();
      for (const n of pending) this.saveNote(n);
      if (this.metaDirty) {
        this.metaDirty = false;
        this.run("save metadata", () => this.writeMeta());
      }
      const q = this.queue;
      await q;
      const settled = q === this.queue && !this.metaDirty && this.dirty.size === 0;
      if (settled || this.failures !== failuresBefore) return;
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  // ---------------------------------------------------------------- naming

  private isTaken(path: string, self?: Note): boolean {
    const p = path.toLowerCase();
    return this.occupied.has(p) || this.notes.some((n) => n !== self && n.path.toLowerCase() === p);
  }

  /** A free path in `dir` for `stem`, ignoring `self`'s own current path. */
  private uniquePath(dir: string, stem: string, ext: string, self?: Note): string {
    for (let i = 1; ; i++) {
      const p = join(dir, `${stem}${i > 1 ? ` ${i}` : ""}${ext}`);
      if (!this.isTaken(p, self)) return p;
    }
  }

  /** Where `n` should live on disk right now. */
  private wantedPath(n: Note): string {
    const dir = n.deletedAt ? TRASH_DIR : this.diskFolder(n.folderId);
    const ext = n.path ? extOf(n.path) : ".md";
    const hint = this.nameHints.get(n);
    if (hint === undefined && n.path && !n.autoName && dirOf(n.path) === dir) return n.path;
    const stem =
      hint !== undefined ? safeName(hint) : n.autoName || !n.path ? safeName(titleLine(n.body)) : stemOf(n.path);
    // Keep "ideas 2.md" for a note titled "ideas" rather than renaming it back and forth.
    const settled = n.path && dirOf(n.path) === dir && stemOf(n.path).replace(/ \d+$/, "") === stem;
    return settled ? n.path : this.uniquePath(dir, stem, ext, n);
  }

  /** A folder id as it is on disk right now (folder renames still queued are undone). */
  private diskFolder(id: string): string {
    for (let i = this.pendingRenames.length - 1; i >= 0; i--) {
      const [from, to] = this.pendingRenames[i];
      id = swapPrefix(id, to, from);
    }
    return id;
  }

  /** Queue whatever brings `n` up to date on disk. */
  private saveNote(n: Note): void {
    this.run("save", () => this.persist(n), () => this.dirty.add(n));
  }

  private async persist(n: Note): Promise<void> {
    if (!this.notes.includes(n)) return; // deleted meanwhile
    if (!n.path && n.body.trim() === "" && !this.nameHints.has(n)) return; // a new empty note isn't a file yet
    for (let attempt = 0; ; attempt++) {
      const from = n.path;
      const target = this.wantedPath(n);
      try {
        if (!from) {
          await this.be.write(target, n.body, true);
        } else {
          if (from !== target) {
            await this.be.rename(from, target);
            this.movedTo(n, target);
          }
          await this.be.write(target, n.body, false);
        }
        this.movedTo(n, target);
        this.nameHints.delete(n);
        this.mtimes.delete(target); // our own write: re-read it on the next reload
        return;
      } catch (e) {
        // Someone else's file has that name: remember it and try the next name.
        if (!isExists(e) || attempt >= MAX_NAME_TRIES) throw e;
        this.occupied.add(target.toLowerCase());
      }
    }
  }

  private movedTo(n: Note, path: string): void {
    if (n.path === path) return;
    if (n.pinned || n.deletedAt) {
      // flush() picks this up before it returns; the timer covers saves made outside a flush
      this.metaDirty = true;
      this.schedule();
    }
    n.path = path;
  }

  private buildMeta(): Meta {
    const trash: Meta["trash"] = {};
    for (const n of this.notes) {
      if (n.deletedAt && n.path && !n.foreignTrash) trash[baseOf(n.path)] = { from: n.folderId, deletedAt: n.deletedAt };
    }
    return { pinned: this.notes.filter((n) => n.pinned && n.path).map((n) => n.path), trash };
  }

  /** Runs on the queue, so it sees the paths as they are on disk. */
  private async writeMeta(): Promise<void> {
    const json = JSON.stringify(this.buildMeta());
    if (json === this.lastMeta) return;
    await this.be.write(META_FILE, JSON.stringify(JSON.parse(json), null, 2), false);
    this.lastMeta = json;
  }

  // ---------------------------------------------------------------- notes

  get(id: string | null): Note | undefined {
    return id ? this.notes.find((n) => n.id === id) : undefined;
  }

  findByPath(path: string | null): Note | undefined {
    return path ? this.notes.find((n) => n.path === path) : undefined;
  }

  /** A new note. With `nameHint` (imports, links) it's written right away under that name. */
  create(folderId: string, body = "", nameHint?: string): Note {
    const now = Date.now();
    const n: Note = { id: uid(), path: "", folderId, body, createdAt: now, updatedAt: now, autoName: true };
    this.notes.push(n);
    if (nameHint !== undefined) {
      n.autoName = !this.titleFromFile && safeName(nameHint) === safeName(titleLine(body));
      this.nameHints.set(n, nameHint);
      this.saveNote(n);
    } else if (body) {
      this.touch(n);
    }
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
    this.edited.set(n, ++this.clock);
    this.schedule();
  }

  /** Forget an empty note that was never saved. */
  discardIfBlank(n: Note | undefined): boolean {
    if (!n || n.path || n.body.trim() !== "" || this.nameHints.has(n)) return false;
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
    this.metaDirty = true;
    this.schedule();
  }

  /** Give a note's file a name of the user's choosing; it stops following the title. */
  renameNote(n: Note, name: string): void {
    n.autoName = false;
    this.nameHints.set(n, name);
    this.touch(n);
  }

  trash(n: Note): void {
    if (this.discardIfBlank(n)) return;
    n.deletedAt = Date.now();
    n.pinned = undefined;
    this.metaDirty = true;
    this.touch(n);
  }

  restore(n: Note): void {
    if (!n.deletedAt) return;
    n.deletedAt = undefined;
    n.foreignTrash = undefined;
    if (!this.folders.some((f) => f.id === n.folderId)) n.folderId = ROOT;
    this.metaDirty = true;
    this.touch(n);
  }

  destroy(n: Note): void {
    this.notes = this.notes.filter((x) => x !== n);
    this.dirty.delete(n);
    this.metaDirty = true;
    // Read the path when the op runs: a queued save may still move the file first.
    this.run("delete", async () => {
      if (n.path) await this.be.remove(n.path);
    });
    this.schedule();
  }

  emptyTrash(): void {
    for (const n of this.notes.filter((x) => x.deletedAt)) this.destroy(n);
  }

  // ---------------------------------------------------------------- folders

  /** Ids of a folder and everything inside it. */
  private subtree(id: string): string[] {
    return this.folders.filter((f) => f.id === id || f.id.startsWith(id + "/")).map((f) => f.id);
  }

  private uniqueFolder(parent: string, name: string, self?: string): string {
    const taken = new Set(this.folders.filter((f) => f.id !== self).map((f) => f.id.toLowerCase()));
    for (let i = 1; ; i++) {
      const id = join(parent, `${name}${i > 1 ? ` ${i}` : ""}`);
      if (!taken.has(id.toLowerCase()) && id !== TRASH_DIR) return id;
    }
  }

  createFolder(name: string, parent: string = ROOT): Folder {
    const id = this.uniqueFolder(parent, safeName(name, "folder"));
    const f = { id, name: baseOf(id) };
    this.folders = sortFolders([...this.folders, f]);
    this.pendingCreates.add(id);
    const done = () => this.pendingCreates.delete(id);
    this.run("create folder", () => this.be.mkdir(id).finally(done), done);
    return f;
  }

  /** Rename a folder in place; its notes and subfolders move with it. Returns the new id. */
  renameFolder(id: string, name: string): string {
    if (id === ROOT || !this.folders.some((f) => f.id === id)) return id;
    const next = this.uniqueFolder(dirOf(id), safeName(name, "folder"), id);
    if (next === id) return id;
    const relabel = (from: string, to: string) => {
      this.folders = sortFolders(this.folders.map((f) => ({ id: swapPrefix(f.id, from, to), name: baseOf(swapPrefix(f.id, from, to)) })));
      for (const n of this.notes) n.folderId = swapPrefix(n.folderId, from, to);
    };
    relabel(id, next);
    const pending: [string, string] = [id, next];
    this.pendingRenames.push(pending);
    const done = () => (this.pendingRenames = this.pendingRenames.filter((r) => r !== pending));
    this.run(
      "rename folder",
      async () => {
        await this.be.rename(id, next);
        done();
        for (const n of this.notes) if (n.path && !n.deletedAt) n.path = swapPrefix(n.path, id, next);
        this.metaDirty = true;
      },
      () => {
        done();
        relabel(next, id); // the disk didn't change: put the old names back
        this.onFolderRenameReverted(id, next);
      },
    );
    this.schedule();
    return next;
  }

  /** Moves the folder's notes (and its subfolders' notes) to recently deleted, then removes the empty folders. */
  deleteFolder(id: string): void {
    if (id === ROOT) return;
    const ids = this.subtree(id);
    for (const n of this.notes.filter((x) => ids.includes(x.folderId))) {
      if (!n.deletedAt) this.trash(n);
      n.folderId = ROOT;
    }
    this.folders = this.folders.filter((f) => !ids.includes(f.id));
    this.pendingDeletes.add(id);
    // deepest first, so parents are empty by the time we reach them
    const order = [...ids].sort((a, b) => b.split("/").length - a.split("/").length);
    void this.flush().then(() => {
      for (const dir of order) {
        this.run("remove folder", () =>
          this.be.rmdir(dir).catch(() => {
            /* folder still holds non-note files; leave it */
          }),
        );
      }
      this.run("remove folder", async () => void this.pendingDeletes.delete(id));
    });
  }

  // ---------------------------------------------------------------- import

  importFiles(folderId: string, files: ExtFile[]): Note[] {
    return files.map((f) => this.create(folderId, f.body, f.name));
  }

  /** Import a folder tree as a new folder inside `parent`. */
  importDir(dir: ExtDir, parent: string = ROOT): { folder: Folder; count: number } {
    const folder = this.createFolder(dir.name || "imported", parent);
    let count = this.importFiles(folder.id, dir.files).length;
    for (const sub of dir.dirs) count += this.importDir(sub, folder.id).count;
    return { folder, count };
  }
}
