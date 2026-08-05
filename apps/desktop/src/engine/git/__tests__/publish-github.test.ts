// Publish-to-GitHub: create a private repo + push for a local project. Uses the
// *ForTesting seams to inject a fake Octokit + in-memory token store; the mock's
// `clone_url` points at a real LOCAL bare repo so the `git push` works offline.
// We never hit github.com.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkRepoNameAvailable,
  closeState,
  initRepoInPlace,
  listGithubOwners,
  publishRepoToGithub,
  setOctokitFactoryForTesting,
  setStateRootForTesting,
  setTokenStoreForTesting,
} from "..";

const execFileAsync = promisify(execFile);

function makeMemoryTokenStore() {
  let token: string | null = null;
  return {
    store: {
      async get() {
        return token;
      },
      async set(v: string) {
        token = v;
      },
      async clear() {
        token = null;
      },
    },
    setToken(v: string | null) {
      token = v;
    },
  };
}

/** Octokit double for the publish flow. `cloneUrl` is the URL the create call
 *  returns (a local bare repo path in tests). */
function makePublishOctokit(cloneUrl: string) {
  const calls: string[] = [];
  return {
    calls,
    octokit: {
      users: {
        async getAuthenticated() {
          calls.push("users.getAuthenticated");
          return { data: { login: "test-user", avatar_url: "a.png" } };
        },
      },
      orgs: {
        async listForAuthenticatedUser() {
          calls.push("orgs.listForAuthenticatedUser");
          return { data: [{ login: "acme-org", avatar_url: "b.png" }] };
        },
      },
      repos: {
        async get(args: { owner: string; repo: string }) {
          calls.push(`repos.get:${args.owner}/${args.repo}`);
          const e = new Error("Not Found") as Error & { status: number };
          e.status = 404; // available
          throw e;
        },
        async createForAuthenticatedUser(args: { name: string; private: boolean }) {
          calls.push(`repos.createForAuthenticatedUser:${args.name}:${args.private}`);
          return {
            data: {
              clone_url: cloneUrl,
              html_url: `https://github.com/test-user/${args.name}`,
              owner: { login: "test-user" },
              name: args.name,
            },
          };
        },
        async createInOrg(args: { org: string; name: string; private: boolean }) {
          calls.push(`repos.createInOrg:${args.org}/${args.name}:${args.private}`);
          return {
            data: {
              clone_url: cloneUrl,
              html_url: `https://github.com/${args.org}/${args.name}`,
              owner: { login: args.org },
              name: args.name,
            },
          };
        },
        async delete(args: { owner: string; repo: string }) {
          calls.push(`repos.delete:${args.owner}/${args.repo}`);
          return { status: 204 };
        },
      },
    },
  };
}

describe("publish to GitHub", () => {
  let workdir: string;
  let mock: ReturnType<typeof makePublishOctokit>;
  let store: ReturnType<typeof makeMemoryTokenStore>;
  let bare: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-publish-test-"));
    setStateRootForTesting(path.join(workdir, "state"));
    bare = path.join(workdir, "remote");
    await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    mock = makePublishOctokit(bare);
    store = makeMemoryTokenStore();
    store.setToken("gh-token");
    setTokenStoreForTesting(store.store);
    setOctokitFactoryForTesting(() => mock.octokit as never);
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    setTokenStoreForTesting(null);
    setOctokitFactoryForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("git-inits a non-git folder, creates a private repo, wires origin + pushes", async () => {
    const folder = path.join(workdir, "myproj");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "index.js"), "console.log(1)\n");

    const res = await publishRepoToGithub({ repoRoot: folder, name: "myproj" });

    expect(res.originUrl).toBe(bare);
    expect(res.owner).toBe("test-user");
    expect(res.repo).toBe("myproj");
    // Private by default.
    expect(mock.calls).toContain("repos.createForAuthenticatedUser:myproj:true");

    // The folder is now a git repo with origin set to the created repo.
    const origin = (
      await execFileAsync("git", ["-C", folder, "remote", "get-url", "origin"])
    ).stdout.trim();
    expect(origin).toBe(bare);
    // The bare remote received `main` with our initial commit + file.
    const remoteLog = (
      await execFileAsync("git", ["-C", bare, "log", "--oneline", "-1"])
    ).stdout;
    expect(remoteLog).toContain("Initial commit");
    const remoteFiles = (
      await execFileAsync("git", ["-C", bare, "ls-tree", "--name-only", "main"])
    ).stdout;
    expect(remoteFiles).toContain("index.js");
  });

  it("publishes a git-but-remoteless repo (existing commits) without re-init", async () => {
    const folder = path.join(workdir, "existing");
    await mkdir(folder, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    await execFileAsync("git", ["config", "user.email", "e@e"], { cwd: folder });
    await execFileAsync("git", ["config", "user.name", "n"], { cwd: folder });
    await writeFile(path.join(folder, "a.txt"), "hi\n");
    await execFileAsync("git", ["add", "."], { cwd: folder });
    await execFileAsync("git", ["commit", "-q", "-m", "real commit"], {
      cwd: folder,
    });

    const res = await publishRepoToGithub({ repoRoot: folder, name: "existing" });
    expect(res.originUrl).toBe(bare);
    // The user's own commit (not an engine "Initial commit") was pushed.
    const remoteLog = (
      await execFileAsync("git", ["-C", bare, "log", "--oneline", "-1"])
    ).stdout;
    expect(remoteLog).toContain("real commit");
  });

  it("routes an org owner through createInOrg", async () => {
    const folder = path.join(workdir, "orgproj");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "x"), "1\n");
    const res = await publishRepoToGithub({
      repoRoot: folder,
      name: "orgproj",
      owner: "acme-org",
    });
    expect(res.owner).toBe("acme-org");
    expect(mock.calls).toContain("repos.createInOrg:acme-org/orgproj:true");
  });

  it("honors the repository's configured remote name", async () => {
    const folder = path.join(workdir, "custom-remote");
    await mkdir(path.join(folder, ".zeros"), { recursive: true });
    await writeFile(
      path.join(folder, ".zeros", "settings.local.toml"),
      '[git]\nremote = "github"\n',
    );
    await writeFile(path.join(folder, "x"), "1\n");

    await publishRepoToGithub({ repoRoot: folder, name: "custom-remote" });

    const configuredUrl = (
      await execFileAsync("git", [
        "-C",
        folder,
        "remote",
        "get-url",
        "github",
      ])
    ).stdout.trim();
    expect(configuredUrl).toBe(bare);
    expect(
      (await execFileAsync("git", ["-C", folder, "remote"])).stdout
        .trim()
        .split("\n"),
    ).not.toContain("origin");
  });

  it("deletes a just-created GitHub repo and restores local remotes when push fails", async () => {
    const folder = path.join(workdir, "broken-publish");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "x"), "1\n");
    const missingRemote = path.join(workdir, "missing", "remote.git");
    mock = makePublishOctokit(missingRemote);
    setOctokitFactoryForTesting(() => mock.octokit as never);

    await expect(
      publishRepoToGithub({ repoRoot: folder, name: "broken-publish" }),
    ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });

    expect(mock.calls).toContain(
      "repos.delete:test-user/broken-publish",
    );
    expect(
      (await execFileAsync("git", ["-C", folder, "remote"])).stdout.trim(),
    ).toBe("");
  });

  // Deleting a repository needs delete_repo / Administration:write, which none
  // of the selectable auth methods requests — so this DELETE commonly 403s. If
  // the local remote were unwired anyway the user would be left with an orphan
  // repo on GitHub, a taken name, and no remote to retry the push against.
  it("keeps the local remote when GitHub refuses to delete the new repo", async () => {
    const folder = path.join(workdir, "undeletable-publish");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "x"), "1\n");
    const missingRemote = path.join(workdir, "missing", "remote.git");
    mock = makePublishOctokit(missingRemote);
    mock.octokit.repos.delete = async (args: {
      owner: string;
      repo: string;
    }) => {
      mock.calls.push(`repos.delete:${args.owner}/${args.repo}`);
      throw Object.assign(new Error("Must have admin rights to Repository."), {
        status: 403,
      });
    };
    setOctokitFactoryForTesting(() => mock.octokit as never);

    await expect(
      publishRepoToGithub({ repoRoot: folder, name: "undeletable-publish" }),
    ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });

    expect(mock.calls).toContain("repos.delete:test-user/undeletable-publish");
    // Still wired to the created repo, so a retry / manual push can recover.
    expect(
      (await execFileAsync("git", ["-C", folder, "remote", "get-url", "origin"]))
        .stdout.trim(),
    ).toBe(missingRemote);
  });

  it("checkRepoNameAvailable: 404 → available", async () => {
    expect(await checkRepoNameAvailable({ owner: "test-user", name: "free" })).toEqual({
      available: true,
    });
  });

  it("listGithubOwners: returns the authed user first, then orgs", async () => {
    const owners = await listGithubOwners();
    expect(owners[0]).toMatchObject({ login: "test-user", type: "user" });
    expect(owners.some((o) => o.login === "acme-org" && o.type === "org")).toBe(true);
  });

  it("STOPS publishing once the token is cleared (sign-out invalidates the cached client)", async () => {
    // 1. An authenticated publish caches an Octokit client internally.
    const a = path.join(workdir, "stale-a");
    await mkdir(a, { recursive: true });
    await writeFile(path.join(a, "f.txt"), "1\n");
    await publishRepoToGithub({ repoRoot: a, name: "stale-a" });

    // 2. Sign out: the token store is emptied (mirrors seedGithubToken(null) —
    //    the host couriering a cleared token to the engine's working copy).
    store.setToken(null);

    // 3. A fresh publish MUST fail — a cleared token can no longer be served by
    //    the stale cached client. (Regression: getOctokit() used to return the
    //    cached client without re-reading the store, so publish kept working
    //    after sign-out.)
    const b = path.join(workdir, "stale-b");
    await mkdir(b, { recursive: true });
    await writeFile(path.join(b, "f.txt"), "1\n");
    await expect(
      publishRepoToGithub({ repoRoot: b, name: "stale-b" }),
    ).rejects.toThrow(/not signed in/i);
  });
});

describe("initRepoInPlace (local-only git init)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-initrepo-test-"));
  });

  afterEach(async () => {
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("git-inits a non-git folder + makes an initial commit, NO remote", async () => {
    const folder = path.join(workdir, "fresh");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "index.js"), "console.log(1)\n");

    const res = await initRepoInPlace(folder);

    expect(res.initialized).toBe(true);
    expect(res.branch).toBe("main");
    const head = (
      await execFileAsync("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    expect(head).toBe("main");
    const log = (
      await execFileAsync("git", ["-C", folder, "log", "--oneline", "-1"])
    ).stdout;
    expect(log).toContain("Initial commit");
    const tracked = (await execFileAsync("git", ["-C", folder, "ls-files"])).stdout;
    expect(tracked).toContain("index.js");
    // Local-only: no origin was added.
    const remotes = (await execFileAsync("git", ["-C", folder, "remote"])).stdout.trim();
    expect(remotes).toBe("");
  });

  // The three states below all left `git add -A` with an empty index, where a
  // plain `git commit` exits 1 ("nothing to commit") — so Initialize Git used to
  // fail on precisely the folders it exists to repair. Each must end with a real
  // HEAD, because that commit is the base `git worktree add` forks from.
  it("commits on a repo that was git-init'd but never committed (unborn HEAD)", async () => {
    const folder = path.join(workdir, "unborn");
    await mkdir(folder, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    await writeFile(path.join(folder, "a.txt"), "hi\n");

    const res = await initRepoInPlace(folder);

    expect(res.initialized).toBe(false); // already a repo → no re-init
    expect(res.branch).toBe("main");
    const tracked = (await execFileAsync("git", ["-C", folder, "ls-files"]))
      .stdout;
    expect(tracked).toContain("a.txt");
    const log = (
      await execFileAsync("git", ["-C", folder, "log", "--oneline", "-1"])
    ).stdout;
    expect(log).toContain("Initial commit");
  });

  it("initializes an EMPTY folder (nothing to commit) with an empty root commit", async () => {
    const folder = path.join(workdir, "empty");
    await mkdir(folder, { recursive: true });

    const res = await initRepoInPlace(folder);

    expect(res.initialized).toBe(true);
    const head = (
      await execFileAsync("git", [
        "-C",
        folder,
        "rev-parse",
        "--verify",
        "HEAD",
      ])
    ).stdout.trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // Empty commit — no files, but a valid base for a worktree.
    const tracked = (
      await execFileAsync("git", ["-C", folder, "ls-files"])
    ).stdout.trim();
    expect(tracked).toBe("");
  });

  it("initializes a folder whose every file is gitignored", async () => {
    const folder = path.join(workdir, "all-ignored");
    await mkdir(folder, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    await writeFile(path.join(folder, ".gitignore"), "*\n");
    await writeFile(path.join(folder, "build.log"), "noise\n");

    const res = await initRepoInPlace(folder);

    expect(res.initialized).toBe(false);
    const head = (
      await execFileAsync("git", [
        "-C",
        folder,
        "rev-parse",
        "--verify",
        "HEAD",
      ])
    ).stdout.trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves a repo it initialized able to host a worktree", async () => {
    const folder = path.join(workdir, "worktree-base");
    await mkdir(folder, { recursive: true });

    await initRepoInPlace(folder);

    // The whole point of the initial commit: `git worktree add` needs a
    // commit-ish to fork from. An empty root commit satisfies it.
    const wt = path.join(workdir, "worktree-base-wt");
    await execFileAsync("git", [
      "-C",
      folder,
      "worktree",
      "add",
      wt,
      "-b",
      "probe",
    ]);
    expect(existsSync(path.join(wt, ".git"))).toBe(true);
  });

  it("is idempotent on a repo that already has commits", async () => {
    const folder = path.join(workdir, "existing");
    await mkdir(folder, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    await execFileAsync("git", ["config", "user.email", "e@e"], { cwd: folder });
    await execFileAsync("git", ["config", "user.name", "n"], { cwd: folder });
    await writeFile(path.join(folder, "a.txt"), "hi\n");
    await execFileAsync("git", ["add", "."], { cwd: folder });
    await execFileAsync("git", ["commit", "-q", "-m", "real commit"], { cwd: folder });
    const before = (
      await execFileAsync("git", ["-C", folder, "rev-parse", "HEAD"])
    ).stdout.trim();

    const res = await initRepoInPlace(folder);

    expect(res.initialized).toBe(false); // already a repo → no re-init
    const after = (
      await execFileAsync("git", ["-C", folder, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(after).toBe(before); // no new commit
  });

  it("rejects a missing repoRoot", async () => {
    await expect(initRepoInPlace("")).rejects.toThrow();
  });
});
