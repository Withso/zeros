import { mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  allocateBrowserDownload,
  validateBrowserUpload,
} from "../browser-files";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser file boundaries", () => {
  it("resolves a regular upload file and reports only bounded metadata", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "evidence.txt");
    await writeFile(target, "browser evidence", { mode: 0o600 });
    const alias = join(directory, "alias.txt");
    await symlink(target, alias);

    await expect(validateBrowserUpload(alias)).resolves.toEqual({
      path: await realpath(target),
      name: "evidence.txt",
      size: 16,
    });
  });

  it("rejects relative paths, directories, empty files, and oversized uploads", async () => {
    const directory = await temporaryDirectory();
    const empty = join(directory, "empty.txt");
    const large = join(directory, "large.bin");
    await writeFile(empty, "");
    await writeFile(large, "12345");

    await expect(validateBrowserUpload("relative.txt")).rejects.toThrow(
      /absolute path/i,
    );
    await expect(validateBrowserUpload(directory)).rejects.toThrow(
      /regular file/i,
    );
    await expect(validateBrowserUpload(empty)).rejects.toThrow(/not be empty/i);
    await expect(validateBrowserUpload(large, 4)).rejects.toThrow(/4 bytes/i);
  });

  it("allocates a private task-bound path with a sanitized filename", async () => {
    const root = await temporaryDirectory();
    const target = await allocateBrowserDownload({
      root,
      taskId: "task-a",
      suggestedFilename: "../unsafe report?.pdf",
    });

    expect(target.name).toMatch(/^unsafe report_-[0-9a-f-]+\.pdf$/i);
    expect(basename(target.path)).toBe(target.name);
    expect(dirname(target.path)).not.toBe(root);
    expect((await stat(dirname(target.path))).mode & 0o777).toBe(0o700);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zeros-browser-files-"));
  temporaryDirectories.push(directory);
  return directory;
}
