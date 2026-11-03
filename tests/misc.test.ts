import { describe, expect, it } from "vitest";
import { cleanTarget, linkAt, linkRanges } from "../src/links";
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
