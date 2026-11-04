import { stemOf } from "./paths";

/** A folder is a directory directly inside the notes folder. The root itself has id "". */
export interface Folder {
  id: string;
  name: string;
}

export interface Note {
  /** Stable in-memory id; files can be renamed underneath it. */
  id: string;
  /** Path relative to the notes folder, e.g. "ideas/app idea.md". Empty until first saved. */
  path: string;
  folderId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Set when the note is in "recently deleted". folderId is where it came from. */
  deletedAt?: number;
  /** In .trash/ but not put there by this app (e.g. Obsidian's trash): never auto-purged. */
  foreignTrash?: boolean;
  /** The file name follows the note's title (true for notes made in the app). */
  autoName: boolean;
}

export type FontFamily = "roboto mono" | "system mono" | "sans";
export type LineWidth = "narrow" | "normal" | "wide";
export type TitleSource = "first line" | "file name";
export type SoundKind = "off" | "click" | "pop" | "thock" | "typewriter";
export type TypingAnimation = "off" | "ghost" | "sparks" | "pulse";

export interface DayStats {
  /** characters typed (deletions don't count); words = chars / 5 */
  chars: number;
  /** active typing time in ms (gaps over a few seconds don't count) */
  ms: number;
  /** best sustained session wpm that day */
  best: number;
}

export interface StatsData {
  days: Record<string, DayStats>;
}

export interface Settings {
  theme: string;
  fontSize: number; // rem
  fontFamily: FontFamily;
  lineWidth: LineWidth;
  smoothCaret: boolean;
  /** typing stats bar (live wpm, today, streak, average) */
  liveStats: boolean;
  sound: SoundKind;
  soundVolume: number;
  typingAnimation: TypingAnimation;
  checkUpdates: boolean;
  /** Fade the sidebars and footer while typing (off by default). */
  focusMode: boolean;
  /** Collapse the folders sidebar / the notes list. */
  hideFolders: boolean;
  hideNotes: boolean;
  spellcheck: boolean;
  zen: boolean;
  titleSource: TitleSource;
}

export interface AppState {
  version: 2;
  /** Bumped when a default changes in a way existing settings should pick up. */
  settingsRevision: number;
  settings: Settings;
  /** UI state restored on launch. */
  view: { folderId: string; notePath: string | null; collapsed: string[] };
  stats: StatsData;
  lastUpdateCheck: number;
}

export const ALL = "__all__";
export const TRASH = "__trash__";
export const ROOT = "";
export const TRASH_DIR = ".trash";
export const META_FILE = ".monkeynotes.json";
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const defaultSettings: Settings = {
  theme: "serika dark",
  fontSize: 1.5,
  fontFamily: "roboto mono",
  lineWidth: "normal",
  smoothCaret: true,
  liveStats: true,
  focusMode: false,
  hideFolders: false,
  hideNotes: false,
  spellcheck: false,
  zen: false,
  titleSource: "first line",
  sound: "off",
  soundVolume: 0.5,
  typingAnimation: "off",
  checkUpdates: true,
};

export const WELCOME = `welcome to monkeynotes

just start typing. the first line is the title.

esc / ctrl+k      command line (themes, settings, everything)
ctrl+n            new note
ctrl+shift+n      new folder
ctrl+p            jump to a note
ctrl+\\            zen mode (hide the sidebar)
alt+up / down     previous / next note
ctrl+= / ctrl+-   font size

ctrl+f            find in this note
ctrl+enter        follow the [[link]] under the caret (or ctrl+click it)

drag notes onto folders to move them. right-click a note or folder for more.

every note is a plain markdown file. use "change notes folder" in the
command line to keep them anywhere you like, e.g. a synced folder.
`;

export function uid(): string {
  return crypto.randomUUID();
}

export function normalizeState(raw: unknown): AppState {
  const st = (raw && typeof raw === "object" ? raw : {}) as Partial<AppState>;
  const settings = { ...defaultSettings, ...(st.settings ?? {}) };
  const revision = typeof st.settingsRevision === "number" ? st.settingsRevision : 0;
  // Revision 1: focus mode (hiding the UI while typing) became opt-in.
  if (revision < 1) settings.focusMode = false;
  return {
    version: 2,
    settingsRevision: 1,
    settings,
    view: { folderId: ALL, notePath: null, collapsed: [], ...(st.view ?? {}) },
    stats: st.stats && typeof st.stats === "object" && st.stats.days ? st.stats : { days: {} },
    lastUpdateCheck: typeof st.lastUpdateCheck === "number" ? st.lastUpdateCheck : 0,
  };
}

export function titleLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^#+\s*/, "").trim();
}

let titleSource: TitleSource = "first line";
export function setTitleSource(t: TitleSource): void {
  titleSource = t;
}

export function noteTitle(n: Note): string {
  if (titleSource === "file name" && n.path) return stemOf(n.path);
  return titleLine(n.body).slice(0, 80) || "new note";
}

export function notePreview(n: Note): string {
  const lines = n.body.split("\n").filter((l) => l.trim() !== "");
  // In file-name mode the first line isn't the title, so it is the preview,
  // unless it just repeats the title as a heading.
  const skip = titleSource === "file name" && n.path ? (titleLine(lines[0] ?? "") === noteTitle(n) ? 1 : 0) : 1;
  return (lines[skip] ?? "").trim().slice(0, 120);
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
