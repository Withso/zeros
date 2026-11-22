// The build and the worker fetch a planned submodule with submoduleFetchLines, run here for real (bash and
// git). github.com is a local origin for the test only, through the test's own global Git config.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SUBMODULE_FETCHED, submoduleFetchLines, submoduleGitDirName } from "./submodules.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zeros-submodule-fetch-"));
  roots.push(root);
  const gitconfig = join(root, "gitconfig");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  // The submodule's origin, published at "https://github.com/acme/lib.git" for this test.
  const origin = join(root, "lib.git"), seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  writeFileSync(join(seed, "lib.txt"), "one\n"); git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "one");
  const first = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "lib.txt"), "two\n"); git(seed, "commit", "-qam", "two"); git(seed, "push", "-q", "origin", "main");
  writeFileSync(gitconfig, `[url "file://${origin}"]\n\tinsteadOf = https://github.com/acme/lib.git\n[protocol "file"]\n\tallow = always\n`);
  // The project's checkout, with the gitlink folder its clone left empty.
  const checkout = join(root, "home", "zeros", "app");
  mkdirSync(join(checkout, "vendor", "lib"), { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  const run = (lines: string[], header = "Authorization: Basic c3ludGhldGlj\n") =>
    spawnSync("bash", ["-c", lines.join("\n")], { env, input: header, encoding: "utf8" });
  const entry = { path: "vendor/lib", repository: "acme/lib", commit: first, gitDir: `modules/${submoduleGitDirName("vendor/lib")}` };
  return { root, git, checkout, run, entry, first };
}

describe("fetching one planned submodule", () => {
  it("clones over HTTPS into its own Git directory and checks out the gitlink commit, saving no credential", () => {
    const f = fixture();
    const result = f.run(submoduleFetchLines(f.checkout, f.entry));
    expect(result.stdout).toContain(SUBMODULE_FETCHED);
    expect(readFileSync(join(f.checkout, "vendor/lib/lib.txt"), "utf8")).toBe("one\n");
    expect(f.git(join(f.checkout, "vendor/lib"), "rev-parse", "HEAD")).toBe(f.first);
    const gitDir = join(f.checkout, ".git", f.entry.gitDir);
    expect(readFileSync(join(f.checkout, "vendor/lib/.git"), "utf8")).toContain(gitDir);
    // An https remote with no credential in it, and no submodule.* config in the parent.
    expect(f.git(join(f.checkout, "vendor/lib"), "config", "--get", "remote.origin.url")).toBe("https://github.com/acme/lib.git");
    expect(readFileSync(join(gitDir, "config"), "utf8")).not.toMatch(/c3ludGhldGlj|Authorization|extraHeader/);
    expect(readFileSync(join(f.checkout, ".git/config"), "utf8")).not.toContain("submodule");
  });

  it("refuses a symlinked or non-empty target and an existing Git directory, writing nothing", () => {
    const f = fixture();
    // A symlink in the path resolves outside the checkout.
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    rmSync(join(f.checkout, "vendor"), { recursive: true });
    symlinkSync(outside, join(f.checkout, "vendor"));
    mkdirSync(join(outside, "lib"));
    let result = f.run(submoduleFetchLines(f.checkout, f.entry));
    expect(result.stdout).toContain("zeros-submodule-refused target");
    expect(existsSync(join(outside, "lib/.git"))).toBe(false);
    rmSync(join(f.checkout, "vendor"));
    mkdirSync(join(f.checkout, "vendor/lib"), { recursive: true });
    writeFileSync(join(f.checkout, "vendor/lib/planted"), "x");
    result = f.run(submoduleFetchLines(f.checkout, f.entry));
    expect(result.stdout).toContain("zeros-submodule-refused target");
    rmSync(join(f.checkout, "vendor/lib/planted"));
    mkdirSync(join(f.checkout, ".git", f.entry.gitDir), { recursive: true });
    result = f.run(submoduleFetchLines(f.checkout, f.entry));
    expect(result.stdout).toContain("zeros-submodule-refused existing");
    expect(existsSync(join(f.checkout, "vendor/lib/.git"))).toBe(false);
  });

  it("moves an existing submodule to a new planned commit (a rebuild, or a base that moved), and refuses a foreign Git directory", () => {
    const f = fixture();
    expect(f.run(submoduleFetchLines(f.checkout, f.entry)).stdout).toContain(SUBMODULE_FETCHED);
    const second = f.git(join(f.root, "seed"), "rev-parse", "HEAD");
    expect(f.run(submoduleFetchLines(f.checkout, { ...f.entry, commit: second })).stdout).toContain(SUBMODULE_FETCHED);
    expect(readFileSync(join(f.checkout, "vendor/lib/lib.txt"), "utf8")).toBe("two\n");
    // A work tree pointing at some other Git directory is never taken over.
    writeFileSync(join(f.checkout, "vendor/lib/.git"), `gitdir: ${join(f.root, "lib.git")}\n`);
    expect(f.run(submoduleFetchLines(f.checkout, f.entry)).stdout).toContain("zeros-submodule-refused existing");
  });

  it("never builds a command for an unsafe entry", () => {
    const f = fixture();
    for (const bad of [{ path: "../x" }, { path: ".git/hooks" }, { repository: "acme/lib;rm" }, { commit: "HEAD" }, { gitDir: "../../x" }, { gitDir: "modules/abc" }])
      expect(() => submoduleFetchLines(f.checkout, { ...f.entry, ...bad }), JSON.stringify(bad)).toThrow("Invalid submodule");
  });
});
