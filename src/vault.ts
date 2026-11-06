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
import { isExists, isNotFound } from "./errors";
import { baseOf, dirOf, extOf, join, stemOf, swapPrefix } from "./paths";
import { type Folder, META_FILE, type Note, ROOT, TRASH_DIR, TRASH_TTL_MS, titleLine, uid } from "./model";

interface TrashEntry {
  /** folder it was in */
  from: string;
  deletedAt: number;
  /** its file name (without extension) before it was trashed, for restoring */
  name?: string;
  /** text length when trashed: a different file with the same name isn't ours */
  size?: number;
}

/** Folders can be nested this deep (the Rust scan reads no deeper). */
export const MAX_FOLDER_DEPTH = 8;

interface Meta {
  /** Starred notes by path ("pinned" for compatibility with older files). */
  pinned?: string[];
  /** Starred folder ids. */
  starredFolders?: string[];
  /** Keyed by file name inside .trash/. */
  trash?: Record<string, TrashEntry>;
}

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Windows treats these as devices even with an extension (nul.txt). */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** How many other names to try when one is taken on disk. */
const MAX_NAME_TRIES = 50;
/** At most one stored version per note per this long. */
export const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;

/** Turn a title into something every OS accepts as a file or folder name. */
export function safeName(title: string, fallback = "untitled"): string {
  let name = title.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  // Cut by code point so a long title never leaves half an emoji in the name.
  name = Array.from(name.replace(/^\.+/, "")).slice(0, 80).join("").replace(/[. ]+$/, "").trim();
  if (!name) name = fallback;
  if (RESERVED.test(name)) name += "_";
  return name;
}

/** Root first, then depth-first alphabetical, so children follow their parent. */
export function sortFolders(folders: Folder[]): Folder[] {
  const key = (id: string) => id.toLowerCase().split("/").join("\u0001");
  return [...folders].sort((a, b) => (a.id === ROOT ? -1 : b.id === ROOT ? 1 : key(a.id) < key(b.id) ? -1 : 1));
}

/** Keep only well-formed fields of a metadata file; anything else is ignored rather than crashing a load. */
function cleanMeta(raw: Record<string, unknown>): Meta {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const meta: Meta = { pinned: strings(raw.pinned), starredFolders: strings(raw.starredFolders) };
  if (raw.trash && typeof raw.trash === "object" && !Array.isArray(raw.trash)) {
    meta.trash = {};
    for (const [name, e] of Object.entries(raw.trash)) {
      const t = e as Partial<TrashEntry> | null;
      if (!t || typeof t !== "object" || typeof t.deletedAt !== "number") continue;
      meta.trash[name] = {
        from: typeof t.from === "string" ? t.from : ROOT,
        deletedAt: t.deletedAt,
        ...(typeof t.name === "string" ? { name: t.name } : {}),
        ...(typeof t.size === "number" ? { size: t.size } : {}),
      };
    }
  }
  return meta;
}

export class Vault {
  folders: Folder[] = [];
  notes: Note[] = [];
  /** Starred folders, shown right below "all notes". */
  starredFolders = new Set<string>();
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
  /** While frozen nothing touches the disk (the backend may be switching folders). */
  private frozen = false;
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
  /** What each note's file held after its last load or save (the version to keep). */
  private savedBody = new WeakMap<Note, string>();
  /** When each note last had a version stored. */
  private lastSnapshot = new WeakMap<Note, number>();
  /** The clock, replaceable in tests. */
  now: () => number = () => Date.now();
  /** Called when a folder rename fails on disk and is undone (old id, new id). */
  onFolderRenameReverted: (from: string, to: string) => void = () => {};

  /**
   * Stop reading and writing, e.g. while the notes folder is being switched,
   * so nothing from this vault lands in the new folder. Pending saves wait.
   */
  freeze(): void {
    this.frozen = true;
    clearTimeout(this.timer);
  }

  /** Undo freeze() (the switch was cancelled) and save whatever is waiting. */
  unfreeze(): void {
    this.frozen = false;
    this.schedule();
  }
  /** File name a trashed note had before, so restoring puts it back as it was. */
  private originalName = new WeakMap<Note, string>();
  /** Requested file names for imported notes that haven't been written yet. */
  private nameHints = new WeakMap<Note, string>();

  private metaBackedUp = false;

  constructor(private be: Backend) {}

  // ---------------------------------------------------------------- loading

  async load(): Promise<void> {
    const scan = await this.be.scan();
    this.folders = this.foldersFrom(scan);
    const meta = this.parseMeta(scan.meta);
    const pinned = new Set(meta.pinned ?? []);
    this.notes = scan.files.map((f) => this.fromFile(f, f.body ?? "", meta, pinned));
    this.warnUnloaded(scan);
    this.starredFolders = new Set((meta.starredFolders ?? []).filter((id) => this.folders.some((f) => f.id === id)));
    this.rememberTimes(scan);
    // Recently deleted notes are purged after 30 days, but only ones this app put
    // there: another app's .trash (Obsidian uses one too) is never purged.
    const cutoff = Date.now() - TRASH_TTL_MS;
    for (const n of this.notes.filter((x) => x.deletedAt && !x.foreignTrash && x.deletedAt < cutoff)) {
      this.destroy(n);
    }
    this.lastMeta = JSON.stringify(this.buildMeta());
    if (this.metaIsStale(meta)) {
      this.metaDirty = true;
      this.schedule();
    }
  }

  /** The metadata file mentions notes or folders that aren't there any more. */
  private metaIsStale(meta: Meta): boolean {
    const paths = new Set(this.notes.filter((n) => n.path).map((n) => n.path));
    const ours = new Set(this.notes.filter((n) => n.deletedAt && !n.foreignTrash && n.path).map((n) => baseOf(n.path)));
    return (
      (meta.pinned ?? []).some((p) => !paths.has(p)) ||
      Object.keys(meta.trash ?? {}).some((name) => !ours.has(name)) ||
      (meta.starredFolders ?? []).some((id) => !this.folders.some((f) => f.id === id))
    );
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
    if (this.frozen) return false;
    // Scan before saving: if another app changed a file we have unsaved edits
    // for, reconcile keeps its version in history before our save replaces it.
    const mark = this.clock;
    const result = this.queue.then(async () => {
      const scan = await this.be.scan(Object.fromEntries(this.mtimes));
      return this.reconcile(scan, openId, mark);
    });
    this.queue = result.catch(() => undefined);
    const changed = await result;
    await this.flush();
    return changed;
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
        if (f.body !== null && existing.body !== f.body && (this.dirty.has(existing) || editedSince(existing))) {
          // Our unsaved text wins, but never throw away what another app wrote.
          if (f.body !== this.savedBody.get(existing)) {
            const [path, body] = [f.path, f.body];
            this.run("keep the other version", () => this.be.historySave(path, body));
          }
        }
        if (f.body !== null && existing.body !== f.body && !this.dirty.has(existing) && !editedSince(existing)) {
          existing.body = f.body;
          existing.updatedAt = f.modified;
          this.savedBody.set(existing, f.body);
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
    const unloaded = new Set(scan.unloaded ?? []);
    this.notes = this.notes.filter((n) => !n.path || seen.has(n) || unloaded.has(n.path) || this.dirty.has(n) || editedSince(n));
    this.rememberTimes(scan);
    // Stars changed on another device: take them, unless we have changes of our own waiting to be saved.
    if (scan.meta && !this.metaDirty && this.lastMeta === JSON.stringify(this.buildMeta())) {
      const pinned = new Set(meta.pinned ?? []);
      for (const n of this.notes) if (n.path && !n.deletedAt) n.starred = pinned.has(n.path) || undefined;
      this.starredFolders = new Set((meta.starredFolders ?? []).filter((id) => this.folders.some((f) => f.id === id)));
      this.lastMeta = JSON.stringify(this.buildMeta());
    }
    if (this.metaIsStale(meta)) this.metaDirty = true;
    return openChanged;
  }

  /** A folder too big to load completely: say so once, and never touch what was left out. */
  private warnUnloaded(scan: Scan): void {
    const count = scan.unloaded_count ?? 0;
    if (count > 0) {
      this.onError(`this folder is very large: ${count} notes weren't loaded. they are untouched on disk`);
    }
  }

  private rememberTimes(scan: Scan): void {
    this.mtimes = new Map(scan.files.map((f) => [f.path, f.modified]));
  }

  private fromFile(f: FileEntry, body: string, meta: Meta, pinned: Set<string>): Note {
    const inTrash = dirOf(f.path) === TRASH_DIR;
    const entry = inTrash ? meta.trash?.[baseOf(f.path)] : undefined;
    // An entry for a file of a different size is stale (another app's trash
    // file that happens to have the same name): not ours, never auto-purged.
    const t = entry && (entry.size === undefined || entry.size === body.length) ? entry : undefined;
    const note: Note = {
      id: uid(),
      path: f.path,
      folderId: inTrash ? (t?.from ?? ROOT) : dirOf(f.path),
      body,
      createdAt: f.created,
      updatedAt: f.modified,
      starred: pinned.has(f.path) || undefined,
      deletedAt: inTrash ? (t?.deletedAt ?? f.modified) : undefined,
      foreignTrash: inTrash && !t ? true : undefined,
      autoName: this.followsTitle(f.path, body),
    };
    this.savedBody.set(note, body);
    if (t?.name) this.originalName.set(note, t.name);
    return note;
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
    if (!raw) return {};
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return cleanMeta(v as Record<string, unknown>);
    } catch {
      // fall through
    }
    // Unreadable: keep a copy before the next save replaces it.
    if (!this.metaBackedUp) {
      this.metaBackedUp = true;
      this.run("back up unreadable metadata", async () => {
        // never replace an earlier backup: that may be the only good copy
        for (let i = 0; i < 10; i++) {
          try {
            return await this.be.write(META_FILE + (i ? `.bak${i + 1}` : ".bak"), raw, true);
          } catch (e) {
            if (!isExists(e)) throw e;
          }
        }
      });
    }
    return {};
  }

  // ---------------------------------------------------------------- queue

  /** Run `op` after everything already queued. Failures are reported, never thrown. */
  private run(label: string, op: () => Promise<unknown>, onFail?: () => void): Promise<void> {
    const p = this.queue.then(() => {
      if (!this.frozen) return op();
      onFail?.(); // skipped, not failed: a save stays pending
    }).then(
      () => undefined,
      (e) => {
        this.failures++;
        onFail?.();
        const why = String(e).startsWith("TOO_LARGE")
          ? "it is too big (notes can be 8 MB at most)"
          : String(e);
        this.onError(`${label} failed: ${why}`);
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
    if (this.frozen) return;
    const failuresBefore = this.failures;
    for (;;) {
      const pending = [...this.dirty];
      this.dirty.clear();
      for (const n of pending) this.saveNote(n);
      if (this.metaDirty) {
        this.metaDirty = false;
        this.run("save metadata", () => this.writeMeta(), () => (this.metaDirty = true));
      }
      const q = this.queue;
      await q;
      const settled = q === this.queue && !this.metaDirty && this.dirty.size === 0;
      if (settled) return;
      if (this.failures !== failuresBefore) {
        // try again in a while (an unplugged drive may come back), without hammering the disk
        this.timer = setTimeout(() => void this.flush(), 30_000);
        return;
      }
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.frozen) return;
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
      const body = n.body;
      try {
        if (!from) {
          await this.be.write(target, body, true);
          await this.dropStaleHistory(target);
        } else if (from !== target) {
          let moved = true;
          try {
            await this.be.rename(from, target);
          } catch (e) {
            // The file vanished (deleted by another app): write the text fresh.
            if (!isNotFound(e)) throw e;
            await this.be.write(target, body, true);
            moved = false;
          }
          this.movedTo(n, target);
          if (from.toLowerCase() !== target.toLowerCase()) await this.dropStaleHistory(target);
          await this.be.historyMove(from, target, false).catch((e) => this.onError(`moving history failed: ${e}`));
          if (moved) {
            await this.snapshot(n, target);
            await this.be.write(target, body, false, this.savedBody.get(n));
          }
        } else {
          await this.snapshot(n, target);
          await this.be.write(target, body, false, this.savedBody.get(n));
        }
        this.savedBody.set(n, body);
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

  /** History left at a path by a file that's gone isn't this note's: drop it. */
  private async dropStaleHistory(path: string): Promise<void> {
    await this.be.historyDelete(path).catch((e) => this.onError(`clearing old history failed: ${e}`));
  }

  /**
   * Before a save replaces the file, keep what it held as a version: the text
   * from before an editing session is always recoverable, and then at most one
   * version per SNAPSHOT_EVERY_MS. A failure here never blocks the save.
   */
  private async snapshot(n: Note, path: string): Promise<void> {
    const previous = this.savedBody.get(n);
    if (previous === undefined || previous === n.body || previous.trim() === "") return;
    const now = this.now();
    if (now - (this.lastSnapshot.get(n) ?? -Infinity) < SNAPSHOT_EVERY_MS) return;
    try {
      await this.be.historySave(path, previous);
      this.lastSnapshot.set(n, now);
    } catch (e) {
      this.onError(`saving a version failed: ${e}`);
    }
  }

  private movedTo(n: Note, path: string): void {
    if (n.path === path) return;
    if (n.starred || n.deletedAt) {
      // flush() picks this up before it returns; the timer covers saves made outside a flush
      this.metaDirty = true;
      this.schedule();
    }
    n.path = path;
  }

  private buildMeta(): Meta {
    const trash: Meta["trash"] = {};
    for (const n of this.notes) {
      if (n.deletedAt && n.path && !n.foreignTrash) {
        const name = this.originalName.get(n);
        trash[baseOf(n.path)] = { from: n.folderId, deletedAt: n.deletedAt, ...(name ? { name } : {}), size: n.body.length };
      }
    }
    return {
      pinned: this.notes.filter((n) => n.starred && n.path).map((n) => n.path),
      starredFolders: [...this.starredFolders].sort(),
      trash,
    };
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

  toggleStar(n: Note): void {
    n.starred = !n.starred || undefined;
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
    if (n.path) this.originalName.set(n, stemOf(n.path));
    n.deletedAt = Date.now();
    n.starred = undefined;
    this.metaDirty = true;
    this.touch(n);
  }

  restore(n: Note): void {
    if (!n.deletedAt) return;
    n.deletedAt = undefined;
    n.foreignTrash = undefined;
    if (!this.ensureFolder(n.folderId)) n.folderId = ROOT;
    // back under its old file name (not "x 2", which it may have had in the trash)
    const name = this.originalName.get(n);
    if (name !== undefined && !n.autoName) this.nameHints.set(n, name);
    this.originalName.delete(n);
    this.metaDirty = true;
    this.touch(n);
  }

  destroy(n: Note): void {
    this.notes = this.notes.filter((x) => x !== n);
    this.dirty.delete(n);
    this.metaDirty = true;
    // Read the path when the op runs: a queued save may still move the file first.
    this.run("delete", async () => {
      if (!n.path) return;
      await this.be.remove(n.path);
      await this.be.historyDelete(n.path).catch((e) => this.onError(`deleting history failed: ${e}`));
    });
    this.schedule();
  }

  emptyTrash(): void {
    for (const n of this.notes.filter((x) => x.deletedAt)) this.destroy(n);
  }

  // ---------------------------------------------------------------- versions

  /** Stored versions of a note, newest first (saving pending changes first). */
  async versions(n: Note): Promise<number[]> {
    await this.flush();
    return n.path ? this.be.historyList(n.path) : [];
  }

  readVersion(n: Note, at: number): Promise<string> {
    return this.be.historyRead(n.path, at);
  }

  /**
   * Clear version history saved at or after `since` (all time when null) for
   * the given notes, or for every note when `notes` is null. With `dryRun`,
   * only counts. Pending saves are written first so nothing new sneaks in.
   */
  async clearHistory(notes: Note[] | null, since: number | null, dryRun = false): Promise<number> {
    await this.flush();
    const paths = notes === null ? null : notes.filter((n) => n.path).map((n) => n.path);
    if (paths && !paths.length) return 0;
    return this.be.historyClear(paths, since, dryRun);
  }

  /** Put an old version back. The current text is kept as a version first. */
  restoreVersion(n: Note, body: string): void {
    if (n.deletedAt || body === n.body) return;
    this.lastSnapshot.delete(n); // always keep what's being replaced
    const before = this.savedBody.get(n);
    if (n.path && before !== n.body) this.savedBody.set(n, n.body); // include typing not yet saved
    this.setBody(n, body);
  }

  // ---------------------------------------------------------------- folders

  toggleFolderStar(id: string): void {
    if (id === ROOT || !this.folders.some((f) => f.id === id)) return;
    if (!this.starredFolders.delete(id)) this.starredFolders.add(id);
    this.metaDirty = true;
    this.schedule();
  }

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

  /**
   * Make sure folder `id` exists (recreating it, and any missing parents, under
   * exactly that name). False if the id can't be a folder here.
   */
  private ensureFolder(id: string): boolean {
    if (id === ROOT || this.folders.some((f) => f.id === id)) return true;
    const parts = id.split("/");
    if (parts.length > MAX_FOLDER_DEPTH || parts.some((p) => !p || p === TRASH_DIR || safeName(p, "folder") !== p)) return false;
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (this.folders.some((f) => f.id === dir)) continue;
      this.folders = sortFolders([...this.folders, { id: dir, name: baseOf(dir) }]);
      this.pendingCreates.add(dir);
      const done = () => this.pendingCreates.delete(dir);
      this.run(
        "create folder",
        () => this.be.mkdir(dir).finally(done),
        () => {
          // couldn't make it: the notes that were headed there go to the top folder
          done();
          this.folders = this.folders.filter((f) => f.id !== dir && !f.id.startsWith(dir + "/"));
          for (const n of this.notes) {
            if (!n.deletedAt && (n.folderId === dir || n.folderId.startsWith(dir + "/"))) {
              n.folderId = ROOT;
              this.touch(n);
            }
          }
        },
      );
    }
    return true;
  }

  /** Throws if the new folder would be nested deeper than MAX_FOLDER_DEPTH. */
  createFolder(name: string, parent: string = ROOT): Folder {
    if (parent && parent.split("/").length >= MAX_FOLDER_DEPTH) {
      throw new Error(`folders can be nested ${MAX_FOLDER_DEPTH} deep at most`);
    }
    const id = this.uniqueFolder(parent, safeName(name, "folder"));
    const f = { id, name: baseOf(id) };
    this.folders = sortFolders([...this.folders, f]);
    this.pendingCreates.add(id);
    const done = () => this.pendingCreates.delete(id);
    const undo = () => {
      done();
      this.folders = this.folders.filter((x) => x.id !== id);
    };
    this.run("create folder", () => this.be.mkdir(id).finally(done), undo);
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
      this.starredFolders = new Set([...this.starredFolders].map((x) => swapPrefix(x, from, to)));
      this.metaDirty = true;
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
        await this.be.historyMove(id, next, true).catch((e) => this.onError(`moving history failed: ${e}`));
        // every note still on disk under the old name, including ones trashed
        // but not yet moved (paths already in .trash/ never match)
        for (const n of this.notes) if (n.path) n.path = swapPrefix(n.path, id, next);
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

  /** Moves the folder's notes (and its subfolders' notes) to the trash, then removes the empty folders. */
  deleteFolder(id: string): void {
    if (id === ROOT) return;
    const ids = this.subtree(id);
    const affected = this.notes.filter((x) => ids.includes(x.folderId));
    for (const n of affected) {
      // folderId stays: it is where the note goes back to when restored
      if (!n.deletedAt) this.trash(n);
    }
    this.folders = this.folders.filter((f) => !ids.includes(f.id));
    for (const x of ids) this.starredFolders.delete(x);
    this.metaDirty = true;
    this.pendingDeletes.add(id);
    // Queue the moves to the trash now, then the folder removals behind them
    // (deepest first, so parents are empty by the time we reach them). A folder
    // recreated with the same name in the meantime is left alone.
    for (const n of affected) if (this.dirty.delete(n)) this.saveNote(n);
    const order = [...ids].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const dir of order) {
      this.run("remove folder", async () => {
        if (this.pendingCreates.has(dir) || this.folders.some((f) => f.id === dir)) return;
        await this.be.rmdir(dir).catch(() => {
          /* folder still holds non-note files; leave it */
        });
      });
    }
    this.run("remove folder", async () => void this.pendingDeletes.delete(id));
    this.schedule();
  }

  // ---------------------------------------------------------------- import

  importFiles(folderId: string, files: ExtFile[]): Note[] {
    return files.map((f) => this.create(folderId, f.body, f.name));
  }

  /** Import a folder tree as a new folder inside `parent`. */
  importDir(dir: ExtDir, parent: string = ROOT): { folder: Folder; count: number } {
    // past the nesting limit, the notes go into the deepest folder allowed
    const folder =
      parent && parent.split("/").length >= MAX_FOLDER_DEPTH
        ? { id: parent, name: baseOf(parent) }
        : this.createFolder(dir.name || "imported", parent);
    let count = this.importFiles(folder.id, dir.files).length;
    for (const sub of dir.dirs) count += this.importDir(sub, folder.id).count;
    return { folder, count };
  }
}
