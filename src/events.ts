import { overlayScrollbar } from "./scrollbar";
import { showHistory } from "./history";
import { ROOT, noteTitle } from "./model";
import { type KeyType, playKey } from "./sound";
import { $, app, current, els, folderName, galleryShown, isGrid, isRealFolder, notesInView, settings, toast, toastAction, writeState } from "./app";
import { renderAll, renderNotes } from "./list";
import { confirmEmptyTrash, moveNote, toggleStar, newFolder, newNote, openFolder, openNote, renameFolder, stepNote, toggleCollapsed } from "./notes";
import { applyView, backToGallery, bindResizeHandles, focusGallery, focusSearch, galleryKey, narrow, restoreFocus, setSetting, setView, toggleFolders } from "./layout";
import { followLinkAtCaret, hideStats, showStats } from "./typing";
import { folderCommands, jumpMenu, noteCommands, openPalette } from "./commands";

let searchTimer = 0;

export function bindEvents(): void {
  // Widening the window with the drawer open must not leave the sidebar half-inert.
  narrow.addEventListener("change", () => {
    els.app.classList.remove("drawer-open");
    applyView();
  });
  const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

  document.addEventListener("keydown", (e) => {
    if (app.palette.isOpen || e.isComposing) return;
    // Letters and digits by what they print, but fall back to the physical key on
    // layouts (Russian, Greek...) where ctrl+K doesn't report a Latin "k".
    const k = /^[a-z0-9]$/i.test(e.key)
      ? e.key.toLowerCase()
      : /^Key[A-Z]$/.test(e.code)
        ? e.code.slice(3).toLowerCase()
        : /^Digit\d$/.test(e.code)
          ? e.code.slice(5)
          : e.key.toLowerCase();
    if (!els.statsView.hidden) {
      if (e.key === "Escape") {
        e.preventDefault();
        hideStats();
      }
      return;
    }
    if (mod(e) && e.key === "Enter") {
      if (document.activeElement === app.editor.ta && followLinkAtCaret()) e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (app.find.isOpen && document.activeElement !== els.search) {
        app.find.close();
        restoreFocus();
      } else if (els.app.classList.contains("drawer-open")) {
        els.app.classList.remove("drawer-open");
        applyView();
      } else if (document.activeElement === els.search) {
        // first esc clears the search, the next one leaves the box
        if (els.search.value) {
          els.search.value = "";
          renderNotes();
        } else {
          els.search.blur();
          restoreFocus();
        }
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
      focusSearch();
    } else if (galleryShown() && !(document.activeElement instanceof HTMLInputElement) && !mod(e)) {
      galleryKey(e);
    } else if (mod(e) && k === "f") {
      e.preventDefault();
      // in the gallery there's no note open to search in: search all notes instead
      if (galleryShown()) focusSearch();
      else if (current()) app.find.open();
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

  // rows work from the keyboard too: enter or space opens them
  for (const list of [els.folderList, els.noteList]) {
    list.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).matches("li[data-id]")) {
        e.preventDefault();
        (e.target as HTMLElement).click();
      }
    });
  }

  els.folderList.addEventListener("click", (e) => {
    const toggle = (e.target as HTMLElement).closest<HTMLElement>("[data-toggle]");
    if (toggle) return toggleCollapsed(toggle.dataset.toggle!);
    const id = rowId(e);
    if (id !== undefined) openFolder(id);
    if (els.app.classList.contains("drawer-open")) {
      els.app.classList.remove("drawer-open");
      applyView();
    }
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
    const n = app.vault.get(rowId(e) ?? null);
    if (!n) return;
    e.preventDefault();
    if (n.id !== app.currentId) openNote(n.id, { focus: false });
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
    const n = app.vault.get(e.dataTransfer?.getData("text/x-monkeynote") ?? null);
    if (n && folderId !== undefined && isRealFolder(folderId)) moveNote(n, folderId);
  });

  bindResizeHandles();
  for (const el of [els.scroller, els.noteList, els.galleryGrid, document.querySelector<HTMLElement>(".palette-list")]) {
    if (el) overlayScrollbar(el);
  }
  for (const b of document.querySelectorAll<HTMLElement>(".js-new-note")) b.addEventListener("click", newNote);
  for (const b of document.querySelectorAll<HTMLElement>(".js-view")) {
    b.addEventListener("click", () => setView(b.dataset.view as "list" | "grid"));
  }
  $("#sidebar-toggle").addEventListener("click", toggleFolders);
  for (const b of document.querySelectorAll<HTMLElement>(".js-empty-trash")) b.addEventListener("click", confirmEmptyTrash);
  $("#back-to-gallery").addEventListener("click", backToGallery);

  // gallery: open a card, right-click for actions, drag onto a folder, search
  els.galleryGrid.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.id;
    if (id) openNote(id);
  });
  els.galleryGrid.addEventListener("contextmenu", (e) => {
    const n = app.vault.get((e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.id ?? null);
    if (!n) return;
    e.preventDefault();
    if (n.id !== app.currentId) openNote(n.id, { focus: false });
    openPalette({ title: noteTitle(n), items: noteCommands(n) });
  });
  els.galleryGrid.addEventListener("dragstart", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".card")?.dataset.id;
    if (!id || !e.dataTransfer) return;
    e.dataTransfer.setData("text/x-monkeynote", id);
    e.dataTransfer.effectAllowed = "move";
  });
  $("#new-folder").addEventListener("click", () => void newFolder());
  $("#open-palette").addEventListener("click", () => openPalette());
  $("#star-note").addEventListener("click", () => {
    const n = current();
    if (n && !n.deletedAt) toggleStar(n);
  });
  $("#open-history").addEventListener("click", () => {
    const n = current();
    if (!n || n.deletedAt || galleryShown()) return toast("open a note to see its version history");
    void showHistory(n);
  });

  els.search.addEventListener("input", () => {
    // results show in the list, or as cards in gallery view
    if (isGrid() && app.galleryNoteOpen) {
      app.galleryNoteOpen = false;
      applyView();
    }
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderNotes, 90);
  });
  els.search.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      if (galleryShown()) return focusGallery();
      const first = notesInView()[0];
      if (first) openNote(first.id);
    }
  });

  // Clicking empty space on the page puts the caret at the end.
  els.page.addEventListener("mousedown", (e) => {
    if (e.target === app.editor.ta || !current() || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const end = app.editor.ta.value.length;
    app.editor.ta.setSelectionRange(end, end);
    app.editor.focus();
  });

  // key sounds
  app.editor.ta.addEventListener("keydown", (e) => {
    const s = settings();
    if (s.sound === "off" || e.ctrlKey || e.metaKey || app.editor.ta.readOnly) return;
    let key: KeyType | null = null;
    if (e.key === " ") key = "space";
    else if (e.key === "Enter") key = "enter";
    else if (e.key === "Backspace" || e.key === "Delete") key = "back";
    else if (e.key.length === 1 || e.key === "Tab") key = "char";
    if (key) playKey(s.sound, s.soundVolume, key);
  });

  // ctrl/cmd+click a [[link]] to follow it
  app.editor.ta.addEventListener("click", (e) => {
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
      const openBefore = app.currentId;
      const changed = await app.vault.reload(openBefore);
      const n = current();
      if (!n) openNote(notesInView()[0]?.id ?? null, { focus: false });
      // changed in another app: keep the caret and scroll where they were
      else if (changed && app.currentId === openBefore) {
        const top = els.scroller.scrollTop;
        app.editor.load(n.body, { caretAt: app.editor.ta.selectionStart });
        els.scroller.scrollTop = top;
        app.find.refresh();
      }
      renderAll();
    } catch (e) {
      toast(`couldn't read notes folder: ${e}`);
    } finally {
      reloading = false;
    }
  });

  const flushNow = () => {
    void app.vault.flush();
    void writeState();
  };
  window.addEventListener("beforeunload", flushNow);
  document.addEventListener("visibilitychange", flushNow);
}
