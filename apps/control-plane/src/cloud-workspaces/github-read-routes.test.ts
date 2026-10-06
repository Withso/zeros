import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCloudGithubReadRoutes, CLOUD_GITHUB_READ_PATH } from "./github-read-routes.js";
import { GithubReadError, type DatabaseCloudGithubReads } from "./github-read-proxy.js";

it("requires exact engine and actor scope and closes service errors", async () => {
  const read = vi.fn().mockRejectedValue(new Error("synthetic-private-upstream-detail"));
  const app = createCloudGithubReadRoutes({ read } as unknown as DatabaseCloudGithubReads);
  const body = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), actorSessionId: randomUUID(),
    request: { method: "GET", path: "/repos/org/repo/pulls/7" } };
  const headers = { "content-type": "application/json", authorization: `Bearer zwh_${"a".repeat(43)}` };
  const send = (value: unknown, selectedHeaders = headers) => app.request(CLOUD_GITHUB_READ_PATH, { method: "POST", headers: selectedHeaders, body: JSON.stringify(value) });
  expect((await send(body, { ...headers, authorization: "" })).status).toBe(401);
  expect((await send({ ...body, actorSessionId: undefined })).status).toBe(422);
  expect((await send({ ...body, unexpected: true })).status).toBe(422);
  expect(read).not.toHaveBeenCalled();
  const denied = await send(body);
  expect(denied.status).toBe(403);
  expect(denied.headers.get("cache-control")).toBe("no-store");
  expect(await denied.text()).toBe('{"message":"GitHub repository read is unavailable."}');
  read.mockRejectedValueOnce(new GithubReadError(429));
  expect((await send(body)).status).toBe(429);
});
