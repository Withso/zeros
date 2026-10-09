import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const configuration = vi.hoisted(() => vi.fn());
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: configuration,
}));

describe("Git temporary storage", () => {
  const directories: string[] = [];
  let previousMask: number | undefined;
  beforeEach(() => {
    vi.resetModules();
    configuration.mockReset().mockReturnValue(null);
  });
  afterEach(async () => {
    if(previousMask!==undefined){process.umask(previousMask);previousMask=undefined;}
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

  it.skipIf(process.platform !== "linux")(
    "lets same-engine cloud Git create, copy, and reuse indexes under umask 077 without chown",
    async () => {
      previousMask=process.umask(0o077);
      configuration.mockReturnValue({ version:4, uid: 10001, gid: 10001 }); // Archived account fields never select the launch identity.
      const { directory, copyGitTemporaryFile, writeGitTemporaryFile } = await scratch();
      const git = (args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync("git", args, {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, ...env }, encoding: "utf8",
      });
      git(["init", "-q"]);
      const index = path.join(directory, "index");
      git(["read-tree", "--empty"], { GIT_INDEX_FILE: index });
      const copy = path.join(directory, "copied-index");
      await copyGitTemporaryFile(index, copy);
      const cached = path.join(directory, "cached-index");
      await writeGitTemporaryFile(cached, await readFile(index));
      for (const file of [index, copy, cached]) {
        expect(git(["write-tree"], { GIT_INDEX_FILE: file }).trim()).toMatch(/^[a-f0-9]{40}$/);
        expect((await lstat(file)).uid).toBe(process.geteuid!());
        expect((await lstat(file)).mode & 0o077).toBe(0);
      }
      // Same-user engine state has no secrecy boundary; source path checks
      // still refuse aliases and keep exclusive destination writes.
      const privateDir = path.join(directory, "engine-private");
      await mkdir(privateDir, { mode: 0o700 });
      await writeFile(path.join(privateDir, "authority"), "private", { mode: 0o600 });
      await symlink(path.join(privateDir, "authority"), path.join(directory, "index-link"));
      await expect(copyGitTemporaryFile(path.join(directory, "index-link"), path.join(directory, "leak")))
        .rejects.toMatchObject({ code: "ELOOP" });
      await expect(lstat(path.join(directory, "leak"))).rejects.toMatchObject({ code: "ENOENT" });

    },
  );
});
