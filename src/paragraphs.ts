/**
 * Layers that mirror the editor's text (for measuring the caret, underlining
 * links, highlighting find matches) are split into one block per paragraph.
 * When the text changes, only the paragraphs that changed are rebuilt, so the
 * browser only re-lays out those: typing costs the same in a short note and a
 * very long one.
 */

/** Paragraph i is rendered from these nodes. Empty paragraphs still need height. */
export type Render = (text: string, index: number) => Node[];

const plain: Render = (text) => [document.createTextNode(text || "​")];

export class ParagraphLayer {
  private keys: string[] = [];

  constructor(readonly el: HTMLElement) {}

  /**
   * Show `paras`, one block each. `key` identifies what a block shows: blocks
   * whose key is unchanged are kept as they are.
   */
  update(paras: string[], key: (text: string, i: number) => string = (t) => t, render: Render = plain): void {
    const next = paras.map(key);
    const old = this.keys;
    // Skip the unchanged run at the start and at the end; rebuild the middle.
    let start = 0;
    while (start < next.length && start < old.length && next[start] === old[start]) start++;
    let endOld = old.length;
    let endNew = next.length;
    while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const blocks = this.el.children;
    for (let i = endOld - 1; i >= start; i--) blocks[i].remove();
    const frag = document.createDocumentFragment();
    for (let i = start; i < endNew; i++) {
      const block = document.createElement("div");
      block.append(...render(paras[i], i));
      frag.append(block);
    }
    this.el.insertBefore(frag, blocks[start] ?? null);
    this.keys = next;
  }

  block(i: number): HTMLElement | undefined {
    return this.el.children[i] as HTMLElement | undefined;
  }

  /** Mark block i as changed by hand, so the next update rebuilds it. */
  invalidate(i: number): void {
    if (i < this.keys.length) this.keys[i] = "\u0000dirty";
  }

  clear(): void {
    this.el.replaceChildren();
    this.keys = [];
  }
}

/** Which paragraph `pos` falls in, and the offset inside it. */
export function locate(paras: string[], pos: number): { index: number; offset: number } {
  let start = 0;
  for (let i = 0; i < paras.length; i++) {
    const end = start + paras[i].length;
    if (pos <= end) return { index: i, offset: pos - start };
    start = end + 1; // the newline
  }
  return { index: paras.length - 1, offset: paras[paras.length - 1]?.length ?? 0 };
}

/** Start offset of each paragraph in the full text. */
export function starts(paras: string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const p of paras) {
    out.push(at);
    at += p.length + 1;
  }
  return out;
}
