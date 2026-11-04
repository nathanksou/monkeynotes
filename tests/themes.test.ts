import { describe, expect, it } from "vitest";
import { contrast, guardTheme, readable, themes } from "../src/themes";

describe("theme guard", () => {
  it("makes every theme meet the contrast minimums", () => {
    for (const t of themes) {
      const g = guardTheme(t);
      expect(contrast(g.text, g.bg), `${t.name} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(g.main, g.bg), `${t.name} main`).toBeGreaterThanOrEqual(3);
      expect(contrast(g.sub, g.bg), `${t.name} sub`).toBeGreaterThanOrEqual(3);
      expect(contrast(g.error, g.bg), `${t.name} error`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves colors that already pass untouched", () => {
    for (const t of themes) {
      const g = guardTheme(t);
      if (contrast(t.text, t.bg) >= 4.5) expect(g.text, t.name).toBe(t.text);
      if (contrast(t.main, t.bg) >= 3) expect(g.main, t.name).toBe(t.main);
      if (contrast(t.sub, t.bg) >= 3) expect(g.sub, t.name).toBe(t.sub);
      if (contrast(t.error, t.bg) >= 4.5) expect(g.error, t.name).toBe(t.error);
      expect(g.bg).toBe(t.bg);
      expect(g.caret).toBe(t.caret);
    }
  });

  it("keeps the sub-alt layer no stronger than sub, and changes it only when it was", () => {
    for (const t of themes) {
      const g = guardTheme(t);
      expect(contrast(g.subAlt, g.bg), t.name).toBeLessThanOrEqual(contrast(g.sub, g.bg) + 1e-9);
      if (contrast(t.subAlt, t.bg) <= contrast(g.sub, g.bg)) expect(g.subAlt, t.name).toBe(t.subAlt);
    }
  });

  it("moves a failing color just far enough", () => {
    const out = readable("#777777", "#808080", 3);
    expect(contrast(out, "#808080")).toBeGreaterThanOrEqual(3);
    expect(readable("#336699", "#ffffff", 3)).toBe("#336699");
  });
});
