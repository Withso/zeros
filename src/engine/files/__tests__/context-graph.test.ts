// Contract tests for the context-graph module: scaffold idempotence, the
// gitignore split (local private / shared committed), bounded listing with
// previews, the share toggle's move semantics, and the path-safety refusals.

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONTEXT_GRAPH_DIR,
  contextGraphHasContent,
  ensureContextGraph,
  listContextGraph,
  setContextGraphAttachmentShared,
} from "../context-graph";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "zeros-context-graph-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const graph = (...parts: string[]) =>
  path.join(root, CONTEXT_GRAPH_DIR, ...parts);

async function seedAttachment(
  scope: "local" | "shared",
  id: string,
  name: string,
  body: string | Buffer,
): Promise<void> {
  const dir = graph(scope, "attachments", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body);
}

describe("ensureContextGraph", () => {
  it("creates both scopes, their attachments dirs, and the gitignore", async () => {
    const first = await ensureContextGraph(root);
    expect(first).toEqual({ ok: true, created: true });
    for (const p of [
      graph("local", "attachments"),
      graph("shared", "attachments"),
    ]) {
      const stat = await fs.stat(p);
      expect(stat.isDirectory()).toBe(true);
    }
    const ignore = await fs.readFile(graph(".gitignore"), "utf8");
    // `local/` is the private scope; the gitignore self-ignores so an empty
    // scaffold produces ZERO `git status` noise.
    expect(ignore).toContain("/local/");
    expect(ignore).toContain("/.gitignore");
    expect(ignore).not.toContain("/shared/");
  });

  it("is idempotent and reports created: false the second time", async () => {
    await ensureContextGraph(root);
    const second = await ensureContextGraph(root);
    expect(second).toEqual({ ok: true, created: false });
  });

  it("does not clobber a user-edited gitignore", async () => {
    await ensureContextGraph(root);
    await fs.writeFile(graph(".gitignore"), "# mine\n/local/\n");
    await ensureContextGraph(root);
    expect(await fs.readFile(graph(".gitignore"), "utf8")).toBe(
      "# mine\n/local/\n",
    );
  });

  it("refuses when .context-graph exists as a file", async () => {
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

  it("lists attachments from both scopes with ids, and docs without", async () => {
    await ensureContextGraph(root);
    await seedAttachment("local", "att-1", "notes.md", "# hello\nworld");
    await seedAttachment("shared", "att-2", "shot.png", Buffer.from([1, 2]));
    await fs.mkdir(graph("shared", "docs"), { recursive: true });
    await fs.writeFile(graph("shared", "docs", "plan.txt"), "the plan");

    const { exists, items, truncated } = await listContextGraph(root);
    expect(exists).toBe(true);
    expect(truncated).toBe(false);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));

    expect(byName["notes.md"]).toMatchObject({
      scope: "local",
      category: "attachment",
      attachmentId: "att-1",
      kind: "markdown",
      relPath: ".context-graph/local/attachments/att-1/notes.md",
      previewText: "# hello\nworld",
    });
    expect(byName["shot.png"]).toMatchObject({
      scope: "shared",
      category: "attachment",
      attachmentId: "att-2",
      kind: "image",
    });
    expect(byName["shot.png"].previewText).toBeUndefined();
    expect(byName["plan.txt"]).toMatchObject({
      scope: "shared",
      category: "doc",
      kind: "text",
      previewText: "the plan",
    });
    expect(byName["plan.txt"].attachmentId).toBeUndefined();
    // The scaffolding itself never shows up as content.
    expect(byName[".gitignore"]).toBeUndefined();
  });

  it("sorts oldest-first by mtime so new items append instead of reshuffling", async () => {
    await ensureContextGraph(root);
    await seedAttachment("local", "att-b", "second.txt", "2");
    await seedAttachment("local", "att-a", "first.txt", "1");
    const early = new Date(Date.now() - 60_000);
    await fs.utimes(
      graph("local", "attachments", "att-a", "first.txt"),
      early,
      early,
    );
    const { items } = await listContextGraph(root);
    expect(items.map((i) => i.name)).toEqual(["first.txt", "second.txt"]);
  });

  it("skips binary-looking previews", async () => {
    await ensureContextGraph(root);
    await seedAttachment(
      "local",
      "att-bin",
      "blob.txt",
      Buffer.from([104, 105, 0, 1, 2]),
    );
    const { items } = await listContextGraph(root);
    expect(items[0].previewText).toBeUndefined();
  });
});

describe("setContextGraphAttachmentShared", () => {
  it("moves an attachment folder local → shared and back", async () => {
    await ensureContextGraph(root);
    await seedAttachment("local", "att-1", "notes.md", "hi");

    const share = await setContextGraphAttachmentShared(root, "att-1", true);
    expect(share).toEqual({ ok: true, moved: true });
    await expect(
      fs.stat(graph("shared", "attachments", "att-1", "notes.md")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(graph("local", "attachments", "att-1")),
    ).rejects.toThrow();

    const unshare = await setContextGraphAttachmentShared(root, "att-1", false);
    expect(unshare).toEqual({ ok: true, moved: true });
    await expect(
      fs.stat(graph("local", "attachments", "att-1", "notes.md")),
    ).resolves.toBeTruthy();
  });

  it("is idempotent when the attachment is already in the requested scope", async () => {
    await ensureContextGraph(root);
    await seedAttachment("shared", "att-1", "notes.md", "hi");
    expect(await setContextGraphAttachmentShared(root, "att-1", true)).toEqual({
      ok: true,
      moved: false,
    });
  });

  it("refuses to clobber when both scopes hold the id", async () => {
    await ensureContextGraph(root);
    await seedAttachment("local", "att-1", "a.txt", "local copy");
    await seedAttachment("shared", "att-1", "a.txt", "shared copy");
    const res = await setContextGraphAttachmentShared(root, "att-1", true);
    expect(res.ok).toBe(false);
    expect(res.moved).toBe(false);
    // Neither copy was touched.
    expect(
      await fs.readFile(graph("local", "attachments", "att-1", "a.txt"), "utf8"),
    ).toBe("local copy");
    expect(
      await fs.readFile(
        graph("shared", "attachments", "att-1", "a.txt"),
        "utf8",
      ),
    ).toBe("shared copy");
  });

  it("reports a missing attachment", async () => {
    await ensureContextGraph(root);
    const res = await setContextGraphAttachmentShared(root, "att-none", true);
    expect(res.ok).toBe(false);
  });

  it("rejects traversal-shaped ids outright", async () => {
    await ensureContextGraph(root);
    for (const id of ["../escape", "a/b", ".", "..", "", "a".repeat(200)]) {
      const res = await setContextGraphAttachmentShared(root, id, true);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("invalid attachment id");
    }
  });
});

describe("contextGraphHasContent", () => {
  it("is false for a bare scaffold and true once anything lands", async () => {
    await ensureContextGraph(root);
    expect(await contextGraphHasContent(root)).toBe(false);
    await seedAttachment("local", "att-1", "notes.md", "hi");
    expect(await contextGraphHasContent(root)).toBe(true);
  });
});
