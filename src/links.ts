/** [[wiki links]] and #tags, compatible with Obsidian's syntax. */

export const LINK_RE = /\[\[([^[\]\n]+?)\]\]/g;

/**
 * A #tag starts a word and is made of letters, digits, _ - and / (for nested
 * tags like #work/meetings). "# heading", "#123" and "page#anchor" aren't tags.
 */
const TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

/** The line around a text position, and where it starts. */
function lineAt(text: string, index: number): { line: string; start: number } {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endNl = text.indexOf("\n", index);
  return { line: text.slice(start, endNl === -1 ? undefined : endNl), start };
}

/** The link target at a text position, without "|alias" or "#heading". */
export function linkAt(text: string, index: number): string | null {
  // Only look at the current line, it's where links live.
  const { line, start } = lineAt(text, index);
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

/** Every link target in a text, without "|alias" or "#heading". */
export function linkTargets(text: string): string[] {
  if (!text.includes("[[")) return [];
  return [...text.matchAll(LINK_RE)].map((m) => cleanTarget(m[1])).filter(Boolean);
}

/**
 * Point links somewhere else: `to` gets each link's target and returns the new
 * one, or null to leave that link alone. "|alias" and "#heading" are kept.
 */
export function retargetLinks(text: string, to: (target: string) => string | null): string {
  if (!text.includes("[[")) return text;
  return text.replace(LINK_RE, (whole, inner: string) => {
    const cut = inner.search(/[|#]/);
    const target = (cut === -1 ? inner : inner.slice(0, cut)).trim();
    const next = target && to(target);
    return next ? `[[${next}${cut === -1 ? "" : inner.slice(cut)}]]` : whole;
  });
}

/** Each #tag as [start, end, tag], skipping ones made only of digits. */
function tagMatches(text: string): [number, number, string][] {
  if (!text.includes("#")) return [];
  const out: [number, number, string][] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[2].replace(/[/-]+$/, ""); // "#idea-" or "#a/" at a word's end: not part of the tag
    if (!/[^\d/_-]/.test(tag)) continue;
    const start = m.index! + m[1].length;
    out.push([start, start + 1 + tag.length, tag]);
  }
  return out;
}

/** Ranges of every #tag, for underlining. */
export function tagRanges(text: string): [number, number][] {
  return tagMatches(text).map(([a, b]) => [a, b]);
}

/** The #tag at a text position (without the #), lower-cased. */
export function tagAt(text: string, index: number): string | null {
  const { line, start } = lineAt(text, index);
  for (const [a, b, tag] of tagMatches(line)) {
    if (index >= start + a && index <= start + b) return tag.toLowerCase();
  }
  return null;
}

/** A note's tags (without the #), lower-cased, each once. */
export function tagsOf(text: string): string[] {
  return [...new Set(tagMatches(text).map(([, , tag]) => tag.toLowerCase()))];
}
