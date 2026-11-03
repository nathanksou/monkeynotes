/**
 * Find in the current note (ctrl+f). Matches are painted on a layer behind the
 * transparent textarea, using the same text styles so they line up exactly.
 */
import type { Editor } from "./editor";

const MAX_MATCHES = 5000;

export class Find {
  private input: HTMLInputElement;
  private count: HTMLElement;
  private matches: number[] = [];
  private lengths: number[] = [];
  private index = -1;

  constructor(
    private root: HTMLElement,
    private editor: Editor,
    private layer: HTMLElement,
    private scroller: HTMLElement,
  ) {
    this.input = root.querySelector("input")!;
    this.count = root.querySelector(".find-count")!;
    this.input.addEventListener("input", () => this.search(true));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    root.querySelector(".find-prev")?.addEventListener("click", () => this.step(-1));
    root.querySelector(".find-next")?.addEventListener("click", () => this.step(1));
    root.querySelector(".find-close")?.addEventListener("click", () => this.close());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    const ta = this.editor.ta;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes("\n")) this.input.value = sel;
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
    this.search(true);
  }

  /** Close and leave the current match selected in the editor. */
  close(focusEditor = true): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    const start = this.matches[this.index];
    const len = this.lengths[this.index];
    this.layer.replaceChildren();
    if (!focusEditor) return;
    if (start !== undefined) this.editor.select(start, start + len);
    this.editor.focus();
  }

  /** Re-run the search after the note's text changed. */
  refresh(): void {
    if (this.isOpen) this.search(false);
  }

  private search(jump: boolean): void {
    const query = this.input.value;
    const text = this.editor.ta.value;
    this.matches = [];
    this.lengths = [];
    if (query) {
      // Match on the original text (not a lower-cased copy, whose length can
      // differ for characters like "İ") so indices line up with the editor.
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const m of text.matchAll(re)) {
        this.matches.push(m.index!);
        this.lengths.push(m[0].length);
        if (this.matches.length >= MAX_MATCHES) break;
      }
    }
    if (jump || this.index >= this.matches.length) {
      // first match at or after the caret
      const caret = this.editor.ta.selectionStart;
      const next = this.matches.findIndex((m) => m >= caret);
      this.index = this.matches.length ? (next === -1 ? 0 : next) : -1;
    }
    this.paint(text);
    if (jump) this.reveal();
  }

  private step(dir: 1 | -1): void {
    if (!this.matches.length) return;
    this.index = (this.index + dir + this.matches.length) % this.matches.length;
    this.paint(this.editor.ta.value);
    this.reveal();
  }

  private paint(text: string): void {
    this.count.textContent = this.input.value ? `${this.matches.length ? this.index + 1 : 0}/${this.matches.length}` : "";
    this.root.classList.toggle("none", !!this.input.value && !this.matches.length);
    const parts: Node[] = [];
    let last = 0;
    this.matches.forEach((m, i) => {
      const end = m + this.lengths[i];
      parts.push(document.createTextNode(text.slice(last, m)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(m, end);
      if (i === this.index) mark.className = "current";
      parts.push(mark);
      last = end;
    });
    parts.push(document.createTextNode(text.slice(last) + "​"));
    this.layer.replaceChildren(...parts);
  }

  private reveal(): void {
    const mark = this.layer.querySelector<HTMLElement>("mark.current");
    if (!mark) return;
    const s = this.scroller;
    const top = mark.offsetTop + (this.layer.offsetParent as HTMLElement).offsetTop;
    if (top < s.scrollTop + 40 || top > s.scrollTop + s.clientHeight - 80) {
      s.scrollTop = top - s.clientHeight / 3;
    }
  }
}
