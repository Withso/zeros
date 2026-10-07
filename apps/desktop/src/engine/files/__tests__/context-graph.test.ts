// Contract tests for the context-graph module: scaffold idempotence (with no
// ignore rules written), the flat attachment layout and earlier builds'
// scopes, bounded listing with previews, archive selection, and the
// path-safety refusals.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { fstatSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ownership from "../cloud-workspace-ownership";

import {
  CONTEXT_GRAPH_DIR,
  contextGraphArchivePaths,
  contextGraphHasContent,
  ensureContextGraph,
  listContextGraph,
  safeAttachmentFilename,
  stageContextGraphAttachment,
} from "../context-graph";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "zeros-context-graph-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const graph = (...parts: string[]) =>
  path.join(root, CONTEXT_GRAPH_DIR, ...parts);

/** Seed a record in the current flat layout, or in an earlier build's scope. */
async function seedAttachment(
  scope: "flat" | "local" | "shared",
  id: string,
  name: string,
  body: string | Buffer,
): Promise<void> {
  const dir =
    scope === "flat"
      ? graph("attachments", id)
      : graph(scope, "attachments", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body);
}

describe("ensureContextGraph", () => {
  it.each([false, true])("removes an unused legacy staging scaffold (ignore file: %s)", async (ignore) => {
    const staging = graph(".attachment-staging");
    await fs.mkdir(staging, { recursive: true });
    if (ignore) await fs.writeFile(path.join(staging, ".gitignore"), "*\n");
    expect((await ensureContextGraph(root)).ok).toBe(true);
    await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "edited-ignore", "symlink"])("preserves legacy staging contents it cannot identify (%s)", async (kind) => {
    const staging = graph(".attachment-staging");
    const outside = path.join(root, "user-files");
    await fs.mkdir(outside);
    await fs.mkdir(path.dirname(staging), { recursive: true });
    if (kind === "symlink") await fs.symlink(outside, staging);
    else await fs.mkdir(staging);
    const keep = path.join(staging, kind === "file" ? "notes.txt" : ".gitignore");
    await fs.writeFile(keep, "user contents");
    expect((await ensureContextGraph(root)).ok).toBe(true);
    expect(await fs.readFile(keep, "utf8")).toBe("user contents");
  });

  it("creates only the attachments folder and writes no ignore rules", async () => {
    const first = await ensureContextGraph(root);
    expect(first).toEqual({ ok: true, created: true });
    expect((await fs.stat(graph("attachments"))).isDirectory()).toBe(true);
    // Whether `.context/` is committed is the repository's own choice.
    expect(await fs.readdir(graph())).toEqual(["attachments"]);
  });

  it("is idempotent and reports created: false the second time", async () => {
    await ensureContextGraph(root);
    const second = await ensureContextGraph(root);
    expect(second).toEqual({ ok: true, created: false });
  });

  it("leaves a user's own .context ignore file untouched", async () => {
    await fs.mkdir(graph(), { recursive: true });
    await fs.writeFile(graph(".gitignore"), "# mine\n/local/\n");
    await ensureContextGraph(root);
    expect(await fs.readFile(graph(".gitignore"), "utf8")).toBe(
      "# mine\n/local/\n",
    );
  });

  it("refuses when .context exists as a file", async () => {
    await fs.writeFile(path.join(root, CONTEXT_GRAPH_DIR), "not a dir");
    const res = await ensureContextGraph(root);
    expect(res.ok).toBe(false);
    expect(res.created).toBe(false);
  });
});

describe("listContextGraph", () => {
  it("reports exists: false before any scaffold", async () => {
    expect(await listContextGraph(root)).toEqual({
      exists: false,
      items: [],
      truncated: false,
    });
  });

  it("lists attachments with ids and agents' working files as docs", async () => {
    await ensureContextGraph(root);
    await seedAttachment("flat", "att-1", "notes.md", "# hello\nworld");
    await fs.mkdir(graph("plan-task", "drafts"), { recursive: true });
    await fs.writeFile(graph("plan-task", "plan.txt"), "the plan");
    await fs.writeFile(graph("plan-task", "drafts", "shot.png"), Buffer.from([1, 2]));
    await fs.writeFile(graph("loose.md"), "a loose note");

    const { exists, items, truncated } = await listContextGraph(root);
    expect(exists).toBe(true);
    expect(truncated).toBe(false);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));

    expect(byName["notes.md"]).toMatchObject({
      scope: "local",
      category: "attachment",
      attachmentId: "att-1",
      kind: "markdown",
      relPath: ".context/attachments/att-1/notes.md",
      previewText: "# hello\nworld",
    });
    expect(byName["plan.txt"]).toMatchObject({
      scope: "local",
      category: "doc",
      kind: "text",
      relPath: ".context/plan-task/plan.txt",
      previewText: "the plan",
    });
    expect(byName["plan.txt"].attachmentId).toBeUndefined();
    expect(byName["shot.png"]).toMatchObject({
      category: "doc",
      kind: "image",
      relPath: ".context/plan-task/drafts/shot.png",
    });
    expect(byName["shot.png"].previewText).toBeUndefined();
    expect(byName["loose.md"]).toMatchObject({
      category: "doc",
      relPath: ".context/loose.md",
    });
  });

  it("keeps listing records in earlier builds' local and shared scopes", async () => {
    await ensureContextGraph(root);
    await seedAttachment("local", "att-1", "notes.md", "# hello");
    await seedAttachment("shared", "att-2", "shot.png", Buffer.from([1, 2]));
    await fs.mkdir(graph("shared", "docs"), { recursive: true });
    await fs.writeFile(graph("shared", "docs", "plan.txt"), "the plan");
    await fs.writeFile(graph("local", ".gitignore"), "*\n");

    const { items } = await listContextGraph(root);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName["notes.md"]).toMatchObject({
      scope: "local",
      category: "attachment",
      attachmentId: "att-1",
      relPath: ".context/local/attachments/att-1/notes.md",
    });
    expect(byName["shot.png"]).toMatchObject({
      scope: "shared",
      category: "attachment",
      attachmentId: "att-2",
    });
    expect(byName["plan.txt"]).toMatchObject({
      scope: "shared",
      category: "doc",
      relPath: ".context/shared/docs/plan.txt",
    });
    // Earlier scaffolding never shows up as content.
    expect(byName[".gitignore"]).toBeUndefined();
    expect(items).toHaveLength(3);
  });

  it("hides private tool state and dot entries at the top of .context", async () => {
    await ensureContextGraph(root);
    await fs.mkdir(graph("zeros-dev"), { mode: 0o700 });
    await fs.writeFile(graph("zeros-dev", "owner.json"), "{}", { mode: 0o600 });
    await fs.writeFile(graph("token.json"), "secret", { mode: 0o600 });
    await fs.mkdir(graph(".cache"));
    await fs.writeFile(graph(".cache", "state.txt"), "cache");
    await fs.writeFile(graph(".gitignore"), "*\n");
    await fs.writeFile(graph("notes.md"), "visible");

    const { items } = await listContextGraph(root);
    expect(items.map((i) => i.relPath)).toEqual([".context/notes.md"]);
  });

  it("does not follow a symlinked entry out of .context", async () => {
    await ensureContextGraph(root);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, graph("linked"));
    expect((await listContextGraph(root)).items).toEqual([]);
  });

  it("sorts oldest-first by mtime so new items append instead of reshuffling", async () => {
    await ensureContextGraph(root);
    await seedAttachment("flat", "att-b", "second.txt", "2");
    await seedAttachment("flat", "att-a", "first.txt", "1");
    const early = new Date(Date.now() - 60_000);
    await fs.utimes(graph("attachments", "att-a", "first.txt"), early, early);
    const { items } = await listContextGraph(root);
    expect(items.map((i) => i.name)).toEqual(["first.txt", "second.txt"]);
  });

  it("skips binary-looking previews", async () => {
    await ensureContextGraph(root);
    await seedAttachment(
      "flat",
      "att-bin",
      "blob.txt",
      Buffer.from([104, 105, 0, 1, 2]),
    );
    const { items } = await listContextGraph(root);
    expect(items[0].previewText).toBeUndefined();
  });
});

describe("contextGraphHasContent", () => {
  it("is false for a bare scaffold and true once anything lands", async () => {
    await ensureContextGraph(root);
    expect(await contextGraphHasContent(root)).toBe(false);
    await seedAttachment("flat", "att-1", "notes.md", "hi");
    expect(await contextGraphHasContent(root)).toBe(true);
  });

  it("counts agents' working files and earlier builds' scopes", async () => {
    await ensureContextGraph(root);
    await fs.mkdir(graph("task", "nested"), { recursive: true });
    await fs.writeFile(graph("task", "nested", "plan.md"), "plan");
    expect(await contextGraphHasContent(root)).toBe(true);

    await fs.rm(graph("task"), { recursive: true });
    await seedAttachment("shared", "att-1", "notes.md", "hi");
    expect(await contextGraphHasContent(root)).toBe(true);
  });

  it("ignores private tool state and dot entries", async () => {
    await ensureContextGraph(root);
    await fs.mkdir(graph("zeros-dev"), { mode: 0o700 });
    await fs.writeFile(graph("zeros-dev", "owner.json"), "{}", { mode: 0o600 });
    await fs.writeFile(graph(".gitignore"), "*\n");
    expect(await contextGraphHasContent(root)).toBe(false);
  });

  it("short-circuits without opening text files for previews", async () => {
    await ensureContextGraph(root);
    await seedAttachment("flat", "att-1", "notes.md", "hi");
    const open = vi.spyOn(fs, "open");
    try {
      expect(await contextGraphHasContent(root)).toBe(true);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});

describe("contextGraphArchivePaths", () => {
  it.each(["", "task"])("preserves files after the listing entry limit under %s", async (parent) => {
    const directory = graph(parent);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 2_000 }, (_, i) =>
      fs.mkdir(path.join(directory, `empty-${String(i).padStart(4, "0")}`)),
    ));
    await fs.writeFile(path.join(directory, "zz-result.txt"), "keep this result");
    expect(await contextGraphHasContent(root)).toBe(true);
    expect(await contextGraphArchivePaths(root)).toContain(
      parent ? ".context/task" : ".context/zz-result.txt",
    );
  });

  it("preserves task files below the listing depth limit", async () => {
    const nested = graph("task", ...Array.from({ length: 7 }, () => "nested"));
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "result.txt"), "keep this result");
    expect(await listContextGraph(root)).toMatchObject({ items: [], truncated: true });
    expect(await contextGraphHasContent(root)).toBe(true);
    expect(await contextGraphArchivePaths(root)).toContain(".context/task");
  });

  it("archives nothing for a bare scaffold", async () => {
    await ensureContextGraph(root);
    expect(await contextGraphArchivePaths(root)).toEqual([]);
  });

  it("archives attachments, working files and earlier scopes but not private state", async () => {
    await ensureContextGraph(root);
    await seedAttachment("flat", "att-1", "notes.md", "hi");
    await seedAttachment("local", "att-0", "old.md", "old");
    await fs.mkdir(graph("plan-task"));
    await fs.writeFile(graph("plan-task", "plan.md"), "plan");
    await fs.writeFile(graph("report.html"), "<p>report</p>");
    await fs.mkdir(graph("zeros-dev"), { mode: 0o700 });
    await fs.writeFile(graph("zeros-dev", "owner.json"), "{}", { mode: 0o600 });
    await fs.mkdir(graph(".cache"));
    await fs.writeFile(graph(".cache", "state.txt"), "cache");

    const paths = await contextGraphArchivePaths(root);
    expect(paths).toEqual(
      expect.arrayContaining([
        ".context/attachments",
        ".context/local",
        ".context/plan-task",
        ".context/report.html",
      ]),
    );
    expect(paths).not.toContain(".context/shared");
    expect(paths).not.toContain(".context/zeros-dev");
    expect(paths).not.toContain(".context/.cache");
    expect(paths).not.toContain(".context");
  });
});

describe("stageContextGraphAttachment", () => {
  it("publishes the admitted parent and renamed attachment by its still-open descriptor", async () => {
    const published: string[] = [];
    const original = ownership.publishCloudWorkspacePath;
    vi.spyOn(ownership, "publishCloudWorkspacePath").mockImplementation((target, fd) => {
      if (fd !== undefined) {
        const pinned = fstatSync(fd), current = statSync(target);
        expect(pinned.nlink).toBe(1);
        expect([pinned.dev, pinned.ino]).toEqual([current.dev, current.ino]);
        expect(target).toBe(graph("attachments", "att-1", "notes.txt"));
      }
      published.push(target);
      original(target, fd);
    });
    expect(await stageContextGraphAttachment(root, {
      attachmentId: "att-1", base64: Buffer.from("hello").toString("base64"), filename: "notes.txt",
    })).toMatchObject({ ok: true });
    expect(published).toContain(graph("attachments", "att-1"));
    expect(published).toContain(graph("attachments", "att-1", "notes.txt"));
    expect(published.every(target => target.startsWith(graph() + path.sep))).toBe(true);
  });

  it("scaffolds on demand and writes to .context/attachments/<id>/", async () => {
    const res = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("hello").toString("base64"),
      filename: "notes.txt",
    });
    expect(res.ok).toBe(true);
    expect(res.relativePath).toBe(
      path.join(".context", "attachments", "att-1", "notes.txt"),
    );
    expect(
      await fs.readFile(graph("attachments", "att-1", "notes.txt"), "utf8"),
    ).toBe("hello");
    expect(await fs.readdir(graph())).toEqual(["attachments"]);
  });

  it.each(["shared", "local"] as const)(
    "keeps a record an earlier build wrote under %s/ in its folder",
    async (scope) => {
      // A draft attached before the upgrade still names the scoped path. The
      // send-time re-write must not leave a second copy beside it.
      await seedAttachment(scope, "att-1", "notes.txt", "hello");
      const res = await stageContextGraphAttachment(root, {
        attachmentId: "att-1",
        base64: Buffer.from("hello").toString("base64"),
        filename: "notes.txt",
      });
      expect(res).toMatchObject({
        ok: true,
        skipped: true,
        relativePath: path.join(".context", scope, "attachments", "att-1", "notes.txt"),
      });
      await expect(fs.lstat(graph("attachments", "att-1"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("prefers the current folder when the id also exists in an earlier scope", async () => {
    await seedAttachment("flat", "att-1", "notes.txt", "hello");
    await seedAttachment("local", "att-1", "notes.txt", "older copy");
    const res = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("hello").toString("base64"),
      filename: "notes.txt",
    });
    expect(res.relativePath).toBe(
      path.join(".context", "attachments", "att-1", "notes.txt"),
    );
    expect(
      await fs.readFile(graph("local", "attachments", "att-1", "notes.txt"), "utf8"),
    ).toBe("older copy");
  });

  it("skips the write (and keeps mtime) when the same bytes are already there", async () => {
    const first = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("hello").toString("base64"),
      filename: "notes.txt",
    });
    expect(first.skipped).toBeUndefined();
    const file = graph("attachments", "att-1", "notes.txt");
    const before = await fs.stat(file);
    await new Promise((r) => setTimeout(r, 20));
    const second = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("hello").toString("base64"),
      filename: "notes.txt",
    });
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("refreshes an existing same-length file when its bytes differ", async () => {
    await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("hello").toString("base64"),
      filename: "notes.txt",
    });
    const file = graph("attachments", "att-1", "notes.txt");
    await fs.writeFile(file, "jello");

    const refreshed = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("hello").toString("base64"),
      filename: "notes.txt",
    });

    expect(refreshed.ok).toBe(true);
    expect(refreshed.skipped).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).toBe("hello");
  });

  it("sanitises hostile filenames into the attachment folder", async () => {
    const res = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("x").toString("base64"),
      filename: "../../../etc/passwd",
    });
    expect(res.ok).toBe(true);
    expect(res.absolutePath).toContain(path.join("attachments", "att-1"));
    // basename → "passwd"; nothing escaped the folder.
    const entries = await fs.readdir(graph("attachments", "att-1"));
    expect(entries).toEqual(["passwd"]);
  });

  it("parks a name that sanitises to nothing on a constant", () => {
    expect(safeAttachmentFilename("///")).toBe("attachment");
    expect(safeAttachmentFilename("..")).toBe("attachment");
    // Non-ASCII collapses to underscores (pre-existing policy) but keeps any
    // ASCII extension: "日本語.png" → "_.png"; a bare "日本語" → "_".
    expect(safeAttachmentFilename("日本語.png")).toBe("_.png");
    expect(safeAttachmentFilename("ok name.png")).toBe("ok_name.png");
  });

  it("preserves an image extension when a long attachment name is capped", () => {
    const safeName = safeAttachmentFilename(`${"a".repeat(100)}.png`);

    expect(safeName).toHaveLength(80);
    expect(safeName).toBe(`${"a".repeat(76)}.png`);
  });

  it("rejects traversal-shaped ids outright", async () => {
    for (const id of ["../escape", "a/b", ".", "..", ""]) {
      const res = await stageContextGraphAttachment(root, {
        attachmentId: id,
        base64: "aGk=",
        filename: "a.txt",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("invalid attachment id");
    }
  });

  it("replaces a symlink squatting at the write path instead of following it", async () => {
    // The post-attach path is predictable, so a hostile in-worktree process
    // could plant a link there before the send-time re-write. writeFile
    // follows symlinks; the stage must unlink the squatter, not its target.
    await ensureContextGraph(root);
    const target = path.join(root, "precious.txt");
    await fs.writeFile(target, "keep me");
    const dir = graph("attachments", "att-1");
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(target, path.join(dir, "notes.txt"));
    const res = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("new bytes").toString("base64"),
      filename: "notes.txt",
    });
    expect(res.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("keep me");
    const written = await fs.lstat(path.join(dir, "notes.txt"));
    expect(written.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(dir, "notes.txt"), "utf8")).toBe(
      "new bytes",
    );
  });

  it("leaves a PRE-EXISTING two-scope divergence alone", async () => {
    // An id hand-copied into both earlier scopes: the write refreshes the
    // shared copy (the one a share action moved) and never deletes the other.
    await seedAttachment("local", "att-1", "notes.txt", "local copy");
    await seedAttachment("shared", "att-1", "notes.txt", "shared copy");
    const res = await stageContextGraphAttachment(root, {
      attachmentId: "att-1",
      base64: Buffer.from("shared copy").toString("base64"),
      filename: "notes.txt",
    });
    expect(res.ok).toBe(true);
    expect(res.relativePath).toBe(
      path.join(".context", "shared", "attachments", "att-1", "notes.txt"),
    );
    expect(
      await fs.readFile(graph("local", "attachments", "att-1", "notes.txt"), "utf8"),
    ).toBe("local copy");
  });
});
