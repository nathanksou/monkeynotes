import { linkAt, linkRanges, tagAt, tagRanges } from "./links";
import { ALL } from "./model";
import { renderStatsView } from "./stats-view";
import { app, current, els, saveState, settings, targetFolder, toast, view } from "./app";
import { renderFolders } from "./list";
import { openNote } from "./notes";
import { restoreFocus, searchFor } from "./layout";

export function resetLiveStats(): void {
  els.app.classList.remove("typing");
}

let statsSaveTimer = 0;
export function onType(chars: number): void {
  app.stats.type(chars);
  if (settings().focusMode) els.app.classList.add("typing");
  // Stats change on every keystroke; save them every 10s (and on close), not each pause.
  if (!statsSaveTimer) {
    statsSaveTimer = window.setTimeout(() => {
      statsSaveTimer = 0;
      saveState();
    }, 10_000);
  }
}

let lastStatsKey = "";

/** The always-visible stats bar under the editor (it stays put in focus mode). */
export function renderStatsBar(): void {
  if (!settings().liveStats) return;
  const live = app.stats.live();
  const parts: [string, string, string?][] = [
    [String(live ?? app.stats.lastWpm), "wpm", live === null ? "idle" : "live"],
    [String(app.stats.average()), "avg wpm"],
  ];
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

export function showStats(): void {
  els.statsView.replaceChildren(renderStatsView(app.stats));
  els.statsView.hidden = false;
  els.statsView.focus(); // so typing can't reach the note behind it
}

export function hideStats(): void {
  els.statsView.hidden = true;
  restoreFocus();
}

// ---------------------------------------------------------------- links

/** Open the note a [[link]] points at, creating it if it doesn't exist (like Obsidian). */
function followLink(target: string): void {
  let n = app.vault.resolveLink(target);
  if (!n) {
    const from = current();
    const folder = from && !from.deletedAt ? from.folderId : targetFolder();
    const body = settings().titleSource === "file name" ? "" : `${target}\n`;
    n = app.vault.create(folder, body, target.split("/").pop());
    toast(`created "${target}"`);
  }
  if (view().folderId !== ALL && view().folderId !== n.folderId) {
    view().folderId = ALL;
    els.search.value = "";
  }
  renderFolders();
  openNote(n.id);
}

/** Follow the [[link]] under the caret, or search all notes for the #tag under it. */
export function followLinkAtCaret(): boolean {
  const { value, selectionStart } = app.editor.ta;
  const target = linkAt(value, selectionStart);
  if (target) {
    followLink(target);
    return true;
  }
  const tag = tagAt(value, selectionStart);
  if (tag) searchFor(`#${tag}`);
  return !!tag;
}

/** Underline [[links]] and #tags on a layer behind the text. */
let decorTimer = 0;

/** One paragraph with its [[links]] and #tags wrapped for underlining. */
function renderDecor(text: string): Node[] {
  const ranges = [
    ...linkRanges(text).map(([a, b]) => [a, b, "link"] as const),
    ...tagRanges(text).map(([a, b]) => [a, b, "tag"] as const),
  ].sort((x, y) => x[0] - y[0]);
  if (!ranges.length) return [document.createTextNode(text || "\u200b")];
  const parts: Node[] = [];
  let last = 0;
  for (const [a, b, kind] of ranges) {
    if (a < last) continue; // a #tag inside a [[link]]: the link wins
    parts.push(document.createTextNode(text.slice(last, a)));
    const u = document.createElement("span");
    u.className = kind;
    u.textContent = text.slice(a, b);
    parts.push(u);
    last = b;
  }
  parts.push(document.createTextNode(text.slice(last)));
  return parts;
}

export function paintLinks(): void {
  clearTimeout(decorTimer);
  decorTimer = window.setTimeout(() => {
    const text = app.editor.ta.value;
    if (!text.includes("[[") && !text.includes("#")) return app.linkLayer.clear();
    app.linkLayer.update(text.split("\n"), (t) => t, renderDecor);
  }, 60);
}

// ---------------------------------------------------------------- updates
