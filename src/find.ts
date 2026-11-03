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
    this.layer.replaceChildren();
    if (!focusEditor) return;
    if (start !== undefined) this.editor.select(start, start + this.input.value.length);
    this.editor.focus();
  }

  /** Re-run the search after the note's text changed. */
  refresh(): void {
    if (this.isOpen) this.search(false);
  }

  private search(jump: boolean): void {
    const q = this.input.value.toLowerCase();
    const text = this.editor.ta.value;
    const hay = text.toLowerCase();
    this.matches = [];
    if (q) {
      for (let i = hay.indexOf(q); i !== -1 && this.matches.length < MAX_MATCHES; i = hay.indexOf(q, i + q.length)) {
        this.matches.push(i);
      }
    }
    if (jump || this.index >= this.matches.length) {
      // first match at or after the caret
      const caret = this.editor.ta.selectionStart;
      const next = this.matches.findIndex((m) => m >= caret);
      this.index = this.matches.length ? (next === -1 ? 0 : next) : -1;
    }
    this.paint(text, q.length);
    if (jump) this.reveal();
  }

  private step(dir: 1 | -1): void {
    if (!this.matches.length) return;
    this.index = (this.index + dir + this.matches.length) % this.matches.length;
    this.paint(this.editor.ta.value, this.input.value.length);
    this.reveal();
  }

  private paint(text: string, len: number): void {
    this.count.textContent = this.input.value ? `${this.matches.length ? this.index + 1 : 0}/${this.matches.length}` : "";
    this.root.classList.toggle("none", !!this.input.value && !this.matches.length);
    const parts: Node[] = [];
    let last = 0;
    this.matches.forEach((m, i) => {
      parts.push(document.createTextNode(text.slice(last, m)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(m, m + len);
      if (i === this.index) mark.className = "current";
      parts.push(mark);
      last = m + len;
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
