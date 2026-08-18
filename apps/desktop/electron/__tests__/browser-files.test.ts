import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  allocateBrowserDownload,
  discardStagedBrowserUpload,
  pruneBrowserDownloads,
  stageBrowserUpload,
  validateBrowserUpload,
} from "../browser/files";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Zeros browser file boundaries", () => {
  it("allows a symlink whose resolved file remains inside the owning workspace", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "evidence.txt");
    const alias = join(root, "alias.txt");
    await writeFile(file, "browser evidence", { mode: 0o600 });
    await symlink(file, alias);
    await expect(validateBrowserUpload(alias, root)).resolves.toEqual({
      path: await realpath(file),
      name: "evidence.txt",
      size: 16,
    });
  });

  it("rejects a path or symlink that escapes the owning workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, join(root, "escape.txt"));
    await expect(validateBrowserUpload(secret, root)).rejects.toThrow(
      /workspace/i,
    );
    await expect(
      validateBrowserUpload(join(root, "escape.txt"), root),
    ).rejects.toThrow(/workspace/i);
  });

  it("freezes an upload into a private app-owned file before confirmation", async () => {
    const workspace = await temporaryDirectory();
    const artifacts = await temporaryDirectory();
    const file = join(workspace, "evidence.txt");
    await writeFile(file, "stable evidence", { mode: 0o600 });

    const staged = await stageBrowserUpload({
      requestedPath: file,
      workspaceRoot: workspace,
      root: artifacts,
      browserSessionId: "browser-a",
    });
    expect(staged.path).not.toBe(file);
    expect(staged.name).toBe("evidence.txt");
    expect(await readFile(staged.path, "utf8")).toBe("stable evidence");
    expect((await stat(staged.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);

    await discardStagedBrowserUpload(staged);
    await expect(stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allocates a private app-owned download path with a sanitized name", async () => {
    const root = await temporaryDirectory();
    const target = allocateBrowserDownload({
      root,
      browserSessionId: "browser-a",
      suggestedFilename: "../unsafe report?.pdf",
    });
    expect(target.name).toMatch(/^unsafe report_-[0-9a-f-]+\.pdf$/i);
    expect(basename(target.path)).toBe(target.name);
    expect(dirname(target.path)).not.toBe(root);
    expect((await stat(dirname(target.path))).mode & 0o777).toBe(0o700);
  });

  it("bounds downloads that survive a browser lease close and reopen", async () => {
    const root = await temporaryDirectory();
    const downloads = ["old.txt", "middle.txt", "new.txt"].map((name) =>
      allocateBrowserDownload({
        root,
        browserSessionId: "browser-a",
        suggestedFilename: name,
      }),
    );
    for (const [index, target] of downloads.entries()) {
      await writeFile(target.path, target.name);
      await utimes(target.path, index + 1, index + 1);
    }

    await expect(pruneBrowserDownloads(root, "browser-a", 2)).resolves.toBe(1);
    const retained = await readdir(dirname(downloads[0]!.path));
    expect(retained).not.toContain(downloads[0]!.name);
    expect(retained).toEqual(
      expect.arrayContaining([downloads[1]!.name, downloads[2]!.name]),
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zeros-browser-files-"));
  roots.push(root);
  return root;
}
