import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import "./styles.css";

import { NotDesktopError, createBackend } from "./backend";
import { Editor } from "./editor";
import { spawnEffect } from "./effects";
import { isNotFound } from "./errors";
import { Find } from "./find";
import { ParagraphLayer } from "./paragraphs";
import { ALL, ROOT, TRASH, WELCOME, normalizeState } from "./model";
import { Palette } from "./palette";
import { TypingStats } from "./stats";
import { $, app, current, els, isGrid, isRealFolder, notesInView, settings, toast, view, writeState } from "./app";
import { applySettings, renderFolders, renderSoon, renderStatsSoon } from "./list";
import { migrateLegacy, openNote, openVault } from "./notes";
import { onType, paintLinks, renderStatsBar } from "./typing";
import { checkUpdates } from "./commands";
import { bindEvents } from "./events";
import { showFolderError, showNotDesktop } from "./screens";

async function bindWindowClose(): Promise<void> {
  if (!app.backend.desktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  // Make sure the last keystrokes hit the disk before the window goes away.
  await getCurrentWindow().onCloseRequested(async () => {
    await Promise.all([app.vault.flush(), writeState()]);
  });
}

// ---------------------------------------------------------------- boot

async function main(): Promise<void> {
  try {
    app.backend = await createBackend();
  } catch (e) {
    if (e instanceof NotDesktopError) return showNotDesktop();
    throw e;
  }
  let rawState: string | null = null;
  try {
    rawState = await app.backend.loadState();
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
  app.state = normalizeState(parsed);
  app.stats = new TypingStats(app.state.stats);
  setInterval(() => {
    if (!document.hidden) renderStatsBar();
  }, 250);

  try {
    await openVault();
  } catch (e) {
    if (!isNotFound(e)) return showFolderError(e);
    // The chosen folder is missing (e.g. an unplugged drive). Use the default
    // folder for this session only, so the choice comes back with the drive.
    try {
      await app.backend.resetNotesDir(false);
      await openVault();
    } catch (err) {
      return showFolderError(err);
    }
    const missing = String(e).replace(/^NOT_FOUND:\s*/, "");
    setTimeout(() => toast(`notes folder not found: ${missing}. using ${app.notesDirPath} until next launch`, undefined, 10000), 500);
  }

  const legacy = await app.backend.loadLegacy().catch(() => null);
  if (legacy) {
    const before = app.vault.failures;
    const count = migrateLegacy(legacy, !rawState);
    await app.vault.flush();
    if (app.vault.failures === before) {
      await app.backend.retireLegacy();
      if (count) setTimeout(() => toast(`moved ${count} notes into ${app.notesDirPath}`), 500);
    } else {
      // Keep notes.json so the move is tried again next launch.
      setTimeout(() => toast("couldn't move your v0.1 notes yet; they're safe and will be retried next launch"), 500);
    }
  } else if (!rawState && !app.vault.notes.length) {
    app.vault.create(ROOT, WELCOME);
  }

  app.palette = new Palette($("#palette"));
  app.editor = new Editor($("#wrap"), els.scroller, {
    onChange: (value) => {
      const n = current();
      if (!n || n.deletedAt) return;
      app.vault.setBody(n, value);
      app.find.refresh();
      paintLinks();
      renderStatsSoon();
      renderSoon();
    },
    onType,
    onTyped: (x, y, h, ch) => spawnEffect(settings().typingAnimation, els.fx, app.editor.caretEl, x, y, h, ch),
  });
  app.find = new Find($("#find"), app.editor, $("#highlights"), els.scroller);
  app.linkLayer = new ParagraphLayer(els.decor);

  applySettings();
  bindEvents();
  void bindWindowClose();

  if (!isRealFolder(view().folderId) && view().folderId !== ALL && view().folderId !== TRASH) view().folderId = ALL;
  const last = app.vault.findByPath(view().notePath);
  const start = last && !last.deletedAt ? last : notesInView()[0];
  if (start && !notesInView().includes(start)) view().folderId = ALL;
  renderFolders();
  // gallery view starts on the cards, with the last note selected
  openNote(start?.id ?? null, { focus: !isGrid() });
  document.body.classList.add("ready");

  const DAY = 24 * 60 * 60 * 1000;
  if (app.backend.desktop && settings().checkUpdates && Date.now() - app.state.lastUpdateCheck > DAY) {
    setTimeout(() => void checkUpdates(false), 3000);
  }
}

void main().catch((e) => {
  document.body.classList.add("ready");
  document.body.textContent = `monkeynotes couldn't start: ${e}`;
});
