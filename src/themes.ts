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

export function applyTheme(theme: Theme): void {
  const s = document.documentElement.style;
  s.setProperty("--bg", theme.bg);
  s.setProperty("--main", theme.main);
  s.setProperty("--caret", theme.caret);
  s.setProperty("--sub", theme.sub);
  s.setProperty("--sub-alt", theme.subAlt);
  s.setProperty("--text", theme.text);
  s.setProperty("--error", theme.error);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bg);
}
