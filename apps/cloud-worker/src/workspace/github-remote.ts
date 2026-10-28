import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  fchmodSync,
  fsyncSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { CommandRunner } from "./commands";

export type GithubRepositoryBinding = {
  repositoryId: string;
  repository: string;
  previousRepositories: string[];
};

/** GitHub.com remotes only. Never interpret a credential, URL rewrite, helper,
 * extra push destination or arbitrary host as this workspace's repository. */
export function githubRemoteRepository(value: string): string | null {
  let path: string;
  const scp = /^git@github\.com:([^\s]+)$/.exec(value);
  if (scp) path = scp[1];
  else {
    try {
      const url = new URL(value);
      if (
        url.hostname !== "github.com" ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === "https:"
          ? !!url.username || !!url.port
          : url.protocol !== "ssh:" ||
            url.username !== "git" ||
            (!!url.port && url.port !== "22"))
      )
        return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  path = path.replace(/\.git$/, "");
  const parts = path.split("/");
  return parts.length === 2 &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== "." && part !== "..",
    )
    ? path
    : null;
}

function readConfig(path: string) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error("Unsupported Git configuration.");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Git configuration changed during read.");
    return {
      data: bytes.subarray(0, size).toString("utf8"),
      ino: stat.ino,
      dev: stat.dev,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    };
  } finally {
    closeSync(fd);
  }
}
const unchanged = (
  a: ReturnType<typeof readConfig>,
  b: ReturnType<typeof readConfig>,
) =>
  a.data === b.data &&
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.mtimeMs === b.mtimeMs;

/** Applies only server-verified moves of the pinned repository. Git's lock and
 * an exact config comparison preserve concurrent edits and fork push URLs. */
export async function reconcileGithubRemote(
  root: string,
  binding: GithubRepositoryBinding,
  run: CommandRunner,
  current = () => true,
): Promise<boolean> {
  if (
    !/^[1-9][0-9]{0,15}$/.test(binding.repositoryId) ||
    githubRemoteRepository(`https://github.com/${binding.repository}`) !==
      binding.repository
  )
    return false;
  const common = (
    await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { readOnly: true },
    )
  ).stdout.trim();
  const local = relative(root, common);
  if (!local || local === ".." || local.startsWith("../") || isAbsolute(local))
    return false;
  const path = join(common, "config"),
    before = readConfig(path);
  const parsed = await run(
    "git",
    ["config", "--file", "-", "--no-includes", "--null", "--list"],
    { input: before.data, readOnly: true },
  );
  const values = new Map<string, string[]>();
  for (const entry of parsed.stdout.split("\0")) {
    const split = entry.indexOf("\n");
    if (split < 0) continue;
    const key = entry.slice(0, split);
    values.set(key, [...(values.get(key) ?? []), entry.slice(split + 1)]);
  }
  const urls = values.get("remote.origin.url");
  if (urls?.length !== 1) return false;
  const source = githubRemoteRepository(urls[0]!);
  if (
    !source ||
    ![binding.repository, ...binding.previousRepositories].some(
      (name) => name.toLowerCase() === source.toLowerCase(),
    )
  )
    return false;
  const expectedPush = values.get("remote.origin.pushurl") ?? urls;
  const effective = async () => {
    const [fetch, push] = await Promise.all([
      run("git", ["remote", "get-url", "--all", "origin"], { readOnly: true }),
      run("git", ["remote", "get-url", "--push", "--all", "origin"], {
        readOnly: true,
      }),
    ]);
    return (
      fetch.stdout.trim() === urls[0] &&
      push.stdout.trim() === expectedPush.join("\n")
    );
  };
  if (!current() || !(await effective())) return false;
  const rewrite = (url: string) => {
    if (githubRemoteRepository(url)?.toLowerCase() !== source.toLowerCase())
      return url;
    const prefix = url.startsWith("git@github.com:")
      ? "git@github.com:"
      : /^[a-z]+:\/\/[^/]+\//.exec(url)?.[0];
    return prefix
      ? `${prefix}${binding.repository}${url.endsWith(".git") ? ".git" : ""}`
      : url;
  };
  const edits = ["remote.origin.url", "remote.origin.pushurl"].filter((key) =>
    values.get(key)?.some((value) => rewrite(value) !== value),
  );
  if (!edits.length || !current() || !unchanged(readConfig(path), before))
    return false;
  const lock = `${path}.lock`;
  let fd: number | undefined;
  let staging: string | undefined;
  let owned = false;
  const ownsLock = () => {
    if (fd === undefined || !owned) return false;
    try {
      const held = fstatSync(fd),
        named = lstatSync(lock);
      return named.isFile() && held.ino === named.ino && held.dev === named.dev;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    fd = openSync(
      lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    owned = true;
    // Git replaces the file passed to --file. Keep its edits in a private
    // staging directory while holding our original config.lock descriptor.
    staging = mkdtempSync(join(tmpdir(), "zeros-github-config-"));
    const stagedConfig = join(staging, "config");
    writeFileSync(stagedConfig, before.data, { flag: "wx", mode: 0o600 });
    for (const key of edits) {
      await run("git", [
        "config",
        "--file",
        stagedConfig,
        "--no-includes",
        "--unset-all",
        key,
      ]);
      for (const value of values.get(key) ?? [])
        await run("git", [
          "config",
          "--file",
          stagedConfig,
          "--no-includes",
          "--add",
          key,
          rewrite(value),
        ]);
    }
    const replacement = readConfig(stagedConfig).data;
    if (
      !(await effective()) ||
      !current() ||
      !unchanged(readConfig(path), before) ||
      !ownsLock()
    )
      return false;
    writeFileSync(fd, replacement);
    fchmodSync(fd, before.mode & 0o777);
    fsyncSync(fd);
    renameSync(lock, path);
    owned = false;
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      if (ownsLock()) unlinkSync(lock);
    } catch {
      /* Preserve the original result and any replacement lock. */
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (staging !== undefined)
        rmSync(staging, { recursive: true, force: true });
    }
  }
}
