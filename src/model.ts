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
  /** Starred notes stay at the top (stored as "pinned" in .monkeynotes.json). */
  starred?: boolean;
  /** Set when the note is in the trash. folderId is where it came from. */
  deletedAt?: number;
  /** In .trash/ but not put there by this app (e.g. Obsidian's trash): never auto-purged. */
  foreignTrash?: boolean;
  /** The file name follows the note's title (true for notes made in the app). */
  autoName: boolean;
}

export type FontFamily = "roboto mono" | "system mono" | "sans";
export type LineWidth = "narrow" | "normal" | "wide";
export type TitleSource = "first line" | "file name";
export type ViewMode = "list" | "grid";
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
  /** Collapse the folders sidebar. */
  hideFolders: boolean;
  /** Notes as a list next to the editor, or as a gallery of cards. */
  viewMode: ViewMode;
  /** Sidebar widths in px (drag their right edge; double-click to reset). */
  foldersWidth: number;
  notesWidth: number;
  spellcheck: boolean;
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
  viewMode: "list",
  foldersWidth: 200,
  notesWidth: 280,
  spellcheck: false,
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
ctrl+\\            show / hide the folders sidebar
ctrl+1 / ctrl+2   list view / gallery view
alt+up / down     previous / next note
ctrl+= / ctrl+-   font size

ctrl+f            find in this note
ctrl+shift+f      search all notes
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

/**
 * A YAML front matter block at the very top ("---", key: value lines, "---").
 * Returns where the text after it starts and its `title:` value, if any.
 * Without a closing line it isn't front matter (a lone "---" is just a rule).
 */
function frontMatter(body: string): { end: number; title: string } | null {
  const bom = body.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(body.slice(bom));
  if (!open) return null;
  let title = "";
  let start = bom + open[0].length;
  while (start <= body.length) {
    const nl = body.indexOf("\n", start);
    const line = body.slice(start, nl === -1 ? undefined : nl).replace(/\r$/, "");
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) return { end: nl === -1 ? body.length : nl + 1, title };
    const m = /^title[ \t]*:[ \t]*(.*)$/i.exec(line);
    if (m && !title) title = m[1].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (nl === -1) return null;
    start = nl + 1;
  }
  return null;
}

/**
 * The first non-empty line, without a leading "#" heading marker. A YAML front
 * matter block is skipped: its `title:` key wins, otherwise the first real line
 * after it. Stops reading at that line.
 */
export function titleLine(body: string): string {
  const fm = frontMatter(body);
  if (fm?.title) return fm.title;
  let start = fm ? fm.end : 0;
  while (start <= body.length) {
    const end = body.indexOf("\n", start);
    const line = body.slice(start, end === -1 ? undefined : end);
    if (line.trim() !== "") return line.replace(/^#+\s*/, "").trim();
    if (end === -1) break;
    start = end + 1;
  }
  return "";
}

/** The first `count` non-empty lines, reading no further than needed. */
function firstLines(body: string, count: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (out.length < count && start <= body.length) {
    const end = body.indexOf("\n", start);
    const line = body.slice(start, end === -1 ? undefined : end);
    if (line.trim() !== "") out.push(line);
    if (end === -1) break;
    start = end + 1;
  }
  return out;
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
  const fm = frontMatter(n.body);
  const lines = firstLines(fm ? n.body.slice(fm.end) : n.body, 2);
  // In file-name mode the first line isn't the title, so it is the preview,
  // unless it just repeats the title as a heading. A title taken from the front
  // matter's title: key doesn't use up a content line either.
  const fromKey = !!fm?.title && !(titleSource === "file name" && n.path);
  const skip = fromKey
    ? 0
    : titleSource === "file name" && n.path
      ? titleLine(lines[0] ?? "") === noteTitle(n)
        ? 1
        : 0
      : 1;
  return (lines[skip] ?? "").trim().slice(0, 120);
}

/** Words (runs of non-space), counted without building a list of them. */
export function wordCount(s: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const space = c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x2028 || c === 0x2029 || c === 0xfeff;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

export function sortNotes(a: Note, b: Note): number {
  if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
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
