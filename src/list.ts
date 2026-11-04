import { baseOf, isUnder } from "./paths";
import { ALL, type Note, ROOT, TRASH, formatDate, notePreview, noteTitle, setTitleSource, wordCount } from "./model";
import { applyTheme, findTheme } from "./themes";
import { app, current, depthOf, els, folderPath, isGrid, notesInView, settings, view, viewTitle } from "./app";
import { applyView, icon, renderGallery, starIcon } from "./layout";

interface FolderRow {
  id: string;
  name: string;
  count: number;
  depth: number;
  starred?: boolean;
  /** for a starred subfolder shown at the top: where it lives */
  parent?: string;
  /** whether this row's subfolders are listed right under it */
  hasKids?: boolean;
}

/**
 * Sidebar rows: "all notes", then starred folders (each with its subfolders),
 * then the rest of the folder tree, then the trash.
 */
function folderRows(): FolderRow[] {
  const live = app.vault.notes.filter((n) => !n.deletedAt);
  const counts = new Map<string, number>();
  for (const n of live) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);
  const count = (id: string) => counts.get(id) ?? 0;
  const starred = app.vault.starredFolders;
  const under = isUnder;
  // starred folders that aren't already inside another starred folder
  const starRoots = app.vault.folders.filter((f) => starred.has(f.id) && ![...starred].some((s) => s !== f.id && under(f.id, s)));
  const inStarBlock = (id: string) => starRoots.some((r) => under(id, r.id));

  // One block of the tree (a starred folder with its subfolders, or the rest).
  // A row is hidden only by a collapsed folder in the same block, and its
  // twisty only appears if it has subfolders in the same block.
  const block = (ids: string[], base: (id: string) => number): FolderRow[] => {
    const inBlock = new Set(ids);
    const collapsed = view().collapsed.filter((c) => inBlock.has(c));
    const tucked = (id: string) => collapsed.some((c) => isUnder(id, c) && id !== c);
    const parents = new Set(ids.map((id) => id.slice(0, id.lastIndexOf("/"))).filter((p) => inBlock.has(p)));
    return ids
      .filter((id) => !tucked(id))
      .map((id) => ({
        id,
        name: baseOf(id),
        parent: base(id) === 0 && id.includes("/") ? folderPath(id.slice(0, id.lastIndexOf("/"))) : undefined,
        count: count(id),
        depth: base(id),
        starred: starred.has(id),
        hasKids: id !== ROOT && parents.has(id),
      }));
  };

  const rows: FolderRow[] = [{ id: ALL, name: "all notes", count: live.length, depth: 0 }];
  for (const r of starRoots) {
    const ids = app.vault.folders.map((f) => f.id).filter((id) => under(id, r.id));
    rows.push(...block(ids, (id) => depthOf(id) - depthOf(r.id)));
  }
  const rest = app.vault.folders.map((f) => f.id).filter((id) => !inStarBlock(id));
  rows.push(...block(rest, depthOf).map((row) => (row.id === ROOT ? { ...row, name: "notes", hasKids: false } : row)));
  const trashed = app.vault.notes.length - live.length;
  if (trashed || view().folderId === TRASH) rows.push({ id: TRASH, name: "trash", count: trashed, depth: 0 });
  return rows;
}

export function renderFolders(): void {
  els.folderList.replaceChildren(
    ...folderRows().map((r) => {
      const li = document.createElement("li");
      li.dataset.id = r.id;
      li.className = "folder";
      li.tabIndex = 0;
      if (r.id === view().folderId) li.classList.add("active");
      if (r.starred) li.classList.add("starred");
      li.style.setProperty("--depth", String(r.depth));
      const twisty = document.createElement("span");
      twisty.className = "twisty";
      if (r.hasKids) {
        twisty.textContent = view().collapsed.includes(r.id) ? "\u25b8" : "\u25be";
        twisty.dataset.toggle = r.id;
      }
      li.append(twisty, icon(r.id === ALL ? "all" : r.id === TRASH ? "trash" : "folder"));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      if (r.id !== ALL && r.id !== TRASH && r.id !== ROOT) name.title = folderPath(r.id);
      if (r.parent) {
        const where = document.createElement("span");
        where.className = "parent";
        where.textContent = `in ${r.parent}`;
        name.append(where);
      }
      li.append(name);
      if (r.starred) li.append(starIcon());
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(r.count);
      li.append(count);
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
  li.tabIndex = 0;
  li.draggable = !n.deletedAt;
  if (n.id === app.currentId) li.classList.add("active");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = noteTitle(n);
  if (n.starred) title.prepend(starIcon());
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
    f.append(icon("folder"), label);
    li.append(f);
  }
  return li;
}

export function renderNotes(): void {
  const notes = notesInView();
  const trashFull = view().folderId === TRASH && notes.length > 0;
  for (const el of document.querySelectorAll<HTMLElement>(".trash-foot")) el.hidden = !trashFull;
  els.notesTitle.textContent = viewTitle();
  if (isGrid()) {
    renderGallery(notes);
    renderedOrder = [];
    return; // the list is hidden in gallery view: don't build it
  }
  if (!notes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText();
    els.noteList.replaceChildren(li);
    renderedOrder = [];
    return;
  }
  els.noteList.replaceChildren(...notes.map(noteRow));
  renderedOrder = notes.map((n) => n.id);
  els.noteList.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
}

export const emptyText = () => (els.search.value ? "no matches" : view().folderId === TRASH ? "nothing here" : "no notes yet");

/** Move the highlight to the open note without rebuilding the list, if its order is unchanged. */
export function markActive(): boolean {
  if (isGrid() || !renderedOrder.length) return false;
  const order = notesInView().map((n) => n.id);
  if (order.length !== renderedOrder.length || order.some((id, i) => id !== renderedOrder[i])) return false;
  for (const li of els.noteList.querySelectorAll("li.note.active")) li.classList.remove("active");
  const row = app.currentId ? els.noteList.querySelector<HTMLElement>(`li[data-id="${app.currentId}"]`) : null;
  row?.classList.add("active");
  row?.scrollIntoView({ block: "nearest" });
  return true;
}

export function renderStats(): void {
  const n = current();
  const part = (text: string) => {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  };
  // folder, words | (typing stats) | last edited + version history, all in one line
  els.meta.replaceChildren(
    ...(n
      ? n.deletedAt
        ? [part("in the trash · restore it from the command line, or it's deleted after 30 days")]
        : [part(folderPath(n.folderId)), part(`${wordCount(n.body)} words`)]
      : []),
  );
  const edited = document.getElementById("note-edited");
  if (edited) edited.textContent = n && !n.deletedAt ? `edited ${formatDate(n.updatedAt)}` : "";
  updateNoteButtons(n);
}

/** The toolbar's star and history buttons follow the open note. */
function updateNoteButtons(n: Note | undefined): void {
  const usable = !!n && !n.deletedAt;
  const star = document.getElementById("star-note") as HTMLButtonElement | null;
  if (star) {
    star.disabled = !usable;
    star.classList.toggle("on", !!n?.starred);
    star.setAttribute("aria-pressed", String(!!n?.starred));
    const label = n?.starred ? "unstar note" : "star note";
    star.title = label;
    star.setAttribute("aria-label", label);
  }
  const history = document.getElementById("open-history") as HTMLButtonElement | null;
  if (history) history.disabled = !usable;
}

let statsTimer = 0;
/** While typing, the footer (and its whole-note word count) updates at most every 250ms. */
export function renderStatsSoon(): void {
  if (statsTimer) return;
  statsTimer = window.setTimeout(() => {
    statsTimer = 0;
    renderStats();
  }, 250);
}

let listTimer = 0;
/** After typing: refresh just the open note's row, unless the list order changed. */
export function renderSoon(): void {
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

export function renderAll(): void {
  renderFolders();
  renderNotes();
  renderStats();
}

export function applySettings(): void {
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
  app.editor?.ta.setAttribute("spellcheck", String(s.spellcheck));
  app.editor?.setSmooth(s.smoothCaret);
  app.editor?.refresh();
}

// ---------------------------------------------------------------- note actions
