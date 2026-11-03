export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Note {
  id: string;
  folderId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Set when the note is in "recently deleted". */
  deletedAt?: number;
}

export type FontFamily = "roboto mono" | "system mono" | "sans";
export type LineWidth = "narrow" | "normal" | "wide";

export interface Settings {
  theme: string;
  fontSize: number; // rem
  fontFamily: FontFamily;
  lineWidth: LineWidth;
  smoothCaret: boolean;
  liveStats: boolean;
  focusMode: boolean;
  spellcheck: boolean;
  zen: boolean;
}

export interface DB {
  version: 1;
  folders: Folder[];
  notes: Note[];
  settings: Settings;
  /** UI state restored on launch. */
  view: { folderId: string; noteId: string | null };
}

export const ALL = "__all__";
export const TRASH = "__trash__";
export const DEFAULT_FOLDER = "notes";
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const defaultSettings: Settings = {
  theme: "banana",
  fontSize: 1.5,
  fontFamily: "roboto mono",
  lineWidth: "normal",
  smoothCaret: true,
  liveStats: true,
  focusMode: true,
  spellcheck: false,
  zen: false,
};

const WELCOME = `welcome to monkeynotes

just start typing. the first line is the title.

esc / ctrl+k      command line (themes, settings, everything)
ctrl+n            new note
ctrl+shift+n      new folder
ctrl+p            jump to a note
ctrl+\\            zen mode (hide the sidebar)
alt+up / down     previous / next note
ctrl+= / ctrl+-   font size

drag notes onto folders to move them. right-click a note or folder for more.
`;

export function uid(): string {
  return crypto.randomUUID();
}

export function freshDB(): DB {
  const now = Date.now();
  const welcome: Note = {
    id: uid(),
    folderId: DEFAULT_FOLDER,
    body: WELCOME,
    createdAt: now,
    updatedAt: now,
  };
  return {
    version: 1,
    folders: [{ id: DEFAULT_FOLDER, name: "notes", createdAt: now }],
    notes: [welcome],
    settings: { ...defaultSettings },
    view: { folderId: ALL, noteId: welcome.id },
  };
}

/** Fill in anything missing from an older / hand-edited file and purge expired trash. */
export function normalize(raw: unknown): DB {
  const base = freshDB();
  if (!raw || typeof raw !== "object") return base;
  const db = raw as Partial<DB>;
  const folders = Array.isArray(db.folders) ? db.folders : base.folders;
  if (!folders.some((f) => f.id === DEFAULT_FOLDER)) {
    folders.unshift({ id: DEFAULT_FOLDER, name: "notes", createdAt: Date.now() });
  }
  const folderIds = new Set(folders.map((f) => f.id));
  const cutoff = Date.now() - TRASH_TTL_MS;
  const notes = (Array.isArray(db.notes) ? db.notes : [])
    .filter((n) => !(n.deletedAt && n.deletedAt < cutoff))
    .map((n) => (folderIds.has(n.folderId) ? n : { ...n, folderId: DEFAULT_FOLDER }));
  return {
    version: 1,
    folders,
    notes,
    settings: { ...defaultSettings, ...(db.settings ?? {}) },
    view: { ...base.view, ...(db.view ?? {}) },
  };
}

export function noteTitle(n: Note): string {
  const line = n.body.split("\n").find((l) => l.trim() !== "") ?? "";
  const clean = line.replace(/^#+\s*/, "").trim();
  return clean.slice(0, 80) || "new note";
}

export function notePreview(n: Note): string {
  const lines = n.body.split("\n").filter((l) => l.trim() !== "");
  return (lines[1] ?? "").trim().slice(0, 120);
}

export function wordCount(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

export function sortNotes(a: Note, b: Note): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" }).toLowerCase();
  return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" });
}
