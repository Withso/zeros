import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  contextGraphArchivePaths,
  contextGraphHasContent,
  ensureContextGraph,
  listContextGraph,
  setContextGraphAttachmentShared,
  stageContextGraphAttachment,
} from "../context-graph";
import { snapshotWorkingTree } from "../../git/turns-git";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-context-migration-"));
  execFileSync("git", ["init", "-q", root]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function put(relative: string, contents = "keep me") {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents);
  return absolute;
}
const read = (relative: string) =>
  fs.readFile(path.join(root, relative), "utf8");
const status = () =>
  execFileSync("git", ["-C", root, "status", "--porcelain", "-uall"], {
    encoding: "utf8",
  });

describe(".context directory compatibility", () => {
  it("keeps the content probe read-only for a symlinked context root", async () => {
    const elsewhere = await put("other/local/notes.md", "outside context");
    await fs.symlink(
      path.dirname(path.dirname(elsewhere)),
      path.join(root, ".context"),
    );
    await expect(contextGraphHasContent(root)).resolves.toBe(false);
  });

  it("refuses archive provenance that escapes the context directory", async () => {
    await put(
      ".context/local/.zeros-context-migration/archive-paths/invalid.json",
      JSON.stringify({ version: 1, path: "../sentinel.txt" }),
    );
    await expect(contextGraphArchivePaths(root)).rejects.toThrow(
      /invalid context migration record/,
    );
  });

  it("keeps legacy files visible and archivable when they collide with the new metadata directory", async () => {
    await put(
      ".context-graph/local/.zeros-context-migration/notes.md",
      "legacy document",
    );
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect((await listContextGraph(root)).items).toEqual([
      expect.objectContaining({
        name: "notes.md",
        previewText: "legacy document",
      }),
    ]);
    expect(await contextGraphArchivePaths(root)).toContain(".context-graph");
  });

  it("refuses a recovery record that would restore outside the legacy directory", async () => {
    const recovery =
      ".context/local/.zeros-context-migration/recovery/move-test";
    await put(
      `${recovery}/record.json`,
      JSON.stringify({ version: 1, path: "local/../../sentinel.txt" }),
    );
    await put(`${recovery}/file`, "private contents");
    expect(await ensureContextGraph(root)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid context migration record/),
    });
    expect(await read(`${recovery}/file`)).toBe("private contents");
    await expect(
      fs.lstat(path.join(root, "sentinel.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an atomic save between copying and removing a legacy file", async () => {
    const source = await put(".context-graph/local/doc.md", "old version");
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      await link(from, to);
      if (String(to) === path.join(root, ".context/local/doc.md")) {
        await fs.writeFile(`${source}.save`, "new version");
        await fs.rename(`${source}.save`, source);
      }
    });

    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect(await read(".context-graph/local/doc.md")).toBe("new version");
    expect(await read(".context/local/doc.md")).toBe("old version");
  });

  it("leaves a save at the original name intact after the removal claim", async () => {
    const source = await put(".context-graph/local/doc.md", "old version");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === source) await fs.writeFile(source, "new version");
    });
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect(await read(".context-graph/local/doc.md")).toBe("new version");
    expect(await read(".context/local/doc.md")).toBe("old version");
  });

  it.each([false, true])(
    "recovers an interrupted removal with a replacement: %s",
    async (replace) => {
      const source = await put(".context-graph/local/doc.md", "old version");
      const link = fs.link.bind(fs);
      if (replace) {
        vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
          await link(from, to);
          if (String(to) === path.join(root, ".context/local/doc.md")) {
            await fs.writeFile(`${source}.save`, "new version");
            await fs.rename(`${source}.save`, source);
          }
        });
      }
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (String(from) === source)
          throw Object.assign(new Error("process stopped"), { code: "EIO" });
      });
      expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await read(".context/local/doc.md")).toBe("old version");
      vi.restoreAllMocks();

      expect(await ensureContextGraph(root)).toMatchObject({ ok: !replace });
      if (replace)
        expect(await fs.readFile(source, "utf8")).toBe("new version");
      // Recovery records do not appear as extra context cards.
      expect((await listContextGraph(root)).items).toHaveLength(
        replace ? 2 : 1,
      );
    },
  );

  it("archives a captured replacement when another save occupies the original name", async () => {
    const source = await put(".context-graph/local/doc.md", "old version");
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      await link(from, to);
      if (String(to) === path.join(root, ".context/local/doc.md")) {
        await fs.writeFile(`${source}.save`, "captured version");
        await fs.rename(`${source}.save`, source);
      }
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === source) await fs.writeFile(source, "latest version");
    });
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect(await read(".context/local/doc.md")).toBe("old version");
    expect(await read(".context-graph/local/doc.md")).toBe("latest version");
    const ref = "refs/zeros-review/context-recovery";
    expect(
      await snapshotWorkingTree(root, ref, {
        forceAddPaths: await contextGraphArchivePaths(root),
      }),
    ).toBeTruthy();
    const paths = execFileSync(
      "git",
      ["-C", root, "ls-tree", "-rz", "--name-only", ref],
      { encoding: "utf8" },
    ).split("\0");
    const recovered = paths.find(
      (file) => file.includes("/recovery/") && file.endsWith("/file"),
    );
    expect(recovered).toBeTruthy();
    expect(
      execFileSync("git", ["-C", root, "show", `${ref}:${recovered}`], {
        encoding: "utf8",
      }),
    ).toBe("captured version");
  });

  it("archives migrated root files without including neighboring scratch files", async () => {
    await put(".context/scratch.md", "unrelated scratch");
    await put(".context/docs/scratch.md", "unrelated nested scratch");
    await put(".context-graph/overview.md", "root document");
    await put(".context-graph/docs/plan.md", "nested root document");
    await put(".context-graph/local/attachments/a/a.txt", "attachment");
    expect(await ensureContextGraph(root)).toMatchObject({ ok: true });

    const ref = "refs/zeros-review/context-archive";
    expect(
      await snapshotWorkingTree(root, ref, {
        forceAddPaths: await contextGraphArchivePaths(root),
      }),
    ).toBeTruthy();
    const snapshot = execFileSync(
      "git",
      ["-C", root, "ls-tree", "-r", "--name-only", ref],
      { encoding: "utf8" },
    );
    expect(snapshot).toContain(".context/overview.md");
    expect(snapshot).toContain(".context/docs/plan.md");
    expect(snapshot).not.toContain("scratch.md");
  });

  it.each([".context", ".context-graph"])(
    "keeps committed shared files when %s ignore rules would hide their destinations",
    async (directory) => {
      await put(".gitignore", ".context/\n");
      await put(`${directory}/shared/.gitignore`, "*.md\n");
      await put(".context-graph/shared/docs/plan.md", "committed plan");
      execFileSync("git", [
        "-C",
        root,
        "add",
        "-f",
        ".context-graph/shared/docs/plan.md",
      ]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "shared context",
      ]);

      expect(await ensureContextGraph(root)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/gitignored/),
      });
      expect(await read(".context-graph/shared/docs/plan.md")).toBe(
        "committed plan",
      );
      expect(status()).not.toContain(" D .context-graph/shared/docs/plan.md");
      await fs.writeFile(
        path.join(root, directory, "shared/.gitignore"),
        "# allow docs\n",
      );
      // Incoming rules may already have been copied to validate their effect.
      await fs.rm(path.join(root, ".context/shared/.gitignore"), {
        force: true,
      });
      expect(await ensureContextGraph(root)).toMatchObject({ ok: true });
      expect(status()).toContain(".context/shared/docs/plan.md");
    },
  );

  it("merges a legacy local gitignore with the generated private-scope rules", async () => {
    const rules = "# local tooling rules\n*.tmp\n";
    await put(".context-graph/.gitignore", "/local/\n/.gitignore\n");
    await put(".context-graph/local/.gitignore", rules);
    await put(".context-graph/local/notes.md", "keep me");

    expect(await ensureContextGraph(root)).toMatchObject({ ok: true });
    expect(await read(".context/local/.gitignore")).toContain(rules);
    expect(
      await stageContextGraphAttachment(root, {
        attachmentId: "new-id",
        filename: "new.txt",
        base64: "bmV3",
      }),
    ).toMatchObject({ ok: true });
    expect(status()).toBe("");
    expect(await ensureContextGraph(root)).toEqual({
      ok: true,
      created: false,
    });
  });

  it("preserves intentionally ignored files alongside visible shared documents", async () => {
    await put(".context-graph/shared/.gitignore", "*.tmp\n");
    await put(".context-graph/shared/plan.md", "shared plan");
    await put(".context-graph/shared/draft.tmp", "ignored draft");
    expect(await ensureContextGraph(root)).toMatchObject({ ok: true });
    expect(await read(".context/shared/draft.tmp")).toBe("ignored draft");
    expect(status()).toContain(".context/shared/plan.md");
    expect(status()).not.toContain("draft.tmp");
  });

  it("resumes after an interrupted file move without losing either record", async () => {
    await put(".context-graph/local/attachments/a/one.txt", "one");
    await put(".context-graph/local/attachments/b/two.txt", "two");
    const link = fs.link.bind(fs);
    const failure = vi
      .spyOn(fs, "link")
      .mockImplementation(async (source, target) => {
        if (String(source).endsWith("two.txt"))
          throw Object.assign(new Error("interrupted"), { code: "EIO" });
        return link(source, target);
      });
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect((await listContextGraph(root)).items).toHaveLength(2);
    expect(await read(".context/local/attachments/a/one.txt")).toBe("one");
    expect(await read(".context-graph/local/attachments/b/two.txt")).toBe(
      "two",
    );
    failure.mockRestore();
    expect(await ensureContextGraph(root)).toMatchObject({ ok: true });
    expect(await read(".context/local/attachments/b/two.txt")).toBe("two");
    await expect(
      fs.lstat(path.join(root, ".context-graph")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries when another writer adds a legacy file after preflight", async () => {
    await put(".context-graph/local/attachments/a/one.txt", "one");
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementationOnce(async (source, target) => {
      await link(source, target);
      await put(".context-graph/local/late.txt", "late write");
    });
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect(await read(".context-graph/local/late.txt")).toBe("late write");
    expect(await ensureContextGraph(root)).toMatchObject({ ok: true });
    expect(await read(".context/local/late.txt")).toBe("late write");
  });

  it("stages in an existing .context without consuming scratch or old transcript files", async () => {
    await put(".context/notes.md", "scratch");
    await put(".context/attachments/chat/old.png", "old image");
    const result = await stageContextGraphAttachment(root, {
      attachmentId: "new-id",
      filename: "new.txt",
      base64: "bmV3",
    });
    expect(result).toMatchObject({
      ok: true,
      relativePath: ".context/local/attachments/new-id/new.txt",
    });
    expect(await read(".context/notes.md")).toBe("scratch");
    expect(await read(".context/attachments/chat/old.png")).toBe("old image");
    expect(
      (await listContextGraph(root)).items.map((item) => item.name),
    ).toEqual(["new.txt"]);
    expect(status()).toBe("");
  });

  it("migrates legacy scopes and docs into an existing folder, preserving mtime and ignore rules", async () => {
    await put(".context/notes.md", "scratch");
    await put(".context/.gitignore", "# user rules\n*\n");
    await put(".context-graph/.gitignore", "/local/\n/.gitignore\n");
    const source = await put(
      ".context-graph/local/attachments/old-id/notes.txt",
    );
    await fs.utimes(source, new Date(1_000), new Date(1_000));
    await put(".context-graph/shared/docs/plan.md", "shared plan");
    expect(await ensureContextGraph(root)).toMatchObject({
      ok: true,
      created: true,
    });
    expect(await read(".context/local/attachments/old-id/notes.txt")).toBe(
      "keep me",
    );
    expect(
      (
        await fs.stat(
          path.join(root, ".context/local/attachments/old-id/notes.txt"),
        )
      ).mtimeMs,
    ).toBe(1_000);
    expect(await read(".context/shared/docs/plan.md")).toBe("shared plan");
    expect(await read(".context/.gitignore")).toContain("# user rules\n*\n");
    expect(await read(".context/notes.md")).toBe("scratch");
    await expect(
      fs.lstat(path.join(root, ".context-graph")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(status()).toContain(".context/shared/docs/plan.md");
    expect(status()).not.toContain("notes.txt");
    expect(await ensureContextGraph(root)).toEqual({
      ok: true,
      created: false,
    });
  });

  it("does not overwrite differing same-path files during migration", async () => {
    await put(".context/local/attachments/id/a.txt", "new copy");
    await put(".context-graph/local/attachments/id/a.txt", "old copy");
    const result = await ensureContextGraph(root);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/conflict/i),
    });
    expect(await read(".context/local/attachments/id/a.txt")).toBe("new copy");
    expect(await read(".context-graph/local/attachments/id/a.txt")).toBe(
      "old copy",
    );
    expect((await listContextGraph(root)).items).toHaveLength(2);
  });

  it("refuses an attachment id collision across roots and scopes", async () => {
    await put(".context/shared/attachments/id/a.txt", "shared");
    await put(".context-graph/local/attachments/id/a.txt", "local");
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect(await read(".context/shared/attachments/id/a.txt")).toBe("shared");
    expect(await read(".context-graph/local/attachments/id/a.txt")).toBe(
      "local",
    );
  });

  it("resumes duplicate-file migration safely and coalesces concurrent scaffolds", async () => {
    await put(".context/local/attachments/id/a.txt");
    await put(".context-graph/local/attachments/id/a.txt");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureContextGraph(root)),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await listContextGraph(root)).items).toHaveLength(1);
    expect(await ensureContextGraph(root)).toEqual({
      ok: true,
      created: false,
    });
  });

  it.each([
    ".context",
    ".context/local",
    ".context-graph",
    ".context-graph/local",
  ])(
    "refuses a symlink at %s without reading or moving its target",
    async (relative) => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "zeros-context-outside-"),
      );
      try {
        await fs.writeFile(path.join(outside, "secret.txt"), "private");
        await fs.mkdir(path.dirname(path.join(root, relative)), {
          recursive: true,
        });
        await fs.symlink(outside, path.join(root, relative));
        expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
        expect((await listContextGraph(root)).items).toEqual([]);
        expect(
          await fs.readFile(path.join(outside, "secret.txt"), "utf8"),
        ).toBe("private");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("shares through a parent ignore and an existing star ignore while keeping scratch private", async () => {
    await put(".gitignore", "# existing rules\n.context/\n");
    await put(".context/.gitignore", "# scratch\n*\n");
    await put(".context/notes.md", "private scratch");
    await stageContextGraphAttachment(root, {
      attachmentId: "id",
      filename: "a.txt",
      base64: "aGk=",
    });
    expect(await read(".gitignore")).toBe("# existing rules\n.context/\n");
    expect(await setContextGraphAttachmentShared(root, "id", true)).toEqual({
      ok: true,
      moved: true,
    });
    expect(status()).toContain(".context/shared/attachments/id/a.txt");
    expect(status()).not.toContain("notes.md");
    expect(status()).not.toContain(".context/.gitignore");
    expect(await read(".gitignore")).toContain("# existing rules\n.context/\n");
    expect(await setContextGraphAttachmentShared(root, "id", false)).toEqual({
      ok: true,
      moved: true,
    });
    expect(status()).not.toContain("a.txt");
  });

  it("refuses a share still excluded by rules inside shared, leaving the private record intact", async () => {
    await put(".context/shared/.gitignore", "*.txt\n");
    await stageContextGraphAttachment(root, {
      attachmentId: "id",
      filename: "a.txt",
      base64: "aGk=",
    });
    expect(
      await setContextGraphAttachmentShared(root, "id", true),
    ).toMatchObject({
      ok: false,
      moved: false,
      error: expect.stringMatching(/gitignored/),
    });
    expect(await read(".context/local/attachments/id/a.txt")).toBe("hi");
  });

  it("keeps legacy shared files available when ignore preparation fails, then retries", async () => {
    await put(".git/info/exclude", ".context/\n");
    const rules = await put("rules.txt", "# do not edit\n");
    await fs.symlink(rules, path.join(root, ".gitignore"));
    await put(".context-graph/shared/attachments/id/a.txt");
    expect(await ensureContextGraph(root)).toMatchObject({ ok: false });
    expect(await read(".context-graph/shared/attachments/id/a.txt")).toBe(
      "keep me",
    );
    expect(await read("rules.txt")).toBe("# do not edit\n");
    await fs.unlink(path.join(root, ".gitignore"));
    expect(await ensureContextGraph(root)).toMatchObject({ ok: true });
    expect(status()).toContain(".context/shared/attachments/id/a.txt");
  });
});
