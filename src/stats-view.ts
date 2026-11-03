/** The full typing stats view (opened from the stats bar or the command line). */
import { type TypingStats, dayKey, formatDuration } from "./stats";

export function renderStatsView(stats: TypingStats): HTMLElement {
  const t = stats.totals();
  const today = stats.today();
  const days = stats.recent(14);
  const max = Math.max(1, ...days.map((d) => d.stats?.chars ?? 0));
  const box = document.createElement("div");
  box.className = "stats-box";
  const h = document.createElement("h2");
  h.textContent = "typing stats";
  const grid = document.createElement("div");
  grid.className = "stats-grid";
  const cell = (value: string, label: string) => {
    const c = document.createElement("div");
    const v = document.createElement("div");
    v.className = "big";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    c.append(l, v);
    return c;
  };
  grid.append(
    cell(String(Math.round(today.chars / 5)), "words today"),
    cell(formatDuration(today.ms), "typing today"),
    cell(String(today.best || "-"), "best wpm today"),
    cell(String(stats.streak()), "day streak"),
    cell(String(stats.average()), "avg wpm (30 days)"),
    cell(String(t.best || "-"), "best wpm ever"),
    cell(t.words.toLocaleString(), "words all time"),
    cell(formatDuration(t.ms), "typing all time"),
  );
  const chart = document.createElement("div");
  chart.className = "stats-chart";
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "col";
    if (d.key === dayKey()) col.classList.add("today");
    const words = Math.round((d.stats?.chars ?? 0) / 5);
    col.title = `${d.day.toLocaleDateString()} · ${words} words · ${formatDuration(d.stats?.ms ?? 0)}`;
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${((d.stats?.chars ?? 0) / max) * 100}%`;
    const lbl = document.createElement("div");
    lbl.className = "day";
    lbl.textContent = d.day.toLocaleDateString([], { weekday: "narrow" });
    col.append(bar, lbl);
    chart.append(col);
  }
  const foot = document.createElement("div");
  foot.className = "stats-foot";
  foot.textContent = "words = characters / 5 · only active typing time counts · esc to close";
  box.append(h, grid, chart, foot);
  return box;
}
