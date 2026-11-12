import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveContext, ARCHIVED_CONTEXT_LIMITS } from "../archived-contexts";

describe("visible archived contexts", () => {
  let root: string, source: string, channel: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "zeros-context-archive-")));
    source = path.join(root, "checkout"); channel = path.join(root, "zeros-alpha");
    await mkdir(path.join(source, ".context"), { recursive: true });
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const limits = { ...ARCHIVED_CONTEXT_LIMITS, files: 3, bytes: 12, totalBytes: 24 };
  const copy = (extra: Partial<Parameters<typeof archiveContext>[0]> = {}, budget = limits) => archiveContext({
    sourceRoot: source, channelRoot: channel, repository: "repo", workspace: "w-7", identity: "local:workspace-7", ...extra,
  }, budget);

  it("copies regular files in byte order, skips attachments and links, and leaves the source untouched", async () => {
    await mkdir(path.join(source, ".context", "attachments"));
    await writeFile(path.join(source, ".context", "attachments", "private.txt"), "excluded");
    await writeFile(path.join(source, ".context", "notes.md"), "notes");
    await writeFile(path.join(root, "outside"), "never copy");
    await symlink(path.join(root, "outside"), path.join(source, ".context", "alias"));
    await symlink(root, path.join(source, ".context", "linked-directory"));
    const result = await copy();
    expect(result).toMatchObject({ files: 1, bytes: 5, limited: false, path: path.join(channel, "archived-contexts", "repo", "w-7") });
    expect(await readdir(result!.path)).toEqual(["notes.md"]);
    expect(await readFile(path.join(result!.path, "notes.md"), "utf8")).toBe("notes");
    expect(await readFile(path.join(source, ".context", "attachments", "private.txt"), "utf8")).toBe("excluded");
  });

  it("bounds files and bytes independently and replaces an earlier copy only after the new one is ready", async () => {
    for (const name of ["c", "a", "b", "d"]) await writeFile(path.join(source, ".context", name), "four");
    const first = await copy();
    expect(first).toMatchObject({ files: 3, bytes: 12, limited: true });
    expect(await readdir(first!.path)).toEqual(["a", "b", "c"]);
    await rm(path.join(source, ".context", "a"));
    const next = await copy({}, { ...limits, bytes: 8 });
    expect(next).toMatchObject({ files: 2, bytes: 8, limited: true, path: first!.path });
    expect(await readdir(next!.path)).toEqual(["b", "c"]);
  });

  it("copies a file across several bounded reads without truncating or repeating bytes", async () => {
    const content = Buffer.alloc(200_001);
    for (let index = 0; index < content.length; index++) content[index] = index % 251;
    await writeFile(path.join(source, ".context", "capture.bin"), content);
    const result = await copy({}, { ...limits, bytes: 300_000, totalBytes: 300_000 });
    expect(await readFile(path.join(result!.path, "capture.bin"))).toEqual(content);
    expect(result).toMatchObject({ files: 1, bytes: content.length, limited: false });
  });

  it("does not overwrite another owner's same-name archive or an existing unowned folder", async () => {
    await writeFile(path.join(source, ".context", "notes"), "first");
    const first = await copy();
    await writeFile(path.join(source, ".context", "notes"), "second");
    const second = await copy({ identity: "cloud:account:org-b:workspace-7" });
    expect(second!.path).not.toBe(first!.path);
    expect(await readFile(path.join(first!.path, "notes"), "utf8")).toBe("first");
    expect(await readFile(path.join(second!.path, "notes"), "utf8")).toBe("second");
    expect((await copy({ identity: "cloud:account:org-b:workspace-7" }))!.path).toBe(second!.path);
    const occupied = path.join(channel, "archived-contexts", "repo", "occupied");
    await mkdir(occupied); await writeFile(path.join(occupied, "mine"), "user file");
    expect((await copy({ workspace: "occupied" }))!.path).not.toBe(occupied);
    expect(await readFile(path.join(occupied, "mine"), "utf8")).toBe("user file");
  });

  it("evicts oldest complete copies first within this channel's total budget", async () => {
    await writeFile(path.join(source, ".context", "notes"), "12345678");
    const first = await copy({ identity: "first", workspace: "first", archivedAt: 1 });
    const second = await copy({ identity: "second", workspace: "second", archivedAt: 2 });
    const newest = await copy({ identity: "newest", workspace: "newest", archivedAt: 3 }, { ...limits, totalBytes: 16 });
    await expect(readFile(path.join(first!.path, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(second!.path, "notes"), "utf8")).toBe("12345678");
    expect(await readFile(path.join(newest!.path, "notes"), "utf8")).toBe("12345678");
  });

  it("counts edits in older copies against retention and leaves a different channel alone", async () => {
    await writeFile(path.join(source, ".context", "notes"), "12345678");
    const first = await copy({ identity: "first", workspace: "first", archivedAt: 1 });
    const beta = await copy({ channelRoot: path.join(root, "zeros-beta") });
    await writeFile(path.join(first!.path, "notes"), "x".repeat(21));
    await copy({ identity: "new", workspace: "new", archivedAt: 2 });
    await expect(readFile(path.join(first!.path, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(beta!.path, "notes"), "utf8")).toBe("12345678");
  });

  it("keeps the copy just published even when its cloud archive time predates the retained copies", async () => {
    await writeFile(path.join(source, ".context", "notes"), "12345678");
    const first = await copy({ identity: "first", workspace: "first", archivedAt: 20 });
    const second = await copy({ identity: "second", workspace: "second", archivedAt: 30 });
    const published = await copy({ identity: "late-mirror", workspace: "late-mirror", archivedAt: 10 }, { ...limits, totalBytes: 16 });

    expect(await readFile(path.join(published!.path, "notes"), "utf8")).toBe("12345678");
    await expect(readFile(path.join(first!.path, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(second!.path, "notes"), "utf8")).toBe("12345678");
  });

  it("rolls back a failed replacement and serializes concurrent publishers for retention", async () => {
    await writeFile(path.join(source, ".context", "notes"), "first");
    const first = await copy({ archivedAt: 1 });
    await writeFile(path.join(source, ".context", "notes"), "later");
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.basename(String(from)).startsWith(".pending-") && path.basename(String(to)) === "w-7")
        throw new Error("injected rename failure");
      return rename(from, to);
    });
    await expect(copy()).rejects.toThrow("injected rename failure");
    expect(await readFile(path.join(first!.path, "notes"), "utf8")).toBe("first");
    vi.restoreAllMocks();
    const [a, b] = await Promise.all([
      copy({ identity: "a", workspace: "a", archivedAt: 10 }, { ...limits, totalBytes: 5 }),
      copy({ identity: "b", workspace: "b", archivedAt: 20 }, { ...limits, totalBytes: 5 }),
    ]);
    const copies = await Promise.all([a, b].map(item => readFile(path.join(item!.path, "notes"), "utf8").catch(() => null)));
    expect(copies.filter(value => value !== null)).toEqual(["later"]);
  });

  it("refuses symlinked source or destination parents and never writes outside the channel", async () => {
    await writeFile(path.join(source, ".context", "notes"), "notes");
    await mkdir(channel, { recursive: true });
    await mkdir(path.join(root, "foreign"));
    await symlink(path.join(root, "foreign"), path.join(channel, "archived-contexts"));
    await expect(copy()).rejects.toThrow();
    expect(await readdir(path.join(root, "foreign"))).toEqual([]);
    await rm(path.join(channel, "archived-contexts"));
    await symlink(source, path.join(root, "source-link"));
    await expect(copy({ sourceRoot: path.join(root, "source-link") })).rejects.toThrow();
  });

  it("keeps the previous copy when the captured owner is no longer current", async () => {
    await writeFile(path.join(source, ".context", "notes"), "first");
    const first = await copy();
    await writeFile(path.join(source, ".context", "notes"), "later");
    await expect(copy({ isCurrent: () => false })).rejects.toThrow();
    expect(await readFile(path.join(first!.path, "notes"), "utf8")).toBe("first");
  });

  it.each([false, true])("recovers interrupted publication before retention (published %s)", async (published) => {
    await writeFile(path.join(source, ".context", "notes"), "first");
    const first = await copy({ archivedAt: 1 });
    const records = path.join(channel, "archived-contexts", ".records");
    const recordName = (await readdir(records))[0]!;
    const receipt = JSON.parse(await readFile(path.join(records, recordName), "utf8"));
    const stagedName = ".pending-11111111-1111-4111-8111-111111111111";
    const repository = path.dirname(first!.path), staged = path.join(repository, stagedName);
    await mkdir(staged); await writeFile(path.join(staged, "notes"), "after");
    await writeFile(path.join(records, stagedName), JSON.stringify({ ...receipt, archivedAt: 2 }));
    await fs.rename(first!.path, path.join(repository, `.previous-${receipt.key}`));
    if (published) await fs.rename(staged, first!.path);

    await copy({ identity: "trigger", workspace: "trigger", archivedAt: 3 });
    expect(await readFile(path.join(first!.path, "notes"), "utf8")).toBe(published ? "after" : "first");
    expect((await readdir(repository)).some(name => name.startsWith(".pending-") || name.startsWith(".previous-"))).toBe(false);
    expect((await readdir(records)).some(name => name.startsWith(".pending-"))).toBe(false);
  });
});
