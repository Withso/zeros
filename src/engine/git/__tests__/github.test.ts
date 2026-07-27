// Phase 3 GitHub integration. Tests use *ForTesting seams to inject
// a fake Octokit + in-memory token store. We don't hit github.com.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createPr,
  createWorkspace,
  getAuthStatus,
  getPr,
  getRepositoryOwnerAvatar,
  getWorkspace,
  listPrs,
  markPrReady,
  mergePr,
  parseGitHubRemote,
  resetBehindByCacheForTesting,
  setOctokitFactoryForTesting,
  setPushForTesting,
  setStateRootForTesting,
  setTokenStoreForTesting,
  updatePr,
} from "..";

const execFileAsync = promisify(execFile);

// ── Test doubles ─────────────────────────────────────────

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

interface PrPayload {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  title: string;
  body: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; label: string; sha: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  node_id: string;
}

function makeOctokitMock() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const prs = new Map<number, PrPayload>();
  let nextPrNumber = 100;
  let user = { login: "test-user" };
  let userResponse: (() => unknown) | null = null;
  let repositoryOwner = {
    login: "Acme",
    type: "Organization",
    avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
  };
  const behindBy = new Map<string, number>();

  const fake = {
    users: {
      async getAuthenticated() {
        calls.push({ method: "users.getAuthenticated", args: {} });
        if (userResponse) return userResponse();
        return { data: user };
      },
      async getByUsername(args: { username: string }) {
        calls.push({ method: "users.getByUsername", args });
        return { data: repositoryOwner };
      },
    },
    pulls: {
      async create(args: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
        draft: boolean;
      }) {
        calls.push({ method: "pulls.create", args });
        const number = nextPrNumber++;
        const pr: PrPayload = {
          number,
          html_url: `https://github.com/${args.owner}/${args.repo}/pull/${number}`,
          state: "open",
          draft: args.draft,
          title: args.title,
          body: args.body,
          user: { login: "test-user" },
          base: { ref: args.base },
          head: {
            ref: args.head,
            label: `test-user:${args.head}`,
            sha: "a".repeat(40),
          },
          mergeable: true,
          mergeable_state: "clean",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          node_id: `MDExOlB1bGxSZXF1ZXN0${number}`,
        };
        prs.set(number, pr);
        return { data: pr };
      },
      async update(args: {
        owner: string;
        repo: string;
        pull_number: number;
        title?: string;
        body?: string;
      }) {
        calls.push({ method: "pulls.update", args });
        const pr = prs.get(args.pull_number);
        if (!pr) throw Object.assign(new Error("Not Found"), { status: 404 });
        if (args.title !== undefined) pr.title = args.title;
        if (args.body !== undefined) pr.body = args.body;
        pr.updated_at = new Date().toISOString();
        return { data: pr };
      },
      async get(args: { owner: string; repo: string; pull_number: number }) {
        calls.push({ method: "pulls.get", args });
        const pr = prs.get(args.pull_number);
        if (!pr) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: pr };
      },
      async list(args: { owner: string; repo: string; state?: string }) {
        calls.push({ method: "pulls.list", args });
        const all = Array.from(prs.values());
        const filtered =
          !args.state || args.state === "all"
            ? all
            : args.state === "open"
              ? all.filter((p) => p.state === "open")
              : all.filter((p) => p.state === "closed");
        return { data: filtered };
      },
      async merge(args: {
        owner: string;
        repo: string;
        pull_number: number;
        merge_method: string;
      }) {
        calls.push({ method: "pulls.merge", args });
        const pr = prs.get(args.pull_number);
        if (!pr) throw Object.assign(new Error("Not Found"), { status: 404 });
        pr.state = "closed";
        pr.merged_at = new Date().toISOString();
        pr.merge_commit_sha = "0".repeat(40);
        return { data: { sha: "0".repeat(40) } };
      },
    },
    repos: {
      async compareCommitsWithBasehead(args: {
        owner: string;
        repo: string;
        basehead: string;
        per_page: number;
      }) {
        calls.push({ method: "repos.compareCommitsWithBasehead", args });
        return { data: { behind_by: behindBy.get(args.basehead) ?? 0 } };
      },
    },
    async graphql(_query: string, _vars: unknown) {
      calls.push({ method: "graphql", args: _vars });
      // markPullRequestReadyForReview — flip draft -> false on the PR.
      const v = _vars as { id: string };
      for (const pr of prs.values()) {
        if (pr.node_id === v.id) {
          pr.draft = false;
        }
      }
      return {} as unknown;
    },
  };

  return {
    octokit: fake,
    calls,
    setUser(u: { login: string }) {
      user = u;
    },
    setUserResponse(fn: (() => unknown) | null) {
      userResponse = fn;
    },
    setRepoOwner(owner: typeof repositoryOwner) {
      repositoryOwner = owner;
    },
    prCount() {
      return prs.size;
    },
    getPr(n: number) {
      return prs.get(n);
    },
    setBehindBy(basehead: string, count: number) {
      behindBy.set(basehead, count);
    },
  };
}

// ── Setup ────────────────────────────────────────────────

describe("github", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;
  let store: ReturnType<typeof makeMemoryTokenStore>;
  let mock: ReturnType<typeof makeOctokitMock>;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-gh-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);

    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", [
      "remote",
      "add",
      "origin",
      "git@github.com:Acme/example.git",
    ], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# x\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;

    store = makeMemoryTokenStore();
    setTokenStoreForTesting(store.store);
    mock = makeOctokitMock();
    setOctokitFactoryForTesting((_token) => mock.octokit as never);
    // createPr now pushes the head branch before opening the PR — stub it so
    // tests don't make a real network push to the fake github.com origin.
    setPushForTesting(async () => ({ remoteRef: "origin/test", ahead: 0, behind: 0 }));
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    setTokenStoreForTesting(null);
    setOctokitFactoryForTesting(null);
    setPushForTesting(null);
    resetBehindByCacheForTesting();
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  describe("parseGitHubRemote", () => {
    it("parses ssh-style URLs", () => {
      const r = parseGitHubRemote("git@github.com:Acme/example.git");
      expect(r.owner).toBe("Acme");
      expect(r.repo).toBe("example");
    });

    it("parses https URLs", () => {
      const r = parseGitHubRemote("https://github.com/Acme/example");
      expect(r.owner).toBe("Acme");
      expect(r.repo).toBe("example");
    });

    it("parses URL-style SSH remotes and normalizes the GitHub host", () => {
      expect(
        parseGitHubRemote("ssh://git@SSH.GITHUB.COM:443/Acme/example.git"),
      ).toEqual({ owner: "Acme", repo: "example" });
    });

    it("rejects lookalike hosts and extra path segments", () => {
      expect(() =>
        parseGitHubRemote("https://github.com.example/Acme/example.git"),
      ).toThrow();
      expect(() =>
        parseGitHubRemote("https://github.com/group/Acme/example.git"),
      ).toThrow();
    });

    it("rejects non-github URLs", () => {
      expect(() =>
        parseGitHubRemote("https://gitlab.com/Acme/example"),
      ).toThrow();
    });
  });

  describe("getRepositoryOwnerAvatar", () => {
    it("loads the repository owner's organization avatar without requiring auth or repository visibility", async () => {
      await expect(
        getRepositoryOwnerAvatar("git@github.com:Acme/example.git"),
      ).resolves.toEqual({
        login: "Acme",
        type: "org",
        avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
      });
      expect(mock.calls).toContainEqual({
        method: "users.getByUsername",
        args: { username: "Acme" },
      });
    });

    it("normalizes a user owner and rejects unsafe avatar URLs", async () => {
      mock.setRepoOwner({
        login: "octocat",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      });
      await expect(
        getRepositoryOwnerAvatar("https://github.com/octocat/hello-world"),
      ).resolves.toMatchObject({ login: "octocat", type: "user" });

      mock.setRepoOwner({
        login: "octocat",
        type: "User",
        avatar_url: "http://avatars.githubusercontent.com/u/1",
      });
      await expect(
        getRepositoryOwnerAvatar("https://github.com/octocat/hello-world"),
      ).resolves.toBeNull();
    });
  });

  describe("getAuthStatus", () => {
    it("returns unauthenticated when no token is stored", async () => {
      const status = await getAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.login).toBeUndefined();
    });

    it("returns authenticated + login when token works", async () => {
      store.setToken("ghp_test_token");
      mock.setUser({ login: "Acme" });
      const status = await getAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.login).toBe("Acme");
    });

    it("clears the token on 401", async () => {
      store.setToken("ghp_revoked");
      mock.setUserResponse(() => {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      });
      const status = await getAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(await store.store.get()).toBeNull();
    });
  });

  describe("createPr", () => {
    beforeEach(() => {
      store.setToken("ghp_test_token");
    });

    it("creates a draft PR and updates the workspace row", async () => {
      const ws = getWorkspace(workspaceId);
      const pr = await createPr({
        workspaceId,
        title: "test PR",
        body: "test body",
      });
      expect(pr.number).toBeGreaterThan(0);
      expect(pr.state).toBe("draft");
      expect(pr.url).toMatch(/^https:\/\/github\.com\/Acme\/example\/pull\/\d+$/);
      expect(pr.baseBranch).toBe(ws.baseBranch);
      expect(pr.headBranch).toBe(ws.branch);

      const refreshed = getWorkspace(workspaceId);
      expect(refreshed.status).toBe("in-review");
      expect(refreshed.prNumber).toBe(pr.number);
      expect(refreshed.prState).toBe("draft");
      expect(refreshed.prUrl).toBe(pr.url);
    });

    it("network failure surfaces NETWORK_ERROR with cause preserved", async () => {
      const original = mock.octokit.pulls.create;
      mock.octokit.pulls.create = async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        });
      };
      await expect(
        createPr({ workspaceId, title: "t", body: "b" }),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      mock.octokit.pulls.create = original;
    });

    it("pushes the head branch before opening the PR", async () => {
      // The worktree branch is local-only by default; createPr must push it to
      // origin first, else GitHub 422s ("head sha can't be found").
      let pushedFor: string | null = null;
      setPushForTesting(async (args) => {
        pushedFor = args.workspaceId;
        return { remoteRef: "origin/test", ahead: 0, behind: 0 };
      });
      await createPr({ workspaceId, title: "t", body: "b" });
      expect(pushedFor).toBe(workspaceId);
    });

    it("retries as a non-draft PR when drafts are unsupported", async () => {
      // GitHub 422 for plans/repos that reject draft PRs.
      const original = mock.octokit.pulls.create;
      let attempts = 0;
      mock.octokit.pulls.create = async (args) => {
        attempts += 1;
        if (args.draft) {
          throw Object.assign(
            new Error("Draft pull requests are not supported in this repository."),
            { status: 422 },
          );
        }
        return original(args);
      };
      const pr = await createPr({ workspaceId, title: "t", body: "b", draft: true });
      expect(attempts).toBe(2); // draft attempt 422'd, then retried as non-draft
      expect(pr.number).toBeGreaterThan(0);
      mock.octokit.pulls.create = original;
    });
  });

  describe("markPrReady", () => {
    beforeEach(() => {
      store.setToken("ghp_test_token");
    });

    it("transitions a draft PR to ready", async () => {
      const draft = await createPr({
        workspaceId,
        title: "draft",
        body: "",
        draft: true,
      });
      expect(draft.state).toBe("draft");
      const ready = await markPrReady({
        workspaceId,
        prNumber: draft.number,
      });
      expect(ready.state).toBe("ready");
      const refreshed = getWorkspace(workspaceId);
      expect(refreshed.prState).toBe("ready");
    });
  });

  describe("updatePr", () => {
    beforeEach(() => {
      store.setToken("ghp_test_token");
    });

    it("updates title and body", async () => {
      const pr = await createPr({
        workspaceId,
        title: "before",
        body: "old",
      });
      const after = await updatePr({
        workspaceId,
        prNumber: pr.number,
        title: "after",
        body: "new",
      });
      expect(after.title).toBe("after");
      expect(after.body).toBe("new");
    });
  });

  describe("getPr / listPrs", () => {
    beforeEach(() => {
      store.setToken("ghp_test_token");
    });

    it("getPr round-trips", async () => {
      const pr = await createPr({ workspaceId, title: "t", body: "b" });
      const got = await getPr({ workspaceId, prNumber: pr.number });
      expect(got.number).toBe(pr.number);
      expect(got.title).toBe("t");
      expect(got.headSha).toBe("a".repeat(40));
    });

    it("recomputes behindBy when the PR base changes without a head push", async () => {
      const pr = await createPr({ workspaceId, title: "behind", body: "" });
      const payload = mock.getPr(pr.number)!;
      payload.mergeable_state = "behind";
      mock.setBehindBy(`main...${payload.head.label}`, 2);

      await expect(
        getPr({ workspaceId, prNumber: pr.number }),
      ).resolves.toMatchObject({ behindBy: 2 });

      payload.base.ref = "release";
      mock.setBehindBy(`release...${payload.head.label}`, 5);
      await expect(
        getPr({ workspaceId, prNumber: pr.number }),
      ).resolves.toMatchObject({ behindBy: 5 });

      expect(
        mock.calls.filter(
          (call) => call.method === "repos.compareCommitsWithBasehead",
        ),
      ).toHaveLength(2);
    });

    it("listPrs returns open PRs", async () => {
      await createPr({ workspaceId, title: "a", body: "" });
      await createPr({ workspaceId, title: "b", body: "" });
      const list = await listPrs({
        owner: "Acme",
        repo: "example",
        state: "open",
      });
      expect(list.length).toBe(2);
    });
  });

  describe("mergePr", () => {
    beforeEach(() => {
      store.setToken("ghp_test_token");
    });

    it("merges and bumps workspace status to done", async () => {
      const pr = await createPr({
        workspaceId,
        title: "ready to merge",
        body: "",
      });
      const result = await mergePr({
        workspaceId,
        prNumber: pr.number,
        method: "squash",
      });
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      const merged = await getPr({ workspaceId, prNumber: pr.number });
      expect(merged.mergeCommitSha).toBe(result.sha);
      const refreshed = getWorkspace(workspaceId);
      expect(refreshed.status).toBe("done");
      expect(refreshed.prState).toBe("merged");
    });
  });

  describe("auth fallthrough", () => {
    it("createPr without a token throws NOT_AUTHENTICATED", async () => {
      // Token is null at start of test.
      await expect(
        createPr({ workspaceId, title: "t", body: "b" }),
      ).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    });
  });

  describe("client ID resolution", () => {
    it("startDeviceFlow throws clearly when the client ID is still the placeholder", async () => {
      const { setClientIdForTesting, startDeviceFlow } = await import("..");
      setClientIdForTesting("Ov23liPLACEHOLDERPLACEHOLDER");
      const original = process.env.ZEROS_GITHUB_CLIENT_ID;
      delete process.env.ZEROS_GITHUB_CLIENT_ID;
      try {
        await expect(
          startDeviceFlow({ onVerification: () => {} }),
        ).rejects.toMatchObject({
          code: "NOT_AUTHENTICATED",
          message: expect.stringMatching(/client ID is unset/i),
        });
      } finally {
        if (original !== undefined) process.env.ZEROS_GITHUB_CLIENT_ID = original;
        setClientIdForTesting(null);
      }
    });

    it("ZEROS_GITHUB_CLIENT_ID env var overrides the placeholder", async () => {
      const { setClientIdForTesting, startDeviceFlow } = await import("..");
      // Placeholder fallback would normally fail. With env override, we
      // should fail later — on the actual network call, not on the
      // placeholder gate.
      setClientIdForTesting("Ov23liPLACEHOLDERPLACEHOLDER");
      const original = process.env.ZEROS_GITHUB_CLIENT_ID;
      process.env.ZEROS_GITHUB_CLIENT_ID = "Iv23liVALIDFAKEFAKEFAKE";
      try {
        // We pass an onVerification that never fires (no real GitHub
        // server to hit). The promise will reject with a network error,
        // NOT the placeholder error — which is what we want to assert.
        await expect(
          startDeviceFlow({ onVerification: () => {} }),
        ).rejects.toMatchObject({
          // The error code can be NOT_AUTHENTICATED (octokit wraps the
          // network failure as auth-failed) or just GITHUB_API_ERROR.
          // What we care about: the MESSAGE doesn't include "client ID
          // is unset".
          message: expect.not.stringMatching(/client ID is unset/i),
        });
      } finally {
        if (original === undefined) delete process.env.ZEROS_GITHUB_CLIENT_ID;
        else process.env.ZEROS_GITHUB_CLIENT_ID = original;
        setClientIdForTesting(null);
      }
    });
  });
});
