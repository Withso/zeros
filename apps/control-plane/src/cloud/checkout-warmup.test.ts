import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CHECKOUT_WARMUP_SCRIPT } from "./lifecycle.js";

// The warm-up runs beside the worker's own checkout, so it must never write the
// index, a submodule's index or anything else, nor run an fsmonitor command.
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const temporary = async (prefix: string) => { const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory; };
const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
const warm = (cwd: string, env: NodeJS.ProcessEnv) => execFileSync("sh", ["-c", CHECKOUT_WARMUP_SCRIPT], { cwd, env, encoding: "utf8" });

it("reads a restored checkout without changing its branch, index or files", async () => {
  const repository = await temporary("zeros-warmup-restored-"), env = { ...process.env, ...identity };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  for (const name of ["a.txt", "b.txt"]) await writeFile(join(repository, name), `${name}\n`);
  git("add", "."); git("commit", "-q", "-m", "fixture");
  // A snapshot restore keeps mtimes and sizes but gives every file a new inode.
  for (const name of ["a.txt", "b.txt"]) execFileSync("sh", ["-c", `cp -p ${name} ${name}.restored && mv ${name}.restored ${name}`], { cwd: repository });
  await writeFile(join(repository, "b.txt"), "changed\n");
  const index = join(repository, ".git", "index"), before = { head: git("rev-parse", "HEAD"), index: await readFile(index) };
  warm(repository, env);
  expect({ head: git("rev-parse", "HEAD"), index: await readFile(index) }).toEqual(before);
  expect(await readFile(join(repository, "b.txt"), "utf8")).toBe("changed\n");
});

it("leaves a populated submodule's index and a configured fsmonitor alone", async () => {
  const root = await temporary("zeros-warmup-submodule-");
  const env = { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  await mkdir(join(root, "sub")); await mkdir(join(root, "super"));
  git(join(root, "sub"), "init", "-q", "-b", "main"); await writeFile(join(root, "sub", "a.txt"), "a\n");
  git(join(root, "sub"), "add", "."); git(join(root, "sub"), "commit", "-q", "-m", "sub");
  git(join(root, "super"), "init", "-q", "-b", "main"); await writeFile(join(root, "super", "m.txt"), "m\n");
  git(join(root, "super"), "add", "."); git(join(root, "super"), "-c", "protocol.file.allow=always", "submodule", "add", "-q", "../sub", "dep");
  git(join(root, "super"), "commit", "-q", "-m", "super");
  git(root, "-c", "protocol.file.allow=always", "clone", "-q", "--recurse-submodules", join(root, "super"), "checkout");
  const checkout = join(root, "checkout"), monitored = join(root, "fsmonitor-ran");
  git(checkout, "config", "core.fsmonitor", `touch ${monitored}`);
  const later = new Date(Date.now() + 5_000);
  await utimes(join(checkout, "dep", "a.txt"), later, later);
  const submoduleIndex = join(checkout, ".git", "modules", "dep", "index"), before = await readFile(submoduleIndex);
  warm(checkout, env);
  expect((await readFile(submoduleIndex)).equals(before)).toBe(true);
  await expect(readFile(monitored)).rejects.toThrow();
});

const hasLfs = (() => { try { execFileSync("git", ["lfs", "version"], { stdio: "ignore" }); return true; } catch { return false; } })();
// Minimal stat checking lets a racily clean entry reach a content comparison,
// which for LFS starts git-lfs's clean filter. Nothing may persist from it.
it.skipIf(!hasLfs)("changes nothing in an LFS checkout, .git included, even when git-lfs's clean filter runs", async () => {
  const repository = await temporary("zeros-warmup-lfs-"), env = { ...process.env, ...identity };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, env, encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("lfs", "install", "--local");
  git("lfs", "track", "*.bin");
  await writeFile(join(repository, "data.bin"), Buffer.alloc(64 * 1024, 7));
  await writeFile(join(repository, "a.txt"), "a\n");
  git("add", "."); git("commit", "-q", "-m", "fixture");
  for (const name of ["data.bin", "a.txt"]) execFileSync("sh", ["-c", `cp -p ${name} ${name}.restored && mv ${name}.restored ${name}`], { cwd: repository });
  const listing = async () => {
    const entries = await readdir(repository, { recursive: true, withFileTypes: true });
    const files = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
      const path = join(entry.parentPath, entry.name);
      return `${path.slice(repository.length)} ${createHash("sha256").update(await readFile(path)).digest("hex")}`;
    }));
    return files.sort();
  };
  const before = await listing();
  warm(repository, env);
  expect(await listing()).toEqual(before);
});
