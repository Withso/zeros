import { describe, expect, it, vi } from "vitest";
import { CloudGithubApi } from "./github-api.js";

const head = "a".repeat(40),
  base = "b".repeat(40);
const repository = {
  id: 42,
  name: "project",
  owner: { login: "new-owner" },
  default_branch: "main",
  private: true,
  archived: false,
  disabled: false,
  permissions: { pull: true, push: true },
};
const target = {
  repositoryId: "42",
  repository: "old-owner/project",
  branch: "work/topic",
  baseBranch: "main",
};
const pull = {
  number: 7,
  node_id: "PR_example",
  html_url: "https://github.com/new-owner/project/pull/7",
  state: "open",
  draft: true,
  title: "A change",
  body: "Description",
  user: { login: "contributor" },
  base: { ref: "main", sha: base, repo: repository },
  head: { ref: "work/topic", sha: head, repo: repository },
  mergeable: true,
  mergeable_state: "clean",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  merged_at: null,
};

function fixture(
  respond: (path: string, init: RequestInit) => Response | Promise<Response>,
) {
  const assertCurrent = vi.fn(async () => {});
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe(
        /^\/repositories\/[0-9]+$/.test(new URL(String(url)).pathname)
          ? "manual"
          : "error",
      );
      return respond(
        new URL(String(url)).pathname + new URL(String(url)).search,
        init ?? {},
      );
    },
  );
  const api = new CloudGithubApi({
    apiBaseUrl: "https://api.github.com",
    token: "synthetic-user-token",
    assertCurrent,
    fetch,
  });
  return { api, fetch, assertCurrent };
}

describe("cloud GitHub API", () => {
  it("finds the open PR after a full page of newer closed PRs on a reused branch", async () => {
    const { api, fetch } = fixture((path) => {
      if (path === "/repositories/42") return Response.json(repository);
      if (
        new URL(path, "https://api.github.com").searchParams.get("page") === "2"
      )
        return Response.json([pull]);
      return Response.json(
        Array.from({ length: 100 }, (_, index) => ({
          ...pull,
          state: "closed",
          number: index + 100,
          html_url: `https://github.com/new-owner/project/pull/${index + 100}`,
        })),
      );
    });
    await expect(api.find(target)).resolves.toMatchObject({
      number: 7,
      state: "draft",
    });
    expect(fetch.mock.calls).toHaveLength(3);
  });
  it.each(["create", "update", "merge", "comment", "lineComment"] as const)(
    "addresses %s by immutable repository ID through the final write",
    async (operation) => {
      const { api, fetch } = fixture((path, init) => {
        if (path === "/repositories/42") return Response.json(repository);
        if (path.includes("/pulls?")) return Response.json([]);
        if (init.method === "PUT")
          return Response.json({ merged: true, sha: head });
        if (init.method === "POST" && path.endsWith("/comments"))
          return Response.json({
            id: 71,
            html_url: `${pull.html_url}#issuecomment-71`,
          });
        return Response.json({ ...pull, draft: false });
      });
      if (operation === "create")
        await api.create(target, { title: "Change", body: "Description" });
      else if (operation === "update")
        await api.update(target, 7, { title: "Changed", headSha: head });
      else if (operation === "merge")
        await api.merge(target, 7, { method: "squash", headSha: head });
      else if (operation === "comment")
        await api.comment(target, 7, "Discussion");
      else
        await api.lineComment(target, 7, {
          body: "Review",
          path: "src/file.ts",
          side: "RIGHT",
          line: 2,
          commitSha: head,
          baseSha: base,
        });
      const writes = fetch.mock.calls.filter(([, init]) =>
        ["POST", "PATCH", "PUT"].includes(init?.method ?? "GET"),
      );
      expect(writes).toHaveLength(1);
      expect(String(writes[0]![0])).toMatch(
        /^https:\/\/api\.github\.com\/repositories\/42\//,
      );
      expect(writes[0]![1]?.redirect).toBe("error");
    },
  );
  it("follows immutable repository identity across transfers without consulting a reused old name", async () => {
    const { api, fetch } = fixture((path) =>
      Response.json(path === "/repositories/42" ? repository : pull),
    );
    const result = await api.get(target, 7);
    expect(result).toMatchObject({
      number: 7,
      url: pull.html_url,
      headSha: head,
      state: "draft",
      headRepository: "new-owner/project",
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repositories/42",
      "https://api.github.com/repositories/42/pulls/7",
    ]);
  });

  it("refuses repository substitution and same-number PRs from another branch or fork", async () => {
    for (const altered of [
      { ...pull, base: { ...pull.base, repo: { ...repository, id: 99 } } },
      { ...pull, head: { ...pull.head, ref: "another-branch" } },
      { ...pull, head: { ...pull.head, repo: { ...repository, id: 99 } } },
    ]) {
      const { api } = fixture((path) =>
        Response.json(path === "/repositories/42" ? repository : altered),
      );
      await expect(api.get(target, 7)).rejects.toMatchObject({
        code: "github_pr_identity_changed",
      });
    }
    const { api } = fixture(() => Response.json({ ...repository, id: 99 }));
    await expect(api.repository(target)).rejects.toMatchObject({
      code: "github_repository_changed",
    });
  });

  it("adopts an existing open PR and reconciles a lost create response without issuing a second create", async () => {
    let created = false,
      writes = 0;
    const { api } = fixture((path, init) => {
      if (path === "/repositories/42") return Response.json(repository);
      if (init.method === "POST") {
        writes++;
        created = true;
        throw new TypeError("synthetic network loss");
      }
      if (path.includes("/pulls?")) return Response.json(created ? [pull] : []);
      return Response.json(pull);
    });
    await expect(
      api.create(target, {
        title: "A change",
        body: "Description",
        draft: true,
      }),
    ).resolves.toMatchObject({ number: 7 });
    expect(writes).toBe(1);
    await expect(
      api.create(target, { title: "A change", body: "Description" }),
    ).resolves.toMatchObject({ number: 7 });
    expect(writes).toBe(1);
  });

  it.each([false, true])(
    "creates or reconciles only a PR onto the selected base (lost response=%s)",
    async (lostResponse) => {
      const other = {
        ...pull,
        number: 8,
        html_url: "https://github.com/new-owner/project/pull/8",
        base: { ...pull.base, ref: "release" },
      };
      let writes = 0;
      const { api } = fixture((path, init) => {
        if (path === "/repositories/42") return Response.json(repository);
        if (path.includes("/pulls?"))
          return Response.json(writes ? [other, pull] : [other]);
        if (init.method === "POST") {
          writes++;
          expect(JSON.parse(String(init.body))).toMatchObject({
            head: target.branch,
            base: "main",
          });
          if (lostResponse) throw new TypeError("synthetic response loss");
        }
        return Response.json(pull);
      });
      await expect(
        api.create(target, { title: "A change", body: "Description" }),
      ).resolves.toMatchObject({ number: 7, baseBranch: "main" });
      expect(writes).toBe(1);
    },
  );

  it("does not elevate read-only user permissions for merge or branch publication", async () => {
    const { api, fetch } = fixture((path) =>
      Response.json(
        path === "/repositories/42"
          ? { ...repository, permissions: { pull: true, push: false } }
          : pull,
      ),
    );
    await expect(api.get(target, 7)).resolves.toMatchObject({ number: 7 });
    await expect(
      api.merge(target, 7, { method: "squash", headSha: head }),
    ).rejects.toMatchObject({ code: "github_cloud_write_denied" });
    await expect(
      api.create(target, { title: "Change", body: "Description" }),
    ).rejects.toMatchObject({ code: "github_cloud_write_denied" });
    expect(
      fetch.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });

  it("merges the exact reviewed head and honors GitHub's protection refusal", async () => {
    const { api, fetch } = fixture((path, init) => {
      if (path === "/repositories/42") return Response.json(repository);
      if (init.method === "PUT")
        return new Response("upstream-private-message", { status: 405 });
      return Response.json({ ...pull, draft: false });
    });
    await expect(
      api.merge(target, 7, { method: "squash", headSha: "c".repeat(40) }),
    ).rejects.toMatchObject({ code: "github_pr_changed" });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
    await expect(
      api.merge(target, 7, { method: "squash", headSha: head }),
    ).rejects.toMatchObject({ code: "github_merge_blocked" });
    const write = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      sha: head,
      merge_method: "squash",
    });
  });

  it("checks both diff revisions before posting a line comment", async () => {
    const { api, fetch } = fixture((path) =>
      Response.json(path === "/repositories/42" ? repository : pull),
    );
    await expect(
      api.lineComment(target, 7, {
        body: "Please check",
        path: "src/file.ts",
        side: "RIGHT",
        line: 3,
        commitSha: head,
        baseSha: "c".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "github_pr_changed" });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("checks the connection generation before requests and before releasing protected reads", async () => {
    const { api, assertCurrent, fetch } = fixture(() =>
      Response.json(repository),
    );
    assertCurrent.mockRejectedValueOnce(
      Object.assign(new Error("Changed"), {
        code: "github_authorization_changed",
      }),
    );
    await expect(api.repository(target)).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
    expect(fetch).not.toHaveBeenCalled();
    assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      Object.assign(new Error("Changed"), {
        code: "github_authorization_changed",
      }),
    );
    await expect(api.repository(target)).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
  });

  it.each([
    [401, "github_authorization_expired"],
    [403, "github_cloud_access_denied"],
    [404, "github_repository_unavailable"],
    [429, "github_rate_limited"],
    [503, "github_unavailable"],
  ])(
    "classifies %s without leaking upstream response text",
    async (status, code) => {
      const { api } = fixture(
        () =>
          new Response("private-upstream-details", {
            status: status as number,
          }),
      );
      const error = await api.repository(target).catch((error) => error);
      expect(error).toMatchObject({ code });
      expect(error.message).not.toContain("private-upstream-details");
    },
  );

  it("keeps checks from an old head out of a refreshed PR", async () => {
    let reads = 0;
    const { api } = fixture((path) => {
      if (path === "/repositories/42") return Response.json(repository);
      if (path.includes("/check-runs"))
        return Response.json({ check_runs: [], total_count: 0 });
      if (path.includes("/statuses")) return Response.json([]);
      return Response.json(
        ++reads === 1
          ? pull
          : { ...pull, head: { ...pull.head, sha: "c".repeat(40) } },
      );
    });
    await expect(api.checks(target, 7)).rejects.toMatchObject({
      code: "github_pr_changed",
    });
  });
});
