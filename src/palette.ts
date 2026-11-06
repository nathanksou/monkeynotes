/**
 * The command line: a filterable list opened with esc / ctrl+k.
 * Supports nested menus, live previews (e.g. themes) and free-text prompts.
 */
export interface Command {
  label: string;
  hint?: string;
  /** Marks the currently-selected option inside a choice menu. */
  active?: boolean;
  run?: () => void;
  /** Opens a nested menu instead of running. */
  sub?: () => Menu;
  /** Called while the item is highlighted. */
  preview?: () => void;
}

export interface Menu {
  title: string;
  items: Command[];
  /** Called when the menu is left without choosing (used to undo previews). */
  onCancel?: () => void;
  /** No dimming, and the box sits at the bottom, so previews behind it stay visible. */
  seeThrough?: boolean;
  /** An extra last item for what's been typed (e.g. "link to a new note"), or null. */
  extra?: (query: string) => Command | null;
}

interface PromptState {
  title: string;
  resolve: (v: string | null) => void;
}

export class Palette {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private stack: Menu[] = [];
  private filtered: Command[] = [];
  private index = 0;
  private prompt: PromptState | null = null;
  private returnFocus: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.input = root.querySelector("input")!;
    this.list = root.querySelector(".palette-list")!;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "settings and commands");
    this.list.id = "palette-list";
    this.list.setAttribute("role", "listbox");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-label", "search commands");
    this.input.setAttribute("aria-controls", "palette-list");
    this.input.setAttribute("aria-autocomplete", "list");

    this.input.addEventListener("input", () => {
      this.index = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) return this.cancelAll();
      // clicking a row mustn't take focus from the input, or the keyboard stops working
      if (e.target !== this.input) e.preventDefault();
    });
    this.list.addEventListener("mousemove", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-i]");
      if (li && Number(li.dataset.i) !== this.index) {
        this.index = Number(li.dataset.i);
        this.highlight();
      }
    });
    this.list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-i]");
      if (li) {
        this.index = Number(li.dataset.i);
        this.choose();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(menu: Menu, returnFocus: () => void): void {
    this.prompt = null;
    this.stack = [menu];
    this.returnFocus = returnFocus;
    this.show();
  }

  /** Ask for a line of text. Resolves null if cancelled. */
  ask(title: string, initial: string, returnFocus: () => void): Promise<string | null> {
    this.prompt?.resolve(null); // a prompt that is replaced counts as cancelled
    return new Promise((resolve) => {
      this.stack = [];
      this.prompt = { title, resolve };
      this.returnFocus = returnFocus;
      this.show(initial);
    });
  }

  private show(initial = ""): void {
    this.root.hidden = false;
    this.input.value = initial;
    this.index = this.startIndex();
    this.render();
    this.input.focus();
    this.input.select();
  }

  private close(): void {
    this.root.hidden = true;
    this.stack = [];
    this.prompt = null;
    const f = this.returnFocus;
    this.returnFocus = null;
    f?.();
  }

  private cancelAll(): void {
    if (this.prompt) this.prompt.resolve(null);
    for (let i = this.stack.length - 1; i >= 0; i--) this.stack[i].onCancel?.();
    this.close();
  }

  private back(): void {
    const m = this.stack.pop();
    m?.onCancel?.();
    if (this.stack.length === 0) return this.close();
    this.input.value = "";
    this.index = this.startIndex();
    this.render();
  }

  private startIndex(): number {
    const menu = this.stack.at(-1);
    const i = menu?.items.findIndex((c) => c.active) ?? -1;
    return Math.max(0, i);
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return this.prompt ? this.cancelAll() : this.back();
    }
    if (k === "Enter") {
      if (e.isComposing) return; // Enter that commits an IME composition
      e.preventDefault();
      return this.choose();
    }
    if (this.prompt) return;
    if (k === "Backspace" && this.input.value === "" && this.stack.length > 1) {
      e.preventDefault();
      return this.back();
    }
    const move = k === "ArrowDown" || (k === "Tab" && !e.shiftKey) || (e.ctrlKey && k === "j") ? 1
      : k === "ArrowUp" || (k === "Tab" && e.shiftKey) || (e.ctrlKey && k === "k") ? -1 : 0;
    if (move && this.filtered.length) {
      e.preventDefault();
      this.index = (this.index + move + this.filtered.length) % this.filtered.length;
      this.highlight();
    }
  }

  private choose(): void {
    if (this.prompt) {
      const { resolve } = this.prompt;
      const v = this.input.value.trim();
      this.close();
      resolve(v || null);
      return;
    }
    const cmd = this.filtered[this.index];
    if (!cmd) return;
    if (cmd.sub) {
      this.stack.push(cmd.sub());
      this.input.value = "";
      this.index = this.startIndex();
      this.render();
      return;
    }
    this.close();
    cmd.run?.();
  }

  private render(): void {
    if (this.prompt) {
      this.root.classList.remove("see-through");
      this.input.placeholder = this.prompt.title;
      this.list.replaceChildren();
      return;
    }
    const menu = this.stack.at(-1);
    if (!menu) return;
    this.input.placeholder = menu.title;
    this.root.classList.toggle("see-through", !!menu.seeThrough);
    const q = this.input.value.trim().toLowerCase();
    if (q) {
      // Exact substring matches first, then looser in-order matches.
      const exact = menu.items.filter((c) => c.label.toLowerCase().includes(q));
      const exactSet = new Set(exact);
      const loose = menu.items.filter((c) => !exactSet.has(c) && fuzzy(c.label.toLowerCase(), q));
      this.filtered = [...exact, ...loose];
      const extra = menu.extra?.(this.input.value.trim());
      if (extra) this.filtered.push(extra);
    } else {
      this.filtered = menu.items;
    }
    if (this.index >= this.filtered.length) this.index = 0;

    const frag = document.createDocumentFragment();
    this.filtered.forEach((c, i) => {
      const li = document.createElement("li");
      li.dataset.i = String(i);
      li.id = `palette-opt-${i}`;
      li.setAttribute("role", "option");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = c.label + (c.sub ? "..." : "");
      li.append(label);
      if (c.active) li.classList.add("active");
      if (c.hint) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = c.hint;
        li.append(hint);
      }
      frag.append(li);
    });
    if (!this.filtered.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "nothing found";
      frag.append(li);
    }
    this.list.replaceChildren(frag);
    this.highlight();
  }

  private highlight(): void {
    this.list.querySelectorAll("li.selected").forEach((el) => {
      el.classList.remove("selected");
      el.setAttribute("aria-selected", "false");
    });
    const li = this.list.querySelector<HTMLElement>(`li[data-i="${this.index}"]`);
    if (!li) return;
    li.classList.add("selected");
    li.setAttribute("aria-selected", "true");
    this.input.setAttribute("aria-activedescendant", li.id);
    li.scrollIntoView({ block: "nearest" });
    this.filtered[this.index]?.preview?.();
  }
}

/** Every query character appears in order. */
function fuzzy(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === q[i]) i++;
  return i === q.length;
}
