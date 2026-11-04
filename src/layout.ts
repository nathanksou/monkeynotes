import { type Note, type Settings, defaultSettings, formatDate, noteExcerpt, noteTitle } from "./model";
import { app, current, els, galleryShown, isGrid, notesInView, saveState, settings, viewTitle } from "./app";
import { applySettings, emptyText, renderFolders, renderNotes } from "./list";
import { openNote } from "./notes";

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  app.state.settings[key] = value;
  applySettings();
  saveState();
}

const PANE_LIMITS = { folders: [140, 420], notes: [180, 560] } as const;
const clampWidth = (pane: "folders" | "notes", w: number) =>
  Math.round(Math.min(PANE_LIMITS[pane][1], Math.max(PANE_LIMITS[pane][0], w)));

/** Drag a sidebar's right edge to resize it; double-click the edge to reset. */
export function bindResizeHandles(): void {
  for (const handle of document.querySelectorAll<HTMLElement>(".resize-handle")) {
    const pane = handle.dataset.pane as "folders" | "notes";
    const key = pane === "folders" ? "foldersWidth" : "notesWidth";
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = settings()[key];
      els.app.classList.add("resizing");
      handle.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        settings()[key] = clampWidth(pane, startW + ev.clientX - startX);
        els.app.style.setProperty(pane === "folders" ? "--folders-size" : "--notes-size", `${settings()[key]}px`);
      };
      const listening = new AbortController();
      const up = () => {
        listening.abort(); // removes move, up and cancel together
        els.app.classList.remove("resizing");
        handle.classList.remove("dragging");
        app.editor.refresh();
        saveState();
      };
      const { signal } = listening;
      handle.addEventListener("pointermove", move, { signal });
      handle.addEventListener("pointerup", up, { signal });
      handle.addEventListener("pointercancel", up, { signal });
    });
    handle.addEventListener("dblclick", () => setSetting(key, defaultSettings[key]));
  }
}

// ---------------------------------------------------------------- views (list / gallery) and the sidebar

const ICONS = {
  all: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  star: '<path d="m8 2.2 1.75 3.6 3.95.55-2.87 2.77.69 3.93L8 11.2l-3.52 1.85.69-3.93L2.3 6.35l3.95-.55z"/>',
};

export function starIcon(): SVGSVGElement {
  const svg = icon("star");
  svg.setAttribute("class", "star-icon");
  return svg;
}

export function icon(kind: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "folder-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[kind]; // fixed markup, never user text
  return svg;
}

export const narrow = matchMedia("(max-width: 760px)");

/** Show / hide the folders sidebar. In a narrow window it slides over as a drawer. */
export function toggleFolders(): void {
  if (narrow.matches) {
    els.app.classList.toggle("drawer-open");
    applyView();
    return;
  }
  // Slide the sidebar open or shut. Only this toggle animates the columns; the
  // class is dropped afterwards so other layout changes (list/gallery) stay instant.
  els.app.classList.add("sidebar-anim");
  clearTimeout(sidebarAnimTimer);
  sidebarAnimTimer = window.setTimeout(() => {
    els.app.classList.remove("sidebar-anim");
    app.editor.refresh();
  }, 280);
  setSetting("hideFolders", !settings().hideFolders);
}

let sidebarAnimTimer = 0;

/** Classes for the current view; the CSS does the layout. */
export function applyView(): void {
  els.app.classList.toggle("grid", isGrid());
  els.app.classList.toggle("grid-note", isGrid() && app.galleryNoteOpen);
  for (const b of document.querySelectorAll<HTMLElement>(".js-view")) {
    b.classList.toggle("on", b.dataset.view === settings().viewMode);
  }
  // Whatever is hidden can't be clicked, tabbed to or typed into.
  const foldersHidden = narrow.matches ? !els.app.classList.contains("drawer-open") : settings().hideFolders;
  els.folders.inert = foldersHidden;
  const toggle = document.getElementById("sidebar-toggle");
  if (toggle) {
    toggle.classList.toggle("closed", foldersHidden);
    toggle.setAttribute("aria-expanded", String(!foldersHidden));
    const label = foldersHidden ? "show folders" : "hide folders";
    toggle.setAttribute("aria-label", label);
    toggle.title = `${label} (ctrl+\\)`;
  }
  els.notesPane.inert = isGrid();
  for (const el of [els.scroller, els.footer]) el.inert = galleryShown();
}

let switchingTimer = 0;

export function setView(mode: "list" | "grid"): void {
  app.galleryNoteOpen = false;
  if (settings().viewMode !== mode) {
    // restart the fade on the list box / card grid
    els.app.classList.remove("switching");
    void els.app.offsetWidth;
    els.app.classList.add("switching");
    clearTimeout(switchingTimer);
    switchingTimer = window.setTimeout(() => els.app.classList.remove("switching"), 250);
  }
  if (settings().viewMode !== mode) setSetting("viewMode", mode);
  else applyView();
  renderNotes();
  if (mode === "list") {
    app.editor.refresh();
    focusEditor();
  } else {
    focusGallery();
  }
}

export function backToGallery(): void {
  if (!isGrid()) return;
  if (app.vault.discardIfBlank(current())) {
    app.currentId = null;
    renderFolders();
  }
  app.galleryNoteOpen = false;
  applyView();
  renderNotes();
  focusGallery();
}

export function focusSearch(): void {
  els.search.focus();
  els.search.select();
}

export function focusGallery(): void {
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
  if (n.id === app.currentId) card.classList.add("active");
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.textContent = noteExcerpt(n) || " ";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = noteTitle(n);
  if (n.starred) title.prepend(starIcon());
  const date = document.createElement("div");
  date.className = "card-date";
  date.textContent = formatDate(n.updatedAt);
  card.append(thumb, title, date);
  return card;
}

export function renderGallery(notes: Note[] = notesInView()): void {
  els.galleryTitle.textContent = viewTitle();
  if (!notes.length) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = emptyText();
    els.galleryGrid.replaceChildren(empty);
    return;
  }
  els.galleryGrid.replaceChildren(...notes.map(noteCard));
}

/** Arrow keys move between cards (up/down to the nearest card in the next row); enter opens one. */
export function galleryKey(e: KeyboardEvent): void {
  const cards = [...els.galleryGrid.querySelectorAll<HTMLElement>(".card")];
  if (!cards.length) return;
  const at = Math.max(0, cards.indexOf(document.activeElement as HTMLElement));
  const here = cards[at];
  let next: HTMLElement | undefined;
  if (e.key === "ArrowLeft") next = cards[at - 1];
  else if (e.key === "ArrowRight") next = cards[at + 1];
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    // rows aren't all full (the starred section has its own), so go by position
    const down = e.key === "ArrowDown";
    const rowTops = [...new Set(cards.map((c) => c.offsetTop))].sort((a, b) => a - b);
    const row = rowTops.indexOf(here.offsetTop) + (down ? 1 : -1);
    if (row >= 0 && row < rowTops.length) {
      const inRow = cards.filter((c) => c.offsetTop === rowTops[row]);
      next = inRow.reduce((best, c) =>
        Math.abs(c.offsetLeft - here.offsetLeft) < Math.abs(best.offsetLeft - here.offsetLeft) ? c : best,
      );
    }
  } else if (e.key === "Enter" && document.activeElement?.classList.contains("card")) {
    e.preventDefault();
    openNote(here.dataset.id!);
    return;
  } else return;
  e.preventDefault();
  next?.focus();
}

function focusEditor(): void {
  if (current() && !galleryShown()) app.editor.focus();
}

/** Put focus back where the user was: the cards in the gallery, else the editor. */
export function restoreFocus(): void {
  if (galleryShown()) focusGallery();
  else focusEditor();
}

// ---------------------------------------------------------------- typing stats
