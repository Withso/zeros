import { describe, expect, it } from "vitest";
import { authorizeGithubApiRequest, validateGitReceivePackHeader } from "./github-write-proxy.js";
import type { GithubProxyAuthority } from "./github-write-grants.js";
const scope: GithubProxyAuthority = { owner: "org", repository: "repo", repositoryId: "123", operation: "gh.prUpdate", prNumber: 7,
  userToken: "synthetic-user-token", expiresAtMs: Date.now() + 10000, expectedBody: { title: "Updated" }, gitReference: "refs/heads/test" };
describe("GitHub write proxy admission", () => {
  it("binds writes to the repository, operation, PR and exact submitted fields", () => {
    expect(authorizeGithubApiRequest(scope, "PATCH", "/repos/org/repo/pulls/7", { title: "Updated" })).toBe("api");
    for (const path of ["/repos/org/another/pulls/7", "/repos/org/repo/pulls/8", "/repos/org/repo/issues/7", "/repos/org/repo/pulls/7?extra=1"])
      expect(() => authorizeGithubApiRequest(scope, "PATCH", path, { title: "Updated" })).toThrow();
    expect(() => authorizeGithubApiRequest(scope, "PATCH", "/repos/org/repo/pulls/7", { title: "Updated", state: "closed" })).toThrow();
    expect(() => authorizeGithubApiRequest(scope, "DELETE", "/repos/org/repo/pulls/7", {})).toThrow();
  });
  it("does not admit arbitrary GraphQL operations or another node", () => {
    const ready = { ...scope, operation: "gh.prMarkReady", expectedBody: null };
    expect(() => authorizeGithubApiRequest(ready, "POST", "/graphql", { query: "query { viewer { login } }", variables: {} }, "PR_expected")).toThrow();
    const body = { query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }", variables: { id: "PR_wrong" } };
    expect(() => authorizeGithubApiRequest(ready, "POST", "/graphql", body, "PR_expected")).toThrow();
    body.variables.id = "PR_expected";
    expect(authorizeGithubApiRequest(ready, "POST", "/graphql", body, "PR_expected")).toBe("api");
  });
  it("admits one non-delete branch update and rejects extra refs, deletes and malformed packets", () => {
    const line = (ref: string, next = "b".repeat(40)) => {
      const value = `${"a".repeat(40)} ${next} ${ref}\0 report-status side-band-64k\n`;
      return Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4,"0") + value);
    };
    expect(validateGitReceivePackHeader(Buffer.concat([line("refs/heads/test"), Buffer.from("0000PACK")]), scope.gitReference!)).toBe(true);
    for (const bytes of [Buffer.concat([line("refs/heads/other"), Buffer.from("0000")]), Buffer.concat([line("refs/heads/test", "0".repeat(40)), Buffer.from("0000")]),
      Buffer.concat([line("refs/heads/test"),line("refs/heads/other"),Buffer.from("0000")]), Buffer.from("zzzz")])
      expect(() => validateGitReceivePackHeader(bytes, scope.gitReference!)).toThrow();
    expect(validateGitReceivePackHeader(line("refs/heads/test").subarray(0, 10), scope.gitReference!)).toBe(false);
  });
  it("accepts bounded shallow declarations only before the single branch update", () => {
    const packet = (value: string) => Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value);
    const shallow = packet(`shallow ${"a".repeat(40)}\n`);
    const update = packet(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/test\0report-status\n`);
    const flush = Buffer.from("0000");
    expect(validateGitReceivePackHeader(Buffer.concat([shallow, update, flush]), scope.gitReference!)).toBe(true);
    expect(validateGitReceivePackHeader(shallow.subarray(0, 12), scope.gitReference!)).toBe(false);
    for (const bytes of [Buffer.concat([shallow, flush]), Buffer.concat([update, shallow, flush]),
      Buffer.concat([...Array<Buffer>(129).fill(shallow), update, flush]),
      Buffer.concat([packet(`shallow ${"a".repeat(64)}\n`), update, flush]),
      Buffer.concat([packet("shallow not-an-object\n"), update, flush])])
      expect(() => validateGitReceivePackHeader(bytes, scope.gitReference!)).toThrow();
  });
});

describe("GitHub proxy HTTP boundary", () => {
  it("acknowledges only an exact empty authentication probe without spending a write", async () => {
    const { createCloudGithubProxyRoutes, CLOUD_GITHUB_PROXY_PATH } = await import("./github-write-proxy.js");
    const { vi } = await import("vitest");
    const authorizeProxy = vi.fn(async () => ({ ...scope, operation: "git.push" }));
    const upstream = vi.fn(async () => Response.json({ id: 123 }));
    const app = createCloudGithubProxyRoutes({ authorizeProxy } as unknown as import("./github-write-grants.js").DatabaseCloudGithubWriteGrants, upstream);
    const request = (body: string) => app.request(`${CLOUD_GITHUB_PROXY_PATH}/git/org/repo.git/git-receive-pack`, { method: "POST",
      headers: { authorization: `Bearer zgp_${"p".repeat(43)}`, "content-type": "application/x-git-receive-pack-request" }, body });
    expect((await request("0000")).status).toBe(200);
    expect(authorizeProxy).toHaveBeenCalledTimes(2);
    expect(authorizeProxy.mock.calls.every(call => call.length === 1)).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(String(upstream.mock.calls[0]?.[0])).toBe("https://api.github.com/repos/org/repo");
    authorizeProxy.mockClear(); upstream.mockClear();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await request("0000hidden update")).status).toBe(403);
    expect(authorizeProxy).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
  it("uses the user identity only upstream, rejects repository replacement and scrubs provider errors", async () => {
    const { createCloudGithubProxyRoutes, CLOUD_GITHUB_PROXY_PATH } = await import("./github-write-proxy.js");
    const { vi } = await import("vitest");
    const authorizeProxy = vi.fn(async () => scope), allowDraftFallback = vi.fn();
    const service = { authorizeProxy, allowDraftFallback } as unknown as import("./github-write-grants.js").DatabaseCloudGithubWriteGrants;
    const token = `zgp_${"p".repeat(43)}`;
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-user-token");
      return String(url).endsWith("/pulls/7") ? Response.json({ message: "failed synthetic-user-token" }, { status: 403 }) : Response.json({ id: 123 });
    });
    const app = createCloudGithubProxyRoutes(service, upstream);
    const request = () => app.request(`${CLOUD_GITHUB_PROXY_PATH}/api/repos/org/repo/pulls/7`, { method: "PATCH", headers: { authorization: `token ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Updated" }) });
    const response = await request();
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("synthetic-user-token");
    expect(authorizeProxy).toHaveBeenLastCalledWith(token, "api");
    upstream.mockImplementation(async () => Response.json({ id: 999 })); authorizeProxy.mockClear();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await request()).status).toBe(403);
    expect(authorizeProxy).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("[github-write-proxy] request rejected", { stage: "repository", upstreamStatus: 200 });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-user-token");
    warning.mockRestore();
  });
  it("does not contact GitHub without a capability, and refuses redirects", async () => {
    const { createCloudGithubProxyRoutes, CLOUD_GITHUB_PROXY_PATH } = await import("./github-write-proxy.js");
    const { vi } = await import("vitest");
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { expect(init?.redirect).toBe("error"); throw new Error("redirect blocked"); });
    const service = { authorizeProxy: vi.fn(async () => scope) } as unknown as import("./github-write-grants.js").DatabaseCloudGithubWriteGrants;
    const app = createCloudGithubProxyRoutes(service, upstream);
    const path = `${CLOUD_GITHUB_PROXY_PATH}/git/org/repo.git/info/refs?service=git-receive-pack`;
    expect((await app.request(path)).status).toBe(401); expect(upstream).not.toHaveBeenCalled();
    expect((await app.request(path, { headers: { authorization: `Basic ${Buffer.from(`x-access-token:zgp_${"p".repeat(43)}`).toString("base64")}` } })).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
