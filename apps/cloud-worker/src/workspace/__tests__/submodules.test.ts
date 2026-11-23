// workspace-submodules-v1, run for real (git): a new checkout's planned submodules, fetched the way the project
// build fetches them. github.com is a local origin for the test only, through the test's own global Git config.
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlannedSubmodules, SUBMODULE_PUSH_REFUSED, type WorkerSubmodule } from "../submodules";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const digest = (name: string) => createHash("sha256").update(name).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-submodules-")); directories.push(root);
  const gitconfig = join(root, "gitconfig");
  const environment = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, timeout: 10_000,
    env: { ...process.env, ...environment, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test" } })).stdout.trim();
  // acme/lib's origin, published at https://github.com/acme/lib.git for this test.
  const origin = join(root, "lib.git"), seed = join(root, "seed");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, seed);
  await writeFile(join(seed, "lib.txt"), "one\n"); await git(seed, "add", "-A"); await git(seed, "commit", "-q", "-m", "one");
  const first = await git(seed, "rev-parse", "HEAD");
  await writeFile(join(seed, "lib.txt"), "two\n"); await git(seed, "commit", "-qam", "two"); await git(seed, "push", "-q", "origin", "main");
  const second = await git(seed, "rev-parse", "HEAD");
  // oss/vendor (public, an account without the App) is the same origin for the test.
  await writeFile(gitconfig, `[url "file://${origin}"]\n\tinsteadOf = https://github.com/acme/lib.git\n\tinsteadOf = https://github.com/oss/vendor.git\n[protocol "file"]\n\tallow = always\n`);
  // The workspace's checkout, with the gitlink folder its clone left empty.
  const checkout = join(root, "home", "zeros", "app");
  await mkdir(join(checkout, "vendor", "lib"), { recursive: true });
  await git(checkout, "init", "-q", "-b", "main");
  const entry: WorkerSubmodule = { position: 0, path: "vendor/lib", repository: "acme/lib", commit: first, gitDir: `modules/${digest("vendor/lib")}` };
  return { root, git, checkout, environment, entry, first, second };
}

describe("a new checkout's planned submodules", () => {
  it("clones over HTTPS into its own Git directory at the gitlink commit, and refuses a push in a plain sentence", async () => {
    const f = await fixture();
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment)).toEqual([{ path: "vendor/lib", fetched: true }]);
    const target = join(f.checkout, "vendor/lib"), gitDir = join(f.checkout, ".git", f.entry.gitDir);
    expect(await readFile(join(target, "lib.txt"), "utf8")).toBe("one\n");
    expect(await f.git(target, "rev-parse", "HEAD")).toBe(f.first);
    expect(await readFile(join(target, ".git"), "utf8")).toContain(gitDir);
    expect(await f.git(target, "config", "--get", "remote.origin.url")).toBe("https://github.com/acme/lib.git");
    expect(await readFile(join(f.checkout, ".git/config"), "utf8")).not.toContain("submodule");
    expect((await stat(join(gitDir, "hooks/pre-push"))).mode & 0o111).toBeTruthy();
    await writeFile(join(target, "lib.txt"), "mine\n");
    await f.git(target, "commit", "-qam", "mine");
    const pushed = await f.git(target, "push", "origin", "HEAD:refs/heads/mine").then(() => null, (error: { stderr: string }) => error.stderr);
    expect(pushed).toContain(SUBMODULE_PUSH_REFUSED);
    expect(await f.git(join(f.root, "lib.git"), "branch", "--list", "mine")).toBe("");
  });

  it("fetches a public one with no way to ask for a credential, and a private one through the broker as before", async () => {
    const f = await fixture();
    // Every Git the worker starts, with what it could ask a credential from.
    const bin = join(f.root, "bin"), log = join(f.root, "git.log");
    const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh\necho "$* | askpass=\${GIT_ASKPASS:-} broker=\${GH_ZEROS_BROKER_SOCKET:-} config=\${GIT_CONFIG_COUNT:-} prompt=\${GIT_TERMINAL_PROMPT:-}" >> '${log}'\nexec '${realGit}' "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    await mkdir(join(f.checkout, "vendor", "pub"), { recursive: true });
    const broker = { ...f.environment, GIT_ASKPASS: join(f.root, "askpass"), GH_ZEROS_BROKER_SOCKET: join(f.root, "github.sock"), GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: `!${join(f.root, "git-credential")}` };
    const pub = { position: 0, path: "vendor/pub", repository: "oss/vendor", commit: f.first, gitDir: `modules/${digest("vendor/pub")}`, public: true as const };
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry, pub], broker)).toEqual([{ path: "vendor/lib", fetched: true }, { path: "vendor/pub", fetched: true }]);
    expect(await readFile(join(f.checkout, "vendor/pub/lib.txt"), "utf8")).toBe("one\n");
    const clones = (await readFile(log, "utf8")).split("\n").filter(line => line.split(" | ")[0]!.includes(" clone "));
    const publicClone = clones.find(line => line.includes("oss/vendor.git"))!, privateClone = clones.find(line => line.includes("acme/lib.git"))!;
    expect(clones).toHaveLength(2);
    expect(publicClone).toContain("credential.helper=");
    expect(publicClone.split(" | ")[1]).toBe(`askpass= broker= config= prompt=0`);
    expect(privateClone.split(" | ")[1]).toBe(`askpass=${join(f.root, "askpass")} broker=${join(f.root, "github.sock")} config=1 prompt=0`);
  });

  it("moves its own submodule to a new planned commit (a fork whose base moved), and never takes over another Git directory", async () => {
    const f = await fixture();
    await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment);
    expect(await fetchPlannedSubmodules(f.checkout, [{ ...f.entry, commit: f.second }], f.environment)).toEqual([{ path: "vendor/lib", fetched: true }]);
    expect(await readFile(join(f.checkout, "vendor/lib/lib.txt"), "utf8")).toBe("two\n");
    await writeFile(join(f.checkout, "vendor/lib/.git"), `gitdir: ${join(f.root, "lib.git")}\n`);
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment)).toEqual([{ path: "vendor/lib", fetched: false }]);
  });

  it("refuses a symlinked or non-empty target, an unsafe entry, and the submodules of one that failed, writing nothing", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(join(outside, "lib"), { recursive: true });
    await rm(join(f.checkout, "vendor"), { recursive: true });
    await symlink(outside, join(f.checkout, "vendor"));
    const child = { ...f.entry, path: "vendor/lib/inner", gitDir: `${f.entry.gitDir}/modules/${digest("inner")}` };
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry, child], f.environment)).toEqual([
      { path: "vendor/lib", fetched: false }, { path: "vendor/lib/inner", fetched: false }]);
    expect(existsSync(join(outside, "lib/.git"))).toBe(false);
    await rm(join(f.checkout, "vendor"));
    await mkdir(join(f.checkout, "vendor/lib"), { recursive: true });
    await writeFile(join(f.checkout, "vendor/lib/planted"), "x");
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment)).toEqual([{ path: "vendor/lib", fetched: false }]);
    const zeroWidth = `.g${String.fromCharCode(0x200c)}it`;
    for (const bad of [{ path: "../x" }, { path: ".GIT/hooks" }, { path: `${zeroWidth}/x` }, { path: "git~1/x" }, { path: "a\\b" },
      { repository: "acme/.." }, { commit: "HEAD" }, { gitDir: "../../x" }, { gitDir: "modules/abc" }])
      expect([bad, await fetchPlannedSubmodules(f.checkout, [{ ...f.entry, ...bad }], f.environment)]).toEqual([bad, [{ path: bad.path ?? f.entry.path, fetched: false }]]);
    expect(existsSync(join(f.checkout, ".git/modules"))).toBe(false);
  });
});

/** Every name, mode and byte under a folder: equal before and after means nothing was touched. */
async function snapshot(top: string): Promise<string[]> {
  const lines: string[] = [];
  // Each entry's kind from the listing itself, and its mode and bytes from one opened handle: no separate check of a
  // path before using it.
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name), rel = relative(top, path);
      if (entry.isSymbolicLink()) { lines.push(`${rel} -> ${await readlink(path)}`); continue; }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const { mode } = await handle.stat();
        if (entry.isDirectory()) lines.push(`${rel}/ ${mode}`);
        else lines.push(`${rel} ${mode} ${createHash("sha256").update(await handle.readFile()).digest("hex")}`);
      } finally { await handle.close(); }
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(top);
  return lines;
}

/** Every Git the code under test starts, logged before it runs. */
async function gitLog(root: string) {
  const bin = join(root, "bin"), log = join(root, "git.log");
  const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return async () => existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean) : [];
}

describe("a checkout whose branch was already there (a restore): only missing submodules", () => {
  it("fetches one a restore left empty, with no Git directory, at its gitlink commit with the pre-push refusal", async () => {
    // An older control plane's restore: the gitlink's folder empty (read-tree -u), .git/modules absent, branch not created.
    // The restored index records the gitlink, as every restore writes it.
    const f = await fixture();
    await f.git(f.checkout, "update-index", "--add", "--cacheinfo", `160000,${f.first},vendor/lib`);
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment, { onlyMissing: true })).toEqual([{ path: "vendor/lib", fetched: true }]);
    const target = join(f.checkout, "vendor/lib"), gitDir = join(f.checkout, ".git", f.entry.gitDir);
    expect(await f.git(target, "rev-parse", "HEAD")).toBe(f.first);
    expect(await f.git(target, "rev-parse", "--absolute-git-dir")).toBe(gitDir);
    expect(await readFile(join(target, "lib.txt"), "utf8")).toBe("one\n");
    expect((await stat(join(gitDir, "hooks/pre-push"))).mode & 0o111).toBeTruthy();
    expect(await readFile(join(gitDir, "hooks/pre-push"), "utf8")).toContain("Push it from your own computer");
  });

  it("leaves one that is there, at another commit with a dirty file and a staged change, exactly as it is, running no Git", async () => {
    const f = await fixture();
    await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment);
    const target = join(f.checkout, "vendor/lib"), gitDir = join(f.checkout, ".git", f.entry.gitDir);
    await f.git(target, "fetch", "-q", "origin", "main");
    await f.git(target, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", f.second);
    await writeFile(join(target, "staged.txt"), "staged\n"); await f.git(target, "add", "staged.txt");
    await writeFile(join(target, "lib.txt"), "dirty\n");
    const before = { tree: await snapshot(target), gitDir: await snapshot(gitDir), status: await f.git(target, "status", "--porcelain=v1") };
    const logged = await gitLog(f.root);
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment, { onlyMissing: true }))
      .toEqual([{ path: "vendor/lib", fetched: false, kept: true }]);
    expect(await logged()).toEqual([]);
    expect({ tree: await snapshot(target), gitDir: await snapshot(gitDir), status: await f.git(target, "status", "--porcelain=v1") }).toEqual(before);
    expect(await f.git(target, "rev-parse", "HEAD")).toBe(f.second);
    expect(before.status.split("\n")).toEqual(["M lib.txt", "A  staged.txt"]);
  });

  it("keeps an absent, non-empty or symlinked folder and an existing Git directory as they are, and never creates a parent's Git directory", async () => {
    const f = await fixture();
    const absent = { ...f.entry, path: "vendor/gone", gitDir: `modules/${digest("vendor/gone")}` };
    const planted = { ...f.entry, path: "vendor/planted", gitDir: `modules/${digest("vendor/planted")}` };
    const linked = { ...f.entry, path: "vendor/linked", gitDir: `modules/${digest("vendor/linked")}` };
    const leftover = { ...f.entry, path: "vendor/leftover", gitDir: `modules/${digest("vendor/leftover")}` };
    await mkdir(join(f.checkout, "vendor/planted")); await writeFile(join(f.checkout, "vendor/planted/mine.txt"), "mine\n");
    await mkdir(join(f.root, "elsewhere")); await symlink(join(f.root, "elsewhere"), join(f.checkout, "vendor/linked"));
    await mkdir(join(f.checkout, "vendor/leftover")); await mkdir(join(f.checkout, ".git", leftover.gitDir), { recursive: true });
    // A person's own clone where a planned submodule goes: its child is not fetched into a Git directory it doesn't use.
    await f.git(f.root, "clone", "-q", join(f.root, "lib.git"), join(f.checkout, "vendor/lib"));
    await mkdir(join(f.checkout, "vendor/lib/inner"));
    const child = { ...f.entry, path: "vendor/lib/inner", gitDir: `${f.entry.gitDir}/modules/${digest("inner")}` };
    const before = await snapshot(f.checkout), logged = await gitLog(f.root);
    expect(await fetchPlannedSubmodules(f.checkout, [absent, planted, linked, leftover, f.entry, child], f.environment, { onlyMissing: true }))
      .toEqual([absent, planted, linked, leftover, f.entry, child].map(entry => ({ path: entry.path, fetched: false, kept: true })));
    expect(await snapshot(f.checkout)).toEqual(before);
    expect(existsSync(join(f.checkout, ".git", f.entry.gitDir))).toBe(false);
    expect(existsSync(join(f.checkout, "vendor/gone"))).toBe(false);
    expect(await logged()).toEqual([]);
  });

  it("judges a kept parent's child on its own, fetches the children of one fetched now as before, and skips those of one that failed", async () => {
    const f = await fixture();
    // The parent is there (kept); its child's folder is empty and its Git directory absent: fetched into the parent's.
    await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment);
    await mkdir(join(f.checkout, "vendor/lib/inner"));
    // The kept parent's own index records its child's gitlink.
    await f.git(join(f.checkout, "vendor/lib"), "update-index", "--add", "--cacheinfo", `160000,${f.first},inner`);
    const child = { ...f.entry, path: "vendor/lib/inner", gitDir: `${f.entry.gitDir}/modules/${digest("inner")}` };
    // A planned child the kept parent's index no longer records as a submodule: left alone.
    await mkdir(join(f.checkout, "vendor/lib/gone"));
    const gone = { ...f.entry, path: "vendor/lib/gone", gitDir: `${f.entry.gitDir}/modules/${digest("gone")}` };
    const parentHead = await f.git(join(f.checkout, "vendor/lib"), "rev-parse", "HEAD");
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry, child, gone], f.environment, { onlyMissing: true }))
      .toEqual([{ path: "vendor/lib", fetched: false, kept: true }, { path: "vendor/lib/inner", fetched: true }, { path: "vendor/lib/gone", fetched: false, kept: true }]);
    expect(existsSync(join(f.checkout, ".git", gone.gitDir))).toBe(false);
    expect(await f.git(join(f.checkout, "vendor/lib/inner"), "rev-parse", "--absolute-git-dir")).toBe(join(f.checkout, ".git", child.gitDir));
    expect(await f.git(join(f.checkout, "vendor/lib"), "rev-parse", "HEAD")).toBe(parentHead);
    // Missing parent, fetched now: its child follows the created-branch rule (here its folder isn't in the parent's tree).
    const other = { ...f.entry, path: "vendor/other", gitDir: `modules/${digest("vendor/other")}` };
    await mkdir(join(f.checkout, "vendor/other"));
    await f.git(f.checkout, "update-index", "--add", "--cacheinfo", `160000,${f.first},vendor/other`);
    const otherChild = { ...other, path: "vendor/other/inner", gitDir: `${other.gitDir}/modules/${digest("inner")}` };
    expect(await fetchPlannedSubmodules(f.checkout, [other, otherChild], f.environment, { onlyMissing: true }))
      .toEqual([{ path: "vendor/other", fetched: true }, { path: "vendor/other/inner", fetched: false }]);
    // Missing but unreachable, or unsafe: skipped (not kept), and so are its submodules.
    const broken = { ...f.entry, path: "vendor/broken", repository: "acme/missing", gitDir: `modules/${digest("vendor/broken")}` };
    await mkdir(join(f.checkout, "vendor/broken"));
    await f.git(f.checkout, "update-index", "--add", "--cacheinfo", `160000,${f.first},vendor/broken`);
    const brokenChild = { ...broken, path: "vendor/broken/inner", repository: "acme/lib", gitDir: `${broken.gitDir}/modules/${digest("inner")}` };
    await writeFile(join(f.root, "gitconfig"), `${await readFile(join(f.root, "gitconfig"), "utf8")}[url "file://${join(f.root, "nothing.git")}"]\n\tinsteadOf = https://github.com/acme/missing.git\n`);
    expect(await fetchPlannedSubmodules(f.checkout, [broken, brokenChild, { ...f.entry, commit: "HEAD" }], f.environment, { onlyMissing: true }))
      .toEqual([{ path: "vendor/broken", fetched: false }, { path: "vendor/broken/inner", fetched: false }, { path: "vendor/lib", fetched: false }]);
    expect(existsSync(join(f.checkout, ".git", brokenChild.gitDir))).toBe(false);
  });
});
