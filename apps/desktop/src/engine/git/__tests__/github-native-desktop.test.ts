import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { TransportClient } from "../../transport/types";
import {
  configureNativeGithubDesktop, acceptNativeGithubDesktop, requestNativeGithubDesktop,
} from "../github-native-desktop";
const request = () => ({
  actorUserId: randomUUID(), organizationId: randomUUID(), workspaceId: randomUUID(),
  generation: 1, engineInstanceId: randomUUID(), owner: "org", repository: "repo", repositoryId: "42",
  operation: "git.push" as const, paramsSha256: "a".repeat(64),
  native: { requestId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), branch: "topic",
    source: { kind: "agent" as const, leaseId: randomUUID() } },
});
function client(userId: string, role: "owner" | "viewer" | "prompter" = "owner"): TransportClient {
  return { id: randomUUID(), kind: "cloud", accountUserId: userId, authorized: () => true,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role, fingerprint: "a".repeat(64) },
    send: vi.fn(), close: vi.fn() };
}
it("fails immediately and clearly without an authorized connected desktop", async () => {
  configureNativeGithubDesktop(() => []);
  await expect(requestNativeGithubDesktop(request(), new AbortController().signal)).rejects.toThrow(
    "Open Zeros to authorize GitHub push for this cloud workspace",
  );
});
it.each(["viewer", "prompter"] as const)("never asks a %s or another actor to prepare a grant", async role => {
  const input = request(), guest = client(input.actorUserId, role), other = client(randomUUID());
  configureNativeGithubDesktop(() => [guest, other]);
  expect(acceptNativeGithubDesktop(guest, { kind: "ready" })).toBe(false);
  expect(acceptNativeGithubDesktop(other, { kind: "ready" })).toBe(true);
  await expect(requestNativeGithubDesktop(input, new AbortController().signal)).rejects.toThrow("Open Zeros");
  expect(guest.send).not.toHaveBeenCalled(); expect(other.send).not.toHaveBeenCalled();
});
it("binds a reply to the requested actor and exact live connection", async () => {
  const input = request(), desktop = client(input.actorUserId), other = client(input.actorUserId);
  configureNativeGithubDesktop(() => [desktop, other]);
  acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const waiting = requestNativeGithubDesktop(input, new AbortController().signal);
  const reply = { kind: "reply", requestId: input.native.requestId, grant: `zgw_${"a".repeat(43)}` };
  expect(acceptNativeGithubDesktop(other, reply)).toBe(false);
  expect(acceptNativeGithubDesktop(desktop, reply)).toBe(true);
  expect(await waiting).toEqual({ grant: reply.grant, actorSessionId: desktop.cloudActor!.sessionId });
  expect(acceptNativeGithubDesktop(desktop, reply)).toBe(false);
});
it("drops an aborted request and leaves Local clients untouched", async () => {
  const input = request(), desktop = client(input.actorUserId);
  const local = { ...desktop, kind: "local" as const };
  configureNativeGithubDesktop(() => [local, desktop]);
  expect(acceptNativeGithubDesktop(local, { kind: "ready" })).toBe(false);
  acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const abort = new AbortController();
  const waiting = requestNativeGithubDesktop(input, abort.signal);
  const rejected = expect(waiting).rejects.toThrow("Open Zeros");
  abort.abort(); await rejected;
  expect(acceptNativeGithubDesktop(desktop, { kind: "reply", requestId: input.native.requestId, grant: null })).toBe(false);
});
