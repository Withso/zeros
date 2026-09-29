import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { configureNativeGithubTransport, nativeGithubSupported, requestNativeGithub } from "../github-native-client";
import { configureNativeGithubDesktop, acceptNativeGithubDesktop } from "../github-native-desktop";
import type { TransportClient } from "../../transport/types";
const authority = { heartbeatEndpoint: "https://api.example.test/internal/heartbeat", heartbeatToken: `zwh_${"a".repeat(43)}`,
  workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
it("requires connected-account capability and rejects the retired installation-token protocol", async () => {
  const request = vi.fn(async () => Response.json({ nativeGithub: 1 }));
  configureNativeGithubTransport(() => authority, request);
  expect(await nativeGithubSupported()).toBe(false);
  request.mockImplementation(async () => Response.json({ nativeGit: 1 }));
  expect(await nativeGithubSupported()).toBe(true); expect(await nativeGithubSupported()).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});
it("bounds responses and emits actionable errors without credential text", async () => {
  let cancelled = false;
  configureNativeGithubTransport(() => authority, async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(9000))); }, cancel() { cancelled = true; },
  })));
  const request = { source: { kind: "agent" as const, leaseId: randomUUID() }, operation: "git.push" as const, branch: "topic" };
  await expect(requestNativeGithub(request, new AbortController().signal)).rejects.toThrow("Open Zeros");
  expect(cancelled).toBe(true);
  configureNativeGithubTransport(() => null);
  await expect(requestNativeGithub(request, new AbortController().signal)).rejects.toThrow("Open Zeros");
});
it("obtains and redeems a grant from the exact connected desktop, then releases it", async () => {
  const user = randomUUID(), grant = `zgw_${"g".repeat(43)}`, proxy = `zgp_${"p".repeat(43)}`;
  const desktop: TransportClient = { id: randomUUID(), kind: "cloud", accountUserId: user, authorized: () => true,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), fingerprint: "a".repeat(64), role: "owner" }, close: vi.fn(),
    send: message => { if (message.type === "GITHUB_NATIVE_GRANT_REQUEST")
      queueMicrotask(() => acceptNativeGithubDesktop(desktop, { kind: "reply", requestId: message.request.native.requestId, grant })); } };
  configureNativeGithubDesktop(() => [desktop]); acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const calls: Record<string, unknown>[] = [];
  configureNativeGithubTransport(() => authority, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { request: Record<string, unknown> };
    calls.push(body.request);
    if (body.request.kind === "native-capabilities") return Response.json({ nativeGit: 1 });
    if (body.request.kind === "native-context") return Response.json({ actorUserId: user, organizationId: authority.organizationId,
      workspaceId: authority.workspaceId, generation: 1, engineInstanceId: authority.engineInstanceId, owner: "org", repository: "repo", repositoryId: "42" });
    if (body.request.kind === "release") return Response.json({ released: true });
    expect(body.request).toMatchObject({ kind: "redeem", grant, actorSessionId: desktop.cloudActor!.sessionId, operation: "git.push", branch: "topic" });
    return Response.json({ token: proxy, owner: "org", repository: "repo", expiresAtMs: Date.now() + 60000 });
  });
  const credential = await requestNativeGithub({ source: { kind: "agent", leaseId: randomUUID() }, operation: "git.push", branch: "topic" }, new AbortController().signal);
  expect(credential.token).toBe(proxy); await credential.release();
  expect(calls.map(call => call.kind)).toEqual(["native-capabilities", "native-context", "redeem", "release"]);
});
