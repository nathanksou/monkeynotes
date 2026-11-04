import { monkeytypeThemes } from "./themes-monkeytype";

export interface Theme {
  name: string;
  bg: string;
  main: string;
  caret: string;
  sub: string;
  subAlt: string;
  text: string;
  error: string;
}

const t = (
  name: string,
  bg: string,
  main: string,
  sub: string,
  subAlt: string,
  text: string,
  error: string,
  caret = main,
): Theme => ({ name, bg, main, caret, sub, subAlt, text, error });

// Our own palettes, plus Monkeytype's full theme collection (GPL-3.0).
const own: Theme[] = [
  t("matcha", "#2b3a2f", "#a7c957", "#5c6b5f", "#243128", "#e6eedc", "#e07a5f"),
  t("espresso", "#2a211c", "#e0a96d", "#6b5a4e", "#231b17", "#ede0d4", "#d1495b"),
];

export const themes: Theme[] = [
  ...own,
  ...monkeytypeThemes.map(([name, bg, main, caret, sub, subAlt, text, error]) =>
    t(name, bg, main, sub, subAlt, text, error, caret),
  ),
].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

export const DEFAULT_THEME = "serika dark";

/** Names from earlier versions that were renamed. */
const renamed: Record<string, string> = { banana: "serika dark", gruvbox: "gruvbox dark" };

export function findTheme(name: string): Theme {
  const wanted = renamed[name] ?? name;
  return themes.find((x) => x.name === wanted) ?? themes.find((x) => x.name === DEFAULT_THEME)!;
}

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6);
  const n = parseInt(f, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function luminance([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Keep a color readable on the background: if it falls short of `min`, mix it
 * toward black or white (whichever helps) just far enough. Palettes that already
 * pass are returned untouched, so themes look exactly like Monkeytype's.
 */
export function readable(color: string, bg: string, min: number): string {
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})/i.test(color) || !/^#([0-9a-f]{3}|[0-9a-f]{6})/i.test(bg)) return color;
  if (contrast(color, bg) >= min) return color;
  const base = rgb(color);
  const target = contrast("#000000", bg) >= contrast("#ffffff", bg) ? 0 : 255;
  for (let k = 1; k <= 20; k++) {
    const mixed = base.map((v) => Math.round(v + (target - v) * (k / 20)));
    const hex = `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (contrast(hex, bg) >= min) return hex;
  }
  return target ? "#ffffff" : "#000000";
}

/**
 * The theme as it is actually shown: text and error readable (4.5:1), accent and
 * secondary text/icons visible (3:1) on the background. Colors that already pass
 * are left exactly as the palette has them.
 */
export function guardTheme(theme: Theme): Theme {
  const sub = readable(theme.sub, theme.bg, 3);
  let subAlt = theme.subAlt;
  // Panels (sub-alt) sit between the background and the secondary color: if the
  // palette had it stronger than the lifted sub, step it back toward the background.
  if (contrast(subAlt, theme.bg) > contrast(sub, theme.bg)) subAlt = sub;
  return {
    ...theme,
    main: readable(theme.main, theme.bg, 3),
    sub,
    subAlt,
    text: readable(theme.text, theme.bg, 4.5),
    error: readable(theme.error, theme.bg, 4.5),
  };
}

export function applyTheme(theme: Theme): void {
  const g = guardTheme(theme);
  const s = document.documentElement.style;
  s.setProperty("--bg", g.bg);
  // Body text must be readable (4.5:1); the accent drives focus rings and icons (3:1).
  s.setProperty("--main", g.main);
  s.setProperty("--caret", g.caret);
  s.setProperty("--sub", g.sub);
  s.setProperty("--sub-alt", g.subAlt);
  s.setProperty("--text", g.text);
  s.setProperty("--error", g.error);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", g.bg);
}
