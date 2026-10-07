import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ directory: "", user: null as { accountId: string; sub: string; provider: "workos"; sessionId: string } | null,
  listeners: [] as Array<() => void>, refresh: vi.fn(), wake: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => h.directory } }));
vi.mock("../ipc/commands/auth-session", () => ({ getSessionUserForMain: () => h.user,
  onMainAuthSessionChanged: (fn: () => void) => { h.listeners.push(fn); return () => {}; }, getValidAccessTokenForMain: h.refresh }));
import { cloudTranscriptCacheRead, cloudTranscriptCacheWrite, cloudTranscriptCachePrune,
  installCloudTranscriptCacheLifecycle } from "../ipc/commands/cloud-transcript-cache";

const owner = { accountId: "account-a", organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat-a" };
const window = { recordEpoch: null, revision: 2, cursor: "m-1", messages: [{ msgId: "m-1", kind: "text", createdAt: 10,
  payload: JSON.stringify({ id: "m-1", kind: "text", role: "agent", text: "confirmed", createdAt: 10 }) }] };
const event = {} as Parameters<typeof cloudTranscriptCacheRead>[1];
beforeEach(async () => {
  h.directory = await mkdtemp(path.join(tmpdir(), "zeros-cache-ipc-"));
  h.user = { accountId: owner.accountId, sub: "workos-a", provider: "workos", sessionId: h.directory };
  h.refresh.mockReset(); h.wake.mockReset();
  installCloudTranscriptCacheLifecycle();
});
afterEach(async () => { await rm(h.directory, { recursive: true, force: true }); });

describe("account-owned transcript cache IPC", () => {
  it("reads/writes only the current main-owned account without refreshing auth or waking compute", () => {
    const receipt = cloudTranscriptCacheRead(owner, event) as { cacheEpoch: string; window: null };
    expect(receipt.window).toBeNull();
    cloudTranscriptCacheWrite({ ...owner, cacheEpoch: receipt.cacheEpoch, window }, event);
    expect(cloudTranscriptCacheRead(owner, event)).toMatchObject({ window: { revision: 2 } });
    expect(h.refresh).not.toHaveBeenCalled(); expect(h.wake).not.toHaveBeenCalled();
    expect(() => cloudTranscriptCacheRead({ ...owner, accountId: "account-b" }, event)).toThrow(/owner changed/u);
    expect(() => cloudTranscriptCacheWrite({ ...owner, accessToken: "synthetic", cacheEpoch: receipt.cacheEpoch, window }, event)).toThrow();
  });
  it("purges a retired account and fences late writes even after A → B → A", () => {
    const a = cloudTranscriptCacheRead(owner, event) as { cacheEpoch: string };
    cloudTranscriptCacheWrite({ ...owner, cacheEpoch: a.cacheEpoch, window }, event);
    h.user = { ...h.user!, accountId: "account-b", sessionId: "session-b" };
    for (const listener of h.listeners) listener();
    expect(() => cloudTranscriptCacheRead(owner, event)).toThrow();
    h.user = { ...h.user!, accountId: owner.accountId, sessionId: "session-a-new" };
    for (const listener of h.listeners) listener();
    expect(cloudTranscriptCacheRead(owner, event)).toMatchObject({ window: null });
    expect(() => cloudTranscriptCacheWrite({ ...owner, cacheEpoch: a.cacheEpoch, window }, event)).toThrow(/owner changed/u);
  });
  it("purges on sign-out and removes exact tombstones without deleting sibling chats", () => {
    const receipt = cloudTranscriptCacheRead(owner, event) as { cacheEpoch: string };
    cloudTranscriptCacheWrite({ ...owner, cacheEpoch: receipt.cacheEpoch, window }, event);
    const b = { ...owner, chatId: "chat-b" };
    cloudTranscriptCacheWrite({ ...b, cacheEpoch: receipt.cacheEpoch, window }, event);
    cloudTranscriptCachePrune(owner, event);
    expect(cloudTranscriptCacheRead(owner, event)).toMatchObject({ window: null });
    expect(cloudTranscriptCacheRead(b, event)).toMatchObject({ window: { revision: 2 } });
    h.user = null; for (const listener of h.listeners) listener();
    expect(() => cloudTranscriptCacheRead(b, event)).toThrow();
    h.user = { accountId: owner.accountId, sub: "workos-a", provider: "workos", sessionId: "signed-in-again" };
    for (const listener of h.listeners) listener();
    expect(cloudTranscriptCacheRead(b, event)).toMatchObject({ window: null });
  });
});
