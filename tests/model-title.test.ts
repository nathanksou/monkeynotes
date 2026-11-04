import { describe, expect, it } from "vitest";
import { type Note, noteTitle, notePreview, titleLine } from "../src/model";

const note = (body: string): Note => ({ id: "x", path: "", folderId: "", body, createdAt: 0, updatedAt: 0, autoName: true });

describe("titleLine", () => {
  it("uses the first non-empty line without heading marks", () => {
    expect(titleLine("\n\n# Hello\nbody")).toBe("Hello");
    expect(titleLine("")).toBe("");
  });
  it("skips a YAML front matter block", () => {
    expect(titleLine("---\ntags: [a]\n---\n# Real title\nbody")).toBe("Real title");
    expect(titleLine("---\r\ntags: a\r\n---\r\nReal title")).toBe("Real title");
    expect(titleLine("---\n---\n\nAfter empty block")).toBe("After empty block");
    expect(titleLine("﻿---\ntags: a\n---\nBom title")).toBe("Bom title");
  });
  it("prefers a title: key in the front matter", () => {
    expect(titleLine("---\ntitle: My note\ntags: a\n---\nbody line")).toBe("My note");
    expect(titleLine('---\ntitle: "Quoted: yes"\n---\nbody')).toBe("Quoted: yes");
    expect(titleLine("---\ntitle:\n---\nbody line")).toBe("body line");
    expect(titleLine("---\nTitle: Upper\n---\nbody")).toBe("Upper");
  });
  it("gives nothing for front matter with no content", () => {
    expect(titleLine("---\ntags: a\n---\n")).toBe("");
  });
  it("leaves a lone --- (no closing line) alone", () => {
    expect(titleLine("---\nnot front matter")).toBe("---");
    expect(titleLine("text\n---\ntitle: x\n---")).toBe("text");
  });
});

describe("noteTitle / notePreview with front matter", () => {
  it("titles from content and previews the next line", () => {
    const n = note("---\ntags: a\n---\n# Real\nsecond line");
    expect(noteTitle(n)).toBe("Real");
    expect(notePreview(n)).toBe("second line");
  });
  it("previews the first content line when the title came from a title: key", () => {
    const n = note("---\ntitle: Keyed\n---\nfirst content");
    expect(noteTitle(n)).toBe("Keyed");
    expect(notePreview(n)).toBe("first content");
  });
});
