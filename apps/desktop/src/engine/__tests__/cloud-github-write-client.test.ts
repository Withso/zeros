import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requestCloudGithubWrite } from "../cloud-github-write-client";
const authority = { heartbeatEndpoint: "https://control.example.test/heartbeat", heartbeatToken: `zwh_${"a".repeat(43)}`,
  workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
describe("cloud Git author client", () => {
  it("accepts only bounded noreply identity from the authenticated backend", async () => {
    const request = { kind: "author" as const, actorSessionId: randomUUID() };
    const author = { name: "Member", email: "1234+member@users.noreply.github.com" };
    const fetcher = vi.fn(async () => Response.json({ author }));
    expect(await requestCloudGithubWrite(authority, request, new AbortController().signal, fetcher)).toEqual(author);
    for (const value of [{ author: { ...author, email: "personal@example.test" } }, { author: { ...author, name: "Bad\nName" } }, { author, token: "not-allowed" }])
      await expect(requestCloudGithubWrite(authority, request, new AbortController().signal, async () => Response.json(value))).rejects.toThrow();
    expect(await requestCloudGithubWrite(authority, request, new AbortController().signal, async () => Response.json({ author: null }))).toBeNull();
  });
});
