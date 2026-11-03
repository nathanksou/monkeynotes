import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import "./styles.css";

import { backend } from "./backend";
import { Editor } from "./editor";
import { spawnEffect } from "./effects";
import { Find } from "./find";
import { linkAt, linkRanges } from "./links";
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
  normalizeState,
  setTitleSource,
  notePreview,
  noteTitle,
  sortNotes,
  wordCount,
} from "./model";
import { type Command, type Menu, Palette } from "./palette";
import { type KeyType, playKey } from "./sound";
import { TypingStats, dayKey, formatDuration } from "./stats";
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
let stats: TypingStats;

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

function notesInView(): Note[] {
  const { folderId } = view();
  const q = els.search.value.trim().toLowerCase();
  return vault.notes
    .filter((n) => (folderId === TRASH ? !!n.deletedAt : !n.deletedAt))
    .filter((n) => folderId === ALL || folderId === TRASH || n.folderId === folderId)
    .filter((n) => !q || n.body.toLowerCase().includes(q))
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
      li.append(twisty);
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

function renderNotes(): void {
  const notes = notesInView();
  els.notesTitle.textContent = folderName(view().folderId);
  if (!notes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = els.search.value ? "no matches" : view().folderId === TRASH ? "nothing here" : "no notes yet";
    els.noteList.replaceChildren(li);
    return;
  }
  els.noteList.replaceChildren(
    ...notes.map((n) => {
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
        f.textContent = folderPath(n.folderId);
        li.append(f);
      }
      return li;
    }),
  );
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

let listTimer = 0;
function renderSoon(): void {
  clearTimeout(listTimer);
  listTimer = window.setTimeout(() => {
    renderNotes();
    renderFolders();
  }, 120);
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
  els.app.classList.toggle("zen", s.zen);
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
  editor.load(n?.body ?? "", { readOnly: !n || !!n.deletedAt, caretAt: "end" });
  els.fx.replaceChildren();
  paintLinks();
  els.page.classList.toggle("empty", !n);
  resetLiveStats();
  renderNotes();
  renderStats();
  saveState();
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
    openNote(next?.id ?? null);
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
  const current = n.path ? n.path.slice(n.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") : noteTitle(n);
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

// ---------------------------------------------------------------- folder actions

async function newFolder(parent: string = ROOT): Promise<void> {
  const name = await palette.ask(parent ? `new folder inside ${folderPath(parent)}` : "folder name", "", focusEditor);
  if (!name) return;
  view().collapsed = view().collapsed.filter((c) => c !== parent);
  openFolder(vault.createFolder(name, parent).id);
}

/** Swap a folder id prefix after a rename. */
const swapPrefix = (x: string, from: string, to: string) =>
  x === from ? to : x.startsWith(from + "/") ? to + x.slice(from.length) : x;

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
  const files = await backend.pickImportFiles().catch((e) => (toast(`import failed: ${e}`), null));
  if (!files?.length) return;
  const folder = targetFolder();
  const notes = vault.importFiles(folder, files);
  if (view().folderId === TRASH) view().folderId = folder;
  renderFolders();
  openNote(notes[0].id);
  toast(`imported ${notes.length} note${notes.length === 1 ? "" : "s"} into ${folderName(folder)}`);
}

async function importDir(): Promise<void> {
  const dir = await backend.pickImportDir().catch((e) => (toast(`import failed: ${e}`), null));
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

async function openVault(root: string): Promise<void> {
  if (vault) await vault.flush();
  const next = new Vault(backend, root);
  next.onError = (m) => toast(m);
  next.titleFromFile = settings().titleSource === "file name";
  await next.load();
  vault = next;
}

async function changeNotesDir(dir: string | null): Promise<void> {
  try {
    await openVault(dir ?? (await backend.defaultRoot()));
  } catch (e) {
    toast(`couldn't open that folder: ${e}`);
    return;
  }
  state.notesDir = dir;
  view().folderId = ALL;
  els.search.value = "";
  currentId = null;
  renderFolders();
  openNote(notesInView()[0]?.id ?? null);
  await writeState();
  toast(`notes folder: ${vault.root}`);
}

async function pickNotesDir(): Promise<void> {
  const dir = await backend.pickNotesDir();
  if (dir) await changeNotesDir(dir);
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
    if (!o.body?.trim()) continue;
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
  if (streak) parts.push([String(streak), streak === 1 ? "day streak" : "day streak"]);
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
  const t = stats.totals();
  const today = stats.today();
  const days = stats.recent(14);
  const max = Math.max(1, ...days.map((d) => d.stats?.chars ?? 0));
  const box = document.createElement("div");
  box.className = "stats-box";
  const h = document.createElement("h2");
  h.textContent = "typing stats";
  const grid = document.createElement("div");
  grid.className = "stats-grid";
  const cell = (value: string, label: string) => {
    const c = document.createElement("div");
    const v = document.createElement("div");
    v.className = "big";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    c.append(l, v);
    return c;
  };
  grid.append(
    cell(String(Math.round(today.chars / 5)), "words today"),
    cell(formatDuration(today.ms), "typing today"),
    cell(String(today.best || "-"), "best wpm today"),
    cell(String(stats.streak()), "day streak"),
    cell(String(stats.average()), "avg wpm (30 days)"),
    cell(String(t.best || "-"), "best wpm ever"),
    cell(t.words.toLocaleString(), "words all time"),
    cell(formatDuration(t.ms), "typing all time"),
  );
  const chart = document.createElement("div");
  chart.className = "stats-chart";
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "col";
    if (d.key === dayKey()) col.classList.add("today");
    const words = Math.round((d.stats?.chars ?? 0) / 5);
    col.title = `${d.day.toLocaleDateString()} · ${words} words · ${formatDuration(d.stats?.ms ?? 0)}`;
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${((d.stats?.chars ?? 0) / max) * 100}%`;
    const lbl = document.createElement("div");
    lbl.className = "day";
    lbl.textContent = d.day.toLocaleDateString([], { weekday: "narrow" });
    col.append(bar, lbl);
    chart.append(col);
  }
  const foot = document.createElement("div");
  foot.className = "stats-foot";
  foot.textContent = "words = characters / 5 · only active typing time counts · esc to close";
  box.append(h, grid, chart, foot);
  els.statsView.replaceChildren(box);
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
  const stem = (p: string) => p.replace(/\.[^./]+$/, "").toLowerCase();
  const live = vault.notes.filter((n) => !n.deletedAt);
  let n =
    live.find((x) => x.path && stem(x.path) === t) ??
    live.find((x) => x.path && stem(x.path.slice(x.path.lastIndexOf("/") + 1)) === t) ??
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
function paintLinks(): void {
  clearTimeout(decorTimer);
  decorTimer = window.setTimeout(() => {
    const text = editor.ta.value;
    const ranges = linkRanges(text);
    if (!ranges.length) {
      els.decor.replaceChildren();
      return;
    }
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
    parts.push(document.createTextNode(text.slice(last) + "\u200b"));
    els.decor.replaceChildren(...parts);
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
    { label: s.zen ? "exit zen mode" : "zen mode", hint: "ctrl+\\", run: () => setSetting("zen", !s.zen) },
    ...(desktop
      ? [
          { label: "change notes folder", hint: vault.root, run: () => void pickNotesDir() },
          ...(state.notesDir ? [{ label: "use default notes folder", run: () => void changeNotesDir(null) }] : []),
          { label: "copy notes folder path", run: () => void navigator.clipboard.writeText(vault.root) },
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
      setSetting("zen", !settings().zen);
    } else if (mod(e) && e.shiftKey && k === "f") {
      e.preventDefault();
      if (settings().zen) setSetting("zen", false);
      els.search.focus();
      els.search.select();
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

  const rowId = (e: Event, _list: HTMLElement) =>
    (e.target as HTMLElement).closest<HTMLElement>("li[data-id]")?.dataset.id;

  els.folderList.addEventListener("click", (e) => {
    const toggle = (e.target as HTMLElement).closest<HTMLElement>("[data-toggle]");
    if (toggle) return toggleCollapsed(toggle.dataset.toggle!);
    const id = rowId(e, els.folderList);
    if (id !== undefined) openFolder(id);
  });
  els.folderList.addEventListener("dblclick", (e) => {
    const id = rowId(e, els.folderList);
    if (id !== undefined && id !== ROOT && isRealFolder(id)) void renameFolder(id);
  });
  els.folderList.addEventListener("contextmenu", (e) => {
    const id = rowId(e, els.folderList);
    if (id === undefined) return;
    e.preventDefault();
    const cmds = folderCommands(id);
    if (cmds.length) openPalette({ title: folderName(id), items: cmds });
  });

  els.noteList.addEventListener("click", (e) => {
    const id = rowId(e, els.noteList);
    if (id) openNote(id);
  });
  els.noteList.addEventListener("contextmenu", (e) => {
    const n = vault.get(rowId(e, els.noteList) ?? null);
    if (!n) return;
    e.preventDefault();
    if (n.id !== currentId) openNote(n.id, { focus: false });
    openPalette({ title: noteTitle(n), items: noteCommands(n) });
  });

  // drag a note onto a folder to move it
  els.noteList.addEventListener("dragstart", (e) => {
    const id = rowId(e, els.noteList);
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
    const folderId = rowId(e, els.folderList);
    const n = vault.get(e.dataTransfer?.getData("text/x-monkeynote") ?? null);
    if (n && folderId !== undefined && isRealFolder(folderId)) moveNote(n, folderId);
  });

  $("#new-note").addEventListener("click", newNote);
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
  window.addEventListener("focus", async () => {
    try {
      const changed = await vault.reload(currentId);
      const n = current();
      if (!n) openNote(notesInView()[0]?.id ?? null, { focus: false });
      else if (changed) editor.load(n.body, { caretAt: "end" });
      renderAll();
    } catch (e) {
      toast(`couldn't read notes folder: ${e}`);
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

async function main(): Promise<void> {
  let rawState: string | null = null;
  try {
    rawState = await backend.loadState();
  } catch (e) {
    console.error(e);
  }
  state = normalizeState(rawState ? JSON.parse(rawState) : null);
  stats = new TypingStats(state.stats);

  try {
    await openVault(state.notesDir ?? (await backend.defaultRoot()));
  } catch (e) {
    // The chosen folder is gone (e.g. an unplugged drive): fall back to the default.
    state.notesDir = null;
    await openVault(await backend.defaultRoot());
    setTimeout(() => toast(`notes folder unavailable, using the default: ${e}`), 500);
  }

  const legacy = await backend.loadLegacy().catch(() => null);
  if (legacy) {
    const count = migrateLegacy(legacy, !rawState);
    await vault.flush();
    await backend.retireLegacy();
    if (count) setTimeout(() => toast(`moved ${count} notes into ${vault.root}`), 500);
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
      renderStats();
      renderSoon();
    },
    onType,
    onTyped: (x, y, h, ch) => spawnEffect(settings().typingAnimation, els.fx, editor.caretEl, x, y, h, ch),
  });
  find = new Find($("#find"), editor, $("#highlights"), els.scroller);

  applySettings();
  bindEvents();
  void bindWindowClose();

  if (!isRealFolder(view().folderId) && view().folderId !== ALL && view().folderId !== TRASH) view().folderId = ALL;
  const last = vault.findByPath(view().notePath);
  const start = last && !last.deletedAt ? last : notesInView()[0];
  if (start && !notesInView().includes(start)) view().folderId = ALL;
  renderFolders();
  openNote(start?.id ?? null);
  document.body.classList.add("ready");

  const DAY = 24 * 60 * 60 * 1000;
  if (backend.desktop && settings().checkUpdates && Date.now() - state.lastUpdateCheck > DAY) {
    setTimeout(() => void checkUpdates(false), 3000);
  }
}

void main();
