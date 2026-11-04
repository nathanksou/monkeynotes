import { describe, expect, it } from "vitest";
import { META_FILE } from "../src/model";
import { Vault } from "../src/vault";
import { MemoryBackend } from "./memory-backend";

async function open(seed: Record<string, string> = {}, setup?: (be: MemoryBackend) => void) {
  const be = new MemoryBackend(seed, 1000);
  setup?.(be);
  const v = new Vault(be);
  const errors: string[] = [];
  v.onError = (m) => errors.push(m);
  await v.load();
  return { be, v, errors };
}

const versions = (be: MemoryBackend, path: string) => Object.values(be.history[path] ?? {});

describe("external changes between reloads", () => {
  it("keeps the disk version in history when it is replaced by the app's unsaved edit", async () => {
    const { be, v } = await open({ "a.md": "a\noriginal" });
    const n = v.notes[0];
    v.setBody(n, "a\nmy edit"); // not saved yet
    be.put("a.md", "a\nfrom another app"); // edited on disk meanwhile
    await v.reload(n.id);
    await v.flush();
    expect(be.files.get("a.md")?.body).toBe("a\nmy edit");
    expect(versions(be, "a.md")).toContain("a\nfrom another app");
  });

  it("adopts stars changed on disk and doesn't wipe them with the next save", async () => {
    const meta = (pinned: string[]) => JSON.stringify({ pinned, starredFolders: ["f"], trash: {} });
    const { be, v } = await open({ "a.md": "a", "b.md": "b", "f/c.md": "c", [META_FILE]: meta(["a.md"]) });
    expect(v.findByPath("a.md")?.starred).toBe(true);
    be.put(META_FILE, JSON.stringify({ pinned: ["b.md"], starredFolders: [], trash: {} }));
    await v.reload(null);
    expect(v.findByPath("a.md")?.starred).toBeUndefined();
    expect(v.findByPath("b.md")?.starred).toBe(true);
    expect(v.starredFolders.has("f")).toBe(false);
    // an ordinary edit and save must not bring the old stars back
    v.setBody(v.findByPath("a.md")!, "a edited");
    await v.flush();
    const saved = JSON.parse(be.files.get(META_FILE)!.body);
    expect(saved.pinned).toEqual(["b.md"]);
    expect(saved.starredFolders).toEqual([]);
  });

  it("keeps a local star change made before a reload instead of overwriting it silently", async () => {
    const { be, v } = await open({ "a.md": "a", "b.md": "b" });
    v.toggleStar(v.findByPath("a.md")!);
    be.put(META_FILE, JSON.stringify({ pinned: ["b.md"] }));
    await v.reload(null);
    await v.flush();
    const saved = JSON.parse(be.files.get(META_FILE)!.body);
    expect(saved.pinned.sort()).toEqual(["a.md"]);
  });
});

describe("unreadable metadata", () => {
  for (const raw of ["{ not json", "[]", "null", "42", '"text"', "[1,2]", ""]) {
    it(`loads with ${JSON.stringify(raw)} and keeps a backup copy`, async () => {
      const { be, v } = await open({ "a.md": "a", [META_FILE]: raw });
      expect(v.notes).toHaveLength(1);
      v.toggleStar(v.notes[0]);
      await v.flush();
      expect(JSON.parse(be.files.get(META_FILE)!.body).pinned).toEqual(["a.md"]);
      if (raw) expect(be.files.get(META_FILE + ".bak")?.body).toBe(raw);
    });
  }

  it("doesn't overwrite an older backup", async () => {
    const { be, v } = await open({ "a.md": "a", [META_FILE]: "{ broken", [META_FILE + ".bak"]: "{ older" });
    await v.flush();
    expect(be.files.get(META_FILE + ".bak")?.body).toBe("{ older");
    expect([...be.files.values()].some((f) => f.body === "{ broken")).toBe(true);
  });

  it("survives fields of the wrong type", async () => {
    for (const bad of [{ pinned: 5 }, { pinned: "a.md" }, { starredFolders: 3 }, { trash: [] }, { trash: { "a.md": null } }, { pinned: [1, null] }]) {
      const { v } = await open({ "a.md": "a", [META_FILE]: JSON.stringify(bad) });
      expect(v.notes).toHaveLength(1);
    }
  });

  it("keeps trashed notes in the trash when the metadata is unreadable", async () => {
    const { v } = await open({ ".trash/gone.md": "gone", [META_FILE]: "{ broken" });
    expect(v.notes[0].deletedAt).toBeTruthy();
    expect(v.notes[0].foreignTrash).toBe(true); // never auto-purged
  });
});

describe("failing file operations", () => {
  it("removes a folder again when creating it fails", async () => {
    const { be, v, errors } = await open();
    be.failing.add("mkdir");
    const f = v.createFolder("ideas");
    expect(v.folders.some((x) => x.id === f.id)).toBe(true);
    await v.flush();
    expect(v.folders.some((x) => x.id === f.id)).toBe(false);
    expect(errors.join()).toMatch(/create folder failed/);
    await v.reload(null);
    expect(v.folders.some((x) => x.id === f.id)).toBe(false);
  });

  it("still saves the note when storing a version fails, and says so", async () => {
    const { be, v, errors } = await open({ "a.md": "a\none" });
    be.failing.add("historySave");
    v.setBody(v.notes[0], "a\ntwo");
    await v.flush();
    expect(be.files.get("a.md")?.body).toBe("a\ntwo");
    expect(errors.join()).toMatch(/saving a version failed/);
    expect(v.failures).toBe(0);
  });
});

describe("trash and folders", () => {
  it("restores a note from another app's trash to the top folder", async () => {
    const { be, v } = await open({ ".trash/old.md": "old\nnote" });
    const n = v.notes[0];
    expect(n.foreignTrash).toBe(true);
    v.restore(n);
    await v.flush();
    expect(n.deletedAt).toBeUndefined();
    expect(n.foreignTrash).toBeUndefined();
    expect(be.paths()).toEqual(["old.md"]);
    expect(JSON.parse(be.files.get(META_FILE)?.body ?? "{}").trash ?? {}).toEqual({});
  });

  it("stars a folder, follows its rename, and remembers it", async () => {
    const { be, v } = await open({ "work/a.md": "a", "play/b.md": "b" });
    v.toggleFolderStar("work");
    v.toggleFolderStar("nope"); // unknown folders are ignored
    v.toggleFolderStar(""); // the root can't be starred
    expect([...v.starredFolders]).toEqual(["work"]);
    v.renameFolder("work", "jobs");
    expect([...v.starredFolders]).toEqual(["jobs"]);
    await v.flush();
    expect(JSON.parse(be.files.get(META_FILE)!.body).starredFolders).toEqual(["jobs"]);
    const again = new Vault(be);
    await again.load();
    expect([...again.starredFolders]).toEqual(["jobs"]);
    v.toggleFolderStar("jobs");
    expect(v.starredFolders.size).toBe(0);
  });

  it("relabels starred subfolders along with their parent", async () => {
    const { v } = await open({ "a/b/n.md": "n" });
    v.toggleFolderStar("a/b");
    v.renameFolder("a", "z");
    expect([...v.starredFolders]).toEqual(["z/b"]);
  });

  it("empties the trash: files, history and metadata", async () => {
    const { be, v } = await open({ "a.md": "a", "b.md": "b" });
    const [a, b] = [v.findByPath("a.md")!, v.findByPath("b.md")!];
    v.setBody(a, "a\nedited");
    await v.flush();
    v.trash(a);
    v.trash(b);
    await v.flush();
    expect(be.paths().every((p) => p.startsWith(".trash/"))).toBe(true);
    v.emptyTrash();
    await v.flush();
    expect(be.paths()).toEqual([]);
    expect(Object.keys(be.history)).toEqual([]);
    expect(JSON.parse(be.files.get(META_FILE)!.body).trash).toEqual({});
    expect(v.notes).toEqual([]);
  });

  it("restores notes of a deleted folder into that folder again", async () => {
    const { be, v } = await open({ "work/a.md": "a\nbody", "work/deep/b.md": "b\nbody", "keep.md": "k" });
    v.deleteFolder("work");
    await v.flush();
    expect(be.dirs.has("work")).toBe(false);
    const a = v.notes.find((n) => n.body.startsWith("a"))!;
    const b = v.notes.find((n) => n.body.startsWith("b"))!;
    // survives a restart
    const again = new Vault(be);
    await again.load();
    expect(again.notes.find((n) => n.body.startsWith("a"))!.folderId).toBe("work");
    v.restore(a);
    v.restore(b);
    await v.flush();
    expect(a.folderId).toBe("work");
    expect(b.folderId).toBe("work/deep");
    expect(be.paths()).toEqual(["keep.md", "work/a.md", "work/deep/b.md"]);
    expect(v.folders.map((f) => f.id)).toEqual(["", "work", "work/deep"]);
  });

  it("restores to the top folder when the old folder can't be recreated", async () => {
    const { be, v } = await open({ "work/a.md": "a\nbody" });
    v.deleteFolder("work");
    await v.flush();
    be.failing.add("mkdir");
    const a = v.notes[0];
    v.restore(a);
    await v.flush();
    expect(be.paths()).toEqual(["a.md"]);
    expect(a.folderId).toBe("");
  });
});

describe("case-only renames", () => {
  async function ci(seed: Record<string, string>) {
    const be = new MemoryBackend(seed, 1000);
    be.caseInsensitive = true;
    const v = new Vault(be);
    v.onError = () => {};
    await v.load();
    return { be, v };
  }

  it("renames Ideas.md to ideas.md when the title changes case", async () => {
    const { be, v } = await ci({ "Ideas.md": "Ideas\nx" });
    const n = v.notes[0];
    v.setBody(n, "ideas\nx");
    await v.flush();
    expect(be.paths()).toEqual(["ideas.md"]);
    expect(n.path).toBe("ideas.md");
    expect(v.failures).toBe(0);
  });

  it("keeps history through a case-only rename", async () => {
    const { be, v } = await ci({ "Ideas.md": "Ideas\none" });
    be.history["Ideas.md"] = { 5: "Ideas\nancient" };
    v.setBody(v.notes[0], "ideas\ntwo");
    await v.flush();
    expect(Object.values(be.history["ideas.md"] ?? {})).toContain("Ideas\nancient");
  });

  it("gives a second note whose title differs only by case another name", async () => {
    const { be, v } = await ci({ "Ideas.md": "Ideas\nx" });
    const n = v.create("", "ideas\ny");
    await v.flush();
    expect(be.paths().sort()).toEqual(["Ideas.md", "ideas 2.md"]);
    expect(n.path).toBe("ideas 2.md");
  });

  it("treats the names as different on a case-sensitive disk", async () => {
    const be = new MemoryBackend({ "Ideas.md": "Ideas\nx" }, 1000);
    const v = new Vault(be);
    await v.load();
    v.create("", "ideas\ny");
    await v.flush();
    expect(be.paths().sort()).toEqual(["Ideas.md", "ideas 2.md"]);
  });
});
