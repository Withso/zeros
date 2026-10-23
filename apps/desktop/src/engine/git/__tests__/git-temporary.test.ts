import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("Git temporary storage", () => {
  const directories: string[] = [];
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })));
  });

  async function scratch() {
    const helpers = await import("../git-temporary");
    const directory = await helpers.createGitTemporaryDirectory(
      path.join(tmpdir(), "zeros-git-temporary-test-"),
    );
    directories.push(directory);
    return { ...helpers, directory };
  }

  it("keeps local scratch private and copies a complete index without changing its source", async () => {
    const { directory, copyGitTemporaryFile, writeGitTemporaryFile } = await scratch();
    const source = path.join(directory, "source");
    const destination = path.join(directory, "index");
    await writeFile(source, "index snapshot");
    await copyGitTemporaryFile(source, destination);
    await writeGitTemporaryFile(path.join(directory, "patch"), "patch contents");
    expect(await readFile(destination, "utf8")).toBe("index snapshot");
    expect(await readFile(source, "utf8")).toBe("index snapshot");
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(directory, "patch"))).mode & 0o777).toBe(0o600);
    }
  });

  it("never follows an existing destination link or truncates an existing scratch file", async () => {
    const { directory, copyGitTemporaryFile, writeGitTemporaryFile } = await scratch();
    const source = path.join(directory, "source");
    const link = path.join(directory, "link");
    await writeFile(source, "unchanged");
    await symlink(source, link);
    await expect(copyGitTemporaryFile(source, link)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(writeGitTemporaryFile(link, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(writeGitTemporaryFile(source, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(source, "utf8")).toBe("unchanged");
  });

  it("cleans an incomplete streamed scratch file", async () => {
    const { directory, writeGitTemporaryFile } = await scratch();
    async function* broken() {
      yield Buffer.from("partial");
      throw new Error("source failed");
    }
    const destination = path.join(directory, "index");
    await expect(writeGitTemporaryFile(destination, broken())).rejects.toThrow("source failed");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
