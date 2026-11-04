import { type Note, ROOT, formatDate, noteTitle, wordCount } from "./model";
import { type Menu } from "./palette";
import { app, current, els, folderName, isRealFolder, toast, view } from "./app";
import { renderAll, renderStats } from "./list";
import { paintLinks } from "./typing";
import { openPalette } from "./commands";

/** "today 3:42 pm", "yesterday 9:05 am", "nov 2 11:30 pm" */
function versionLabel(at: number): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = formatDate(at);
  return /\d:\d/.test(day) ? `today ${time}` : `${day} ${time}`;
}

/** Browse a note's versions in the command line: arrowing previews, enter restores. */
export async function showHistory(n: Note): Promise<void> {
  let list: number[];
  try {
    list = await app.vault.versions(n);
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
    app.editor.load(n.body, { caretAt: "start" });
    paintLinks();
    renderStats();
  };
  const preview = (at: number) => {
    const t = ++token;
    app.vault
      .readVersion(n, at)
      .then((body) => {
        if (t !== token || app.currentId !== n.id) return;
        previewing = true;
        app.editor.load(body, { readOnly: true, caretAt: "start" });
        paintLinks();
        els.meta.textContent = `version from ${versionLabel(at)} · ${wordCount(body)} words · enter to restore it`;
      })
      .catch((e) => toast(`couldn't read that version: ${e}`));
  };
  const restore = async (at: number) => {
    token++;
    try {
      const body = await app.vault.readVersion(n, at);
      if (app.currentId !== n.id) return; // switched notes while it loaded
      app.vault.restoreVersion(n, body);
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
      {
        label: "clear this note's version history",
        preview: showCurrent,
        sub: () => historyRangeMenu(noteScope(n)),
      },
    ],
  });
}

// ---------------------------------------------------------------- clearing version history

interface HistoryScope {
  /** "this note", "folder work", "all notes" */
  label: string;
  /** null = every note */
  notes: Note[] | null;
}

const HOUR = 60 * 60 * 1000;
const HISTORY_RANGES: [string, number | null][] = [
  ["the last hour", HOUR],
  ["the last 24 hours", 24 * HOUR],
  ["the last 7 days", 7 * 24 * HOUR],
  ["the last 4 weeks", 28 * 24 * HOUR],
  ["all time", null],
];

export const noteScope = (n: Note): HistoryScope => ({ label: `"${noteTitle(n)}"`, notes: [n] });

/** A folder and its subfolders, including notes from there that are now in the trash. */
export function folderScope(id: string): HistoryScope {
  const inside = (f: string) => (id === ROOT ? f === ROOT : f === id || f.startsWith(id + "/"));
  return { label: `the "${folderName(id)}" folder`, notes: app.vault.notes.filter((n) => inside(n.folderId)) };
}

const allScope: HistoryScope = { label: "all notes", notes: null };

/** Step 1 (from the command line): what to clear. */
export function clearHistoryMenu(): Menu {
  const n = current();
  const folder = view().folderId;
  const scopes: HistoryScope[] = [
    ...(n?.path ? [noteScope(n)] : []),
    ...(isRealFolder(folder) ? [folderScope(folder)] : []),
    allScope,
  ];
  return {
    title: "clear version history for...",
    items: scopes.map((scope) => ({ label: scope.label, sub: () => historyRangeMenu(scope) })),
  };
}

/** Step 2: how far back. */
export function historyRangeMenu(scope: HistoryScope): Menu {
  return {
    title: `clear version history for ${scope.label} from...`,
    items: HISTORY_RANGES.map(([label, span]) => ({
      label,
      run: () => void confirmClearHistory(scope, span === null ? null : Date.now() - span, label),
    })),
  };
}

/** Step 3: say exactly what will go, then do it. */
async function confirmClearHistory(scope: HistoryScope, since: number | null, range: string): Promise<void> {
  let count: number;
  try {
    count = await app.vault.clearHistory(scope.notes, since, true);
  } catch (e) {
    toast(`couldn't read version history: ${e}`);
    return;
  }
  if (!count) {
    toast(`no versions of ${scope.label} from ${range}`);
    return;
  }
  const what = `${count} version${count === 1 ? "" : "s"}`;
  openPalette({
    title: `clear ${what} of ${scope.label} from ${range}? this can't be undone`,
    items: [
      { label: "no, keep them", run: () => undefined },
      {
        label: `yes, clear ${what}`,
        run: async () => {
          try {
            const removed = await app.vault.clearHistory(scope.notes, since, false);
            toast(`cleared ${removed} version${removed === 1 ? "" : "s"} of ${scope.label}`);
          } catch (e) {
            toast(`couldn't clear version history: ${e}`);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- folder actions
