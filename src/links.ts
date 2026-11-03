/** [[wiki links]], compatible with Obsidian's syntax. */

export const LINK_RE = /\[\[([^[\]\n]+?)\]\]/g;

/** The link target at a text position, without "|alias" or "#heading". */
export function linkAt(text: string, index: number): string | null {
  // Only look at the current line, it's where links live.
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endNl = text.indexOf("\n", index);
  const line = text.slice(start, endNl === -1 ? undefined : endNl);
  for (const m of line.matchAll(LINK_RE)) {
    const from = start + m.index!;
    if (index >= from && index <= from + m[0].length) return cleanTarget(m[1]);
  }
  return null;
}

export function cleanTarget(raw: string): string {
  return raw.split("|")[0].split("#")[0].trim();
}

/** Ranges of every link, for underlining. */
export function linkRanges(text: string): [number, number][] {
  if (!text.includes("[[")) return [];
  return [...text.matchAll(LINK_RE)].map((m) => [m.index!, m.index! + m[0].length]);
}
