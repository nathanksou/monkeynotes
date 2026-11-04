import { describe, expect, it } from "vitest";
import { cleanTarget, linkAt, linkRanges } from "../src/links";
import { locate, starts } from "../src/paragraphs";
import { TypingStats, dayKey } from "../src/stats";
import { isNewer } from "../src/updates";

describe("links", () => {
  const text = "see [[Ideas]] and [[projects/Plan|the plan]]\n[[Other#heading]]";
  it("finds the link under a position", () => {
    expect(linkAt(text, 6)).toBe("Ideas");
    expect(linkAt(text, 25)).toBe("projects/Plan");
    expect(linkAt(text, 50)).toBe("Other");
    expect(linkAt(text, 15)).toBeNull();
  });
  it("strips aliases and headings", () => {
    expect(cleanTarget("a|b")).toBe("a");
    expect(cleanTarget("a#b")).toBe("a");
  });
  it("lists link ranges", () => {
    expect(linkRanges("x [[a]] y")).toEqual([[2, 7]]);
    expect(linkRanges("no links")).toEqual([]);
  });
});

describe("typing stats", () => {
  it("counts only active time and computes wpm", () => {
    let t = 0;
    const s = new TypingStats({ days: {} }, () => t);
    // 60 characters over 12 seconds, one key every 200ms = 60 wpm
    for (let i = 0; i < 61; i++) {
      s.type(1);
      t += 200;
    }
    expect(s.today().ms).toBe(12000);
    expect(s.lastWpm).toBe(61); // 61 chars / 5 / 0.2 min
    expect(s.today().best).toBe(61);
    // a long pause doesn't count as typing time
    t += 60_000;
    s.type(1);
    expect(s.today().ms).toBe(12000);
    expect(s.live()).toBeNull();
  });

  it("counts a streak of days", () => {
    const days: Record<string, { chars: number; ms: number; best: number }> = {};
    const d = new Date();
    for (let i = 1; i <= 3; i++) {
      d.setDate(d.getDate() - 1);
      days[dayKey(d)] = { chars: 100, ms: 1000, best: 0 };
    }
    const s = new TypingStats({ days });
    expect(s.streak()).toBe(3); // today not started yet: counts back from yesterday
    s.today().chars = 100;
    expect(s.streak()).toBe(4);
  });
});

describe("update check", () => {
  it("compares versions", () => {
    expect(isNewer("v0.3.0", "0.2.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("v0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("paragraph helpers", () => {
  const paras = "ab\n\ncde".split("\n"); // ["ab", "", "cde"]
  it("locates a text position inside its paragraph", () => {
    expect(locate(paras, 0)).toEqual({ index: 0, offset: 0 });
    expect(locate(paras, 2)).toEqual({ index: 0, offset: 2 }); // end of "ab"
    expect(locate(paras, 3)).toEqual({ index: 1, offset: 0 }); // the empty line
    expect(locate(paras, 4)).toEqual({ index: 2, offset: 0 });
    expect(locate(paras, 7)).toEqual({ index: 2, offset: 3 }); // end of text
  });
  it("lists paragraph start offsets", () => {
    expect(starts(paras)).toEqual([0, 3, 4]);
  });
});

import { contrast, readable, themes } from "../src/themes";

describe("theme legibility", () => {
  it("keeps readable colors untouched and fixes unreadable ones", () => {
    expect(readable("#ffffff", "#000000", 4.5)).toBe("#ffffff");
    expect(contrast(readable("#eeeeee", "#ffffff", 4.5), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
  it("every theme's text ends up at 4.5:1", () => {
    for (const t of themes) expect(contrast(readable(t.text, t.bg, 4.5), t.bg), t.name).toBeGreaterThanOrEqual(4.5);
  });
});

describe("isNewer with pre-releases", () => {
  it("treats the final release as newer than its beta", () => {
    expect(isNewer("v0.4.0", "0.4.0-beta.1")).toBe(true);
    expect(isNewer("v0.4.0-beta.2", "0.4.0")).toBe(false);
    expect(isNewer("v0.4.1", "0.4.0")).toBe(true);
  });
});
