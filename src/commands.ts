import { linkAt } from "./links";
import { ALL, type FontFamily, type LineWidth, type Note, ROOT, type SoundKind, TRASH, type TitleSource, type TypingAnimation, noteTitle, sortNotes } from "./model";
import { type Command, type Menu } from "./palette";
import { playKey } from "./sound";
import { applyTheme, findTheme, themes } from "./themes";
import { VERSION, checkForUpdate } from "./updates";
import { app, current, els, folderPath, isGrid, saveState, settings, toast, view } from "./app";
import { renderFolders } from "./list";
import { changeNotesDir, confirmEmptyTrash, deleteFolder, destroyNote, exportAll, exportNote, importDir, importFiles, moveNote, newFolder, newNote, openFolder, openNote, renameFolder, renameNote, restoreNote, setTitleMode, toggleStar, trashNote } from "./notes";
import { clearHistoryMenu, folderScope, historyRangeMenu, noteScope, showHistory } from "./history";
import { backToGallery, restoreFocus, setSetting, setView, toggleFolders } from "./layout";
import { followLinkAtCaret, showStats } from "./typing";

async function openUrl(url: string): Promise<void> {
  if (app.backend.desktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export async function checkUpdates(manual: boolean): Promise<void> {
  try {
    const release = await checkForUpdate();
    app.state.lastUpdateCheck = Date.now();
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

export function choice<T>(title: string, options: { label: string; value: T }[], get: () => T, set: (v: T) => void): Menu {
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

export function noteCommands(n: Note): Command[] {
  if (n.deletedAt) {
    return [
      { label: "restore note", run: () => restoreNote(n) },
      { label: "delete note forever", run: () => destroyNote(n) },
    ];
  }
  return [
    { label: "find in note", hint: "ctrl+f", run: () => app.find.open() },
    ...(linkAt(n.body, app.editor.ta.selectionStart) ? [{ label: "follow link", hint: "ctrl+enter", run: () => void followLinkAtCaret() }] : []),
    { label: n.starred ? "unstar note" : "star note", hint: "keeps it at the top", run: () => toggleStar(n) },
    { label: "rename note", hint: "file name", run: () => void renameNote(n) },
    {
      label: "move note to",
      sub: () => ({
        title: "move to folder",
        items: app.vault.folders.map((f) => ({ label: folderPath(f.id), active: f.id === n.folderId, run: () => moveNote(n, f.id) })),
      }),
    },
    ...(n.path
      ? [
          { label: "version history", hint: "browse and restore", run: () => void showHistory(n) },
          { label: "clear this note's version history", sub: () => historyRangeMenu(noteScope(n)) },
        ]
      : []),
    { label: "export note", hint: ".md", run: () => void exportNote(n) },
    { label: "copy note to clipboard", run: () => navigator.clipboard.writeText(n.body).catch((e) => toast(`couldn't copy: ${e}`)) },
    { label: "delete note", hint: "moves it to the trash", run: () => trashNote(n) },
  ];
}

export function folderCommands(id: string): Command[] {
  if (id === TRASH) return [{ label: "empty trash", hint: "delete everything in it forever", run: confirmEmptyTrash }];
  const f = app.vault.folders.find((x) => x.id === id);
  if (!f || id === ROOT) return [];
  const count = app.vault.notes.filter((n) => (n.folderId === id || n.folderId.startsWith(id + "/")) && !n.deletedAt).length;
  return [
    {
      label: app.vault.starredFolders.has(id) ? `unstar folder "${f.name}"` : `star folder "${f.name}"`,
      hint: "shows it below all notes",
      run: () => {
        app.vault.toggleFolderStar(id);
        renderFolders();
      },
    },
    { label: `new folder inside "${f.name}"`, run: () => void newFolder(id) },
    { label: `clear version history of "${f.name}"`, hint: "and its subfolders", sub: () => historyRangeMenu(folderScope(id)) },
    { label: `rename folder "${f.name}"`, run: () => void renameFolder(id) },
    {
      label: `delete folder "${f.name}"`,
      sub: () => ({
        title: count ? `delete "${f.name}" and move its ${count} notes to the trash?` : `delete "${f.name}"?`,
        items: [
          { label: "no", run: () => undefined },
          { label: "yes, delete", run: () => deleteFolder(id) },
        ],
      }),
    },
  ];
}

export function jumpMenu(): Menu {
  return {
    title: "jump to note",
    items: app.vault.notes
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
  const desktop = app.backend.desktop;
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
          ...app.vault.folders,
          ...(app.vault.notes.some((x) => x.deletedAt) ? [{ id: TRASH, name: "trash" }] : []),
        ].map((f) => ({ label: folderPath(f.id), active: f.id === view().folderId, run: () => openFolder(f.id) })),
      }),
    },
    ...(n ? noteCommands(n) : []),
    ...folderCommands(view().folderId),
    { label: "clear version history", hint: "a note, a folder or everything", sub: clearHistoryMenu },
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
    ...(isGrid() && app.galleryNoteOpen ? [{ label: "back to gallery", run: backToGallery }] : []),
    ...(desktop
      ? [
          { label: "change notes folder", hint: app.notesDirPath, run: () => void changeNotesDir(true) },
          { label: "use default notes folder", run: () => void changeNotesDir(false) },
          { label: "copy notes folder path", run: () => navigator.clipboard.writeText(app.notesDirPath).catch((e) => toast(`couldn't copy: ${e}`)) },
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

export function openPalette(menu: Menu = rootMenu()): void {
  app.palette.open(menu, restoreFocus);
}

// ---------------------------------------------------------------- events
