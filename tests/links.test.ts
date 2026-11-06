import { describe, expect, it } from "vitest";
import { linkTargets, retargetLinks, tagAt, tagRanges, tagsOf } from "../src/links";
import { Vault } from "../src/vault";
import { MemoryBackend } from "./memory-backend";

async function open(seed: Record<string, string> = {}) {
  const be = new MemoryBackend(seed);
  const v = new Vault(be);
  const updated: string[][] = [];
  v.onLinksUpdated = (notes) => updated.push(notes.map((n) => n.path));
  await v.load();
  const note = (path: string) => v.notes.find((n) => n.path === path)!;
  return { be, v, note, updated };
}

describe("tags", () => {
  it("finds tags that start a word, not headings, numbers or anchors", () => {
    const text = "# heading\n#idea and #work/meetings, #123 page#anchor #été #a-b";
    expect(tagsOf(text)).toEqual(["idea", "work/meetings", "été", "a-b"]);
  });
  it("lists ranges including the #", () => {
    expect(tagRanges("x #a y")).toEqual([[2, 4]]);
    expect(tagRanges("no tags # here")).toEqual([]);
  });
  it("finds the tag under a position", () => {
    const text = "one #Two three";
    expect(tagAt(text, 5)).toBe("two");
    expect(tagAt(text, 1)).toBeNull();
  });
  it("leaves trailing dashes and slashes out", () => {
    expect(tagsOf("#idea- #a/")).toEqual(["idea", "a"]);
  });
});

describe("link targets", () => {
  it("lists every target without alias or heading", () => {
    expect(linkTargets("[[a]] [[b|x]] [[c#h]]")).toEqual(["a", "b", "c"]);
  });
  it("rewrites chosen links and keeps alias and heading", () => {
    const text = "[[old]] [[old|nice]] [[old#part]] [[other]]";
    expect(retargetLinks(text, (t) => (t === "old" ? "new" : null))).toBe("[[new]] [[new|nice]] [[new#part]] [[other]]");
  });
});

describe("following links", () => {
  it("resolves a path, then a file name, then a title", async () => {
    const { v, note } = await open({ "ideas/plan.md": "the plan", "plan.md": "top plan", "x.md": "Shopping\nmilk" });
    expect(v.resolveLink("ideas/plan")).toBe(note("ideas/plan.md"));
    expect(v.resolveLink("PLAN")).toBe(note("plan.md")); // the top-level path wins
    expect(v.resolveLink("other/plan")).toBe(note("ideas/plan.md")); // then the name alone
    expect(v.resolveLink("shopping")).toBe(note("x.md"));
    expect(v.resolveLink("nothing")).toBeUndefined();
  });

  it("links by file name, or by path when the name is shared", async () => {
    const { v, note } = await open({ "a/plan.md": "plan", "b/plan.md": "plan", "solo.md": "solo" });
    expect(v.linkName(note("solo.md"))).toBe("solo");
    expect(v.linkName(note("a/plan.md"))).toBe("plan");
    expect(v.linkName(note("b/plan.md"))).toBe("b/plan");
  });
});

describe("backlinks", () => {
  it("lists notes linking to a note, by any name", async () => {
    const { v, note } = await open({
      "target.md": "Target\ntext",
      "by-name.md": "see [[target]]",
      "by-title.md": "see [[Target|it]]",
      "other.md": "see [[elsewhere]]",
      "self.md": "[[self]]",
    });
    expect(v.backlinks(note("target.md")).map((n) => n.path).sort()).toEqual(["by-name.md", "by-title.md"]);
    expect(v.backlinks(note("self.md"))).toEqual([]);
  });

  it("ignores links from the trash", async () => {
    const { v, note } = await open({ "target.md": "t", "a.md": "[[target]]" });
    v.trash(note("a.md"));
    expect(v.backlinks(note("target.md"))).toEqual([]);
  });
});

describe("renames keep links working", () => {
  it("rewrites links when a note's title (and so its file) changes", async () => {
    const { be, v, note, updated } = await open({ "ideas.md": "ideas\nlist", "a.md": "a\nsee [[ideas]] and [[ideas|my list#x]]" });
    v.setBody(note("ideas.md"), "big ideas\nlist");
    await v.flush();
    expect(be.files.get("a.md")?.body).toBe("a\nsee [[big ideas]] and [[big ideas|my list#x]]");
    expect(updated).toEqual([["a.md"]]);
  });

  it("rewrites folder-qualified links when a note moves to another folder", async () => {
    const { be, v, note } = await open({ "ideas/plan.md": "plan", "a.md": "[[ideas/plan]] and [[plan]]", "work/x.md": "x" });
    v.move(note("ideas/plan.md"), "work");
    await v.flush();
    // the bare name still finds it, so only the path link changes
    expect(be.files.get("a.md")?.body).toBe("[[work/plan]] and [[plan]]");
  });

  it("rewrites links into a renamed folder", async () => {
    const { be, v } = await open({ "projects/plan.md": "plan", "a.md": "[[projects/plan]]" });
    v.renameFolder("projects", "work");
    await v.flush();
    expect(be.files.get("a.md")?.body).toBe("[[work/plan]]");
  });

  it("leaves links to other notes with the old name alone", async () => {
    const { be, v, note } = await open({ "a/plan.md": "plan", "b/plan.md": "plan", "x.md": "[[plan]] [[b/plan]]" });
    v.setBody(note("b/plan.md"), "goals");
    await v.flush();
    // [[plan]] meant a/plan.md, which didn't move; a path link stays a path
    expect(be.files.get("x.md")?.body).toBe("[[plan]] [[b/goals]]");
  });

  it("doesn't rewrite links when a note goes to the trash", async () => {
    const { be, v, note } = await open({ "ideas.md": "ideas", "a.md": "[[ideas]]" });
    v.trash(note("ideas.md"));
    await v.flush();
    expect(be.files.get("a.md")?.body).toBe("[[ideas]]");
  });

  it("keeps the linking note's place in the list", async () => {
    const { v, note } = await open({ "ideas.md": "ideas", "a.md": "[[ideas]]" });
    const a = note("a.md");
    const before = a.updatedAt;
    v.setBody(note("ideas.md"), "plans");
    await v.flush();
    expect(a.body).toBe("[[plans]]");
    expect(a.updatedAt).toBe(before);
  });
});
