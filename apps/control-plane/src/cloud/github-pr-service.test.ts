import { describe, expect, it, vi } from "vitest";
import { CloudGithubApi } from "./github-api.js";
import {
  CloudGithubPrService,
  type CloudGithubPrContext,
} from "./github-pr-service.js";

const head = "a".repeat(40),
  base = "b".repeat(40);
const repository = {
  id: 42,
  name: "project",
  owner: { login: "example" },
  default_branch: "main",
  private: true,
  archived: false,
  permissions: { pull: true, push: true },
};
const pull = {
  number: 7,
  node_id: "PR_example",
  html_url: "https://github.com/example/project/pull/7",
  state: "open",
  draft: false,
  title: "Change",
  body: "Description",
  user: { login: "contributor" },
  base: { ref: "main", sha: base, repo: repository },
  head: { ref: "topic", sha: head, repo: repository },
  mergeable: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  merged_at: null,
};
const authority = {
  connectionGeneration: "connection-1",
  repositoryId: "42",
  repository: "example/project",
  branch: "topic",
  baseBranch: "main",
  contextRevision: "boot-1:1",
};
const changed = () =>
  Object.assign(new Error("Changed"), { code: "github_authorization_changed" });
function fixture() {
  let context: CloudGithubPrContext = {
    workspaceId: "workspace",
    organizationId: "organization",
    creatorUserId: "creator",
    repository: "example/project",
    repositoryId: "42",
    branch: "topic",
    baseBranch: "main",
    headSha: head,
    revision: "boot-1:1",
  };
  let revoked = false;
  const assertCurrent = vi.fn(async () => {
    if (revoked) throw changed();
  });
  const fetch = vi.fn(
    async (url: string | URL | Request, input?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repositories/42") return Response.json(repository);
      if (input?.method === "PUT")
        return Response.json({ merged: true, sha: "c".repeat(40) });
      if (String(url).includes("/pulls?"))
        return Response.json([
          pull,
          {
            ...pull,
            number: 6,
            html_url: "https://github.com/example/project/pull/6",
            state: "closed",
          },
        ]);
      return Response.json(pull);
    },
  );
  const api = new CloudGithubApi({
    apiBaseUrl: "https://api.github.com",
    token: "synthetic",
    assertCurrent,
    fetch,
  });
  const deps = {
    context: vi.fn(async () => context),
    access: vi.fn(async () => ({
      api,
      login: "contributor",
      generation: "connection-1",
      assertCurrent,
    })),
    repository: vi.fn(async () => {}),
    recordPr: vi.fn(async () => {}),
    mutate: vi.fn(
      async <T>(_workspace: string, _user: string, action: () => Promise<T>) =>
        action(),
    ),
  };
  return {
    service: new CloudGithubPrService(deps),
    deps,
    fetch,
    setContext: (next: Partial<CloudGithubPrContext>) => {
      context = { ...context, ...next };
    },
    revoke: () => {
      revoked = true;
    },
  };
}
const merge = {
  op: "gh.prMerge",
  expected: authority,
  params: { prNumber: 7, headSha: head, baseSha: base, method: "squash" },
};

describe("cloud PR service authority", () => {
  it("reports the selected GitHub identity after verifying repository access", async () => {
    const { service, deps } = fixture();
    await expect(
      service.execute("workspace", "creator", {
        op: "gh.authStatus",
        params: {},
      }),
    ).resolves.toMatchObject({
      result: { authenticated: true, login: "contributor" },
    });
    expect(deps.mutate).not.toHaveBeenCalled();
  });
  it("reads a stopped workspace entirely through GitHub without a lifecycle mutation", async () => {
    const { service, deps } = fixture();
    await expect(
      service.execute("workspace", "creator", {
        op: "gh.prGet",
        params: { prNumber: 7 },
      }),
    ).resolves.toMatchObject({ authority, result: { number: 7 } });
    expect(deps.mutate).not.toHaveBeenCalled();
  });
  it("rejects another creator before requesting a credential or GitHub data", async () => {
    const { service, deps, fetch } = fixture();
    await expect(
      service.execute("workspace", "other", {
        op: "gh.prGet",
        params: { prNumber: 7 },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(deps.access).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects stale connection and checkout authority before writing", async () => {
    const { service, fetch } = fixture();
    for (const expected of [
      { ...authority, connectionGeneration: "old" },
      { ...authority, contextRevision: "boot-1:0" },
    ])
      await expect(
        service.execute("workspace", "creator", { ...merge, expected }),
      ).rejects.toMatchObject({ code: "github_authorization_changed" });
    expect(fetch.mock.calls.some(([, input]) => input?.method === "PUT")).toBe(
      false,
    );
  });
  it("fences branch changes that race a GitHub preflight", async () => {
    const { service, fetch, setContext } = fixture();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, input) => {
      const response = await original(url, input);
      if (String(url).endsWith("/pulls/7") && input?.method === "GET")
        setContext({ branch: "another", revision: "boot-1:2" });
      return response;
    });
    await expect(
      service.execute("workspace", "creator", merge),
    ).rejects.toMatchObject({ code: "github_authorization_changed" });
    expect(fetch.mock.calls.some(([, input]) => input?.method === "PUT")).toBe(
      false,
    );
  });
  it("rejects stale base revisions and foreign adoption URLs", async () => {
    const { service, fetch } = fixture();
    await expect(
      service.execute("workspace", "creator", {
        ...merge,
        params: { ...merge.params, baseSha: "d".repeat(40) },
      }),
    ).rejects.toMatchObject({ code: "github_pr_changed" });
    await expect(
      service.execute("workspace", "creator", {
        op: "gh.prSync",
        params: { url: "https://github.com/another/project/pull/7" },
      }),
    ).rejects.toMatchObject({ code: "github_pr_identity_changed" });
    expect(fetch.mock.calls.some(([, input]) => input?.method === "PUT")).toBe(
      false,
    );
  });
  it("returns the complete matching PR list for the requested state", async () => {
    const { service } = fixture();
    const result = await service.execute("workspace", "creator", {
      op: "gh.prList",
      params: { state: "all" },
    });
    expect(result.result).toMatchObject([{ number: 7 }, { number: 6 }]);
  });
  it("preserves a confirmed mutation if authorization changes after GitHub accepts it", async () => {
    const { service, fetch, revoke, deps } = fixture();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, input) => {
      const response = await original(url, input);
      if (input?.method === "PUT") revoke();
      return response;
    });
    await expect(
      service.execute("workspace", "creator", merge),
    ).resolves.toMatchObject({
      authorityCurrent: false,
      result: { sha: "c".repeat(40) },
    });
    expect(
      fetch.mock.calls.filter(([, input]) => input?.method === "PUT"),
    ).toHaveLength(1);
    expect(deps.recordPr).not.toHaveBeenCalled();
  });
  it("does not turn a catalog persistence failure into a failed public write", async () => {
    const { service, deps } = fixture();
    deps.recordPr.mockRejectedValue(
      new Error("Database temporarily unavailable"),
    );
    await expect(
      service.execute("workspace", "creator", {
        op: "gh.prUpdate",
        expected: authority,
        params: {
          prNumber: 7,
          headSha: head,
          baseSha: base,
          title: "New title",
        },
      }),
    ).resolves.toMatchObject({ result: { number: 7 } });
  });
});
