import { type Backend } from "./backend";
import { Editor } from "./editor";
import { Find } from "./find";
import { ParagraphLayer } from "./paragraphs";
import { ALL, type AppState, type Note, ROOT, TRASH, sortNotes } from "./model";
import { Palette } from "./palette";
import { TypingStats } from "./stats";
import { Vault } from "./vault";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export const els = {
  app: $("#app"),
  folderList: $("#folder-list"),
  noteList: $("#note-list"),
  notesTitle: $("#notes-title"),
  search: $<HTMLInputElement>("#search"),
  scroller: $("#scroller"),
  page: $("#page"),
  statsBar: $("#statsbar"),
  folders: $("#folders"),
  notesPane: $("#notes"),
  footer: $("#footer"),
  gallery: $("#gallery"),
  galleryGrid: $("#gallery-grid"),
  galleryTitle: $("#gallery-title"),
  statsView: $("#stats-view"),
  decor: $("#decor"),
  fx: $("#fx"),
  meta: $("#note-meta"),
  toast: $("#toast"),
};

/** In gallery view: whether a note is open full-size (otherwise the cards show). */
export const isGrid = () => settings().viewMode === "grid";
export const galleryShown = () => isGrid() && !app.galleryNoteOpen;
/** Where the notes folder is, for display. */

export interface AppContext {
  state: AppState;
  vault: Vault;
  editor: Editor;
  palette: Palette;
  find: Find;
  stats: TypingStats;
  backend: Backend;
  linkLayer: ParagraphLayer;
  currentId: string | null;
  /** In gallery view: whether a note is open full-size (otherwise the cards show). */
  galleryNoteOpen: boolean;
  /** Where the notes folder is, for display. */
  notesDirPath: string;
}

/** The app's shared, long-lived objects. Filled in by main() before anything renders. */
export const app = {
  currentId: null,
  galleryNoteOpen: false,
  notesDirPath: "",
} as unknown as AppContext;

// ---------------------------------------------------------------- state helpers

export const settings = () => app.state.settings;
export const current = (): Note | undefined => app.vault.get(app.currentId);
export const view = () => app.state.view;
export const isRealFolder = (id: string) => app.vault.folders.some((f) => f.id === id);
export const folderName = (id: string) =>
  id === ALL ? "all notes" : id === TRASH ? "trash" : (app.vault.folders.find((f) => f.id === id)?.name ?? "notes");
/** "projects / 2026" for nested folders. */
export const folderPath = (id: string) => (id === ROOT || id === ALL || id === TRASH ? folderName(id) : id.split("/").join(" / "));
export const depthOf = (id: string) => (id === ROOT || id === ALL || id === TRASH ? 0 : id.split("/").length - 1);
/** Where new and imported notes go from the current view. */
export const targetFolder = () => (isRealFolder(view().folderId) ? view().folderId : ROOT);

let stateTimer = 0;
export function saveState(): void {
  clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => void writeState(), 400);
}
export function writeState(): Promise<void> {
  clearTimeout(stateTimer);
  app.state.view.notePath = current()?.path || null;
  return app.backend.saveState(JSON.stringify(app.state, null, 1)).catch((e) => toast(`couldn't save settings: ${e}`));
}

let toastTimer = 0;
export let toastAction: (() => void) | null = null;
export function toast(msg: string, action?: () => void, ms = 4000): void {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  els.toast.classList.toggle("clickable", !!action);
  toastAction = action ?? null;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (els.toast.hidden = true), ms);
}

/** Lower-cased note text for search, recomputed only when a note's text changes. */
const lowerCache = new WeakMap<Note, { body: string; lower: string }>();
function lowerBody(n: Note): string {
  const hit = lowerCache.get(n);
  if (hit && hit.body === n.body) return hit.lower;
  const lower = n.body.toLowerCase();
  lowerCache.set(n, { body: n.body, lower });
  return lower;
}

const searchQuery = () => els.search.value.trim().toLowerCase();

/**
 * The notes to list: the open folder's, or while searching, every matching
 * note in any folder (searching from the trash searches the trash).
 */
export function notesInView(): Note[] {
  const { folderId } = view();
  const q = searchQuery();
  return app.vault.notes
    .filter((n) => (folderId === TRASH ? !!n.deletedAt : !n.deletedAt))
    .filter((n) => q !== "" || folderId === ALL || folderId === TRASH || n.folderId === folderId)
    .filter((n) => !q || lowerBody(n).includes(q))
    .sort(sortNotes);
}

/** "work", or "results for “milk”" while searching. */
export const viewTitle = () => (searchQuery() ? `results for “${els.search.value.trim()}”` : folderName(view().folderId));

// ---------------------------------------------------------------- rendering
