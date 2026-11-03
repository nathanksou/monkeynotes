/**
 * A plain <textarea> with a custom, smoothly-animated caret.
 *
 * A textarea can't report where its caret is on screen, so the native caret is
 * hidden and a hidden "mirror" with identical text styles is used to measure it:
 * a marker is put at the caret's spot in the mirror and its position is read.
 * The mirror also says how tall the textarea should be, so it grows with its
 * content and the page scrolls instead.
 *
 * The mirror holds one block per paragraph and only changed paragraphs are
 * rebuilt (see paragraphs.ts), so measuring stays cheap in very long notes.
 */
import { ParagraphLayer, locate } from "./paragraphs";

export interface EditorCallbacks {
  onChange(value: string): void;
  onType(insertedChars: number): void;
  /** Called after the caret has moved for a typed character (for animations). */
  onTyped?(x: number, y: number, h: number, ch: string): void;
}

export class Editor {
  readonly ta: HTMLTextAreaElement;
  private mirror: ParagraphLayer;
  /** The text the mirror currently shows, split into paragraphs. */
  private paras: string[] = [];
  private mirrored: string | null = null;
  /** The paragraph that currently holds the caret marker. */
  private marked = -1;
  private caret: HTMLDivElement;
  private wrap: HTMLElement;
  private scroller: HTMLElement;
  private raf = 0;
  private typingTimer = 0;
  private follow = false;
  private pendingFx: string | null = null;

  constructor(
    wrap: HTMLElement,
    scroller: HTMLElement,
    private cb: EditorCallbacks,
  ) {
    this.wrap = wrap;
    this.scroller = scroller;
    this.ta = wrap.querySelector("textarea")!;
    this.mirror = new ParagraphLayer(wrap.querySelector(".mirror")!);
    this.caret = wrap.querySelector(".caret")!;

    const ta = this.ta;
    ta.addEventListener("input", (e) => {
      const ie = e as InputEvent;
      if (ie.inputType?.startsWith("insert")) {
        this.cb.onType(ie.data?.length ?? 1);
        this.pendingFx = ie.inputType === "insertLineBreak" ? "\n" : (ie.data?.slice(-1) ?? "");
      }
      this.markTyping();
      this.follow = true;
      this.cb.onChange(ta.value);
      this.schedule();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        // execCommand keeps the native undo stack intact.
        document.execCommand("insertText", false, "\t");
      }
      if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key.startsWith("Page")) {
        this.follow = true;
        this.markTyping();
      }
      this.schedule();
    });
    for (const ev of ["keyup", "mouseup", "select", "focus", "click"]) {
      ta.addEventListener(ev, () => this.schedule());
    }
    ta.addEventListener("mousemove", (e) => {
      if (e.buttons) this.schedule();
    });
    ta.addEventListener("focus", () => this.caret.classList.remove("hidden"));
    ta.addEventListener("blur", () => this.caret.classList.add("hidden"));
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === ta) this.schedule();
    });
    new ResizeObserver(() => this.schedule()).observe(wrap);
    document.fonts?.ready.then(() => this.schedule());
  }

  get caretEl(): HTMLElement {
    return this.caret;
  }

  get value(): string {
    return this.ta.value;
  }

  /** The note's paragraphs as of the last measurement (shared with other layers). */
  get paragraphs(): string[] {
    return this.paras;
  }

  /** Replace the content (e.g. switching notes). Resets undo history. */
  load(value: string, opts: { readOnly?: boolean; caretAt?: "start" | "end" } = {}): void {
    this.ta.value = value;
    this.ta.readOnly = !!opts.readOnly;
    const pos = opts.caretAt === "start" ? 0 : value.length;
    this.ta.setSelectionRange(pos, pos);
    this.caret.classList.add("no-anim");
    this.update();
    this.scroller.scrollTop = opts.caretAt === "start" ? 0 : this.scroller.scrollHeight;
    requestAnimationFrame(() => this.caret.classList.remove("no-anim"));
  }

  focus(): void {
    this.ta.focus({ preventScroll: true });
    this.schedule();
  }

  /** Select a range and scroll it into view. */
  select(start: number, end: number): void {
    this.ta.setSelectionRange(start, end);
    this.follow = true;
    this.schedule();
  }

  setSmooth(on: boolean): void {
    this.caret.classList.toggle("smooth", on);
  }

  /** Re-measure after a style change (font, size, width). */
  refresh(): void {
    this.caret.classList.add("no-anim");
    this.update();
    requestAnimationFrame(() => this.caret.classList.remove("no-anim"));
  }

  private markTyping(): void {
    this.caret.classList.add("typing");
    clearTimeout(this.typingTimer);
    this.typingTimer = window.setTimeout(() => this.caret.classList.remove("typing"), 600);
  }

  private schedule(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.update());
  }

  private update(): void {
    const { ta, mirror, caret } = this;
    const value = ta.value;
    const pos = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;

    // Bring the mirror up to date; only changed paragraphs are rebuilt.
    if (value !== this.mirrored) {
      this.paras = value.split("\n");
      this.mirrored = value;
    }
    const { index, offset } = locate(this.paras, pos);
    // The paragraph that held the marker last time goes back to plain text: a
    // stray zero-width marker could change where its lines wrap. Always, since
    // the paragraphs around it may have shifted even if the caret's index didn't.
    if (this.marked !== -1) mirror.invalidate(this.marked);
    mirror.update(this.paras);

    // Put the marker at the caret, inside its paragraph only.
    const text = this.paras[index] ?? "";
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.block(index)?.replaceChildren(
      document.createTextNode(text.slice(0, offset)),
      marker,
      document.createTextNode(text.slice(offset)),
    );
    this.marked = index;

    ta.style.height = `${mirror.el.offsetHeight}px`;
    const x = marker.offsetLeft;
    const y = marker.offsetTop;
    const h = marker.offsetHeight;
    caret.style.transform = `translate(${x}px, ${y}px)`;
    caret.style.height = `${h}px`;
    caret.classList.toggle("selecting", ta.selectionStart !== ta.selectionEnd);

    if (this.follow) {
      this.follow = false;
      this.keepVisible(y, h);
    }
    if (this.pendingFx !== null) {
      this.cb.onTyped?.(x, y, h, this.pendingFx);
      this.pendingFx = null;
    }
  }

  /** Keep the caret inside the comfortable middle band of the viewport. */
  private keepVisible(y: number, h: number): void {
    const s = this.scroller;
    const top = this.wrap.offsetTop + y; // wrap is positioned within the scroller's content
    const viewTop = s.scrollTop;
    const viewH = s.clientHeight;
    const lowLimit = viewTop + viewH * 0.65;
    const highLimit = viewTop + viewH * 0.15;
    if (top + h > lowLimit) s.scrollTop = top + h - viewH * 0.65;
    else if (top < highLimit) s.scrollTop = Math.max(0, top - viewH * 0.15);
  }
}
