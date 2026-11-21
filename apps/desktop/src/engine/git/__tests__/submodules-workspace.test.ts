// The submodule step on a workspace made by the real create path: the engine's
// own status and Changes reads stay clean, later Git does not recurse, delete
// still works, and the shipped entry point clones the real github.com URL.

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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  changeCounts,
  closeState,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  setStateRootForTesting,
  status,
} from "..";
import { opSettingsWrite } from "../../settings/ops";
import {
  fetchCreatedWorkspaceSubmodules,
  fetchSubmodules,
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

let root: string;
let repoRoot: string;
let lib: string;
let libCommits: string[];
const previous = { HOME: process.env.HOME, settings: process.env.ZEROS_USER_SETTINGS_DIR };

function commit(dir: string, file: string, body: string): string {
  writeFileSync(path.join(dir, file), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `${file}=${body}`);
  return git(dir, "rev-parse", "HEAD");
}

const cloneSource = (repository: GitHubRepository) =>
  repository.owner === "acme" && repository.repo === "lib"
    ? lib
    : path.join(root, "missing", repository.repo);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zeros-submodule-ws-")));
  process.env.HOME = path.join(root, "home");
  process.env.ZEROS_USER_SETTINGS_DIR = path.join(root, "user-settings");
  mkdirSync(process.env.HOME);
  setStateRootForTesting(path.join(root, "state"));

  lib = path.join(root, "github", "acme", "lib");
  mkdirSync(lib, { recursive: true });
  git(lib, "init", "-q", "-b", "main");
  libCommits = [commit(lib, "lib.txt", "one")];

  const bare = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  repoRoot = path.join(root, "repo");
  mkdirSync(repoRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "remote", "add", "origin", bare);
  writeFileSync(
    path.join(repoRoot, ".gitmodules"),
    [
      '[submodule "lib"]', "\tpath = vendor/lib", "\turl = https://github.com/acme/lib.git",
      '[submodule "secret"]', "\tpath = vendor/secret", "\turl = https://github.com/acme/secret.git",
      '[submodule "elsewhere"]', "\tpath = vendor/elsewhere", "\turl = https://gitlab.com/acme/elsewhere.git",
    ].join("\n"),
  );
  writeFileSync(path.join(repoRoot, "README.md"), "# repo\n");
  git(repoRoot, "add", "-A");
  for (const gitlink of ["vendor/lib", "vendor/secret", "vendor/elsewhere"]) {
    git(repoRoot, "update-index", "--add", "--cacheinfo", `160000,${libCommits[0]},${gitlink}`);
  }
  git(repoRoot, "commit", "-q", "-m", "init");
  git(repoRoot, "push", "-q", "-u", "origin", "main");
  git(repoRoot, "remote", "set-head", "origin", "main");
});

afterEach(() => {
  closeState();
  setStateRootForTesting(null);
  for (const [key, value] of [["HOME", previous.HOME], ["ZEROS_USER_SETTINGS_DIR", previous.settings]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("submodules in a created Local workspace", () => {
  it("leaves the engine's status and every Changes scope clean, fetched or skipped", async () => {
    const created = await createWorkspace({ repoRoot });
    const ws = getWorkspace(created.workspaceId);
    const result = await fetchSubmodules({ workspacePath: ws.path, remote: "origin", cloneSource });
    expect(result.outcomes.map((o) => [o.path, o.status])).toEqual([
      ["vendor/lib", "fetched"],
      ["vendor/secret", "failed"],
      ["vendor/elsewhere", "skipped"],
    ]);
    expect(readFileSync(path.join(ws.path, "vendor/lib/lib.txt"), "utf8")).toBe("one");
    expect(readdirSync(path.join(ws.path, "vendor/secret"))).toEqual([]);
    expect(readdirSync(path.join(ws.path, "vendor/elsewhere"))).toEqual([]);

    expect(git(ws.path, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")).toBe("");
    const engineStatus = await status(ws.id);
    expect(engineStatus).toMatchObject({ staged: [], unstaged: [], untracked: [], conflicted: [] });
    expect(await changeCounts(ws.id)).toEqual({ all: 0, uncommitted: 0, staged: 0, unstaged: 0 });
  });

  it("registers nothing that makes a later git pull recurse", async () => {
    const created = await createWorkspace({ repoRoot });
    const ws = getWorkspace(created.workspaceId);
    await fetchSubmodules({ workspacePath: ws.path, remote: "origin", cloneSource });
    const submodule = path.join(ws.path, "vendor/lib");
    expect(git(submodule, "rev-parse", "HEAD")).toBe(libCommits[0]);

    // Upstream moves both the submodule and the superproject's gitlink.
    const next = commit(lib, "lib.txt", "two");
    git(repoRoot, "update-index", "--cacheinfo", `160000,${next},vendor/lib`);
    git(repoRoot, "commit", "-q", "-m", "bump lib");
    git(repoRoot, "push", "-q", "origin", "main");

    // A user's ordinary pull, with Git's own defaults (fetch.recurseSubmodules
    // = on-demand), neither fetches into nor updates the submodule.
    git(ws.path, "pull", "-q", "--no-rebase", "origin", "main");
    expect(git(ws.path, "rev-parse", "HEAD:vendor/lib")).toBe(next);
    expect(git(submodule, "rev-parse", "HEAD")).toBe(libCommits[0]);
    expect(() => git(submodule, "cat-file", "-e", `${next}^{commit}`)).toThrow();
    expect(git(repoRoot, "config", "--list")).not.toMatch(/^submodule\./im);
  });

  it("deletes a workspace whose submodules were fetched, Git directories included", async () => {
    const created = await createWorkspace({ repoRoot });
    const ws = getWorkspace(created.workspaceId);
    await fetchSubmodules({ workspacePath: ws.path, remote: "origin", cloneSource });
    const worktreeGitDir = git(ws.path, "rev-parse", "--absolute-git-dir");
    expect(readdirSync(path.join(worktreeGitDir, "modules"))).toHaveLength(1);

    await deleteWorkspace({ workspaceId: ws.id, includeBranch: true });
    expect(existsSync(ws.path)).toBe(false);
    expect(existsSync(worktreeGitDir)).toBe(false);
  });

  describe("the shipped entry point", () => {
    let server: Server;
    let requests: string[];
    beforeEach(async () => {
      requests = [];
      server = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' });
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      // The user's own Git config is the only redirect: Git applies it to the
      // real github.com URL exactly as it would for any fetch.
      const { port } = server.address() as AddressInfo;
      writeFileSync(
        path.join(process.env.HOME!, ".gitconfig"),
        `[url "http://127.0.0.1:${port}/"]\n\tinsteadOf = https://github.com/\n`,
      );
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("does nothing, and touches no network, while the setting is off", async () => {
      const created = await createWorkspace({ repoRoot });
      expect(await fetchCreatedWorkspaceSubmodules(created.workspaceId)).toBeNull();
      expect(requests).toEqual([]);
      expect(readdirSync(path.join(created.path, "vendor/lib"))).toEqual([]);
    });

    it("clones the real github.com URL with no override and reports each submodule", async () => {
      opSettingsWrite("repo-local", { git: { fetch_submodules: true } }, repoRoot);
      const created = await createWorkspace({ repoRoot });
      const report = await fetchCreatedWorkspaceSubmodules(created.workspaceId);

      expect(requests.filter((url) => url.includes("/info/refs")).map((url) => url.split("?")[0])).toEqual([
        "/acme/lib.git/info/refs",
        "/acme/secret.git/info/refs",
      ]);
      expect(report).toBe(
        [
          "Submodules: 0 fetched, 1 skipped, 2 failed.",
          "  failed: vendor/lib (github.com/acme/lib): GitHub refused access (a private repository the connected account cannot read, or it does not exist)",
          "  failed: vendor/secret (github.com/acme/secret): GitHub refused access (a private repository the connected account cannot read, or it does not exist)",
          "  skipped: vendor/elsewhere: only github.com submodules are followed",
          "",
          "",
        ].join("\r\n"),
      );
      expect(git(created.path, "status", "--porcelain", "--untracked-files=all")).toBe("");
    });

    it("has no test override a shipped engine could read", () => {
      const source = readFileSync(path.join(__dirname, "..", "submodules.ts"), "utf8");
      const entry = source.slice(source.indexOf("export async function fetchCreatedWorkspaceSubmodules"));
      expect(entry).not.toMatch(/cloneSource/);
      expect(source).not.toMatch(/process\.env/);
      expect(fetchCreatedWorkspaceSubmodules.length).toBeLessThanOrEqual(2);
    });
  });
});
