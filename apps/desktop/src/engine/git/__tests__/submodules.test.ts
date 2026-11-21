// Submodule fetch for a new Local workspace, against real temporary
// repositories. github.com is never contacted: the core step receives a
// test-only clone source argument that maps an approved github.com URL to a
// local fixture repository.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fetchSubmodules,
  formatSubmoduleReport,
  parseGitHubSubmoduleUrl,
  resolveRelativeSubmoduleUrl,
  submoduleGitDirName,
  type FetchSubmodulesOptions,
  type GitHubRepository,
} from "../submodules";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

/** A well-formed commit id that no fixture contains. */
const MISSING_COMMIT = "0123456789abcdef".repeat(3).slice(0, 40);

let root: string;
let previousHome: string | undefined;
let fixtures: Map<string, string>;

function cloneSource(repository: GitHubRepository): string {
  return (
    fixtures.get(`${repository.owner}/${repository.repo}`) ??
    path.join(root, "missing-fixture", repository.owner, repository.repo)
  );
}

/** A fixture repository standing in for github.com/<slug>. */
function fixture(
  slug: string,
  commits: Array<Record<string, string>>,
  setup?: (dir: string) => void,
): { dir: string; shas: string[] } {
  const dir = path.join(root, "github", slug);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const shas: string[] = [];
  for (const files of commits) {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
    }
    git(dir, "add", "-A");
    setup?.(dir);
    git(dir, "commit", "-q", "--allow-empty", "-m", `commit ${shas.length}`);
    shas.push(git(dir, "rev-parse", "HEAD"));
  }
  fixtures.set(slug, dir);
  return { dir, shas };
}

function addGitlink(repo: string, gitlinkPath: string, sha: string): void {
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${sha},${gitlinkPath}`);
}

/** A superproject with literal `.gitmodules` text and gitlinks; returns a
 * linked worktree of it, like a Zeros workspace. */
function superproject(opts: {
  gitmodules?: string;
  gitlinks?: Array<[string, string]>;
  files?: Record<string, string>;
  origin?: string;
  dir?: string;
}): { repo: string; workspace: string } {
  const repo = opts.dir ?? path.join(root, "super");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  if (opts.origin) git(repo, "remote", "add", "origin", opts.origin);
  for (const [file, body] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), body);
  }
  if (opts.gitmodules !== undefined) {
    writeFileSync(path.join(repo, ".gitmodules"), opts.gitmodules);
  }
  git(repo, "add", "-A");
  for (const [gitlinkPath, sha] of opts.gitlinks ?? []) addGitlink(repo, gitlinkPath, sha);
  git(repo, "commit", "-q", "--allow-empty", "-m", "super");
  const workspace = path.join(root, `${path.basename(repo)}-workspace`);
  git(repo, "worktree", "add", "-q", workspace, "-b", `ws-${path.basename(repo)}`);
  return { repo, workspace };
}

function run(workspace: string, extra: Partial<FetchSubmodulesOptions> = {}) {
  return fetchSubmodules({ workspacePath: workspace, remote: "origin", cloneSource, ...extra });
}

function moduleDirs(repo: string, worktree = "super-workspace"): string[] {
  const modules = path.join(repo, ".git", "worktrees", worktree, "modules");
  return existsSync(modules) ? readdirSync(modules).sort() : [];
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zeros-submodules-")));
  fixtures = new Map();
  previousHome = process.env.HOME;
  const home = path.join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe("submodule URL policy", () => {
  it.each([
    ["https://github.com/acme/lib", "acme/lib"],
    ["https://github.com/acme/lib.git", "acme/lib"],
    ["https://github.com/acme/lib/", "acme/lib"],
    ["git@github.com:acme/lib.git", "acme/lib"],
    ["git@github.com:acme/lib", "acme/lib"],
  ])("accepts %s", (url, slug) => {
    const parsed = parseGitHubSubmoduleUrl(url);
    expect(parsed && `${parsed.owner}/${parsed.repo}`).toBe(slug);
  });

  it.each([
    "https://gitlab.com/acme/lib",
    "https://github.com.evil.test/acme/lib",
    "https://GitHub.com/acme/lib",
    "https://user:token@github.com/acme/lib",
    "https://github.com:443/acme/lib",
    "https://github.com/acme/lib?x=1",
    "https://github.com/acme/lib#x",
    "https://github.com/acme/lib/extra",
    "http://github.com/acme/lib",
    "ssh://git@github.com/acme/lib",
    "git://github.com/acme/lib",
    "deploy@github.com:acme/lib",
    "git@gitlab.com:acme/lib",
    "file:///tmp/lib",
    "/tmp/lib",
    "ext::sh -c touch% /tmp/pwned",
    "fd::17",
    "-uhttps://github.com/acme/lib",
    "https://github.com/../lib",
    "https://github.com/acme/..",
  ])("refuses %s", (url) => {
    expect(parseGitHubSubmoduleUrl(url)).toBeNull();
  });

  it("resolves relative URLs only inside github.com", () => {
    const base = parseGitHubSubmoduleUrl("https://github.com/acme/super.git");
    expect(resolveRelativeSubmoduleUrl("../lib.git", base)?.url).toBe("https://github.com/acme/lib.git");
    expect(resolveRelativeSubmoduleUrl("../../other/lib", base)?.url).toBe("https://github.com/other/lib.git");
    expect(resolveRelativeSubmoduleUrl("../../../lib", base)).toBeNull();
    expect(resolveRelativeSubmoduleUrl("./lib", base)).toBeNull();
    expect(resolveRelativeSubmoduleUrl("../lib", null)).toBeNull();
    const ssh = parseGitHubSubmoduleUrl("git@github.com:acme/super.git");
    expect(resolveRelativeSubmoduleUrl("../lib", ssh)?.url).toBe("git@github.com:acme/lib.git");
  });
});

describe("fetchSubmodules", () => {
  it("does nothing for a repository without submodules", async () => {
    const { workspace } = superproject({ files: { "README.md": "x" } });
    const result = await run(workspace);
    expect(result.outcomes).toEqual([]);
    expect(formatSubmoduleReport(result)).toBeNull();
  });

  it("fetches https and ssh github.com submodules at their pinned commits", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "one" }, { "a.txt": "two" }]);
    const ui = fixture("acme/ui", [{ "ui.txt": "ui" }]);
    const { repo, workspace } = superproject({
      gitmodules: [
        '[submodule "lib"]', "\tpath = vendor/lib", "\turl = https://github.com/acme/lib.git",
        '[submodule "ui"]', "\tpath = ui", "\turl = git@github.com:acme/ui",
      ].join("\n"),
      gitlinks: [["vendor/lib", lib.shas[0]!], ["ui", ui.shas[0]!]],
    });

    const result = await run(workspace);
    expect(result.outcomes.map((o) => [o.path, o.status])).toEqual([
      ["vendor/lib", "fetched"],
      ["ui", "fetched"],
    ]);
    expect(readFileSync(path.join(workspace, "vendor/lib/a.txt"), "utf8")).toBe("one");
    expect(git(path.join(workspace, "vendor/lib"), "rev-parse", "HEAD")).toBe(lib.shas[0]);
    // Git directories live in the workspace's own Git metadata, keyed by digest.
    expect(moduleDirs(repo)).toEqual([submoduleGitDirName("lib"), submoduleGitDirName("ui")].sort());
    // No submodule config is registered anywhere, so later commands never recurse.
    expect(git(repo, "config", "--list", "--show-origin")).not.toMatch(/submodule\./i);
    expect(formatSubmoduleReport(result)).toBe("Submodules: 2 fetched, 0 skipped, 0 failed.\r\n\r\n");
  });

  it("skips every URL that is not an approved github.com address, by name", async () => {
    const marker = path.join(root, "ext-ran");
    const local = fixture("local/repo", [{ "x": "x" }]);
    const sha = local.shas[0]!;
    const entries: Array<[string, string]> = [
      ["gitlab", "https://gitlab.com/acme/lib"],
      ["file", `file://${local.dir}`],
      ["abs", local.dir],
      ["bare", "some/path"],
      ["rel", "../lib.git"],
      ["ext", `ext::sh -c touch% ${marker}`],
      ["sshurl", "ssh://git@github.com/acme/lib"],
      ["token", "https://x-access-token:SECRET123@github.com/acme/lib"],
    ];
    const { workspace } = superproject({
      origin: local.dir,
      gitmodules: entries.map(([name, url]) => `[submodule "${name}"]\n\tpath = m/${name}\n\turl = ${url}`).join("\n"),
      gitlinks: entries.map(([name]) => [`m/${name}`, sha] as [string, string]),
    });

    const result = await run(workspace);
    const reasons = Object.fromEntries(result.outcomes.map((o) => [o.name, `${o.status}: ${o.reason}`]));
    expect(reasons).toEqual({
      gitlab: "skipped: only github.com submodules are followed",
      file: "skipped: local paths are not followed",
      abs: "skipped: local paths are not followed",
      bare: "skipped: local paths are not followed",
      rel: "skipped: relative URL does not resolve to a github.com repository",
      ext: "skipped: remote-helper transports are not followed",
      sshurl: "skipped: only https://github.com/<owner>/<repo> and git@github.com:<owner>/<repo> URLs are followed",
      token: "skipped: only https://github.com/<owner>/<repo> and git@github.com:<owner>/<repo> URLs are followed",
    });
    expect(existsSync(marker)).toBe(false);
    for (const [name] of entries) expect(readdirSync(path.join(workspace, "m", name))).toEqual([]);
    const report = formatSubmoduleReport(result)!;
    expect(report).toMatch(/^Submodules: 0 fetched, 8 skipped, 0 failed\./);
    expect(report).toContain("skipped: m/gitlab: only github.com submodules are followed");
    expect(report).not.toContain("SECRET123");
    expect(report).not.toContain(local.dir);
  });

  it("resolves relative URLs against a github.com superproject remote", async () => {
    const lib = fixture("acme/lib", [{ "lib.txt": "lib" }]);
    const { workspace } = superproject({
      origin: "https://github.com/acme/super.git",
      gitmodules: [
        '[submodule "lib"]', "\tpath = lib", "\turl = ../lib.git",
        '[submodule "escape"]', "\tpath = escape", "\turl = ../../../elsewhere",
      ].join("\n"),
      gitlinks: [["lib", lib.shas[0]!], ["escape", lib.shas[0]!]],
    });
    const result = await run(workspace);
    expect(result.outcomes.map((o) => [o.name, o.status, o.repository])).toEqual([
      ["lib", "fetched", "github.com/acme/lib"],
      ["escape", "skipped", undefined],
    ]);
  });

  it("never runs a command from .gitmodules, repository config, hooks, filters or templates", async () => {
    const markers = path.join(root, "markers");
    mkdirSync(markers);
    const touch = (name: string) => `touch ${path.join(markers, name)}`;
    const script = (name: string) => {
      const file = path.join(root, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\n${touch(name)}\ncat\n`);
      chmodSync(file, 0o755);
      return file;
    };
    // The submodule's own content asks for a filter on every file.
    const lib = fixture("acme/lib", [{ ".gitattributes": "* filter=evil diff=evil\n", "a.txt": "content\n" }]);
    const evil = fixture("evil/lib", [{ "evil.txt": "evil" }]);
    const hooks = path.join(root, "global-hooks");
    mkdirSync(hooks);
    for (const hook of ["post-checkout", "post-clone", "reference-transaction", "pre-auto-gc"]) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\n${touch(`global-${hook}`)}\n`);
      chmodSync(path.join(hooks, hook), 0o755);
    }
    const template = path.join(root, "template");
    mkdirSync(path.join(template, "hooks"), { recursive: true });
    writeFileSync(path.join(template, "hooks", "post-checkout"), `#!/bin/sh\n${touch("template-hook")}\n`);
    chmodSync(path.join(template, "hooks", "post-checkout"), 0o755);
    const { repo, workspace } = superproject({
      gitmodules: [
        '[submodule "lib"]',
        "\tpath = lib",
        "\turl = https://github.com/acme/lib",
        `\tupdate = !${touch("update")}`,
        "\tfetchRecurseSubmodules = true",
        "\tbranch = main",
      ].join("\n"),
      gitlinks: [["lib", lib.shas[0]!]],
    });
    git(repo, "config", "core.sshCommand", touch("ssh-command"));
    git(repo, "config", `url.${evil.dir}.insteadOf`, lib.dir);
    git(repo, "config", "submodule.recurse", "true");
    mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\n${touch("repo-hook")}\n`);
    chmodSync(path.join(repo, ".git", "hooks", "post-checkout"), 0o755);
    // Written after the fixtures exist: the user's own config defines the filter, fsmonitor, hooks and template.
    writeFileSync(
      path.join(process.env.HOME!, ".gitconfig"),
      [
        "[filter \"evil\"]", `\tsmudge = ${script("smudge")}`, `\tclean = ${script("clean")}`, `\tprocess = ${script("process")}`, "\trequired = true",
        "[diff \"evil\"]", `\ttextconv = ${script("textconv")}`,
        "[core]", `\tfsmonitor = ${script("fsmonitor")}`, `\thooksPath = ${hooks}`,
        "[init]", `\ttemplateDir = ${template}`,
      ].join("\n"),
    );

    const result = await run(workspace);
    expect(result.outcomes.map((o) => o.status)).toEqual(["fetched"]);
    expect(readdirSync(markers)).toEqual([]);
    // The repository's insteadOf did not redirect the clone.
    expect(readFileSync(path.join(workspace, "lib", "a.txt"), "utf8")).toBe("content\n");
    expect(existsSync(path.join(workspace, "lib", "evil.txt"))).toBe(false);
    // The template's hooks were not copied into the new Git directory.
    const moduleGitDir = path.join(repo, ".git", "worktrees", "super-workspace", "modules", submoduleGitDirName("lib"));
    expect(existsSync(moduleGitDir)).toBe(true);
    expect(existsSync(path.join(moduleGitDir, "hooks", "post-checkout"))).toBe(false);

    // Control: the same checkout through plain Git runs the hostile filter.
    rmSync(path.join(workspace, "lib", "a.txt"));
    expect(() => git(path.join(workspace, "lib"), "checkout", "--", "a.txt")).toThrow(/filter evil failed/);
    expect(readdirSync(markers)).toContain("process");
  });

  it("refuses paths that leave the workspace or pass through a symlink", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "a" }]);
    const sha = lib.shas[0]!;
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const { workspace } = superproject({
      gitmodules: [
        ["up", "../outside"], ["abs", outside], ["dots", "a/../../outside"], ["linked", "vendor/lib"],
      ].map(([name, p]) => `[submodule "${name}"]\n\tpath = ${p}\n\turl = https://github.com/acme/lib`).join("\n"),
      gitlinks: [["vendor/lib", sha]],
    });
    rmSync(path.join(workspace, "vendor"), { recursive: true });
    mkdirSync(path.join(outside, "lib"));
    symlinkSync(outside, path.join(workspace, "vendor"));

    const result = await run(workspace);
    expect(result.outcomes.map((o) => [o.name, o.reason])).toEqual([
      ["up", "path leaves the workspace"],
      ["abs", "path is absolute"],
      ["dots", "path leaves the workspace"],
      ["linked", "a symlink is in the path"],
    ]);
    expect(readdirSync(outside)).toEqual(["lib"]);
    expect(readdirSync(path.join(outside, "lib"))).toEqual([]);
  });

  it.each([
    [".Git/lib", "a path component names .git"],
    ["vendor/.GIT", "a path component names .git"],
    [".g\u200cit/lib", "a path component names .git"],
    ["vendor/.git\ufeff", "a path component names .git"],
    [".git./lib", "a path component names .git"],
    ["GIT~1/lib", "a path component names .git"],
    [".zeros/lib", "paths under .zeros are reserved for Zeros"],
    ["vendor/.Zeros/lib", "paths under .zeros are reserved for Zeros"],
    ["vendor\\\\lib", "path contains a control character, backslash or colon"],
    ["vendor/li:b", "path contains a control character, backslash or colon"],
  ])("refuses the submodule path %j", async (submodulePath, reason) => {
    fixture("acme/lib", [{ "a.txt": "a" }]);
    const { workspace } = superproject({
      gitmodules: `[submodule "lib"]\n\tpath = ${submodulePath}\n\turl = https://github.com/acme/lib`,
    });
    const result = await run(workspace);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ status: "skipped", reason }),
    ]);
  });

  it("skips everything when .gitmodules cannot be parsed", async () => {
    const { workspace } = superproject({ gitmodules: '[submodule "lib"]\n\tpath = "unterminated\n' });
    const result = await run(workspace);
    expect(result).toEqual({ outcomes: [], notice: ".gitmodules could not be parsed; its submodules were skipped" });
    expect(formatSubmoduleReport(result)).toMatch(/could not be parsed/);
  });

  it("refuses to write through a symlinked Git modules folder", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "a" }]);
    const { repo, workspace } = superproject({
      gitmodules: '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/acme/lib',
      gitlinks: [["lib", lib.shas[0]!]],
    });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(repo, ".git", "worktrees", "super-workspace", "modules"));
    const result = await run(workspace);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ status: "skipped", reason: "the workspace's Git modules folder is not a plain folder" }),
    ]);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a path that collides with a tracked path by case", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "a" }]);
    const { workspace } = superproject({
      files: { "Docs/readme.md": "docs" },
      gitmodules: '[submodule "docs"]\n\tpath = docs\n\turl = https://github.com/acme/lib',
      gitlinks: [["docs", lib.shas[0]!]],
    });
    const result = await run(workspace);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "path collides with another tracked path that differs only by case",
      }),
    ]);
    expect(readdirSync(path.join(workspace, "docs"))).toEqual([]);
  });

  it("keys Git directories by a digest of the name, never the name itself", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "a" }]);
    const sha = lib.shas[0]!;
    const names: Array<[string, string]> = [
      ["Lib", "one"], ["lib", "two"], ["a", "three"], ["a/hooks", "four"], ["x/../../escape", "five"],
    ];
    const { repo, workspace } = superproject({
      gitmodules: names.map(([name, p]) => `[submodule "${name}"]\n\tpath = ${p}\n\turl = https://github.com/acme/lib`).join("\n"),
      gitlinks: names.map(([, p]) => [p, sha] as [string, string]),
    });
    const result = await run(workspace);
    expect(result.outcomes.map((o) => [o.name, o.status, o.reason])).toEqual([
      ["Lib", "fetched", undefined],
      ["lib", "fetched", undefined],
      ["a", "fetched", undefined],
      ["a/hooks", "fetched", undefined],
      ["x/../../escape", "skipped", "name contains .."],
    ]);
    const dirs = moduleDirs(repo);
    expect(dirs).toEqual(["Lib", "lib", "a", "a/hooks"].map(submoduleGitDirName).sort());
    expect(new Set(dirs.map((d) => d.toLowerCase())).size).toBe(4);
    for (const dir of dirs) expect(dir).toMatch(/^[0-9a-f]{64}$/);
    // `a/hooks` is not inside `a`'s Git directory.
    expect(existsSync(path.join(repo, ".git", "worktrees", "super-workspace", "modules", submoduleGitDirName("a"), "hooks", "..", "modules"))).toBe(false);
  });

  it("follows nested submodules to the depth bound, resolving relative URLs per level", async () => {
    const d = fixture("acme/d", [{ "d.txt": "d" }]);
    const c = fixture("acme/c", [{ "c.txt": "c", ".gitmodules": '[submodule "d"]\n\tpath = d\n\turl = ../d.git\n' }], (dir) => addGitlink(dir, "d", d.shas[0]!));
    const b = fixture("acme/b", [{ "b.txt": "b", ".gitmodules": '[submodule "c"]\n\tpath = c\n\turl = https://github.com/acme/c\n' }], (dir) => addGitlink(dir, "c", c.shas[0]!));
    const { workspace } = superproject({
      gitmodules: '[submodule "b"]\n\tpath = b\n\turl = https://github.com/acme/b',
      gitlinks: [["b", b.shas[0]!]],
    });
    const result = await run(workspace);
    expect(result.outcomes.map((o) => [o.path, o.status, o.reason])).toEqual([
      ["b", "fetched", undefined],
      ["b/c", "fetched", undefined],
      ["b/c/d", "fetched", undefined],
    ]);
    expect(readFileSync(path.join(workspace, "b/c/d/d.txt"), "utf8")).toBe("d");

    const shallow = superproject({
      dir: path.join(root, "shallow"),
      gitmodules: '[submodule "b"]\n\tpath = b\n\turl = https://github.com/acme/b',
      gitlinks: [["b", b.shas[0]!]],
    });
    const bounded = await run(shallow.workspace, { limits: { maxDepth: 2 } });
    expect(bounded.outcomes.map((o) => [o.path, o.status, o.reason])).toEqual([
      ["b", "fetched", undefined],
      ["b/c", "fetched", undefined],
      ["b/c/d", "skipped", "nested deeper than 2 levels"],
    ]);
    expect(readdirSync(path.join(shallow.workspace, "b/c/d"))).toEqual([]);
  });

  it("stops at the count bound", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "a" }]);
    const { workspace } = superproject({
      gitmodules: ["one", "two", "three"].map((n) => `[submodule "${n}"]\n\tpath = ${n}\n\turl = https://github.com/acme/lib`).join("\n"),
      gitlinks: ["one", "two", "three"].map((n) => [n, lib.shas[0]!] as [string, string]),
    });
    const result = await run(workspace, { limits: { maxCount: 2 } });
    expect(result.outcomes.map((o) => [o.name, o.status, o.reason])).toEqual([
      ["one", "fetched", undefined],
      ["two", "fetched", undefined],
      ["three", "skipped", "more than 2 submodules"],
    ]);
  });

  it("reports a missing pinned commit as failed and leaves an empty folder", async () => {
    const lib = fixture("acme/lib", [{ "a.txt": "a" }]);
    const { repo, workspace } = superproject({
      gitmodules: '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/acme/lib',
      gitlinks: [["lib", MISSING_COMMIT]],
    });
    void lib;
    const result = await run(workspace);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ status: "failed", reason: "git clone or checkout failed" }),
    ]);
    expect(readdirSync(path.join(workspace, "lib"))).toEqual([]);
    expect(moduleDirs(repo)).toEqual([]);
  });

  describe("a private submodule the user cannot read", () => {
    let server: Server;
    let requests: string[];
    beforeEach(async () => {
      requests = [];
      server = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' });
        res.end("Unauthorized");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("is reported as failed with a clear reason and the workspace stays usable", async () => {
      const { port } = server.address() as AddressInfo;
      const { workspace } = superproject({
        gitmodules: '[submodule "private"]\n\tpath = private\n\turl = https://github.com/acme/private',
        gitlinks: [["private", MISSING_COMMIT]],
      });
      const result = await run(workspace, {
        cloneSource: (r) => `http://127.0.0.1:${port}/${r.owner}/${r.repo}.git`,
      });
      expect(requests.some((url) => url.startsWith("/acme/private.git/info/refs"))).toBe(true);
      expect(result.outcomes).toEqual([
        expect.objectContaining({
          path: "private",
          status: "failed",
          repository: "github.com/acme/private",
          reason: expect.stringMatching(/^GitHub refused access/),
        }),
      ]);
      expect(formatSubmoduleReport(result)).toContain(
        "failed: private (github.com/acme/private): GitHub refused access",
      );
      expect(readdirSync(path.join(workspace, "private"))).toEqual([]);
      expect(git(workspace, "status", "--porcelain")).toBe("");
    });
  });

  it("strips control sequences from repository-controlled names in the report", () => {
    const report = formatSubmoduleReport({
      outcomes: [{ path: "a\u001b[31mred", name: "x", status: "skipped", reason: "r" }],
    })!;
    expect(report).not.toContain("\u001b");
    expect(report).toContain("a?[31mred");
  });
});
