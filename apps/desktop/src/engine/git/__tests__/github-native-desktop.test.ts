import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { TransportClient } from "../../transport/types";
import {
  configureNativeGithubDesktop, acceptNativeGithubDesktop, requestNativeGithubDesktop,
} from "../github-native-desktop";
afterEach(() => { configureNativeGithubDesktop(() => []); vi.useRealTimers(); });
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
  const local = { ...desktop, kind: "local" as const, send: vi.fn() };
  configureNativeGithubDesktop(() => [local, desktop]);
  expect(acceptNativeGithubDesktop(local, { kind: "ready" })).toBe(false);
  acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const abort = new AbortController();
  const waiting = requestNativeGithubDesktop(input, abort.signal);
  const rejected = expect(waiting).rejects.toThrow("Open Zeros");
  abort.abort(); await rejected;
  expect(local.send).not.toHaveBeenCalled();
  expect(acceptNativeGithubDesktop(desktop, { kind: "reply", requestId: input.native.requestId, grant: null })).toBe(false);
});

it("tries the next ready device of the same actor after no grant, then selects only one", async () => {
  const input = request(), first = client(input.actorUserId), second = client(input.actorUserId), other = client(randomUUID()), third = client(input.actorUserId);
  configureNativeGithubDesktop(() => [first, other, second, third]);
  for (const desktop of [first, second, other, third]) acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const waiting = requestNativeGithubDesktop(input, new AbortController().signal).catch(error => error);
  expect(acceptNativeGithubDesktop(first, { kind: "reply", requestId: input.native.requestId, grant: null })).toBe(true);
  expect(second.send).toHaveBeenCalledOnce();
  const reply = { kind: "reply", requestId: input.native.requestId, grant: `zgw_${"b".repeat(43)}` };
  expect(acceptNativeGithubDesktop(first, reply)).toBe(false);
  expect(acceptNativeGithubDesktop(other, reply)).toBe(false);
  expect(acceptNativeGithubDesktop(second, reply)).toBe(true);
  expect(await waiting).toEqual({ grant: reply.grant, actorSessionId: second.cloudActor!.sessionId });
  expect(other.send).not.toHaveBeenCalled(); expect(third.send).not.toHaveBeenCalled();
  expect(acceptNativeGithubDesktop(second, reply)).toBe(false);
});

it("bounds fallback to four devices and a single overall deadline", async () => {
  vi.useFakeTimers();
  const input = request(), desktops = Array.from({ length: 5 }, () => client(input.actorUserId));
  configureNativeGithubDesktop(() => desktops);
  for (const desktop of desktops) acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const waiting = requestNativeGithubDesktop(input, new AbortController().signal);
  const rejection = expect(waiting).rejects.toThrow("Open Zeros");
  for (const desktop of desktops.slice(0, 4)) acceptNativeGithubDesktop(desktop, { kind: "reply", requestId: input.native.requestId, grant: null });
  await rejection;
  expect(desktops[4]!.send).not.toHaveBeenCalled();
  expect(desktops.slice(0, 4).every(desktop => vi.mocked(desktop.send).mock.calls.length === 1)).toBe(true);

  const expiring = requestNativeGithubDesktop(input, new AbortController().signal);
  const expired = expect(expiring).rejects.toThrow("Open Zeros");
  await vi.advanceTimersByTimeAsync(14_900);
  acceptNativeGithubDesktop(desktops[0]!, { kind: "reply", requestId: input.native.requestId, grant: null });
  await vi.advanceTimersByTimeAsync(100);
  await expired;
  expect(acceptNativeGithubDesktop(desktops[1]!, { kind: "reply", requestId: input.native.requestId, grant: `zgw_${"b".repeat(43)}` })).toBe(false);
});

it("counts eligible devices rather than duplicate connections against the fallback bound", async () => {
  const input = request(), first = client(input.actorUserId), second = client(input.actorUserId);
  const duplicates = Array.from({ length: 3 }, () => ({ ...client(input.actorUserId),
    cloudActor: { ...first.cloudActor!, sessionId: randomUUID() } }));
  configureNativeGithubDesktop(() => [first, ...duplicates, second]);
  for (const desktop of [first, ...duplicates, second]) acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const abort = new AbortController();
  const waiting = requestNativeGithubDesktop(input, abort.signal).catch(error => error);
  acceptNativeGithubDesktop(first, { kind: "reply", requestId: input.native.requestId, grant: null });
  const attempts = vi.mocked(second.send).mock.calls.length;
  abort.abort(); await waiting;
  expect(attempts).toBe(1);
  expect(duplicates.every(desktop => vi.mocked(desktop.send).mock.calls.length === 0)).toBe(true);
});

it.each(["abort", "reconfigure", "session"])("ends fallback after %s without accepting a late grant", async cause => {
  vi.useFakeTimers();
  const input = request(), first = client(input.actorUserId), second = client(input.actorUserId), third = client(input.actorUserId);
  configureNativeGithubDesktop(() => [first, second, third]);
  for (const desktop of [first, second, third]) acceptNativeGithubDesktop(desktop, { kind: "ready" });
  const abort = new AbortController();
  const waiting = requestNativeGithubDesktop(input, abort.signal);
  const rejection = expect(waiting).rejects.toThrow("Open Zeros");
  acceptNativeGithubDesktop(first, { kind: "reply", requestId: input.native.requestId, grant: null });
  if (cause === "abort") abort.abort();
  if (cause === "reconfigure") configureNativeGithubDesktop(() => [first, second, third]);
  if (cause === "session") Object.assign(second, { cloudActor: { ...second.cloudActor!, sessionId: randomUUID() } });
  expect(acceptNativeGithubDesktop(second, { kind: "reply", requestId: input.native.requestId, grant: `zgw_${"b".repeat(43)}` })).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  expect(third.send).not.toHaveBeenCalled();
});
