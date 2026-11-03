/**
 * Optional typing animations, drawn on top of the editor at the caret.
 */
import type { TypingAnimation } from "./model";

const MAX_LIVE = 80;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function spawnEffect(
  kind: TypingAnimation,
  layer: HTMLElement,
  caret: HTMLElement,
  x: number,
  y: number,
  h: number,
  ch: string,
): void {
  if (kind === "off" || reducedMotion.matches) return;
  if (kind === "pulse") {
    caret.classList.remove("bump");
    void caret.offsetWidth; // restart the animation
    caret.classList.add("bump");
    return;
  }
  if (layer.childElementCount > MAX_LIVE) return;
  if (kind === "ghost") {
    if (!ch.trim()) return;
    const el = document.createElement("span");
    el.className = "fx-ghost";
    el.textContent = ch;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.lineHeight = `${h}px`;
    add(layer, el);
  } else if (kind === "sparks") {
    const count = ch.trim() ? 4 : 2;
    for (let i = 0; i < count; i++) {
      const el = document.createElement("span");
      el.className = "fx-spark";
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2;
      const dist = h * (0.5 + Math.random() * 0.6);
      el.style.left = `${x}px`;
      el.style.top = `${y + h / 2}px`;
      el.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      el.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      add(layer, el);
    }
  }
}

function add(layer: HTMLElement, el: HTMLElement): void {
  el.addEventListener("animationend", () => el.remove(), { once: true });
  layer.append(el);
}
