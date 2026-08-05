// GitHub integration. Tests use *ForTesting seams to inject
// a fake Octokit + in-memory token store. We don't hit github.com.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createPr,
  createWorkspace,
  detectGhCli,
  getAuthStatus,
  getPr,
  getRepositoryOwnerAvatar,
  getWorkspace,
  getWorkspaceRepoAccess,
  listPrs,
  markPrReady,
  mergePr,
  parseGitHubRemote,
  readGhCliCredential,
  resetBehindByCacheForTesting,
  setOctokitFactoryForTesting,
  setPushForTesting,
  setRunFileForTesting,
  setStateRootForTesting,
  setTokenStoreForTesting,
  updatePr,
  verifyGithubToken,
} from "..";
// Not on the barrel: the process-local login cache is an internal hint for
// branch prefixing, not part of the git layer's public surface.
import { cachedGithubLogin } from "../github";

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

function makeGithubError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Error & {
  status: number;
  response: {
    status: number;
    data: { message: string };
    headers: Record<string, string>;
  };
} {
  return Object.assign(new Error(message), {
    status,
    response: {
      status,
      data: { message },
      headers,
    },
  });
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
  let repoPermissions: Record<string, boolean> | undefined = {
    admin: false,
    push: true,
    pull: true,
  };
  let repoGetResponse: (() => unknown) | null = null;
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
      async get(args: { owner: string; repo: string }) {
        calls.push({ method: "repos.get", args });
        if (repoGetResponse) return repoGetResponse();
        return { data: { permissions: repoPermissions } };
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
    setRepoPermissions(permissions: Record<string, boolean> | undefined) {
      repoPermissions = permissions;
    },
    setRepoGetResponse(fn: (() => unknown) | null) {
      repoGetResponse = fn;
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
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "git@github.com:Acme/example.git"],
      { cwd: repoRoot },
    );
    await execFileAsync("git", ["config", "user.email", "t@t"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# x\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: repoRoot,
    });

    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;

    store = makeMemoryTokenStore();
    setTokenStoreForTesting(store.store);
    mock = makeOctokitMock();
    setOctokitFactoryForTesting((_token) => mock.octokit as never);
    // createPr now pushes the head branch before opening the PR — stub it so
    // tests don't make a real network push to the fake github.com origin.
    setPushForTesting(async () => ({
      remoteRef: "origin/test",
      ahead: 0,
      behind: 0,
    }));
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    setTokenStoreForTesting(null);
    setOctokitFactoryForTesting(null);
    setPushForTesting(null);
    setRunFileForTesting(null);
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

    it("parses userless scp-style remotes", () => {
      expect(parseGitHubRemote("github.com:Acme/example.git")).toEqual({
        owner: "Acme",
        repo: "example",
      });
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

    it("never echoes an embedded remote credential in validation errors", () => {
      const secret = "embedded-super-secret";
      let thrown: unknown;
      try {
        parseGitHubRemote(
          `https://legacy-user:${secret}@github.com/Acme/example.git`,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(JSON.stringify(thrown)).not.toContain(secret);
      expect((thrown as Error).message).toMatch(/embedded credential/i);
    });

    it("rejects non-github URLs", () => {
      expect(() =>
        parseGitHubRemote("https://gitlab.com/Acme/example"),
      ).toThrow();
    });
  });

  describe("detectGhCli", () => {
    it("borrows the stored github.com login instead of inherited token overrides", async () => {
      const originalGhToken = process.env.GH_TOKEN;
      const originalGithubToken = process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = "stale-launcher-token";
      process.env.GITHUB_TOKEN = "another-launcher-token";
      const invocation = vi.fn(
        async (
          _command: string,
          _args: string[],
          _options?: { env?: Record<string, string | undefined> },
        ) => ({
          stdout: "stored-gh-token\n",
          stderr: "",
        }),
      );
      setRunFileForTesting(invocation);

      try {
        await detectGhCli();
      } finally {
        if (originalGhToken === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = originalGhToken;
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
      }

      expect(invocation).toHaveBeenCalledWith(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        expect.objectContaining({
          env: expect.not.objectContaining({
            GH_TOKEN: expect.anything(),
            GITHUB_TOKEN: expect.anything(),
          }),
        }),
      );
    });

    it("is a pure probe and does not replace the active token", async () => {
      store.setToken("existing-pat");
      setRunFileForTesting(async () => ({
        stdout: "borrowed-gh-token\n",
        stderr: "",
      }));
      mock.setUser({ login: "cli-user" });

      await expect(detectGhCli()).resolves.toEqual({
        available: true,
        authenticated: true,
        configured: true,
        health: "connected",
        login: "cli-user",
      });
      expect(await store.store.get()).toBe("existing-pat");
    });

    it("distinguishes a missing binary from a signed-out CLI", async () => {
      setRunFileForTesting(async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });
      await expect(detectGhCli()).resolves.toEqual({
        available: false,
        authenticated: false,
        configured: false,
        health: "not-connected",
      });

      setRunFileForTesting(async () => {
        throw Object.assign(new Error("not logged in"), { code: 1 });
      });
      await expect(detectGhCli()).resolves.toEqual({
        available: true,
        authenticated: false,
        configured: false,
        health: "not-connected",
      });
    });

    it("retains a CLI-owned token when its GitHub health probe is transient", async () => {
      setRunFileForTesting(async () => ({
        stdout: "borrowed-gh-token\n",
        stderr: "",
      }));
      mock.setUserResponse(() => {
        throw makeGithubError(503, "Service unavailable");
      });

      await expect(detectGhCli()).resolves.toMatchObject({
        available: true,
        authenticated: false,
        configured: true,
        health: "unavailable",
      });
      await expect(readGhCliCredential()).resolves.toMatchObject({
        method: "gh-cli",
        accessToken: "borrowed-gh-token",
      });
    });

    it("rejects a CLI-owned token only after an explicit credential failure", async () => {
      setRunFileForTesting(async () => ({
        stdout: "revoked-gh-token\n",
        stderr: "",
      }));
      mock.setUserResponse(() => {
        throw makeGithubError(401, "Bad credentials");
      });

      await expect(detectGhCli()).resolves.toMatchObject({
        available: true,
        authenticated: false,
        configured: true,
        health: "invalid",
      });
      // The private broker path does not add a `/user` request before every
      // Git operation. A rejected token is disconnected by the operation's
      // one-shot authentication-failure path.
      await expect(readGhCliCredential()).resolves.toMatchObject({
        method: "gh-cli",
        accessToken: "revoked-gh-token",
      });
    });
  });

  describe("verifyGithubToken", () => {
    it("validates a candidate without replacing the active credential", async () => {
      store.setToken("existing-token");
      mock.setUser({ login: "candidate-user" });

      await expect(verifyGithubToken("candidate-token")).resolves.toEqual({
        login: "candidate-user",
      });
      expect(await store.store.get()).toBe("existing-token");
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

    it("preserves the token and classifies a primary rate limit", async () => {
      store.setToken("ghp_rate_limited");
      mock.setUserResponse(() => {
        throw makeGithubError(403, "API rate limit exceeded", {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1770000000",
        });
      });

      await expect(getAuthStatus()).rejects.toMatchObject({
        code: "GITHUB_RATE_LIMITED",
        context: {
          rateLimitRemaining: 0,
          rateLimitResetAt: "2026-02-02T02:40:00.000Z",
        },
      });
      expect(await store.store.get()).toBe("ghp_rate_limited");
    });

    it("preserves the token and carries SAML authorization details", async () => {
      store.setToken("github_pat_sso");
      mock.setUserResponse(() => {
        throw makeGithubError(
          403,
          "Resource protected by organization SAML enforcement.",
          {
            "x-github-sso":
              "required; url=https://github.com/orgs/acme/sso?authorization_request=abc",
          },
        );
      });

      await expect(getAuthStatus()).rejects.toMatchObject({
        code: "GITHUB_SSO_REQUIRED",
        context: {
          authorizeUrl:
            "https://github.com/orgs/acme/sso?authorization_request=abc",
        },
      });
      expect(await store.store.get()).toBe("github_pat_sso");
    });

    it("preserves the token and exposes accepted GitHub permissions", async () => {
      store.setToken("github_pat_narrow");
      mock.setUserResponse(() => {
        throw makeGithubError(
          403,
          "Resource not accessible by personal access token",
          {
            "x-accepted-github-permissions":
              "pull_requests=write, contents=read",
          },
        );
      });

      await expect(getAuthStatus()).rejects.toMatchObject({
        code: "GITHUB_FORBIDDEN_SCOPE",
        context: {
          acceptedPermissions: {
            pull_requests: "write",
            contents: "read",
          },
        },
      });
      expect(await store.store.get()).toBe("github_pat_narrow");
    });

    it("clears a 403 only when GitHub explicitly says the credential is bad", async () => {
      store.setToken("ghp_bad");
      mock.setUserResponse(() => {
        throw makeGithubError(403, "Bad credentials");
      });

      await expect(getAuthStatus()).resolves.toEqual({
        authenticated: false,
      });
      expect(await store.store.get()).toBeNull();
    });

    it("retains a successful identity when GitHub reports partial SSO results", async () => {
      store.setToken("github_pat_partial_sso");
      mock.setUserResponse(() => ({
        data: { login: "Acme" },
        headers: {
          "x-github-sso": "partial-results; organizations=21955855,20582480",
        },
      }));

      await expect(getAuthStatus()).resolves.toEqual({
        authenticated: true,
        login: "Acme",
        warning: {
          code: "GITHUB_SSO_REQUIRED",
          context: {
            partialResults: true,
            organizationIds: ["21955855", "20582480"],
          },
        },
      });
      expect(await store.store.get()).toBe("github_pat_partial_sso");
    });
  });

  // The preflight the Create PR control runs before it refuses for any other
  // reason, and before it spends an agent turn. Its whole job is to separate
  // "not signed in" from "signed in, but this repository is out of reach" —
  // two states GitHub reports identically.
  describe("getWorkspaceRepoAccess", () => {
    it("confirms a repository the connection can push to", async () => {
      store.setToken("ghp_test_token");
      await expect(getWorkspaceRepoAccess(workspaceId)).resolves.toEqual({
        state: "ok",
        connected: true,
      });
    });

    it("blocks with connected=false when nothing is signed in", async () => {
      store.setToken(null);
      await expect(getWorkspaceRepoAccess(workspaceId)).resolves.toMatchObject({
        state: "blocked",
        connected: false,
        code: "NOT_AUTHENTICATED",
      });
    });

    // The reported case: a GitHub App whose installation covers some other
    // repository. GitHub answers 404, and the caller must be able to say so
    // rather than ask an already-connected user to connect GitHub.
    it("reports a repository outside the connection's reach as connected", async () => {
      store.setToken("ghp_test_token");
      mock.setRepoGetResponse(() => {
        throw makeGithubError(404, "Not Found");
      });
      await expect(getWorkspaceRepoAccess(workspaceId)).resolves.toMatchObject({
        state: "blocked",
        connected: true,
        code: "GITHUB_REPO_NOT_INSTALLED",
      });
    });

    it("blocks read-only access, which cannot push a PR branch", async () => {
      store.setToken("ghp_test_token");
      mock.setRepoPermissions({ admin: false, push: false, pull: true });
      await expect(getWorkspaceRepoAccess(workspaceId)).resolves.toMatchObject({
        state: "blocked",
        connected: true,
        code: "GITHUB_FORBIDDEN_SCOPE",
      });
    });

    // `push: true` is not a guarantee (an App installation can hold narrower
    // `contents` permission than the user who authorized it), and a probe that
    // may only remove a WRONG message must never remove a possible PR.
    it("never blocks on an absent permissions block", async () => {
      store.setToken("ghp_test_token");
      mock.setRepoPermissions(undefined);
      await expect(getWorkspaceRepoAccess(workspaceId)).resolves.toMatchObject({
        state: "ok",
      });
    });

    it("stays indeterminate when the probe itself fails", async () => {
      store.setToken("ghp_test_token");
      for (const failure of [
        () => {
          throw makeGithubError(403, "API rate limit exceeded");
        },
        () => {
          throw makeGithubError(500, "Server Error");
        },
        () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
            code: "ENOTFOUND",
          });
        },
      ]) {
        mock.setRepoGetResponse(failure);
        await expect(
          getWorkspaceRepoAccess(workspaceId),
        ).resolves.toMatchObject({ state: "unknown", connected: true });
      }
    });

    it("blocks on a repository with no GitHub remote at all", async () => {
      store.setToken("ghp_test_token");
      await execFileAsync("git", ["remote", "remove", "origin"], {
        cwd: repoRoot,
      });
      const access = await getWorkspaceRepoAccess(workspaceId);
      expect(access).toMatchObject({
        state: "blocked",
        connected: true,
        code: "VALIDATION_FAILED",
      });
      // Reconnecting GitHub cannot fix a missing remote, so the caller must be
      // able to tell this apart from the credential-shaped refusals.
      expect(access.code).not.toBe("NOT_AUTHENTICATED");
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
      expect(pr.url).toMatch(
        /^https:\/\/github\.com\/Acme\/example\/pull\/\d+$/,
      );
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

    it("does not expose repository or branch names from GitHub validation errors", async () => {
      const original = mock.octokit.pulls.create;
      mock.octokit.pulls.create = async () => {
        throw Object.assign(
          new Error(
            "Validation Failed: No commits between main and customer-secret-branch",
          ),
          {
            status: 422,
            response: {
              status: 422,
              data: {
                message: "Validation Failed",
                errors: [
                  {
                    message:
                      "No commits between Acme/private-customer-repo/main and customer-secret-branch",
                  },
                ],
              },
              headers: {},
            },
          },
        );
      };

      let thrown: unknown;
      try {
        await createPr({ workspaceId, title: "t", body: "b" });
      } catch (error) {
        thrown = error;
      } finally {
        mock.octokit.pulls.create = original;
      }

      expect(thrown).toMatchObject({
        code: "GITHUB_API_ERROR",
        message: "This branch has no commits beyond its base.",
      });
      const rendererPayload = JSON.stringify(thrown);
      expect(rendererPayload).not.toContain("private-customer-repo");
      expect(rendererPayload).not.toContain("customer-secret-branch");
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
            new Error(
              "Draft pull requests are not supported in this repository.",
            ),
            { status: 422 },
          );
        }
        return original(args);
      };
      const pr = await createPr({
        workspaceId,
        title: "t",
        body: "b",
        draft: true,
      });
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

    it("retries one transient 401 before clearing the credential", async () => {
      let attempts = 0;
      const original = mock.octokit.pulls.list;
      mock.octokit.pulls.list = async (args) => {
        attempts += 1;
        if (attempts === 1) {
          throw makeGithubError(401, "Bad credentials");
        }
        return original(args);
      };

      await expect(
        listPrs({ owner: "Acme", repo: "example", state: "open" }),
      ).resolves.toEqual([]);
      expect(attempts).toBe(2);
      expect(await store.store.get()).toBe("ghp_test_token");
      mock.octokit.pulls.list = original;
    });

    it("classifies a repository 404 without clearing the credential", async () => {
      const original = mock.octokit.pulls.list;
      mock.octokit.pulls.list = async () => {
        throw makeGithubError(404, "Not Found");
      };

      await expect(
        listPrs({ owner: "Acme", repo: "missing", state: "open" }),
      ).rejects.toMatchObject({
        code: "GITHUB_REPO_NOT_INSTALLED",
        message: expect.stringContaining("not available"),
      });
      expect(await store.store.get()).toBe("ghp_test_token");
      mock.octokit.pulls.list = original;
    });

    it("rotates a rejected App token before retrying the API call", async () => {
      let token: string | null = "rejected-app-token";
      let attempts = 0;
      const clear = vi.fn(async () => {
        token = null;
      });
      const refreshAfterRejection = vi.fn(async (rejectedToken: string) => {
        expect(rejectedToken).toBe("rejected-app-token");
        token = "rotated-app-token";
        return token;
      });
      setTokenStoreForTesting({
        async get() {
          return token;
        },
        async set(value) {
          token = value;
        },
        clear,
        refreshAfterRejection,
      });
      setOctokitFactoryForTesting(
        (factoryToken) =>
          ({
            ...mock.octokit,
            pulls: {
              ...mock.octokit.pulls,
              async list(args: {
                owner: string;
                repo: string;
                state?: string;
              }) {
                attempts += 1;
                if (factoryToken === "rejected-app-token") {
                  throw makeGithubError(401, "Bad credentials");
                }
                return mock.octokit.pulls.list(args);
              },
            },
          }) as never,
      );

      await expect(
        listPrs({ owner: "Acme", repo: "example", state: "open" }),
      ).resolves.toEqual([]);
      expect(attempts).toBe(2);
      expect(refreshAfterRejection).toHaveBeenCalledOnce();
      expect(clear).not.toHaveBeenCalled();
      expect(token).toBe("rotated-app-token");
    });

    it("does not clear a newer reconnect that races with the rejected retry", async () => {
      let token: string | null = "rejected-app-token";
      const clearAfterRejection = vi.fn(async (rejectedToken: string) => {
        if (token !== rejectedToken) return false;
        token = null;
        return true;
      });
      setTokenStoreForTesting({
        async get() {
          return token;
        },
        async set(value) {
          token = value;
        },
        async clear() {
          token = null;
        },
        async refreshAfterRejection() {
          token = "rotated-app-token";
          return token;
        },
        clearAfterRejection,
      });
      setOctokitFactoryForTesting(
        (factoryToken) =>
          ({
            ...mock.octokit,
            pulls: {
              ...mock.octokit.pulls,
              async list() {
                if (factoryToken === "rotated-app-token") {
                  // A user reconnect wins while this already-started retry is
                  // still in flight.
                  token = "newly-connected-token";
                }
                throw makeGithubError(401, "Bad credentials");
              },
            },
          }) as never,
      );

      await expect(
        listPrs({ owner: "Acme", repo: "example", state: "open" }),
      ).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
      expect(clearAfterRejection).toHaveBeenCalledWith("rotated-app-token");
      expect(token).toBe("newly-connected-token");
    });

    it("preserves a rotating pair when rejected-token refresh is unavailable", async () => {
      let token: string | null = "rejected-app-token";
      const clear = vi.fn(async () => {
        token = null;
      });
      const refreshAfterRejection = vi.fn(async () => null);
      setTokenStoreForTesting({
        async get() {
          return token;
        },
        async set(value) {
          token = value;
        },
        clear,
        refreshAfterRejection,
      });
      setOctokitFactoryForTesting(
        () =>
          ({
            ...mock.octokit,
            pulls: {
              ...mock.octokit.pulls,
              async list() {
                throw makeGithubError(401, "Bad credentials");
              },
            },
          }) as never,
      );

      await expect(
        listPrs({ owner: "Acme", repo: "example", state: "open" }),
      ).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
      expect(refreshAfterRejection).toHaveBeenCalledOnce();
      expect(clear).not.toHaveBeenCalled();
      expect(token).toBe("rejected-app-token");
    });

    // The remembered login is what resolveNewBranchPrefix stamps onto every
    // new workspace branch under `branch_prefix_type = "github"`. A background
    // gh.* call is the only credential clear most users ever hit, so leaving
    // the login behind means every workspace created after a revoked token
    // carries a disconnected account's name — and a created branch is
    // permanent, where falling back to `zeros/` is not.
    it("forgets the remembered login when a background call's credential is rejected", async () => {
      store.setToken("ghp_will_be_revoked");
      mock.setUser({ login: "octo-user" });
      await getAuthStatus();
      expect(cachedGithubLogin()).toBe("octo-user");

      setOctokitFactoryForTesting(
        () =>
          ({
            ...mock.octokit,
            pulls: {
              ...mock.octokit.pulls,
              async list() {
                throw makeGithubError(401, "Bad credentials");
              },
            },
          }) as never,
      );

      await expect(
        listPrs({ owner: "Acme", repo: "example", state: "open" }),
      ).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
      expect(await store.store.get()).toBeNull();
      expect(cachedGithubLogin()).toBeNull();
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
});
