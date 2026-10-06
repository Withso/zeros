import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requestCloudGithubRead } from "../cloud-github-read-client";

const authority = { heartbeatEndpoint: "https://control.example.test/heartbeat", heartbeatToken: `zwh_${"a".repeat(43)}`,
  workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
const actorSessionId = randomUUID();
describe("cloud GitHub read transport", () => {
  it("carries the exact actor to the control plane and strips caller headers", async () => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ number: 7 }));
    const response = await requestCloudGithubRead(authority, actorSessionId, new AbortController().signal,
      "https://api.github.com/repos/org/repo/pulls/7", { headers: { authorization: "caller-credential", accept: "application/vnd.github.v3.diff" } }, upstream);
    expect(await response.json()).toEqual({ number: 7 });
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("https://control.example.test/internal/v1/cloud-workspaces/engine/github-read");
    expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: authority.workspaceId, organizationId: authority.organizationId,
      generation: 1, engineInstanceId: authority.engineInstanceId, actorSessionId,
      request: { method: "GET", path: "/repos/org/repo/pulls/7", format: "diff" } });
    expect(JSON.stringify(init)).not.toContain("caller-credential");
  });
  it.each(["https://other.test/repos/org/repo", "http://api.github.com/repos/org/repo", "https://api.github.com@other.test/", "https://api.github.com/repos/org/repo#fragment"])("denies unexpected destination %s", async url => {
    const upstream = vi.fn();
    await expect(requestCloudGithubRead(authority, actorSessionId, new AbortController().signal, url, {}, upstream)).rejects.toThrow("GitHub read");
    expect(upstream).not.toHaveBeenCalled();
  });
  it("closes transport/error bodies and refuses oversized data", async () => {
    for (const response of [new Response("synthetic-private", { status: 500 }), new Response("x", { headers: { "content-length": String(9 * 1024 * 1024) } })]) {
      await expect(requestCloudGithubRead(authority, actorSessionId, new AbortController().signal,
        "https://api.github.com/repos/org/repo", {}, async () => response)).rejects.toThrow("GitHub read authorization is unavailable.");
    }
  });
});
