// workspace-submodules-v1, run for real (git): a new checkout's planned submodules, fetched the way the project
// build fetches them. github.com is a local origin for the test only, through the test's own global Git config.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPlannedSubmodules, SUBMODULE_PUSH_REFUSED, type WorkerSubmodule } from "../submodules";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
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
  await writeFile(gitconfig, `[url "file://${origin}"]\n\tinsteadOf = https://github.com/acme/lib.git\n[protocol "file"]\n\tallow = always\n`);
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
