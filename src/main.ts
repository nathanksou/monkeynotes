import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import "./styles.css";

import { type Backend, NotDesktopError, createBackend } from "./backend";
import { Editor } from "./editor";
import { spawnEffect } from "./effects";
import { isNotFound } from "./errors";
import { Find } from "./find";
import { linkAt, linkRanges } from "./links";
import { ParagraphLayer } from "./paragraphs";
import { stemOf, swapPrefix } from "./paths";
import {
  ALL,
  type AppState,
  type FontFamily,
  type LineWidth,
  type Note,
  ROOT,
  type Settings,
  type SoundKind,
  type TypingAnimation,
  TRASH,
  type TitleSource,
  WELCOME,
  formatDate,
  defaultSettings,
  normalizeState,
  setTitleSource,
  notePreview,
  noteTitle,
  sortNotes,
  wordCount,
} from "./model";
import { type Command, type Menu, Palette } from "./palette";
import { type KeyType, playKey } from "./sound";
import { TypingStats, formatDuration } from "./stats";
import { renderStatsView } from "./stats-view";
import { applyTheme, findTheme, themes } from "./themes";
import { VERSION, checkForUpdate } from "./updates";
import { Vault, safeName } from "./vault";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const els = {
  app: $("#app"),
  folderList: $("#folder-list"),
  noteList: $("#note-list"),
  notesTitle: $("#notes-title"),
  search: $<HTMLInputElement>("#search"),
  scroller: $("#scroller"),
  page: $("#page"),
  statsBar: $("#statsbar"),
  gallery: $("#gallery"),
  galleryGrid: $("#gallery-grid"),
  galleryTitle: $("#gallery-title"),
  gallerySearch: $<HTMLInputElement>("#gallery-search"),
  statsView: $("#stats-view"),
  decor: $("#decor"),
  fx: $("#fx"),
  meta: $("#note-meta"),
  toast: $("#toast"),
};

let state: AppState;
let vault: Vault;
let editor: Editor;
let palette: Palette;
let find: Find;
let currentId: string | null = null;
/** In gallery view: whether a note is open full-size (otherwise the cards show). */
let galleryNoteOpen = false;
const isGrid = () => settings().viewMode === "grid";
const galleryShown = () => isGrid() && !galleryNoteOpen;
let stats: TypingStats;
let backend: Backend;
/** Where the notes folder is, for display. */
let notesDirPath = "";

// ---------------------------------------------------------------- state helpers

const settings = () => state.settings;
const current = (): Note | undefined => vault.get(currentId);
const view = () => state.view;
const isRealFolder = (id: string) => vault.folders.some((f) => f.id === id);
const folderName = (id: string) =>
  id === ALL ? "all notes" : id === TRASH ? "recently deleted" : (vault.folders.find((f) => f.id === id)?.name ?? "notes");
/** "projects / 2026" for nested folders. */
const folderPath = (id: string) => (id === ROOT || id === ALL || id === TRASH ? folderName(id) : id.split("/").join(" / "));
const depthOf = (id: string) => (id === ROOT || id === ALL || id === TRASH ? 0 : id.split("/").length - 1);
const hasChildren = (id: string) => id !== ROOT && vault.folders.some((f) => f.id.startsWith(id + "/"));
/** Hidden because a parent folder is collapsed. */
const isTucked = (id: string) => view().collapsed.some((c) => id.startsWith(c + "/"));
/** Where new and imported notes go from the current view. */
const targetFolder = () => (isRealFolder(view().folderId) ? view().folderId : ROOT);

let stateTimer = 0;
function saveState(): void {
  clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => void writeState(), 400);
}
function writeState(): Promise<void> {
  clearTimeout(stateTimer);
  state.view.notePath = current()?.path || null;
  return backend.saveState(JSON.stringify(state, null, 1)).catch((e) => toast(`couldn't save settings: ${e}`));
}

let toastTimer = 0;
let toastAction: (() => void) | null = null;
function toast(msg: string, action?: () => void, ms = 4000): void {
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

function notesInView(): Note[] {
  const { folderId } = view();
  const q = els.search.value.trim().toLowerCase();
  return vault.notes
    .filter((n) => (folderId === TRASH ? !!n.deletedAt : !n.deletedAt))
    .filter((n) => folderId === ALL || folderId === TRASH || n.folderId === folderId)
    .filter((n) => !q || lowerBody(n).includes(q))
    .sort(sortNotes);
}

// ---------------------------------------------------------------- rendering

function renderFolders(): void {
  const live = vault.notes.filter((n) => !n.deletedAt);
  const trashed = vault.notes.length - live.length;
  const rows: { id: string; name: string; count: number }[] = [
    { id: ALL, name: "all notes", count: live.length },
    ...vault.folders
      .filter((f) => !isTucked(f.id))
      .map((f) => ({ id: f.id, name: f.name, count: live.filter((n) => n.folderId === f.id).length })),
  ];
  if (trashed || view().folderId === TRASH) rows.push({ id: TRASH, name: "recently deleted", count: trashed });

  els.folderList.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "folder";
      if (r.id === view().folderId) li.classList.add("active");
      if (r.id === ALL || r.id === TRASH) li.classList.add("smart");
      li.style.setProperty("--depth", String(depthOf(r.id)));
      const twisty = document.createElement("span");
      twisty.className = "twisty";
      if (hasChildren(r.id)) {
        twisty.textContent = view().collapsed.includes(r.id) ? "\u25b8" : "\u25be";
        twisty.dataset.toggle = r.id;
      }
      li.append(twisty, folderIcon(r.id === ALL ? "all" : r.id === TRASH ? "trash" : "folder"));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(r.count);
      li.append(name, count);
      return li;
    }),
  );
}

/** Note ids in the order the list currently shows them. */
let renderedOrder: string[] = [];

function noteRow(n: Note): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "note";
  li.dataset.id = n.id;
  li.draggable = !n.deletedAt;
  if (n.id === currentId) li.classList.add("active");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = (n.pinned ? "* " : "") + noteTitle(n);
  const meta = document.createElement("div");
  meta.className = "meta";
  const date = document.createElement("span");
  date.className = "date";
  date.textContent = formatDate(n.updatedAt);
  const prev = document.createElement("span");
  prev.className = "preview";
  prev.textContent = notePreview(n) || "no additional text";
  meta.append(date, prev);
  li.append(title, meta);
  if (view().folderId === ALL) {
    const f = document.createElement("div");
    f.className = "folder-tag";
    f.title = "folder";
    const label = document.createElement("span");
    label.textContent = folderPath(n.folderId);
    f.append(folderIcon("folder"), label);
    li.append(f);
  }
  return li;
}

function renderNotes(): void {
  const notes = notesInView();
  els.notesTitle.textContent = folderName(view().folderId);
  if (isGrid()) renderGallery(notes);
  if (!notes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = els.search.value ? "no matches" : view().folderId === TRASH ? "nothing here" : "no notes yet";
    els.noteList.replaceChildren(li);
    renderedOrder = [];
    return;
  }
  els.noteList.replaceChildren(...notes.map(noteRow));
  renderedOrder = notes.map((n) => n.id);
  els.noteList.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
}

function renderStats(): void {
  const n = current();
  els.meta.textContent = n
    ? n.deletedAt
      ? "recently deleted · restore it from the command line"
      : `${folderPath(n.folderId)} · ${wordCount(n.body)} words · edited ${formatDate(n.updatedAt)}`
    : "";
}

let statsTimer = 0;
/** While typing, the footer (and its whole-note word count) updates at most every 250ms. */
function renderStatsSoon(): void {
  if (statsTimer) return;
  statsTimer = window.setTimeout(() => {
    statsTimer = 0;
    renderStats();
  }, 250);
}

let listTimer = 0;
/** After typing: refresh just the open note's row, unless the list order changed. */
function renderSoon(): void {
  clearTimeout(listTimer);
  listTimer = window.setTimeout(() => {
    const order = notesInView().map((n) => n.id);
    const n = current();
    const row = n && els.noteList.querySelector(`li[data-id="${n.id}"]`);
    if (n && row && order.length === renderedOrder.length && order.every((id, i) => id === renderedOrder[i])) {
      row.replaceWith(noteRow(n));
    } else {
      renderNotes();
    }
  }, 150);
}

function renderAll(): void {
  renderFolders();
  renderNotes();
  renderStats();
}

function applySettings(): void {
  const s = settings();
  setTitleSource(s.titleSource);
  applyTheme(findTheme(s.theme));
  const root = document.documentElement.style;
  root.setProperty("--font-size", `${s.fontSize}rem`);
  root.setProperty(
    "--font",
    s.fontFamily === "sans"
      ? "system-ui, -apple-system, 'Segoe UI', sans-serif"
      : s.fontFamily === "system mono"
        ? "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
        : "'Roboto Mono', monospace",
  );
  root.setProperty("--line-width", s.lineWidth === "narrow" ? "60ch" : s.lineWidth === "wide" ? "100%" : "80ch");
  els.app.classList.toggle("hide-folders", s.hideFolders);
  applyView();
  els.app.style.setProperty("--folders-size", `${s.foldersWidth}px`);
  els.app.style.setProperty("--notes-size", `${s.notesWidth}px`);
  els.app.classList.toggle("no-stats", !s.liveStats);
  editor?.ta.setAttribute("spellcheck", String(s.spellcheck));
  editor?.setSmooth(s.smoothCaret);
  editor?.refresh();
}

// ---------------------------------------------------------------- note actions

function openNote(id: string | null, opts: { focus?: boolean } = {}): void {
  const prev = current();
  if (prev && prev.id !== id && vault.discardIfBlank(prev)) renderFolders();
  find.close(false);
  currentId = id;
  const n = current();
  editor.load(n?.body ?? "", { readOnly: !n || !!n.deletedAt, caretAt: "start" });
  els.fx.replaceChildren();
  paintLinks();
  els.page.classList.toggle("empty", !n);
  resetLiveStats();
  renderNotes();
  renderStats();
  saveState();
  if (isGrid()) {
    // in gallery view, opening a note (not just selecting one) shows it full-size
    galleryNoteOpen = !!n && opts.focus !== false;
    applyView();
  }
  if (opts.focus !== false && n) editor.focus();
}

function openFolder(id: string): void {
  view().folderId = id;
  els.search.value = "";
  const notes = notesInView();
  const keep = notes.find((n) => n.id === currentId);
  renderFolders();
  openNote(keep?.id ?? notes[0]?.id ?? null, { focus: false });
}

function newNote(): void {
  const folder = targetFolder();
  const blank = vault.notes.find((n) => !n.deletedAt && !n.path && n.body.trim() === "" && n.folderId === folder);
  const note = blank ?? vault.create(folder);
  if (view().folderId === TRASH) view().folderId = folder;
  els.search.value = "";
  renderFolders();
  openNote(note.id);
}

function noteAction(fn: () => void, nextFrom?: Note[]): void {
  const n = current();
  fn();
  // If the open note left this view, open its neighbour.
  const after = notesInView();
  if (nextFrom && n && !after.includes(n)) {
    const i = nextFrom.indexOf(n);
    const next = nextFrom.slice(i + 1).find((x) => after.includes(x)) ?? after.filter((x) => nextFrom.includes(x)).at(-1);
    renderFolders();
    openNote(next?.id ?? null, { focus: !isGrid() });
  } else {
    renderAll();
  }
}

const trashNote = (n: Note) => noteAction(() => vault.trash(n), notesInView());
const destroyNote = (n: Note) => noteAction(() => vault.destroy(n), notesInView());
const moveNote = (n: Note, folderId: string) => noteAction(() => vault.move(n, folderId), notesInView());
const togglePin = (n: Note) => noteAction(() => vault.togglePin(n));

function restoreNote(n: Note): void {
  vault.restore(n);
  view().folderId = n.folderId;
  renderFolders();
  openNote(n.id);
}

function emptyTrash(): void {
  vault.emptyTrash();
  if (view().folderId === TRASH) openFolder(ALL);
  else renderAll();
}

function stepNote(dir: 1 | -1): void {
  const list = notesInView();
  if (!list.length) return;
  const i = list.findIndex((n) => n.id === currentId);
  openNote(list[Math.min(list.length - 1, Math.max(0, i + dir))].id);
}

async function renameNote(n: Note): Promise<void> {
  const current = n.path ? stemOf(n.path) : noteTitle(n);
  const name = await palette.ask("rename note file", current, focusEditor);
  if (!name) return;
  vault.renameNote(n, name);
  renderAll();
  saveState();
}

function setTitleMode(mode: TitleSource): void {
  setSetting("titleSource", mode);
  vault.setTitleFromFile(mode === "file name");
  renderAll();
}

// ---------------------------------------------------------------- version history

/** "today 3:42 pm", "yesterday 9:05 am", "nov 2 11:30 pm" */
function versionLabel(at: number): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = formatDate(at);
  return /\d:\d/.test(day) ? `today ${time}` : `${day} ${time}`;
}

/** Browse a note's versions in the command line: arrowing previews, enter restores. */
async function showHistory(n: Note): Promise<void> {
  let list: number[];
  try {
    list = await vault.versions(n);
  } catch (e) {
    toast(`couldn't read version history: ${e}`);
    return;
  }
  if (!list.length) {
    toast("no earlier versions yet. they're kept as you edit, at most one every 5 minutes");
    return;
  }
  let token = 0;
  let previewing = false;
  const showCurrent = () => {
    token++;
    if (!previewing) return;
    previewing = false;
    editor.load(n.body, { caretAt: "start" });
    paintLinks();
    renderStats();
  };
  const preview = (at: number) => {
    const t = ++token;
    vault
      .readVersion(n, at)
      .then((body) => {
        if (t !== token || currentId !== n.id) return;
        previewing = true;
        editor.load(body, { readOnly: true, caretAt: "start" });
        paintLinks();
        els.meta.textContent = `version from ${versionLabel(at)} · ${wordCount(body)} words · enter to restore it`;
      })
      .catch((e) => toast(`couldn't read that version: ${e}`));
  };
  const restore = async (at: number) => {
    token++;
    try {
      const body = await vault.readVersion(n, at);
      vault.restoreVersion(n, body);
      previewing = true; // make showCurrent reload the restored text
      showCurrent();
      renderAll();
      toast(`restored the version from ${versionLabel(at)}. the text it replaced is in version history too`);
    } catch (e) {
      showCurrent();
      toast(`couldn't restore that version: ${e}`);
    }
  };
  openPalette({
    title: `version history · ${noteTitle(n)}`,
    seeThrough: true,
    onCancel: showCurrent,
    items: [
      { label: "current version", active: true, preview: showCurrent, run: showCurrent },
      ...list.map((at) => ({
        label: versionLabel(at),
        preview: () => preview(at),
        run: () => void restore(at),
      })),
    ],
  });
}

// ---------------------------------------------------------------- folder actions

async function newFolder(parent: string = ROOT): Promise<void> {
  const name = await palette.ask(parent ? `new folder inside ${folderPath(parent)}` : "folder name", "", focusEditor);
  if (!name) return;
  view().collapsed = view().collapsed.filter((c) => c !== parent);
  openFolder(vault.createFolder(name, parent).id);
}


function toggleCollapsed(id: string): void {
  const c = view().collapsed;
  view().collapsed = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
  renderFolders();
  saveState();
}

async function renameFolder(id: string): Promise<void> {
  const f = vault.folders.find((x) => x.id === id);
  if (!f || id === ROOT) return;
  const name = await palette.ask(`rename "${f.name}"`, f.name, focusEditor);
  if (!name) return;
  const next = vault.renameFolder(id, name);
  view().folderId = swapPrefix(view().folderId, id, next);
  view().collapsed = view().collapsed.map((c) => swapPrefix(c, id, next));
  renderAll();
  saveState();
}

function deleteFolder(id: string): void {
  vault.deleteFolder(id);
  view().collapsed = view().collapsed.filter((c) => c !== id && !c.startsWith(id + "/"));
  if (view().folderId === id || view().folderId.startsWith(id + "/")) openFolder(ALL);
  else {
    if (current()?.deletedAt) openNote(notesInView()[0]?.id ?? null);
    renderAll();
  }
}

// ---------------------------------------------------------------- import / export / notes folder

async function importFiles(): Promise<void> {
  const files = await backend.importFiles().catch((e: unknown) => (toast(`import failed: ${e}`), null));
  if (!files?.length) return;
  const folder = targetFolder();
  const notes = vault.importFiles(folder, files);
  if (view().folderId === TRASH) view().folderId = folder;
  renderFolders();
  openNote(notes[0].id);
  toast(`imported ${notes.length} note${notes.length === 1 ? "" : "s"} into ${folderName(folder)}`);
}

async function importDir(): Promise<void> {
  const dir = await backend.importDir().catch((e: unknown) => (toast(`import failed: ${e}`), null));
  if (!dir) return;
  const { folder, count } = vault.importDir(dir);
  openFolder(folder.id);
  toast(`imported ${count} note${count === 1 ? "" : "s"} into ${folder.name}`);
}

async function exportNote(n: Note): Promise<void> {
  await vault.flush();
  const ok = await backend.exportNote(safeName(noteTitle(n)), n.body).catch((e) => (toast(`export failed: ${e}`), false));
  if (ok) toast("note exported");
}

async function exportAll(): Promise<void> {
  await vault.flush();
  const files = vault.notes.filter((n) => !n.deletedAt && n.path).map((n) => ({ path: n.path, body: n.body }));
  const dest = await backend.exportAll(files).catch((e) => (toast(`export failed: ${e}`), null));
  if (dest) toast(`exported ${files.length} notes to ${dest}`);
}

/** Load the current notes folder into a fresh vault. Throws if it can't be read. */
async function openVault(): Promise<void> {
  if (vault) await vault.flush();
  const next = new Vault(backend);
  next.onError = (m) => toast(m, undefined, 6000);
  next.titleFromFile = settings().titleSource === "file name";
  // A folder rename that failed on disk was undone: point the view back at the old name.
  next.onFolderRenameReverted = (from, to) => {
    view().folderId = swapPrefix(view().folderId, to, from);
    view().collapsed = view().collapsed.map((c) => swapPrefix(c, to, from));
    renderAll();
    saveState();
  };
  await next.load();
  vault = next;
  notesDirPath = await backend.notesDir();
}

/** Switch notes folders (`choose`: ask the user; otherwise go back to the default). */
async function changeNotesDir(choose: boolean): Promise<void> {
  try {
    if (vault) await vault.flush();
    if (choose) {
      if (!(await backend.chooseNotesDir())) return;
    } else {
      await backend.resetNotesDir(true);
    }
    await openVault();
  } catch (e) {
    toast(`couldn't open that folder: ${e}`);
    return;
  }
  view().folderId = ALL;
  els.search.value = "";
  currentId = null;
  renderFolders();
  openNote(notesInView()[0]?.id ?? null);
  await writeState();
  toast(`notes folder: ${notesDirPath}`);
}

/** Bring notes from the v0.1 single-file database into the notes folder. */
function migrateLegacy(raw: string, freshState: boolean): number {
  type OldNote = { folderId: string; body: string; pinned?: boolean; deletedAt?: number; createdAt?: number };
  let old: { folders?: { id: string; name: string }[]; notes?: OldNote[]; settings?: Partial<Settings> };
  try {
    old = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (freshState && old.settings) state.settings = { ...state.settings, ...old.settings };
  const folderMap = new Map<string, string>([["notes", ROOT]]);
  for (const f of old.folders ?? []) {
    if (!folderMap.has(f.id)) folderMap.set(f.id, vault.createFolder(f.name).id);
  }
  let count = 0;
  for (const o of old.notes ?? []) {
    // skip blanks, and notes a previous (partly failed) migration already brought over
    if (!o.body?.trim() || vault.notes.some((n) => n.body === o.body)) continue;
    const n = vault.create(folderMap.get(o.folderId) ?? ROOT, o.body);
    if (o.createdAt) n.createdAt = o.createdAt;
    if (o.deletedAt) n.deletedAt = o.deletedAt;
    if (o.pinned && !o.deletedAt) n.pinned = true;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- settings

function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  state.settings[key] = value;
  applySettings();
  saveState();
}

const PANE_LIMITS = { folders: [140, 420], notes: [180, 560] } as const;
const clampWidth = (pane: "folders" | "notes", w: number) =>
  Math.round(Math.min(PANE_LIMITS[pane][1], Math.max(PANE_LIMITS[pane][0], w)));

/** Drag a sidebar's right edge to resize it; double-click the edge to reset. */
function bindResizeHandles(): void {
  for (const handle of document.querySelectorAll<HTMLElement>(".resize-handle")) {
    const pane = handle.dataset.pane as "folders" | "notes";
    const key = pane === "folders" ? "foldersWidth" : "notesWidth";
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = settings()[key];
      els.app.classList.add("resizing");
      const move = (ev: PointerEvent) => {
        settings()[key] = clampWidth(pane, startW + ev.clientX - startX);
        els.app.style.setProperty(pane === "folders" ? "--folders-size" : "--notes-size", `${settings()[key]}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        els.app.classList.remove("resizing");
        editor.refresh();
        saveState();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
    handle.addEventListener("dblclick", () => setSetting(key, defaultSettings[key]));
  }
}

// ---------------------------------------------------------------- views (list / gallery) and the sidebar

const ICONS = {
  all: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
};

function folderIcon(kind: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "folder-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[kind]; // fixed markup, never user text
  return svg;
}

function toggleFolders(): void {
  setSetting("hideFolders", !settings().hideFolders);
}

/** Classes for the current view; the CSS does the layout. */
function applyView(): void {
  els.app.classList.toggle("grid", isGrid());
  els.app.classList.toggle("grid-note", isGrid() && galleryNoteOpen);
  for (const b of document.querySelectorAll<HTMLElement>(".js-view")) {
    b.classList.toggle("on", b.dataset.view === settings().viewMode);
  }
}

function setView(mode: "list" | "grid"): void {
  galleryNoteOpen = false;
  if (settings().viewMode !== mode) setSetting("viewMode", mode);
  else applyView();
  renderNotes();
  if (mode === "list") {
    editor.refresh();
    focusEditor();
  } else {
    focusGallery();
  }
}

function backToGallery(): void {
  if (!isGrid()) return;
  if (vault.discardIfBlank(current())) {
    currentId = null;
    renderFolders();
  }
  galleryNoteOpen = false;
  applyView();
  renderNotes();
  focusGallery();
}

function focusGallery(): void {
  const card = els.galleryGrid.querySelector<HTMLElement>(".card.active") ?? els.galleryGrid.querySelector(".card");
  card?.focus({ preventScroll: false });
}

/** A card: a small preview of the note's text, then its title and date. */
function noteCard(n: Note): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = n.id;
  card.tabIndex = 0;
  card.draggable = !n.deletedAt;
  if (n.id === currentId) card.classList.add("active");
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.textContent = n.body.slice(0, 600) || " ";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = (n.pinned ? "* " : "") + noteTitle(n);
  const date = document.createElement("div");
  date.className = "card-date";
  date.textContent = formatDate(n.updatedAt);
  card.append(thumb, title, date);
  return card;
}

function renderGallery(notes: Note[] = notesInView()): void {
  els.galleryTitle.textContent = folderName(view().folderId);
  if (document.activeElement !== els.gallerySearch) els.gallerySearch.value = els.search.value;
  if (!notes.length) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = els.search.value ? "no matches" : view().folderId === TRASH ? "nothing here" : "no notes yet";
    els.galleryGrid.replaceChildren(empty);
    return;
  }
  els.galleryGrid.replaceChildren(...notes.map(noteCard));
}

/** Arrow keys move between cards; enter opens one. */
function galleryKey(e: KeyboardEvent): void {
  const cards = [...els.galleryGrid.querySelectorAll<HTMLElement>(".card")];
  if (!cards.length) return;
  const i = Math.max(0, cards.indexOf(document.activeElement as HTMLElement));
  const top = cards[0].offsetTop;
  const cols = Math.max(1, cards.filter((c) => c.offsetTop === top).length);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
  if (step !== undefined) {
    e.preventDefault();
    cards[Math.min(cards.length - 1, Math.max(0, i + step))].focus();
  } else if (e.key === "Enter" && document.activeElement?.classList.contains("card")) {
    e.preventDefault();
    openNote(cards[i].dataset.id!);
  }
}

function focusEditor(): void {
  if (current()) editor.focus();
}

// ---------------------------------------------------------------- typing stats

function resetLiveStats(): void {
  els.app.classList.remove("typing");
}

function onType(chars: number): void {
  stats.type(chars);
  if (settings().focusMode) els.app.classList.add("typing");
  saveState();
}

let lastStatsKey = "";

/** The always-visible stats bar under the editor (it stays put in focus mode). */
function renderStatsBar(): void {
  if (!settings().liveStats) return;
  const live = stats.live();
  const today = stats.today();
  const streak = stats.streak();
  const parts: [string, string, string?][] = [
    [String(live ?? stats.lastWpm), "wpm", live === null ? "idle" : "live"],
    [String(Math.round(today.chars / 5)), "words today"],
    [formatDuration(today.ms), "typing today"],
    [String(stats.average()), "avg wpm"],
  ];
  if (streak) parts.push([String(streak), "day streak"]);
  const key = JSON.stringify(parts);
  if (key === lastStatsKey) return;
  lastStatsKey = key;
  els.statsBar.replaceChildren(
    ...parts.map(([value, label, cls]) => {
      const item = document.createElement("span");
      item.className = `stat ${cls ?? ""}`;
      const v = document.createElement("b");
      v.textContent = value;
      item.append(v, ` ${label}`);
      return item;
    }),
  );
}
setInterval(() => stats && renderStatsBar(), 250);

function showStats(): void {
  els.statsView.replaceChildren(renderStatsView(stats));
  els.statsView.hidden = false;
}

function hideStats(): void {
  els.statsView.hidden = true;
  focusEditor();
}

// ---------------------------------------------------------------- links

/** Open the note a [[link]] points at, creating it if it doesn't exist (like Obsidian). */
function followLink(target: string): void {
  const t = target.toLowerCase();
  // "folder/name" first, then a bare file name, then a title
  const pathNoExt = (p: string) => p.replace(/\.[^./]+$/, "").toLowerCase();
  const live = vault.notes.filter((n) => !n.deletedAt);
  let n =
    live.find((x) => x.path && pathNoExt(x.path) === t) ??
    live.find((x) => x.path && stemOf(x.path).toLowerCase() === t) ??
    live.find((x) => noteTitle(x).toLowerCase() === t);
  if (!n) {
    const from = current();
    const folder = from && !from.deletedAt ? from.folderId : targetFolder();
    const body = settings().titleSource === "file name" ? "" : `${target}\n`;
    n = vault.create(folder, body, target.split("/").pop());
    toast(`created "${target}"`);
  }
  if (view().folderId !== ALL && view().folderId !== n.folderId) {
    view().folderId = ALL;
    els.search.value = "";
  }
  renderFolders();
  openNote(n.id);
}

function followLinkAtCaret(): boolean {
  const target = linkAt(editor.ta.value, editor.ta.selectionStart);
  if (target) followLink(target);
  return !!target;
}

/** Underline [[links]] on a layer behind the text. */
let decorTimer = 0;
let linkLayer: ParagraphLayer;

/** One paragraph with its [[links]] wrapped for underlining. */
function renderLinks(text: string): Node[] {
  const ranges = linkRanges(text);
  if (!ranges.length) return [document.createTextNode(text || "\u200b")];
  const parts: Node[] = [];
  let last = 0;
  for (const [a, b] of ranges) {
    parts.push(document.createTextNode(text.slice(last, a)));
    const u = document.createElement("span");
    u.className = "link";
    u.textContent = text.slice(a, b);
    parts.push(u);
    last = b;
  }
  parts.push(document.createTextNode(text.slice(last)));
  return parts;
}

function paintLinks(): void {
  clearTimeout(decorTimer);
  decorTimer = window.setTimeout(() => {
    const text = editor.ta.value;
    if (!text.includes("[[")) return linkLayer.clear();
    linkLayer.update(text.split("\n"), (t) => t, renderLinks);
  }, 60);
}

// ---------------------------------------------------------------- updates

async function openUrl(url: string): Promise<void> {
  if (backend.desktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

async function checkUpdates(manual: boolean): Promise<void> {
  try {
    const release = await checkForUpdate();
    state.lastUpdateCheck = Date.now();
    saveState();
    if (release) {
      toast(`monkeynotes ${release.version} is out (you have ${VERSION}). click to open the release page`, () => void openUrl(release.url), 12000);
    } else if (manual) {
      toast(`you're on the latest version (${VERSION})`);
    }
  } catch (e) {
    if (manual) toast(`couldn't check for updates: ${e}`);
  }
}

// ---------------------------------------------------------------- command line

function choice<T>(title: string, options: { label: string; value: T }[], get: () => T, set: (v: T) => void): Menu {
  const original = get();
  return {
    title,
    items: options.map((o) => ({ label: o.label, active: o.value === original, run: () => set(o.value) })),
  };
}

function themeMenu(): Menu {
  const original = settings().theme;
  const active = findTheme(original).name;
  return {
    title: `theme (${themes.length})`,
    seeThrough: true,
    onCancel: () => applyTheme(findTheme(original)),
    items: themes.map((t) => ({
      label: t.name,
      active: t.name === active,
      preview: () => applyTheme(t),
      run: () => setSetting("theme", t.name),
    })),
  };
}

function randomTheme(): void {
  const others = themes.filter((t) => t.name !== findTheme(settings().theme).name);
  const t = others[Math.floor(Math.random() * others.length)];
  setSetting("theme", t.name);
  toast(`theme: ${t.name}`);
}

function noteCommands(n: Note): Command[] {
  if (n.deletedAt) {
    return [
      { label: "restore note", run: () => restoreNote(n) },
      { label: "delete note forever", run: () => destroyNote(n) },
    ];
  }
  return [
    { label: "find in note", hint: "ctrl+f", run: () => find.open() },
    ...(linkAt(n.body, editor.ta.selectionStart) ? [{ label: "follow link", hint: "ctrl+enter", run: () => void followLinkAtCaret() }] : []),
    { label: n.pinned ? "unpin note" : "pin note", run: () => togglePin(n) },
    { label: "rename note", hint: "file name", run: () => void renameNote(n) },
    {
      label: "move note to",
      sub: () => ({
        title: "move to folder",
        items: vault.folders.map((f) => ({ label: folderPath(f.id), active: f.id === n.folderId, run: () => moveNote(n, f.id) })),
      }),
    },
    ...(n.path ? [{ label: "version history", hint: "browse and restore", run: () => void showHistory(n) }] : []),
    { label: "export note", hint: ".md", run: () => void exportNote(n) },
    { label: "copy note to clipboard", run: () => void navigator.clipboard.writeText(n.body) },
    { label: "delete note", hint: "moves to recently deleted", run: () => trashNote(n) },
  ];
}

function folderCommands(id: string): Command[] {
  if (id === TRASH) return [{ label: "empty recently deleted", run: emptyTrash }];
  const f = vault.folders.find((x) => x.id === id);
  if (!f || id === ROOT) return [];
  const count = vault.notes.filter((n) => (n.folderId === id || n.folderId.startsWith(id + "/")) && !n.deletedAt).length;
  return [
    { label: `new folder inside "${f.name}"`, run: () => void newFolder(id) },
    { label: `rename folder "${f.name}"`, run: () => void renameFolder(id) },
    {
      label: `delete folder "${f.name}"`,
      sub: () => ({
        title: count ? `delete "${f.name}" and move its ${count} notes to recently deleted?` : `delete "${f.name}"?`,
        items: [
          { label: "no", run: () => undefined },
          { label: "yes, delete", run: () => deleteFolder(id) },
        ],
      }),
    },
  ];
}

function jumpMenu(): Menu {
  return {
    title: "jump to note",
    items: vault.notes
      .filter((n) => !n.deletedAt)
      .sort(sortNotes)
      .map((n) => ({
        label: noteTitle(n),
        hint: folderPath(n.folderId),
        run: () => {
          if (view().folderId !== ALL && view().folderId !== n.folderId) {
            view().folderId = ALL;
            els.search.value = "";
            renderFolders();
          }
          openNote(n.id);
        },
      })),
  };
}

function rootMenu(): Menu {
  const s = settings();
  const n = current();
  const onOff = [
    { label: "on", value: true },
    { label: "off", value: false },
  ];
  const desktop = backend.desktop;
  const items: Command[] = [
    { label: "new note", hint: "ctrl+n", run: newNote },
    { label: "new folder", hint: "ctrl+shift+n", run: () => void newFolder() },
    { label: "jump to note", hint: "ctrl+p", sub: jumpMenu },
    {
      label: "go to folder",
      sub: () => ({
        title: "folder",
        items: [
          { id: ALL, name: "all notes" },
          ...vault.folders,
          ...(vault.notes.some((x) => x.deletedAt) ? [{ id: TRASH, name: "recently deleted" }] : []),
        ].map((f) => ({ label: folderPath(f.id), active: f.id === view().folderId, run: () => openFolder(f.id) })),
      }),
    },
    ...(n ? noteCommands(n) : []),
    ...folderCommands(view().folderId),
    { label: "import notes", hint: ".md / .txt", run: () => void importFiles() },
    ...(desktop
      ? [
          { label: "import folder", run: () => void importDir() },
          { label: "export all notes", run: () => void exportAll() },
        ]
      : []),
    { label: "theme", sub: themeMenu },
    { label: "random theme", run: randomTheme },
    {
      label: "font size",
      hint: "ctrl+= / ctrl+-",
      sub: () =>
        choice(
          "font size",
          [1, 1.25, 1.5, 2, 2.5, 3].map((v) => ({ label: String(v), value: v })),
          () => s.fontSize,
          (v) => setSetting("fontSize", v),
        ),
    },
    {
      label: "font family",
      sub: () =>
        choice<FontFamily>(
          "font family",
          (["roboto mono", "system mono", "sans"] as const).map((v) => ({ label: v, value: v })),
          () => s.fontFamily,
          (v) => setSetting("fontFamily", v),
        ),
    },
    {
      label: "line width",
      sub: () =>
        choice<LineWidth>(
          "line width",
          (["narrow", "normal", "wide"] as const).map((v) => ({ label: v, value: v })),
          () => s.lineWidth,
          (v) => setSetting("lineWidth", v),
        ),
    },
    {
      label: "note titles",
      hint: s.titleSource === "file name" ? "from file name" : "from first line",
      sub: () =>
        choice<TitleSource>(
          "note titles come from",
          [
            { label: "first line (files are renamed to match)", value: "first line" },
            { label: "file name (files are never renamed; good for obsidian vaults)", value: "file name" },
          ],
          () => s.titleSource,
          setTitleMode,
        ),
    },
    { label: "smooth caret", sub: () => choice("smooth caret", onOff, () => s.smoothCaret, (v) => setSetting("smoothCaret", v)) },
    { label: "show typing stats", run: showStats },
    { label: "stats bar", hint: "wpm, today, streak", sub: () => choice("stats bar", onOff, () => s.liveStats, (v) => setSetting("liveStats", v)) },
    {
      label: "typing sounds",
      sub: () => {
        const menu = choice<SoundKind>(
          "typing sounds",
          (["off", "click", "pop", "thock", "typewriter"] as const).map((v) => ({ label: v, value: v })),
          () => s.sound,
          (v) => setSetting("sound", v),
        );
        // hear each sound as you arrow through the list
        menu.items.forEach((item) => (item.preview = () => playKey(item.label as SoundKind, s.soundVolume, "char")));
        return menu;
      },
    },
    {
      label: "sound volume",
      sub: () =>
        choice(
          "sound volume",
          [
            { label: "quiet", value: 0.25 },
            { label: "medium", value: 0.5 },
            { label: "loud", value: 1 },
          ],
          () => s.soundVolume,
          (v) => setSetting("soundVolume", v),
        ),
    },
    {
      label: "typing animation",
      sub: () =>
        choice<TypingAnimation>(
          "typing animation",
          [
            { label: "off", value: "off" },
            { label: "ghost (letters float away)", value: "ghost" },
            { label: "sparks", value: "sparks" },
            { label: "pulse (caret bumps)", value: "pulse" },
          ],
          () => s.typingAnimation,
          (v) => setSetting("typingAnimation", v),
        ),
    },
    {
      label: "focus mode",
      hint: "hide ui while typing",
      sub: () => choice("focus mode", onOff, () => s.focusMode, (v) => setSetting("focusMode", v)),
    },
    { label: "spellcheck", sub: () => choice("spellcheck", onOff, () => s.spellcheck, (v) => setSetting("spellcheck", v)) },
    { label: s.hideFolders ? "show folders" : "hide folders", hint: "ctrl+\\", run: toggleFolders },
    { label: "list view", hint: "ctrl+1", active: s.viewMode === "list", run: () => setView("list") },
    { label: "gallery view", hint: "ctrl+2", active: s.viewMode === "grid", run: () => setView("grid") },
    ...(isGrid() && galleryNoteOpen ? [{ label: "back to gallery", run: backToGallery }] : []),
    ...(desktop
      ? [
          { label: "change notes folder", hint: notesDirPath, run: () => void changeNotesDir(true) },
          { label: "use default notes folder", run: () => void changeNotesDir(false) },
          { label: "copy notes folder path", run: () => void navigator.clipboard.writeText(notesDirPath) },
          { label: "check for updates", hint: `v${VERSION}`, run: () => void checkUpdates(true) },
          {
            label: "check for updates on launch",
            sub: () => choice("check for updates on launch", onOff, () => s.checkUpdates, (v) => setSetting("checkUpdates", v)),
          },
        ]
      : []),
  ];
  return { title: "type to search", items };
}

function openPalette(menu: Menu = rootMenu()): void {
  palette.open(menu, focusEditor);
}

// ---------------------------------------------------------------- events

function bindEvents(): void {
  const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

  document.addEventListener("keydown", (e) => {
    if (palette.isOpen) return;
    const k = e.key.toLowerCase();
    if (!els.statsView.hidden) {
      if (e.key === "Escape") {
        e.preventDefault();
        hideStats();
      }
      return;
    }
    if (mod(e) && e.key === "Enter") {
      if (document.activeElement === editor.ta && followLinkAtCaret()) e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (document.activeElement === els.search) {
        els.search.blur();
        focusEditor();
      } else if (document.activeElement === els.gallerySearch) {
        els.gallerySearch.blur();
        focusGallery();
      } else openPalette();
    } else if (mod(e) && (k === "k" || (e.shiftKey && k === "p"))) {
      e.preventDefault();
      openPalette();
    } else if (mod(e) && k === "p") {
      e.preventDefault();
      openPalette(jumpMenu());
    } else if (mod(e) && e.shiftKey && k === "n") {
      e.preventDefault();
      void newFolder();
    } else if (mod(e) && k === "n") {
      e.preventDefault();
      newNote();
    } else if (mod(e) && (e.key === "\\" || e.code === "Backslash")) {
      e.preventDefault();
      toggleFolders();
    } else if (mod(e) && (k === "1" || k === "2")) {
      e.preventDefault();
      setView(k === "1" ? "list" : "grid");
    } else if (mod(e) && e.shiftKey && k === "f") {
      e.preventDefault();
      if (isGrid()) {
        if (galleryNoteOpen) backToGallery();
        els.gallerySearch.focus();
        els.gallerySearch.select();
      } else {
        els.search.focus();
        els.search.select();
      }
    } else if (galleryShown() && !(document.activeElement instanceof HTMLInputElement) && !mod(e)) {
      galleryKey(e);
    } else if (mod(e) && k === "f") {
      e.preventDefault();
      if (current()) find.open();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      stepNote(e.key === "ArrowUp" ? -1 : 1);
    } else if (mod(e) && (e.key === "=" || e.key === "+" || e.key === "-")) {
      e.preventDefault();
      const sizes = [1, 1.25, 1.5, 2, 2.5, 3];
      const i = sizes.indexOf(settings().fontSize);
      const next = sizes[Math.min(sizes.length - 1, Math.max(0, (i < 0 ? 2 : i) + (e.key === "-" ? -1 : 1)))];
      setSetting("fontSize", next);
    }
  });

  // Moving the mouse brings the ui back after focus mode hid it.
  let lx = 0;
  let ly = 0;
  document.addEventListener("mousemove", (e) => {
    if (Math.abs(e.screenX - lx) + Math.abs(e.screenY - ly) > 4) els.app.classList.remove("typing");
    lx = e.screenX;
    ly = e.screenY;
  });

  const rowId = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>("li[data-id]")?.dataset.id;

  els.folderList.addEventListener("click", (e) => {
    const toggle = (e.target as HTMLElement).closest<HTMLElement>("[data-toggle]");
    if (toggle) return toggleCollapsed(toggle.dataset.toggle!);
    const id = rowId(e);
    if (id !== undefined) openFolder(id);
  });
  els.folderList.addEventListener("dblclick", (e) => {
    const id = rowId(e);
    if (id !== undefined && id !== ROOT && isRealFolder(id)) void renameFolder(id);
  });
  els.folderList.addEventListener("contextmenu", (e) => {
    const id = rowId(e);
    if (id === undefined) return;
    e.preventDefault();
    const cmds = folderCommands(id);
    if (cmds.length) openPalette({ title: folderName(id), items: cmds });
  });

  els.noteList.addEventListener("click", (e) => {
    const id = rowId(e);
    if (id) openNote(id);
  });
  els.noteList.addEventListener("contextmenu", (e) => {
    const n = vault.get(rowId(e) ?? null);
    if (!n) return;
    e.preventDefault();
    if (n.id !== currentId) openNote(n.id, { focus: false });
    openPalette({ title: noteTitle(n), items: noteCommands(n) });
  });

  // drag a note onto a folder to move it
  els.noteList.addEventListener("dragstart", (e) => {
    const id = rowId(e);
    if (!id || !e.dataTransfer) return;
    e.dataTransfer.setData("text/x-monkeynote", id);
    e.dataTransfer.effectAllowed = "move";
  });
  els.folderList.addEventListener("dragover", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (!li || !isRealFolder(li.dataset.id!)) return;
    e.preventDefault();
    els.folderList.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
    li.classList.add("drop");
  });
  els.folderList.addEventListener("dragleave", (e) => {
    (e.target as HTMLElement).closest("li")?.classList.remove("drop");
  });
  els.folderList.addEventListener("drop", (e) => {
    e.preventDefault();
    els.folderList.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
    const folderId = rowId(e);
    const n = vault.get(e.dataTransfer?.getData("text/x-monkeynote") ?? null);
    if (n && folderId !== undefined && isRealFolder(folderId)) moveNote(n, folderId);
  });

  bindResizeHandles();
  for (const b of document.querySelectorAll<HTMLElement>(".js-new-note")) b.addEventListener("click", newNote);
  for (const b of document.querySelectorAll<HTMLElement>(".js-view")) {
    b.addEventListener("click", () => setView(b.dataset.view as "list" | "grid"));
  }
  $("#sidebar-toggle").addEventListener("click", toggleFolders);
  $("#back-to-gallery").addEventListener("click", backToGallery);

  // gallery: open a card, right-click for actions, drag onto a folder, search
  els.galleryGrid.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.id;
    if (id) openNote(id);
  });
  els.galleryGrid.addEventListener("contextmenu", (e) => {
    const n = vault.get((e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.id ?? null);
    if (!n) return;
    e.preventDefault();
    if (n.id !== currentId) openNote(n.id, { focus: false });
    openPalette({ title: noteTitle(n), items: noteCommands(n) });
  });
  els.galleryGrid.addEventListener("dragstart", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.id;
    if (!id || !e.dataTransfer) return;
    e.dataTransfer.setData("text/x-monkeynote", id);
    e.dataTransfer.effectAllowed = "move";
  });
  els.gallerySearch.addEventListener("input", () => {
    els.search.value = els.gallerySearch.value;
    renderNotes();
  });
  els.gallerySearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusGallery();
    }
  });
  $("#new-folder").addEventListener("click", () => void newFolder());
  $("#open-palette").addEventListener("click", () => openPalette());

  els.search.addEventListener("input", () => renderNotes());
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      const first = notesInView()[0];
      if (first) openNote(first.id);
    }
  });

  // Clicking empty space on the page puts the caret at the end.
  els.page.addEventListener("mousedown", (e) => {
    if (e.target === editor.ta || !current()) return;
    e.preventDefault();
    const end = editor.ta.value.length;
    editor.ta.setSelectionRange(end, end);
    editor.focus();
  });

  // key sounds
  editor.ta.addEventListener("keydown", (e) => {
    const s = settings();
    if (s.sound === "off" || e.ctrlKey || e.metaKey || editor.ta.readOnly) return;
    let key: KeyType | null = null;
    if (e.key === " ") key = "space";
    else if (e.key === "Enter") key = "enter";
    else if (e.key === "Backspace" || e.key === "Delete") key = "back";
    else if (e.key.length === 1 || e.key === "Tab") key = "char";
    if (key) playKey(s.sound, s.soundVolume, key);
  });

  // ctrl/cmd+click a [[link]] to follow it
  editor.ta.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey) followLinkAtCaret();
  });

  els.toast.addEventListener("click", () => {
    toastAction?.();
    els.toast.hidden = true;
  });
  els.statsBar.addEventListener("click", showStats);
  els.statsView.addEventListener("mousedown", (e) => {
    if (e.target === els.statsView) hideStats();
  });

  // Pick up edits made outside the app when the window comes back.
  let reloading = false;
  let lastReload = 0;
  window.addEventListener("focus", async () => {
    if (reloading || Date.now() - lastReload < 1500) return;
    reloading = true;
    lastReload = Date.now();
    try {
      const changed = await vault.reload(currentId);
      const n = current();
      if (!n) openNote(notesInView()[0]?.id ?? null, { focus: false });
      // changed in another app: keep the caret and scroll where they were
      else if (changed) {
        const top = els.scroller.scrollTop;
        editor.load(n.body, { caretAt: editor.ta.selectionStart });
        els.scroller.scrollTop = top;
      }
      renderAll();
    } catch (e) {
      toast(`couldn't read notes folder: ${e}`);
    } finally {
      reloading = false;
    }
  });

  const flushNow = () => {
    void vault.flush();
    void writeState();
  };
  window.addEventListener("beforeunload", flushNow);
  document.addEventListener("visibilitychange", flushNow);
}

async function bindWindowClose(): Promise<void> {
  if (!backend.desktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  // Make sure the last keystrokes hit the disk before the window goes away.
  await getCurrentWindow().onCloseRequested(async () => {
    await Promise.all([vault.flush(), writeState()]);
  });
}

// ---------------------------------------------------------------- boot

/** A full-window message, for when the app can't start. */
function showScreen(heading: string, message: string, action?: { label: string; run: () => void }): void {
  const box = document.createElement("div");
  box.className = "not-desktop";
  const title = document.createElement("h1");
  title.textContent = heading;
  const text = document.createElement("p");
  text.textContent = message;
  box.append(title, text);
  if (action) {
    const button = document.createElement("button");
    button.className = "screen-action";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    box.append(button);
  }
  document.body.replaceChildren(box);
  document.body.classList.add("ready");
}

/** Shown instead of the app if it's opened outside the desktop shell. */
function showNotDesktop(): void {
  showScreen("monkeynotes is a desktop app", "build it from github.com/nathanksou/monkeynotes and run it from there.");
}

/** The notes folder can't be read at all: say why and offer another folder. */
function showFolderError(e: unknown): void {
  showScreen("couldn't open your notes folder", String(e), {
    label: "choose another folder",
    run: async () => {
      try {
        if (await backend.chooseNotesDir()) location.reload();
      } catch (err) {
        showFolderError(err);
      }
    },
  });
}

async function main(): Promise<void> {
  try {
    backend = await createBackend();
  } catch (e) {
    if (e instanceof NotDesktopError) return showNotDesktop();
    throw e;
  }
  let rawState: string | null = null;
  try {
    rawState = await backend.loadState();
  } catch (e) {
    console.error(e);
  }
  let parsed: unknown = null;
  try {
    parsed = rawState ? JSON.parse(rawState) : null;
  } catch (e) {
    console.error("settings file is unreadable, using defaults", e);
    rawState = null;
  }
  state = normalizeState(parsed);
  stats = new TypingStats(state.stats);

  try {
    await openVault();
  } catch (e) {
    if (!isNotFound(e)) return showFolderError(e);
    // The chosen folder is missing (e.g. an unplugged drive). Use the default
    // folder for this session only, so the choice comes back with the drive.
    try {
      await backend.resetNotesDir(false);
      await openVault();
    } catch (err) {
      return showFolderError(err);
    }
    const missing = String(e).replace(/^NOT_FOUND:\s*/, "");
    setTimeout(() => toast(`notes folder not found: ${missing}. using ${notesDirPath} until next launch`, undefined, 10000), 500);
  }

  const legacy = await backend.loadLegacy().catch(() => null);
  if (legacy) {
    const before = vault.failures;
    const count = migrateLegacy(legacy, !rawState);
    await vault.flush();
    if (vault.failures === before) {
      await backend.retireLegacy();
      if (count) setTimeout(() => toast(`moved ${count} notes into ${notesDirPath}`), 500);
    } else {
      // Keep notes.json so the move is tried again next launch.
      setTimeout(() => toast("couldn't move your v0.1 notes yet; they're safe and will be retried next launch"), 500);
    }
  } else if (!rawState && !vault.notes.length) {
    vault.create(ROOT, WELCOME);
  }

  palette = new Palette($("#palette"));
  editor = new Editor($("#wrap"), els.scroller, {
    onChange: (value) => {
      const n = current();
      if (!n || n.deletedAt) return;
      vault.setBody(n, value);
      find.refresh();
      paintLinks();
      renderStatsSoon();
      renderSoon();
    },
    onType,
    onTyped: (x, y, h, ch) => spawnEffect(settings().typingAnimation, els.fx, editor.caretEl, x, y, h, ch),
  });
  find = new Find($("#find"), editor, $("#highlights"), els.scroller);
  linkLayer = new ParagraphLayer(els.decor);

  applySettings();
  bindEvents();
  void bindWindowClose();

  if (!isRealFolder(view().folderId) && view().folderId !== ALL && view().folderId !== TRASH) view().folderId = ALL;
  const last = vault.findByPath(view().notePath);
  const start = last && !last.deletedAt ? last : notesInView()[0];
  if (start && !notesInView().includes(start)) view().folderId = ALL;
  renderFolders();
  // gallery view starts on the cards, with the last note selected
  openNote(start?.id ?? null, { focus: !isGrid() });
  document.body.classList.add("ready");

  const DAY = 24 * 60 * 60 * 1000;
  if (backend.desktop && settings().checkUpdates && Date.now() - state.lastUpdateCheck > DAY) {
    setTimeout(() => void checkUpdates(false), 3000);
  }
}

void main();
