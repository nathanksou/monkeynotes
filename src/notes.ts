import { showFolderError } from "./screens";
import { stemOf, swapPrefix } from "./paths";
import { ALL, type Note, ROOT, type Settings, TRASH, type TitleSource, noteTitle } from "./model";
import { Vault, safeName } from "./vault";
import { app, current, els, folderName, folderPath, isGrid, notesInView, saveState, settings, targetFolder, toast, view, writeState } from "./app";
import { markActive, renderAll, renderFolders, renderNotes, renderStats } from "./list";
import { applyView, restoreFocus, setSetting } from "./layout";
import { paintLinks, resetLiveStats } from "./typing";
import { openPalette } from "./commands";

export function openNote(id: string | null, opts: { focus?: boolean } = {}): void {
  const prev = current();
  if (prev && prev.id !== id && app.vault.discardIfBlank(prev)) renderFolders();
  app.find.close(false);
  app.currentId = id;
  const n = current();
  app.editor.load(n?.body ?? "", { readOnly: !n || !!n.deletedAt, caretAt: "start" });
  els.fx.replaceChildren();
  paintLinks();
  els.page.classList.toggle("empty", !n);
  resetLiveStats();
  if (!markActive()) renderNotes();
  renderStats();
  saveState();
  if (isGrid()) {
    // in gallery view, opening a note (not just selecting one) shows it full-size
    app.galleryNoteOpen = !!n && opts.focus !== false;
    applyView();
  }
  if (opts.focus !== false && n) app.editor.focus();
}

export function openFolder(id: string): void {
  view().folderId = id;
  els.search.value = "";
  const notes = notesInView();
  const keep = notes.find((n) => n.id === app.currentId);
  renderFolders();
  openNote(keep?.id ?? notes[0]?.id ?? null, { focus: false });
}

export function newNote(): void {
  const folder = targetFolder();
  const blank = app.vault.notes.find((n) => !n.deletedAt && !n.path && n.body.trim() === "" && n.folderId === folder);
  const note = blank ?? app.vault.create(folder);
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

export const trashNote = (n: Note) => noteAction(() => app.vault.trash(n), notesInView());
export const destroyNote = (n: Note) => noteAction(() => app.vault.destroy(n), notesInView());
export const moveNote = (n: Note, folderId: string) => noteAction(() => app.vault.move(n, folderId), notesInView());
export const toggleStar = (n: Note) => noteAction(() => app.vault.toggleStar(n));

export function restoreNote(n: Note): void {
  app.vault.restore(n);
  view().folderId = n.folderId;
  renderFolders();
  openNote(n.id);
}

/** Ask first: emptying the trash can't be undone. */
export function confirmEmptyTrash(): void {
  const count = app.vault.notes.filter((n) => n.deletedAt).length;
  if (!count) return;
  openPalette({
    title: `delete ${count} note${count === 1 ? "" : "s"} forever? this can't be undone`,
    items: [
      { label: "no, keep them", run: () => undefined },
      { label: `yes, delete ${count === 1 ? "it" : `all ${count}`} forever`, run: emptyTrash },
    ],
  });
}

function emptyTrash(): void {
  app.vault.emptyTrash();
  if (view().folderId === TRASH) openFolder(ALL);
  else renderAll();
}

export function stepNote(dir: 1 | -1): void {
  const list = notesInView();
  if (!list.length) return;
  const i = list.findIndex((n) => n.id === app.currentId);
  openNote(list[Math.min(list.length - 1, Math.max(0, i + dir))].id);
}

export async function renameNote(n: Note): Promise<void> {
  const current = n.path ? stemOf(n.path) : noteTitle(n);
  const name = await app.palette.ask("rename note file", current, restoreFocus);
  if (!name) return;
  app.vault.renameNote(n, name);
  renderAll();
  saveState();
}

export function setTitleMode(mode: TitleSource): void {
  setSetting("titleSource", mode);
  app.vault.setTitleFromFile(mode === "file name");
  renderAll();
}

// ---------------------------------------------------------------- version history

export async function newFolder(parent: string = ROOT): Promise<void> {
  const name = await app.palette.ask(parent ? `new folder inside ${folderPath(parent)}` : "folder name", "", restoreFocus);
  if (!name) return;
  view().collapsed = view().collapsed.filter((c) => c !== parent);
  openFolder(app.vault.createFolder(name, parent).id);
}


export function toggleCollapsed(id: string): void {
  const c = view().collapsed;
  view().collapsed = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
  renderFolders();
  saveState();
}

export async function renameFolder(id: string): Promise<void> {
  const f = app.vault.folders.find((x) => x.id === id);
  if (!f || id === ROOT) return;
  const name = await app.palette.ask(`rename "${f.name}"`, f.name, restoreFocus);
  if (!name) return;
  const next = app.vault.renameFolder(id, name);
  view().folderId = swapPrefix(view().folderId, id, next);
  view().collapsed = view().collapsed.map((c) => swapPrefix(c, id, next));
  renderAll();
  saveState();
}

export function deleteFolder(id: string): void {
  app.vault.deleteFolder(id);
  view().collapsed = view().collapsed.filter((c) => c !== id && !c.startsWith(id + "/"));
  if (view().folderId === id || view().folderId.startsWith(id + "/")) openFolder(ALL);
  else {
    if (current()?.deletedAt) openNote(notesInView()[0]?.id ?? null);
    renderAll();
  }
}

// ---------------------------------------------------------------- import / export / notes folder

export async function importFiles(): Promise<void> {
  const files = await app.backend.importFiles().catch((e: unknown) => (toast(`import failed: ${e}`), null));
  if (!files?.length) return;
  const folder = targetFolder();
  const notes = app.vault.importFiles(folder, files);
  if (view().folderId === TRASH) view().folderId = folder;
  renderFolders();
  openNote(notes[0].id);
  toast(`imported ${notes.length} note${notes.length === 1 ? "" : "s"} into ${folderName(folder)}`);
}

export async function importDir(): Promise<void> {
  const dir = await app.backend.importDir().catch((e: unknown) => (toast(`import failed: ${e}`), null));
  if (!dir) return;
  const { folder, count } = app.vault.importDir(dir);
  openFolder(folder.id);
  toast(`imported ${count} note${count === 1 ? "" : "s"} into ${folder.name}`);
}

export async function exportNote(n: Note): Promise<void> {
  await app.vault.flush();
  const ok = await app.backend.exportNote(safeName(noteTitle(n)), n.body).catch((e) => (toast(`export failed: ${e}`), false));
  if (ok) toast("note exported");
}

export async function exportAll(): Promise<void> {
  await app.vault.flush();
  const files = app.vault.notes.filter((n) => !n.deletedAt && n.path).map((n) => ({ path: n.path, body: n.body }));
  const dest = await app.backend.exportAll(files).catch((e) => (toast(`export failed: ${e}`), null));
  if (dest) toast(`exported ${files.length} notes to ${dest}`);
}

/** Load the current notes folder into a fresh vault. Throws if it can't be read. */
export async function openVault(): Promise<void> {
  const next = new Vault(app.backend);
  next.onError = (m) => toast(m, undefined, 6000);
  next.titleFromFile = settings().titleSource === "file name";
  // A folder rename that failed on disk was undone: point the view back at the old name.
  next.onFolderRenameReverted = (from, to) => {
    view().folderId = swapPrefix(view().folderId, to, from);
    view().collapsed = view().collapsed.map((c) => swapPrefix(c, to, from));
    renderAll();
    saveState();
  };
  // a note moved and links to it were rewritten: show the open note's new text
  next.onLinksUpdated = (notes) => {
    const n = current();
    if (n && notes.includes(n)) {
      const top = els.scroller.scrollTop;
      app.editor.load(n.body, { caretAt: app.editor.ta.selectionStart });
      els.scroller.scrollTop = top;
      paintLinks();
    }
    renderNotes();
  };
  await next.load();
  app.vault = next;
  app.notesDirPath = await app.backend.notesDir();
}

/** Switch notes folders (`choose`: ask the user; otherwise go back to the default). */
export async function changeNotesDir(choose: boolean): Promise<void> {
  if (app.vault) {
    const failedBefore = app.vault.failures;
    await app.vault.flush();
    if (app.vault.failures > failedBefore) {
      toast("some notes haven't been saved yet, so the folder wasn't changed. try again in a moment");
      return;
    }
  }
  // The backend switches folders before telling us, so the old vault must not
  // touch the disk from here on, and typing waits until the new folder is in.
  const old = app.vault as Vault | undefined;
  const wasReadOnly = app.editor.ta.readOnly;
  old?.freeze();
  app.editor.ta.readOnly = true;
  const cancel = () => {
    old?.unfreeze();
    app.editor.ta.readOnly = wasReadOnly;
  };
  try {
    if (choose) {
      if (!(await app.backend.chooseNotesDir())) return cancel();
    } else {
      await app.backend.resetNotesDir(true);
    }
  } catch (e) {
    cancel();
    toast(`couldn't change the notes folder: ${e}`);
    return;
  }
  // If the new folder can't be read, stop and say so instead.
  try {
    await openVault();
  } catch (e) {
    showFolderError(e);
    return;
  }
  view().folderId = ALL;
  els.search.value = "";
  app.currentId = null;
  renderFolders();
  openNote(notesInView()[0]?.id ?? null);
  await writeState();
  toast(`notes folder: ${app.notesDirPath}`);
}

/** Bring notes from the v0.1 single-file database into the notes folder. */
export function migrateLegacy(raw: string, freshState: boolean): number {
  type OldNote = { folderId: string; body: string; pinned?: boolean; deletedAt?: number; createdAt?: number };
  let old: { folders?: { id: string; name: string }[]; notes?: OldNote[]; settings?: Partial<Settings> };
  try {
    old = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (freshState && old.settings) app.state.settings = { ...app.state.settings, ...old.settings };
  const folderMap = new Map<string, string>([["notes", ROOT]]);
  for (const f of old.folders ?? []) {
    if (!folderMap.has(f.id)) folderMap.set(f.id, app.vault.createFolder(f.name).id);
  }
  let count = 0;
  for (const o of old.notes ?? []) {
    // skip blanks, and notes a previous (partly failed) migration already brought over
    if (!o.body?.trim() || app.vault.notes.some((n) => n.body === o.body)) continue;
    const n = app.vault.create(folderMap.get(o.folderId) ?? ROOT, o.body);
    if (o.createdAt) n.createdAt = o.createdAt;
    if (o.deletedAt) n.deletedAt = o.deletedAt;
    if (o.pinned && !o.deletedAt) n.starred = true; // v0.1 called stars "pinned"
    count++;
  }
  return count;
}

// ---------------------------------------------------------------- settings
