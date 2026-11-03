import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import "./styles.css";

import { Editor } from "./editor";
import {
  ALL,
  DEFAULT_FOLDER,
  TRASH,
  type DB,
  type FontFamily,
  type LineWidth,
  type Note,
  formatDate,
  notePreview,
  noteTitle,
  sortNotes,
  uid,
  wordCount,
} from "./model";
import { type Command, type Menu, Palette } from "./palette";
import * as storage from "./storage";
import { applyTheme, findTheme, themes } from "./themes";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const els = {
  app: $("#app"),
  folderList: $("#folder-list"),
  noteList: $("#note-list"),
  notesTitle: $("#notes-title"),
  search: $<HTMLInputElement>("#search"),
  scroller: $("#scroller"),
  page: $("#page"),
  wpm: $("#wpm"),
  meta: $("#note-meta"),
};

let db: DB;
let editor: Editor;
let palette: Palette;

// ---------------------------------------------------------------- state helpers

const persist = () => storage.save(db);
const settings = () => db.settings;
const current = (): Note | undefined => db.notes.find((n) => n.id === db.view.noteId);
const folderName = (id: string) =>
  id === ALL ? "all notes" : id === TRASH ? "recently deleted" : db.folders.find((f) => f.id === id)?.name ?? "notes";

function notesInView(): Note[] {
  const { folderId } = db.view;
  const q = els.search.value.trim().toLowerCase();
  return db.notes
    .filter((n) => (folderId === TRASH ? !!n.deletedAt : !n.deletedAt))
    .filter((n) => folderId === ALL || folderId === TRASH || n.folderId === folderId)
    .filter((n) => !q || n.body.toLowerCase().includes(q))
    .sort(sortNotes);
}

// ---------------------------------------------------------------- rendering

function renderFolders(): void {
  const live = db.notes.filter((n) => !n.deletedAt);
  const trashed = db.notes.length - live.length;
  const rows: { id: string; name: string; count: number }[] = [
    { id: ALL, name: "all notes", count: live.length },
    ...db.folders.map((f) => ({ id: f.id, name: f.name, count: live.filter((n) => n.folderId === f.id).length })),
  ];
  if (trashed || db.view.folderId === TRASH) rows.push({ id: TRASH, name: "recently deleted", count: trashed });

  els.folderList.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "folder";
      if (r.id === db.view.folderId) li.classList.add("active");
      if (r.id === ALL || r.id === TRASH) li.classList.add("smart");
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
  els.notesTitle.textContent = folderName(db.view.folderId);
  if (!notes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = els.search.value ? "no matches" : db.view.folderId === TRASH ? "nothing here" : "no notes yet";
    els.noteList.replaceChildren(li);
    return;
  }
  els.noteList.replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement("li");
      li.className = "note";
      li.dataset.id = n.id;
      li.draggable = !n.deletedAt;
      if (n.id === db.view.noteId) li.classList.add("active");
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
      if (db.view.folderId === ALL) {
        const f = document.createElement("div");
        f.className = "folder-tag";
        f.textContent = folderName(n.folderId);
        li.append(title, meta, f);
      } else {
        li.append(title, meta);
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
      : `${folderName(n.folderId)} · ${wordCount(n.body)} words · edited ${formatDate(n.updatedAt)}`
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

// ---------------------------------------------------------------- actions

function openNote(id: string | null, opts: { focus?: boolean } = {}): void {
  db.view.noteId = id;
  const n = current();
  editor.load(n?.body ?? "", { readOnly: !n || !!n.deletedAt, caretAt: "end" });
  els.page.classList.toggle("empty", !n);
  resetLiveStats();
  renderNotes();
  renderStats();
  persist();
  if (opts.focus !== false && n) editor.focus();
}

function openFolder(id: string): void {
  db.view.folderId = id;
  els.search.value = "";
  const notes = notesInView();
  const keep = notes.find((n) => n.id === db.view.noteId);
  renderFolders();
  openNote(keep?.id ?? notes[0]?.id ?? null, { focus: false });
}

function newNote(): void {
  const { folderId } = db.view;
  const target = folderId === ALL || folderId === TRASH ? DEFAULT_FOLDER : folderId;
  // Reuse an untouched empty note instead of piling them up.
  const blank = db.notes.find((n) => !n.deletedAt && n.body.trim() === "" && n.folderId === target);
  const now = Date.now();
  const note = blank ?? { id: uid(), folderId: target, body: "", createdAt: now, updatedAt: now };
  if (!blank) db.notes.push(note);
  if (folderId === TRASH) db.view.folderId = target;
  els.search.value = "";
  renderFolders();
  openNote(note.id);
}

async function newFolder(): Promise<void> {
  const name = await palette.ask("folder name", "", focusEditor);
  if (!name) return;
  const f = { id: uid(), name, createdAt: Date.now() };
  db.folders.push(f);
  openFolder(f.id);
  persist();
}

async function renameFolder(id: string): Promise<void> {
  const f = db.folders.find((x) => x.id === id);
  if (!f) return;
  const name = await palette.ask(`rename "${f.name}"`, f.name, focusEditor);
  if (!name) return;
  f.name = name;
  renderAll();
  persist();
}

function deleteFolder(id: string): void {
  if (id === DEFAULT_FOLDER) return;
  const now = Date.now();
  for (const n of db.notes) {
    if (n.folderId === id) {
      n.folderId = DEFAULT_FOLDER;
      if (!n.deletedAt) n.deletedAt = now;
    }
  }
  db.folders = db.folders.filter((f) => f.id !== id);
  if (db.view.folderId === id) openFolder(ALL);
  else renderAll();
  persist();
}

function trashNote(id: string): void {
  const n = db.notes.find((x) => x.id === id);
  if (!n) return;
  const list = notesInView();
  const i = list.findIndex((x) => x.id === id);
  if (n.body.trim() === "") db.notes = db.notes.filter((x) => x !== n);
  else n.deletedAt = Date.now();
  const next = list[i + 1] ?? list[i - 1];
  renderFolders();
  openNote(next && next.id !== id ? next.id : null);
}

function restoreNote(id: string): void {
  const n = db.notes.find((x) => x.id === id);
  if (!n) return;
  delete n.deletedAt;
  if (!db.folders.some((f) => f.id === n.folderId)) n.folderId = DEFAULT_FOLDER;
  db.view.folderId = n.folderId;
  renderFolders();
  openNote(n.id);
}

function destroyNote(id: string): void {
  const list = notesInView();
  const i = list.findIndex((x) => x.id === id);
  db.notes = db.notes.filter((x) => x.id !== id);
  const next = list[i + 1] ?? list[i - 1];
  renderFolders();
  openNote(next?.id ?? null);
}

function emptyTrash(): void {
  db.notes = db.notes.filter((n) => !n.deletedAt);
  if (db.view.folderId === TRASH) openFolder(ALL);
  else renderAll();
  persist();
}

function moveNote(id: string, folderId: string): void {
  const n = db.notes.find((x) => x.id === id);
  if (!n || n.deletedAt) return;
  n.folderId = folderId;
  renderAll();
  persist();
}

function togglePin(id: string): void {
  const n = db.notes.find((x) => x.id === id);
  if (!n) return;
  n.pinned = !n.pinned;
  renderNotes();
  persist();
}

function stepNote(dir: 1 | -1): void {
  const list = notesInView();
  if (!list.length) return;
  const i = list.findIndex((n) => n.id === db.view.noteId);
  const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
  openNote(next.id);
}

function setSetting<K extends keyof DB["settings"]>(key: K, value: DB["settings"][K]): void {
  db.settings[key] = value;
  applySettings();
  persist();
}

function focusEditor(): void {
  if (current()) editor.focus();
}

// ---------------------------------------------------------------- live stats (wpm)

const SESSION_GAP = 3000;
let sessionStart = 0;
let lastKey = 0;
let sessionChars = 0;

function resetLiveStats(): void {
  sessionStart = lastKey = sessionChars = 0;
  els.wpm.textContent = "";
  els.app.classList.remove("typing");
}

function onType(chars: number): void {
  const now = performance.now();
  if (now - lastKey > SESSION_GAP) {
    sessionStart = now;
    sessionChars = 0;
  }
  sessionChars += chars;
  lastKey = now;
  if (settings().focusMode) els.app.classList.add("typing");
}

setInterval(() => {
  const now = performance.now();
  const elapsed = (lastKey - sessionStart) / 60000;
  if (now - lastKey > SESSION_GAP || elapsed < 2 / 60) {
    els.wpm.classList.add("idle");
    return;
  }
  els.wpm.classList.remove("idle");
  els.wpm.textContent = String(Math.round(sessionChars / 5 / elapsed));
}, 250);

// ---------------------------------------------------------------- command line

function choice<T>(title: string, options: { label: string; value: T }[], get: () => T, set: (v: T) => void): Menu {
  const original = get();
  return {
    title,
    items: options.map((o) => ({
      label: o.label,
      active: o.value === original,
      run: () => set(o.value),
    })),
  };
}

function themeMenu(): Menu {
  const original = settings().theme;
  return {
    title: "theme",
    onCancel: () => applyTheme(findTheme(original)),
    items: themes.map((t) => ({
      label: t.name,
      active: t.name === original,
      preview: () => applyTheme(t),
      run: () => setSetting("theme", t.name),
    })),
  };
}

function noteCommands(n: Note): Command[] {
  if (n.deletedAt) {
    return [
      { label: "restore note", run: () => restoreNote(n.id) },
      { label: "delete note forever", run: () => destroyNote(n.id) },
    ];
  }
  return [
    { label: n.pinned ? "unpin note" : "pin note", run: () => togglePin(n.id) },
    {
      label: "move note to",
      sub: () => ({
        title: "move to folder",
        items: db.folders.map((f) => ({ label: f.name, active: f.id === n.folderId, run: () => moveNote(n.id, f.id) })),
      }),
    },
    { label: "copy note to clipboard", run: () => void navigator.clipboard.writeText(n.body) },
    { label: "delete note", hint: "moves to recently deleted", run: () => trashNote(n.id) },
  ];
}

function folderCommands(id: string): Command[] {
  const f = db.folders.find((x) => x.id === id);
  if (id === TRASH) return [{ label: "empty recently deleted", run: emptyTrash }];
  if (!f) return [];
  const cmds: Command[] = [{ label: `rename folder "${f.name}"`, run: () => void renameFolder(id) }];
  if (id !== DEFAULT_FOLDER) {
    const count = db.notes.filter((n) => n.folderId === id && !n.deletedAt).length;
    cmds.push({
      label: `delete folder "${f.name}"`,
      sub: () => ({
        title: count ? `delete "${f.name}" and move its ${count} notes to recently deleted?` : `delete "${f.name}"?`,
        items: [
          { label: "no", run: () => undefined },
          { label: "yes, delete", run: () => deleteFolder(id) },
        ],
      }),
    });
  }
  return cmds;
}

function jumpMenu(): Menu {
  return {
    title: "jump to note",
    items: db.notes
      .filter((n) => !n.deletedAt)
      .sort(sortNotes)
      .map((n) => ({
        label: noteTitle(n),
        hint: folderName(n.folderId),
        run: () => {
          if (db.view.folderId !== ALL && db.view.folderId !== n.folderId) {
            db.view.folderId = ALL;
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
          ...db.folders,
          ...(db.notes.some((x) => x.deletedAt) ? [{ id: TRASH, name: "recently deleted" }] : []),
        ].map((f) => ({ label: f.name, active: f.id === db.view.folderId, run: () => openFolder(f.id) })),
      }),
    },
    ...(n ? noteCommands(n) : []),
    ...folderCommands(db.view.folderId),
    { label: "theme", sub: themeMenu },
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
    { label: "smooth caret", sub: () => choice("smooth caret", onOff, () => s.smoothCaret, (v) => setSetting("smoothCaret", v)) },
    { label: "live wpm", sub: () => choice("live wpm", onOff, () => s.liveStats, (v) => setSetting("liveStats", v)) },
    {
      label: "focus mode",
      hint: "hide ui while typing",
      sub: () => choice("focus mode", onOff, () => s.focusMode, (v) => setSetting("focusMode", v)),
    },
    { label: "spellcheck", sub: () => choice("spellcheck", onOff, () => s.spellcheck, (v) => setSetting("spellcheck", v)) },
    { label: s.zen ? "exit zen mode" : "zen mode", hint: "ctrl+\\", run: () => setSetting("zen", !s.zen) },
    ...(storage.isTauri ? [{ label: "copy data folder path", run: () => void copyDataDir() }] : []),
  ];
  return { title: "type to search", items };
}

async function copyDataDir(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await navigator.clipboard.writeText(await invoke<string>("data_dir"));
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

  els.folderList.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (li) openFolder(li.dataset.id!);
  });
  els.folderList.addEventListener("dblclick", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (li && db.folders.some((f) => f.id === li.dataset.id)) void renameFolder(li.dataset.id!);
  });
  els.folderList.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (!li) return;
    e.preventDefault();
    const cmds = folderCommands(li.dataset.id!);
    if (cmds.length) openPalette({ title: folderName(li.dataset.id!), items: cmds });
  });

  els.noteList.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (li) openNote(li.dataset.id!);
  });
  els.noteList.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (!li) return;
    e.preventDefault();
    const n = db.notes.find((x) => x.id === li.dataset.id);
    if (!n) return;
    if (n.id !== db.view.noteId) openNote(n.id, { focus: false });
    openPalette({ title: noteTitle(n), items: noteCommands(n) });
  });

  // drag a note onto a folder to move it
  els.noteList.addEventListener("dragstart", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (!li || !e.dataTransfer) return;
    e.dataTransfer.setData("text/x-monkeynote", li.dataset.id!);
    e.dataTransfer.effectAllowed = "move";
  });
  els.folderList.addEventListener("dragover", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (!li || !db.folders.some((f) => f.id === li.dataset.id)) return;
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
    const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    const id = e.dataTransfer?.getData("text/x-monkeynote");
    if (li && id) moveNote(id, li.dataset.id!);
  });

  $("#new-note").addEventListener("click", newNote);
  $("#new-folder").addEventListener("click", () => void newFolder());
  $("#open-palette").addEventListener("click", () => openPalette());

  els.search.addEventListener("input", () => {
    renderNotes();
  });
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

  const flushNow = () => void storage.flush();
  window.addEventListener("beforeunload", flushNow);
  document.addEventListener("visibilitychange", flushNow);
}

async function bindWindowClose(): Promise<void> {
  if (!storage.isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  // Make sure the last keystrokes hit the disk before the window goes away.
  await getCurrentWindow().onCloseRequested(async () => {
    await storage.flush();
  });
}

// ---------------------------------------------------------------- boot

async function main(): Promise<void> {
  db = await storage.load();
  palette = new Palette($("#palette"));
  editor = new Editor($("#wrap"), els.scroller, {
    onChange: (value) => {
      const n = current();
      if (!n || n.deletedAt) return;
      n.body = value;
      n.updatedAt = Date.now();
      renderStats();
      renderSoon();
      persist();
    },
    onType,
  });

  applySettings();
  bindEvents();
  void bindWindowClose();

  if (!db.notes.some((n) => n.id === db.view.noteId && !n.deletedAt)) {
    db.view.noteId = notesInView()[0]?.id ?? null;
  }
  renderFolders();
  openNote(db.view.noteId);
  document.body.classList.add("ready");
}

void main();
