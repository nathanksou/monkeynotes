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

// Palettes are either our own or long-standing public palettes
// (nord, dracula, gruvbox, catppuccin, rosé pine, solarized).
export const themes: Theme[] = [
  t("banana", "#323437", "#e2b714", "#646669", "#2c2e31", "#d1d0c5", "#ca4754"),
  t("paper", "#eeeeee", "#444444", "#b2b2b2", "#dddddd", "#444444", "#d70000"),
  t("nord", "#2e3440", "#88c0d0", "#4c566a", "#3b4252", "#d8dee9", "#bf616a"),
  t("dracula", "#282a36", "#bd93f9", "#6272a4", "#21222c", "#f8f8f2", "#ff5555"),
  t("gruvbox", "#282828", "#fabd2f", "#7c6f64", "#32302f", "#ebdbb2", "#fb4934"),
  t("catppuccin", "#1e1e2e", "#cba6f7", "#6c7086", "#181825", "#cdd6f4", "#f38ba8"),
  t("rose pine", "#191724", "#ebbcba", "#6e6a86", "#1f1d2e", "#e0def4", "#eb6f92"),
  t("solarized light", "#fdf6e3", "#268bd2", "#93a1a1", "#eee8d5", "#586e75", "#dc322f"),
  t("matcha", "#2b3a2f", "#a7c957", "#5c6b5f", "#243128", "#e6eedc", "#e07a5f"),
  t("espresso", "#2a211c", "#e0a96d", "#6b5a4e", "#231b17", "#ede0d4", "#d1495b"),
  t("terminal", "#0c0c0c", "#39d353", "#3a5a3f", "#141414", "#b8f5c0", "#ff5f56"),
];

export const DEFAULT_THEME = "banana";

export function findTheme(name: string): Theme {
  return themes.find((x) => x.name === name) ?? themes[0];
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
