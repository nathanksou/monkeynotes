import { describe, expect, it } from "vitest";
import { TRASH_TTL_MS } from "../src/model";
import { Vault, safeName } from "../src/vault";
import { MemoryBackend } from "./memory-backend";

async function open(seed: Record<string, string> = {}, modified?: number, titleFromFile = false) {
  const be = new MemoryBackend(seed, modified);
  const v = new Vault(be);
  v.titleFromFile = titleFromFile;
  await v.load();
  return { be, v };
}

describe("safeName", () => {
  it("strips characters no OS allows", () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });
  it("never produces hidden, empty or reserved names", () => {
    expect(safeName("...hidden")).toBe("hidden");
    expect(safeName("   ")).toBe("untitled");
    expect(safeName("CON")).toBe("CON_");
    expect(safeName("trailing dot.")).toBe("trailing dot");
  });
});

describe("naming notes", () => {
  it("names a new note after its first line and renames as the title changes", async () => {
    const { be, v } = await open();
    const n = v.create("");
    v.setBody(n, "grocery list\nmilk");
    await v.flush();
    expect(be.paths()).toEqual(["grocery list.md"]);
    v.setBody(n, "# weekly groceries\nmilk");
    await v.flush();
    expect(be.paths()).toEqual(["weekly groceries.md"]);
    expect(be.files.get("weekly groceries.md")?.body).toBe("# weekly groceries\nmilk");
  });

  it("doesn't write a file for a new empty note", async () => {
    const { be, v } = await open();
    v.create("");
    await v.flush();
    expect(be.paths()).toEqual([]);
  });

  it("adds a number when the name is taken", async () => {
    const { be, v } = await open({ "ideas.md": "ideas" });
    const n = v.create("");
    v.setBody(n, "ideas\nmore");
    await v.flush();
    expect(be.paths()).toEqual(["ideas 2.md", "ideas.md"]);
  });

  it("keeps the name of a file that doesn't follow its title", async () => {
    const { be, v } = await open({ "2026-11-03.md": "standup\nnotes" });
    v.setBody(v.notes[0], "retro\nnotes");
    await v.flush();
    expect(be.paths()).toEqual(["2026-11-03.md"]);
  });

  it("never renames in file-name title mode", async () => {
    const { be, v } = await open({ "Roadmap.md": "Roadmap\nship it" }, undefined, true);
    v.setBody(v.notes[0], "Totally different\nship it");
    await v.flush();
    expect(be.paths()).toEqual(["Roadmap.md"]);
  });

  it("renameNote picks an explicit file name and stops following the title", async () => {
    const { be, v } = await open({ "a.md": "a" });
    v.renameNote(v.notes[0], "chosen name");
    await v.flush();
    v.setBody(v.notes[0], "b");
    await v.flush();
    expect(be.paths()).toEqual(["chosen name.md"]);
  });
});

describe("trash", () => {
  it("moves deleted notes to .trash and restores them to their folder", async () => {
    const { be, v } = await open({ "work/plan.md": "plan" });
    const n = v.notes[0];
    v.trash(n);
    await v.flush();
    expect(be.paths()).toEqual([".trash/plan.md"]);
    v.restore(n);
    await v.flush();
    expect(be.paths()).toEqual(["work/plan.md"]);
  });

  it("purges its own trash after 30 days", async () => {
    const be = new MemoryBackend({ ".trash/old.md": "old" });
    be.put(".monkeynotes.json", JSON.stringify({ trash: { "old.md": { from: "", deletedAt: Date.now() - TRASH_TTL_MS - 1000 } } }));
    const v = new Vault(be);
    await v.load();
    await v.flush();
    expect(be.paths()).toEqual([]);
  });

  it("never purges another app's trash (e.g. Obsidian's)", async () => {
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const { be, v } = await open({ ".trash/from obsidian.md": "x" }, old);
    await v.flush();
    expect(be.paths()).toEqual([".trash/from obsidian.md"]);
    expect(v.notes[0].deletedAt).toBeTruthy();
    // and it isn't recorded as ours, so a later launch won't purge it either
    expect(be.files.get(".monkeynotes.json")).toBeUndefined();
  });
});

describe("nested folders", () => {
  it("loads nested folders with short names", async () => {
    const { v } = await open({ "projects/2026/plan.md": "plan", "projects/notes.md": "n" });
    expect(v.folders.map((f) => [f.id, f.name])).toEqual([
      ["", "notes"],
      ["projects", "projects"],
      ["projects/2026", "2026"],
    ]);
    expect(v.notes.find((n) => n.body === "plan")?.folderId).toBe("projects/2026");
  });

  it("creates subfolders", async () => {
    const { be, v } = await open({ "projects/a.md": "a" });
    const f = v.createFolder("2027", "projects");
    await v.flush();
    expect(f.id).toBe("projects/2027");
    expect(be.dirs.has("projects/2027")).toBe(true);
  });

  it("renaming a folder moves its subfolders and notes", async () => {
    const { be, v } = await open({ "projects/2026/plan.md": "plan" });
    const next = v.renameFolder("projects", "work");
    const n = v.notes[0];
    v.setBody(n, "plan\nedited");
    await v.flush();
    expect(next).toBe("work");
    expect(v.folders.map((f) => f.id)).toEqual(["", "work", "work/2026"]);
    expect(be.paths()).toEqual(["work/2026/plan.md"]);
    expect(n.folderId).toBe("work/2026");
  });

  it("deleting a folder trashes notes in all its subfolders and removes the folders", async () => {
    const { be, v } = await open({ "projects/a.md": "a", "projects/2026/b.md": "b", "keep.md": "keep" });
    v.deleteFolder("projects");
    await v.flush();
    await v.flush();
    expect(be.paths()).toEqual([".trash/a.md", ".trash/b.md", "keep.md"]);
    expect(be.dirs.has("projects")).toBe(false);
    expect(be.dirs.has("projects/2026")).toBe(false);
  });

  it("imports folder trees", async () => {
    const { be, v } = await open();
    const { count } = v.importDir({
      name: "vault",
      files: [{ name: "top", body: "top" }],
      dirs: [{ name: "sub", files: [{ name: "deep", body: "deep" }], dirs: [] }],
    });
    await v.flush();
    expect(count).toBe(2);
    expect(be.paths()).toEqual(["vault/sub/deep.md", "vault/top.md"]);
  });
});

describe("pins", () => {
  it("survive a rename via the metadata file", async () => {
    const { be, v } = await open({ "a.md": "a" });
    v.togglePin(v.notes[0]);
    v.setBody(v.notes[0], "b");
    await v.flush();
    const meta = JSON.parse(be.files.get(".monkeynotes.json")!.body);
    expect(meta.pinned).toEqual(["b.md"]);
    const again = new Vault(be);
    await again.load();
    expect(again.notes[0].pinned).toBe(true);
  });
});

describe("reload", () => {
  it("picks up external edits but never clobbers unsaved typing", async () => {
    const { be, v } = await open({ "a.md": "a", "b.md": "b" });
    const [a, b] = [v.notes.find((n) => n.path === "a.md")!, v.notes.find((n) => n.path === "b.md")!];
    be.put("a.md", "a\nedited elsewhere");
    const changed = await v.reload(a.id);
    expect(changed).toBe(true);
    expect(a.body).toBe("a\nedited elsewhere");
    expect(b.body).toBe("b");
  });
});

describe("never losing data", () => {
  it("a new note never overwrites a file it doesn't know about", async () => {
    const { be, v } = await open();
    be.put("todo.md", "someone else's todo list"); // e.g. a sync client, no reload yet
    const n = v.create("");
    v.setBody(n, "todo\nmine");
    await v.flush();
    expect(be.files.get("todo.md")?.body).toBe("someone else's todo list");
    expect(be.files.get("todo 2.md")?.body).toBe("todo\nmine");
    expect(n.path).toBe("todo 2.md");
  });

  it("an import never overwrites an unknown file", async () => {
    const { be, v } = await open();
    be.put("notes.md", "existing");
    v.importFiles("", [{ name: "notes", body: "imported" }]);
    await v.flush();
    expect(be.files.get("notes.md")?.body).toBe("existing");
    expect(be.files.get("notes 2.md")?.body).toBe("imported");
  });

  it("a rename onto an unknown file picks another name and leaves no duplicate", async () => {
    const { be, v } = await open({ "ideas.md": "ideas" });
    be.put("plans.md", "not ours");
    v.setBody(v.notes[0], "plans\nfrom ideas");
    await v.flush();
    expect(be.paths()).toEqual(["plans 2.md", "plans.md"]);
    expect(be.files.get("plans.md")?.body).toBe("not ours");
    expect(be.files.get("plans 2.md")?.body).toBe("plans\nfrom ideas");
  });

  it("keeps unsaved text when a save fails, and a reload doesn't replace it", async () => {
    const errors: string[] = [];
    const { be, v } = await open({ "a.md": "a" });
    v.onError = (m) => errors.push(m);
    const n = v.notes[0];
    be.failWrites.add("a.md");
    v.setBody(n, "a\nimportant edit");
    await v.flush();
    expect(errors).toHaveLength(1);
    expect(v.failures).toBe(1);
    await v.reload(n.id); // flushes again: this time the write succeeds
    expect(n.body).toBe("a\nimportant edit");
    expect(be.files.get("a.md")?.body).toBe("a\nimportant edit");
  });

  it("a save queued before a folder rename lands in the renamed folder", async () => {
    const { be, v } = await open({ "projects/plan.md": "plan" });
    const n = v.notes[0];
    v.setBody(n, "plan\nedited");
    const saving = v.flush(); // save queued...
    v.renameFolder("projects", "work"); // ...then the folder rename
    await saving;
    await v.flush();
    expect(be.paths()).toEqual(["work/plan.md"]);
    expect(be.files.get("work/plan.md")?.body).toBe("plan\nedited");
    expect([...be.dirs]).toEqual(["work"]);
  });

  it("a failed folder rename puts the old names back", async () => {
    const { be, v } = await open({ "projects/plan.md": "plan" });
    be.dirs.add("work"); // exists on disk but wasn't scanned yet
    v.onError = () => {};
    v.renameFolder("projects", "work");
    await v.flush();
    expect(v.folders.map((f) => f.id)).toContain("projects");
    expect(v.notes[0].folderId).toBe("projects");
    expect(be.paths()).toEqual(["projects/plan.md"]);
  });

  it("reload only re-reads files that changed", async () => {
    const { be, v } = await open({ "a.md": "a", "b.md": "b" });
    let bodiesSent = 0;
    const scan = be.scan.bind(be);
    be.scan = async (known) => {
      const r = await scan(known);
      bodiesSent += r.files.filter((f) => f.body !== null).length;
      return r;
    };
    be.put("b.md", "b\nchanged");
    await v.reload(null);
    expect(bodiesSent).toBe(1);
  });
});

describe("reload while the user keeps working", () => {
  it("keeps text typed while the folder is being re-read", async () => {
    const { be, v } = await open({ "a.md": "a" });
    const n = v.notes[0];
    v.setBody(n, "a\nfirst edit"); // saved before the reload, so the scan re-reads it
    await v.flush();
    be.duringScan = () => {
      v.setBody(n, "a\nfirst edit\ntyped during the scan");
      void v.flush(); // the debounce timer firing mid-scan
    };
    const changed = await v.reload(n.id);
    await v.flush();
    expect(changed).toBe(false);
    expect(n.body).toBe("a\nfirst edit\ntyped during the scan");
    expect(be.files.get("a.md")?.body).toBe("a\nfirst edit\ntyped during the scan");
  });

  it("keeps a new note whose first save happens during the re-read", async () => {
    const { be, v } = await open({ "a.md": "a" });
    let fresh!: ReturnType<typeof v.create>;
    be.duringScan = () => {
      fresh = v.create("");
      v.setBody(fresh, "brand new\nnote");
      void v.flush();
    };
    await v.reload(null);
    await v.flush();
    expect(v.notes).toContain(fresh);
    expect(be.files.get("brand new.md")?.body).toBe("brand new\nnote");
    v.setBody(fresh, "brand new\nnote, still saving");
    await v.flush();
    expect(be.files.get("brand new.md")?.body).toBe("brand new\nnote, still saving");
  });

  it("keeps a folder created during the re-read", async () => {
    const { v } = await open({ "a.md": "a" });
    const be = (v as unknown as { be: MemoryBackend }).be;
    be.duringScan = () => void v.createFolder("new folder");
    await v.reload(null);
    expect(v.folders.map((f) => f.id)).toContain("new folder");
  });
});

describe("metadata after the last save", () => {
  it("records a pinned note's new name even when the rename is the final write", async () => {
    const { be, v } = await open({ "old.md": "old" });
    const n = v.notes[0];
    v.togglePin(n);
    await v.flush();
    v.setBody(n, "new title\nbody");
    await v.flush(); // e.g. the window closing right after typing
    const meta = JSON.parse(be.files.get(".monkeynotes.json")!.body);
    expect(meta.pinned).toEqual(["new title.md"]);
  });
});

describe("folder rename failures", () => {
  it("tells the app so it can point the view back at the old name", async () => {
    const { be, v } = await open({ "projects/plan.md": "plan" });
    be.dirs.add("work");
    const reverted: [string, string][] = [];
    v.onError = () => {};
    v.onFolderRenameReverted = (from, to) => reverted.push([from, to]);
    v.renameFolder("projects", "work");
    await v.flush();
    expect(reverted).toEqual([["projects", "work"]]);
  });
});

describe("version history", () => {
  const MIN = 60 * 1000;
  async function clocked(seed: Record<string, string>) {
    const o = await open(seed);
    let t = 1_000_000_000;
    o.v.now = () => t;
    return { ...o, tick: (ms: number) => (t += ms) };
  }
  const bodies = (be: MemoryBackend, path: string) =>
    Object.entries(be.history[path] ?? {})
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([, body]) => body);

  it("keeps the text from before an editing session, then at most one version per 5 minutes", async () => {
    const { be, v, tick } = await clocked({ "plan.md": "plan\noriginal" });
    const n = v.notes[0];
    v.setBody(n, "plan\nedit 1");
    await v.flush();
    expect(bodies(be, "plan.md")).toEqual(["plan\noriginal"]);
    tick(MIN);
    v.setBody(n, "plan\nedit 2");
    await v.flush();
    expect(bodies(be, "plan.md")).toEqual(["plan\noriginal"]); // too soon for another
    tick(5 * MIN);
    v.setBody(n, "plan\nedit 3");
    await v.flush();
    expect(bodies(be, "plan.md")).toEqual(["plan\nedit 2", "plan\noriginal"]);
  });

  it("restoring keeps the replaced text as a version", async () => {
    const { be, v, tick } = await clocked({ "plan.md": "plan\noriginal" });
    const n = v.notes[0];
    v.setBody(n, "plan\noops, deleted everything");
    await v.flush();
    tick(MIN);
    const [at] = await v.versions(n);
    v.restoreVersion(n, await v.readVersion(n, at));
    await v.flush();
    expect(be.files.get("plan.md")?.body).toBe("plan\noriginal");
    expect(bodies(be, "plan.md")).toContain("plan\noops, deleted everything");
  });

  it("follows the note through renames, trash and folder renames, and goes when it's deleted", async () => {
    const { be, v } = await clocked({ "ideas/plan.md": "plan\noriginal" });
    const n = v.notes[0];
    v.setBody(n, "roadmap\nrenamed by its title");
    await v.flush();
    expect(Object.keys(be.history)).toEqual(["ideas/roadmap.md"]);
    v.renameFolder("ideas", "work");
    await v.flush();
    expect(Object.keys(be.history)).toEqual(["work/roadmap.md"]);
    v.trash(n);
    await v.flush();
    expect(Object.keys(be.history)).toEqual([".trash/roadmap.md"]);
    expect(await v.versions(n)).toHaveLength(1);
    v.destroy(n);
    await v.flush();
    expect(Object.keys(be.history)).toEqual([]);
  });

  it("never stores a version when nothing changed or the old text was empty", async () => {
    const { be, v } = await clocked({ "a.md": "" });
    v.setBody(v.notes[0], "a\nfirst words");
    await v.flush();
    expect(be.history).toEqual({});
  });
});

describe("starred folders", () => {
  it("are saved, follow renames and are dropped when the folder is deleted", async () => {
    const { be, v } = await open({ "projects/2026/plan.md": "plan", "work/a.md": "a" });
    v.toggleFolderStar("projects/2026");
    v.toggleFolderStar("work");
    await v.flush();
    const meta = () => JSON.parse(be.files.get(".monkeynotes.json")!.body).starredFolders;
    expect(meta()).toEqual(["projects/2026", "work"]);

    v.renameFolder("projects", "archive");
    await v.flush();
    expect(meta()).toEqual(["archive/2026", "work"]);

    v.deleteFolder("work");
    await v.flush();
    expect(meta()).toEqual(["archive/2026"]);

    const again = new Vault(be);
    await again.load();
    expect([...again.starredFolders]).toEqual(["archive/2026"]);
  });
});

describe("clearing version history", () => {
  async function withHistory() {
    const o = await open({ "a.md": "a", "work/b.md": "b", "work/sub/c.md": "c" });
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    for (const path of ["a.md", "work/b.md", "work/sub/c.md"]) {
      o.be.history[path] = { [now - 48 * hour]: "two days ago", [now - 2 * hour]: "two hours ago", [now - 60_000]: "a minute ago" };
    }
    return { ...o, now, hour };
  }
  const count = (be: MemoryBackend) => Object.values(be.history).reduce((n, h) => n + Object.keys(h).length, 0);

  it("counts without deleting on a dry run", async () => {
    const { be, v, now, hour } = await withHistory();
    expect(await v.clearHistory(null, now - 24 * hour, true)).toBe(6);
    expect(count(be)).toBe(9);
  });

  it("clears one note's recent versions only", async () => {
    const { be, v, now, hour } = await withHistory();
    const a = v.notes.find((n) => n.path === "a.md")!;
    expect(await v.clearHistory([a], now - hour)).toBe(1);
    expect(Object.values(be.history["a.md"])).toEqual(["two days ago", "two hours ago"]);
    expect(count(be)).toBe(8);
  });

  it("clears a folder including its subfolders, all time", async () => {
    const { be, v } = await withHistory();
    const inWork = v.notes.filter((n) => n.folderId === "work" || n.folderId.startsWith("work/"));
    expect(await v.clearHistory(inWork, null)).toBe(6);
    expect(Object.keys(be.history)).toEqual(["a.md"]);
  });

  it("clears everything", async () => {
    const { be, v } = await withHistory();
    expect(await v.clearHistory(null, null)).toBe(9);
    expect(be.history).toEqual({});
  });
});
