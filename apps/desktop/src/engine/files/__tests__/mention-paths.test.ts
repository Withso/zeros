import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listMentionPaths } from "../mention-paths";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "zeros-mention-index-"));
  await fs.mkdir(path.join(root, ".context/attachments"), { recursive: true });
  await fs.writeFile(path.join(root, ".context/attachments/rollout.jsonl"), "");
  vi.mocked(fs.readdir).mockClear();
});
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(fs.readdir).mockImplementation(actual.readdir);
  await fs.rm(root, { recursive: true, force: true });
});

describe("mention filesystem index", () => {
  it("streams an oversized tree without hiding matches beyond the index budget", async () => {
    const file = {
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const entries = Array.from({ length: 100_000 }, (_, i) => ({
      ...file,
      name: `${String(i).padStart(6, "0")}-${"x".repeat(90)}`,
    }));
    entries.push({ ...file, name: "wanted.jsonl" });
    vi.mocked(fs.readdir).mockResolvedValue(
      entries as unknown as Awaited<ReturnType<typeof fs.readdir>>,
    );
    expect(await listMentionPaths(root, "wanted", 1, "oversized")).toEqual([
      "wanted.jsonl",
    ]);
    expect(fs.readdir).toHaveBeenCalledTimes(2);
    expect(
      await listMentionPaths(root, "wanted.jsonl", 1, "oversized"),
    ).toEqual(["wanted.jsonl"]);
    // The same revision remembers that indexing is unsuitable and goes
    // straight to one streaming search, rather than retrying the failed build.
    expect(fs.readdir).toHaveBeenCalledTimes(3);
  });

  it("warms once and searches new queries without enumerating directories again", async () => {
    await Promise.all(
      Array.from({ length: 70 }, (_, i) =>
        fs.writeFile(path.join(root, `shallow-${i}.txt`), ""),
      ),
    );
    await listMentionPaths(root, "", 64, "revision-1");
    expect(await listMentionPaths(root, "rollout", 1, "revision-1")).toEqual([
      ".context/attachments/rollout.jsonl",
    ]);
    const reads = vi.mocked(fs.readdir).mock.calls.length;
    await listMentionPaths(root, "attach", 64, "revision-1");
    expect(fs.readdir).toHaveBeenCalledTimes(reads);
  });

  it("shares one cold traversal across concurrent query and limit variants", async () => {
    const results = await Promise.all([
      listMentionPaths(root, "rollout", 1, "revision-1"),
      listMentionPaths(root, "attach", 64, "revision-1"),
      listMentionPaths(root, "", 8, "revision-1"),
    ]);
    expect(results[0]).toEqual([".context/attachments/rollout.jsonl"]);
    expect(fs.readdir).toHaveBeenCalledTimes(3);
  });

  it("returns bare @ before a slow deep directory finishes, without a second walk", async () => {
    await Promise.all(
      Array.from({ length: 70 }, (_, i) =>
        fs.writeFile(path.join(root, `shallow-${i}.txt`), ""),
      ),
    );
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.readdir).mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(root, ".context")) {
        started();
        await gate;
      }
      return actual.readdir(...args);
    });
    let preview: string[] | undefined;
    const bare = listMentionPaths(root, "", 64, "revision-1").then((paths) => {
      preview = paths;
    });
    const deep = listMentionPaths(root, "rollout", 1, "revision-1");
    try {
      await reading;
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(preview).toHaveLength(64);
      expect(preview?.every((path) => path.startsWith("shallow-"))).toBe(true);
    } finally {
      release();
      await bare;
      await deep;
      vi.mocked(fs.readdir).mockImplementation(actual.readdir);
    }
    expect(await deep).toEqual([".context/attachments/rollout.jsonl"]);
    expect(fs.readdir).toHaveBeenCalledTimes(3);
  });

  it("rebuilds after a revision change and then reuses the new snapshot", async () => {
    await listMentionPaths(root, "rollout", 64, "revision-1");
    await fs.rm(path.join(root, ".context/attachments/rollout.jsonl"));
    await fs.writeFile(path.join(root, ".context/attachments/new.txt"), "");
    expect(await listMentionPaths(root, "rollout", 64, "revision-2")).toEqual(
      [],
    );
    const reads = vi.mocked(fs.readdir).mock.calls.length;
    expect(await listMentionPaths(root, "new.txt", 64, "revision-2")).toEqual([
      ".context/attachments/new.txt",
    ]);
    expect(fs.readdir).toHaveBeenCalledTimes(reads);
  });

  it("does not alternate scans between two unchanged renderer revisions", async () => {
    await listMentionPaths(root, "roll", 64, "window-a");
    await listMentionPaths(root, "roll", 64, "window-b");
    const reads = vi.mocked(fs.readdir).mock.calls.length;
    await listMentionPaths(root, "attach", 64, "window-a");
    await listMentionPaths(root, "context", 64, "window-b");
    expect(fs.readdir).toHaveBeenCalledTimes(reads);
  });

  it("rejects a scan's stale generation and shares one replacement after changes", async () => {
    await fs.writeFile(path.join(root, "old.txt"), "");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.readdir).mockImplementationOnce(async (...args) => {
      const entries = await actual.readdir(...args);
      started();
      await gate;
      return entries;
    });
    const old = listMentionPaths(root, "old.txt", 64, "revision-1");
    await reading;
    await fs.rm(path.join(root, "old.txt"));
    await fs.writeFile(path.join(root, "new.txt"), "");
    const newer = listMentionPaths(root, "new.txt", 64, "revision-2");
    const newest = listMentionPaths(root, "new.txt", 1, "revision-3");
    release();
    expect(await old).toEqual([]);
    expect(await newer).toEqual(["new.txt"]);
    expect(await newest).toEqual(["new.txt"]);
    expect(fs.readdir).toHaveBeenCalledTimes(6);
  });

  it("bounds retained workspaces and never mixes roots that share a revision", async () => {
    await listMentionPaths(root, "rollout", 64, "revision-1");
    for (let i = 0; i < 5; i++) {
      const sibling = path.join(root, `workspace-${i}`);
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, "other.txt"), "");
      expect(
        await listMentionPaths(sibling, "rollout", 64, "revision-1"),
      ).toEqual([]);
    }
    const reads = vi.mocked(fs.readdir).mock.calls.length;
    expect(await listMentionPaths(root, "rollout", 64, "revision-1")).toEqual([
      ".context/attachments/rollout.jsonl",
    ]);
    expect(vi.mocked(fs.readdir).mock.calls.length).toBeGreaterThan(reads);
  });
});
