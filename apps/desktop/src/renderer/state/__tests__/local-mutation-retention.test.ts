import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/renderer/platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "@/renderer/platform/bridge/active-bridge";
import { commitWorkspaceDeleted, peekWorkspacesFor, reloadWorkspacesFor } from "@/renderer/state/use-projects";
import type { Workspace } from "@/renderer/platform/git";
import { loadPersistedWorkspaceLists } from "@/renderer/state/workspace-list-persistence";
import { subscribeChatSnapshots } from "@/renderer/state/chat-snapshot-subscription";
import { reconcileChatSnapshot } from "@/renderer/state/chat-reconciliation";
import type { ChatThread } from "@/renderer/state/store";
const flush = () => new Promise(r => setTimeout(r, 0));
afterEach(() => { setActiveBridge(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("a failed Local revalidation cannot replace a completed deletion with an older retained list", async () => {
  const storage = new Map<string,string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  const row: Workspace = { id: "v1b-local-deleted", repoSlug: "v1b-local-delete", repoRoot: "/v1b-local", path: "/v1b-local/workspace", archivedAt: null,
    branch: "fixture", baseBranch: "main", status: "in-progress", createdAt: 1, stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: 1, present: true };
  const request = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { workspaces: [row] } } as never);
  const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  (bridge as any).setStatus("connected"); setActiveBridge(bridge);
  try {
    expect(await reloadWorkspacesFor(row.repoSlug)).toBe(true);
    expect(peekWorkspacesFor(row.repoSlug)).toEqual([row]);
    commitWorkspaceDeleted(row);
    (bridge as any).handleIncoming({ type: "DB_CHANGED", kinds: ["workspaces"], workspaceIds: [row.id] });
    expect(peekWorkspacesFor(row.repoSlug)).toEqual([]);
    request.mockRejectedValueOnce(new Error("Local read temporarily unavailable"));
    const confirmed = await reloadWorkspacesFor(row.repoSlug);
    expect.soft(confirmed).toBe(false);
    expect.soft(peekWorkspacesFor(row.repoSlug)).toEqual([]);
    expect.soft(loadPersistedWorkspaceLists().get(row.repoSlug)).toEqual([]);
  } finally { bridge.dispose(); }
});

it("a failed Local chat pull cannot reinsert a chat removed after the retained snapshot", async () => {
  const chat = { id: "v1b-deleted-chat", folder: "/v1b-local-chat", title: "Saved", createdAt: 1, updatedAt: 2 } as ChatThread;
  const request = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [chat], chatDeletions: [] } } as never);
  const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  (bridge as any).setStatus("connected");
  let current = [chat]; const snapshots: any[] = [];
  const off = subscribeChatSnapshots({ bridge, onLocalReadinessChange: vi.fn(), onError: vi.fn(), onSnapshot: snapshot => {
    snapshots.push(snapshot);
    current = reconcileChatSnapshot(current, snapshot.chats as unknown as ChatThread[], snapshot.chatDeletions, snapshot.confirmedCloudWorkspaces, snapshot.confirmedLocalChats).chats;
  }});
  try {
    await flush(); expect(current).toEqual([chat]);
    current = []; // Renderer has removed the confirmed-deleted chat.
    request.mockRejectedValueOnce(new Error("Local read temporarily unavailable"));
    (bridge as any).handleIncoming({ type: "DB_CHANGED", kinds: ["chats"] });
    await flush(); await flush();
    expect.soft(current).toEqual([]);
  } finally { off(); bridge.dispose(); }
});

it.each([false, true])("a failed Local successor retries without replaying stale chats (cloud present: %s)", async mixed => {
  vi.useFakeTimers();
  const { cloudWorkspaceKey, cloudScopedId } = await import("../../platform/bridge/cloud-workspace-key");
  const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
  const cloud = { id: cloudScopedId(target, "saved"), folder: cloudWorkspaceKey(target), title: "Cloud", createdAt: 1, updatedAt: 1 } as ChatThread;
  const local = { id: "local-successor", folder: "/local-successor", title: "Local", createdAt: 1, updatedAt: 1 } as ChatThread;
  const old = { type: "WORKSPACE_RESPONSE", result: { chats: [local], chatDeletions: [] } };
  const request = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(old as never);
  let revision = 1;
  const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [], readHistory: async () => ({ chats: [cloud], chatDeletions: [], revision }) });
  (bridge as unknown as { setStatus: (status: string) => void }).setStatus("connected");
  if (mixed) await bridge.warmHistoryWorkspace(target);
  let current: ChatThread[] = [local];
  const onSnapshot = vi.fn(snapshot => {
    current = reconcileChatSnapshot(current, snapshot.chats, snapshot.chatDeletions, snapshot.confirmedCloudWorkspaces, snapshot.confirmedLocalChats).chats;
  });
  const off = subscribeChatSnapshots({ bridge, onSnapshot, onError: vi.fn(), onLocalReadinessChange: vi.fn() });
  const emit = () => (bridge as unknown as { handleIncoming: (event: unknown) => void }).handleIncoming({ type: "DB_CHANGED", kinds: ["chats"] });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(current).toContainEqual(local);
    let finish!: (value: never) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    request.mockRejectedValueOnce(new Error("Successor temporarily unavailable"));
    emit(); await vi.advanceTimersByTimeAsync(0);
    current = current.filter(chat => chat.id !== local.id);
    emit();
    finish(old as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(current).not.toContainEqual(local);
    const readsAfterFailure = request.mock.calls.length;
    const snapshotsAfterFailure = onSnapshot.mock.calls.length;
    if (mixed) {
      await vi.advanceTimersByTimeAsync(1_100);
      revision++;
      await bridge.warmHistoryWorkspace(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(readsAfterFailure);
      expect(current).toEqual([cloud]);
    } else {
      expect(onSnapshot.mock.calls.length).toBe(snapshotsAfterFailure);
    }
    request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [local.id] } } as never);
    await vi.advanceTimersByTimeAsync(mixed ? 900 : 2_000);
    expect(request).toHaveBeenCalledTimes(readsAfterFailure + 1);
    expect(onSnapshot.mock.lastCall?.[0].confirmedLocalChats).toBe(true);
    expect(current).toEqual(mixed ? [cloud] : []);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request).toHaveBeenCalledTimes(readsAfterFailure + 1);
  } finally { off(); bridge.dispose(); vi.useRealTimers(); }
});

it("unconfirmed chat rows and tombstones cannot override newer Local or cloud owner receipts", async () => {
  const { cloudScopedId, cloudWorkspaceKey } = await import("../../platform/bridge/cloud-workspace-key");
  const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
  const local = { id: "local-current", folder: "/local", title: "restored", createdAt: 1, updatedAt: 1 } as ChatThread;
  const cloud = { ...local, id: cloudScopedId(target, "restored"), folder: cloudWorkspaceKey(target) };
  const current = [local, cloud];
  const result = reconcileChatSnapshot(current, [{ ...local, id: "deleted-local" }, { ...cloud, id: cloudScopedId(target, "deleted") }], [local.id, cloud.id], [], false);
  expect(result.chats).toBe(current);
  expect(result.removedIds).toEqual([]);
  expect(result.rowsToPush).toEqual([]);
});

it("a failed workspace successor preserves a newer deletion receipt in memory and persistence", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const row = { id: "local-workspace-successor", repoSlug: "local-workspace-successor", path: "/local/workspace-successor", repoRoot: "/local", archivedAt: null, branch: "fixture", baseBranch: "main", status: "in-progress", createdAt: 1, stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: 1, present: true } as Workspace;
  const old = { type: "WORKSPACE_RESPONSE", result: { workspaces: [row] } };
  const request = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(old as never);
  const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  (bridge as unknown as { setStatus: (status: string) => void }).setStatus("connected");
  setActiveBridge(bridge);
  try {
    expect(await reloadWorkspacesFor(row.repoSlug)).toBe(true);
    let finish!: (value: never) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    request.mockRejectedValueOnce(new Error("Successor unavailable"));
    const stale = reloadWorkspacesFor(row.repoSlug);
    await flush();
    commitWorkspaceDeleted(row);
    (bridge as unknown as { handleIncoming: (event: unknown) => void }).handleIncoming({ type: "DB_CHANGED", kinds: ["workspaces"], workspaceIds: [row.id] });
    const fresh = reloadWorkspacesFor(row.repoSlug);
    finish(old as never);
    expect(await stale).toBe(false);
    expect(await fresh).toBe(false);
    expect(peekWorkspacesFor(row.repoSlug)).toEqual([]);
    expect(loadPersistedWorkspaceLists().get(row.repoSlug)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
    request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { workspaces: [] } } as never);
    expect(await reloadWorkspacesFor(row.repoSlug)).toBe(true);
    expect(peekWorkspacesFor(row.repoSlug)).toEqual([]);
  } finally { bridge.dispose(); }
});
