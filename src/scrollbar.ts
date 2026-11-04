/**
 * A thin scrollbar that floats over the content and only shows while the content
 * scrolls. The native bar is hidden (see styles.css) because it took up width, which
 * made text re-wrap between short and long notes. This one never changes the layout.
 */
const HIDE_AFTER_MS = 900;
const MIN_THUMB = 24;

export function overlayScrollbar(el: HTMLElement): void {
  const host = el.parentElement;
  if (!host) return;
  const thumb = document.createElement("div");
  thumb.className = "os-thumb";
  thumb.setAttribute("aria-hidden", "true");
  host.append(thumb);

  let timer = 0;
  const place = (): boolean => {
    const { scrollHeight, clientHeight, scrollTop } = el;
    if (scrollHeight <= clientHeight + 1) return false;
    const h = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * clientHeight);
    const y = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - h);
    thumb.style.height = `${h}px`;
    thumb.style.top = `${el.offsetTop + y}px`;
    return true;
  };
  el.addEventListener(
    "scroll",
    () => {
      if (!place()) return;
      thumb.classList.add("on");
      clearTimeout(timer);
      timer = window.setTimeout(() => thumb.classList.remove("on"), HIDE_AFTER_MS);
    },
    { passive: true },
  );
}
