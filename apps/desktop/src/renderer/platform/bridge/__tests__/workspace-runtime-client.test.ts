import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type ConnectionStatus } from "../ws-client";
import { classifyRpcError, isRecoverable } from "../failure";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
  type WorkspaceRuntimeOptions,
} from "../workspace-runtime-client";
import {
  cloudScopedId,
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "../cloud-workspace-key";
import type { BridgeMessage } from "../messages";
import { bridgeGhPrList, bridgeGhRepoAccess } from "../workspace-bridge";
import {
  bridgePtyCreate,
  bridgePtyTerminals,
  bridgePtyWrite,
  bridgePtyResize,
  bridgePtyKill,
  subscribeBridgePtyData,
  subscribeBridgePtyExit,
} from "../pty-bridge";

const organizationId = "11111111-1111-4111-8111-111111111111";
const a = {
  organizationId,
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const b = {
  organizationId,
  workspaceId: "33333333-3333-4333-8333-333333333333",
};
/** The control-plane mirror holds the worker's native rows under this checkout. */
const MIRROR_ROOT = "/home/user/Owner/repo";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakePeer(target: CloudWorkspaceTarget) {
  const handlers = new Map<string, Set<(message: BridgeMessage) => void>>();
  const request = vi.fn(
    async (
      message: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      return { type: "WORKSPACE_RESPONSE", op: message.op, result:
        message.op === "chats.list"
          ? { chats: [], chatDeletions: [] }
          : { target: target.workspaceId } };
    },
  );
  const send = vi.fn();
  const release = vi.fn();
  const client = {
    request,
    send,
    status: "connected",
    on: (type: string, fn: (message: BridgeMessage) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
    onStatusChange: () => () => {},
  } as unknown as RuntimeClient;
  return {
    peer: {
      client,
      scope: {
        ...target,
        root: "/workspace/repo",
        engineWorkspaceId: "local-main",
      },
      release,
    } as CloudPeer,
    request,
    send,
    release,
    emit: (type: string, fields: object) => {
      for (const fn of handlers.get(type) ?? [])
        fn({ type, ...fields } as BridgeMessage);
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("file reference ownership", () => {
  it("uses only admitted native roots and never wakes another owner to resolve a hover", async () => {
    const peer = fakePeer(a), open = vi.fn(async () => peer.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    try {
      expect(client.fileReferencePath(cloudWorkspaceKey(a), "/workspace/repo/a.png")).toBeNull();
      expect(client.fileReferencePath(cloudWorkspaceKey(a), "art/a.png")).toBe("art/a.png");
      expect(open).not.toHaveBeenCalled();
      await client.warmWorkspace(a);
      expect(client.fileReferencePath(cloudWorkspaceKey(a), "/workspace/repo/a.png")).toBe("a.png");
      expect(client.fileReferencePath(cloudWorkspaceKey(b), "/workspace/repo/a.png")).toBeNull();
      expect(client.fileReferencePath(cloudWorkspaceKey(a), "/other/a.png")).toBeNull();
      expect(client.fileReferencePath("/local/repo", "/local/repo/a.png")).toBe("a.png");
      expect(open).toHaveBeenCalledTimes(1);
      client.clearCloudConnections();
      expect(client.fileReferencePath(cloudWorkspaceKey(a), "/workspace/repo/a.png")).toBeNull();
    } finally { client.dispose(); }
  });
});



describe("workspace runtime routing", () => {
  it("reuses a healthy running v2 peer for repeated send preparation, but obtains fresh admission after stop", async () => {
    const peer = fakePeer(a), replacement = fakePeer(a);
    let running = true;
    const open = vi.fn().mockResolvedValueOnce(peer.peer).mockResolvedValueOnce(replacement.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canReuseForWork: () => running });
    try {
      await client.warmWorkspace(a);
      await client.openWorkspace(a); await client.openWorkspace(a);
      expect(open).toHaveBeenCalledOnce(); expect(peer.release).not.toHaveBeenCalled();
      running = false;
      await client.openWorkspace(a);
      expect(open).toHaveBeenCalledTimes(2); expect(peer.release).toHaveBeenCalledOnce();
      expect(open).toHaveBeenLastCalledWith(a, expect.objectContaining({ wake: true }));
    } finally { client.dispose(); }
  });

  it("never reuses a disconnected or differently owned peer for queued work", async () => {
    let identity = "account-1";
    const old = fakePeer(a), next = fakePeer(a), last = fakePeer(a);
    const open = vi.fn().mockResolvedValueOnce(old.peer).mockResolvedValueOnce(next.peer).mockResolvedValueOnce(last.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canReuseForWork: () => true, identity: () => identity });
    try {
      await client.openWorkspace(a); Object.assign(old.peer.client, { status: "disconnected" });
      await client.openWorkspace(a);
      expect(open).toHaveBeenCalledTimes(2); expect(old.release).toHaveBeenCalledOnce();
      identity = "account-2"; await client.openWorkspace(a);
      expect(open).toHaveBeenCalledTimes(3); expect(next.release).toHaveBeenCalledOnce();
    } finally { client.dispose(); }
  });

  it.each(["/personal/local", "/organization/local", cloudWorkspaceKey(a)])(
    "classifies an account-retired %s list as cancelled ownership without replay or a provider failure",
    async folder => {
      const waiting = deferred<BridgeMessage>();
      const local = vi.spyOn(RuntimeClient.prototype, "request").mockReturnValue(waiting.promise);
      const peer = fakePeer(a), cloud = folder.startsWith("cloud://");
      const open = vi.fn(async () => peer.peer);
      const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
      try {
        if (cloud) await client.warmWorkspace(a);
        const request = client.chatSnapshot("all");
        const classified = request.catch(error => classifyRpcError({ agentId: "codex", stage: "loadSession", error }));
        client.clearCloudConnections();
        waiting.resolve({ type: "WORKSPACE_RESPONSE", op: "chats.list", result: { chats: [{ id: "old", folder }], chatDeletions: [] } } as BridgeMessage);
        const failure = await classified;
        expect(failure).toMatchObject({ kind: "lifecycle-superseded", stage: "loadSession" });
        expect(isRecoverable(failure as ReturnType<typeof classifyRpcError>)).toBe(false);
        expect(open).toHaveBeenCalledTimes(cloud ? 1 : 0);
        expect(local).toHaveBeenCalledOnce();
      } finally { client.dispose(); }
    },
  );

  it("releases a terminally rejected peer while retaining its last confirmed cloud history", async () => {
    const pa = fakePeer(a), replacement = fakePeer(a); let status!: (value: ConnectionStatus) => void;
    pa.peer.client.onStatusChange = (listener) => { status = listener; return () => {}; };
    pa.request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [{ id: "saved" }], chatDeletions: [] } });
    const open = vi.fn().mockResolvedValueOnce(pa.peer).mockResolvedValueOnce(replacement.peer), client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    await client.warmWorkspace(a); expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(true);
    pa.peer.client.lastRejection = { reason: "cloud-superseded", code: "cloud_workspace_access_superseded", message: "Replaced" };
    status("disconnected");
    expect(pa.release).toHaveBeenCalledOnce(); expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(true); expect(open).toHaveBeenCalledOnce();
    await client.warmWorkspace(a); expect(open).toHaveBeenCalledTimes(2); client.dispose();
  });
  it("routes cloud permission and question ownership to its peer without touching the Local socket", async () => {
    const pa = fakePeer(a), local = vi.spyOn(RuntimeClient.prototype, "send"), client = new WorkspaceRuntimeClient({ open: async () => pa.peer, workspaces: () => [] });
    await client.warmWorkspace(a);
    const ownership = { chatId: cloudScopedId(a, "chat"), executionId: cloudScopedId(a, "native") };
    client.send({ type: "AGENT_PERMISSION_RESPONSE", ...ownership, permissionId: "permission", response: { outcome: { outcome: "cancelled" } } });
    client.send({ type: "AGENT_QUESTION_RESPONSE", ...ownership, questionId: "question", response: { outcome: { outcome: "dismissed" } } });
    expect(local).not.toHaveBeenCalled(); expect(pa.send).toHaveBeenCalledTimes(2);
    expect(pa.send).toHaveBeenNthCalledWith(1, { type: "AGENT_PERMISSION_RESPONSE", chatId: "chat", executionId: "native", permissionId: "permission",
      response: { outcome: { outcome: "cancelled" } } });
    expect(pa.send).toHaveBeenNthCalledWith(2, { type: "AGENT_QUESTION_RESPONSE", chatId: "chat", executionId: "native", questionId: "question",
      response: { outcome: { outcome: "dismissed" } } });
    client.dispose();
  });
  it("caps the entire logical open at fifteen minutes even if native admission never settles", async () => {
    vi.useFakeTimers(); const ready = deferred<CloudPeer>(), peer = fakePeer(a), failed = vi.fn();
    const client = new WorkspaceRuntimeClient({ open: () => ready.promise, workspaces: () => [] });
    try {
      const pending = client.openWorkspace(a).catch(failed);
      await vi.advanceTimersByTimeAsync(899_999); expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("fifteen minutes") }));
      ready.resolve(peer.peer); await pending; await vi.advanceTimersByTimeAsync(0);
      expect(peer.release).toHaveBeenCalledOnce(); expect(peer.request).not.toHaveBeenCalled();
    } finally { client.dispose(); vi.useRealTimers(); }
  });
  it("keeps navigation and queued-send opens across a generation replacement and dispatches only to its engine", async () => {
    let generation = 7;
    const ready = deferred<CloudPeer>(), replacement = fakePeer(a), old = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>(() => ready.promise);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => `account:${generation}`,
      wakeOwner: () => ({ account: "account", generation, stopVersion: 0 }) });
    const navigation = client.openWorkspace(a, { reason: "interaction" });
    const send = client.openWorkspace(a);
    generation++; client.pruneCloudConnections();
    expect(open.mock.calls[0][1]?.signal.aborted).toBe(false);
    ready.resolve(replacement.peer);
    await Promise.all([navigation, send]);
    await client.request({ type: "WORKSPACE_REQUEST", op: "git.status", params: { cwd: cloudWorkspaceKey(a) } } as never);
    expect(replacement.request.mock.calls.filter(([message]) => message.op === "git.status")).toHaveLength(1);
    expect(old.request).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledOnce(); client.dispose();
  });
  it("re-admits after a connecting old generation is fenced while preserving the logical open", async () => {
    let generation = 7, reject!: (error: Error) => void;
    const replacement = fakePeer(a), first = new Promise<CloudPeer>((_resolve, fail) => { reject = fail; });
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(first).mockResolvedValue(replacement.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => `account:${generation}`,
      wakeOwner: () => ({ account: "account", generation, stopVersion: 0 }) });
    const pending = client.openWorkspace(a);
    generation++; client.pruneCloudConnections(); reject(new Error("Cloud workspace generation changed during admission"));
    await pending; expect(open).toHaveBeenCalledTimes(2);
    await client.warmWorkspace(a); expect(open).toHaveBeenCalledTimes(2); client.dispose();
  });
  it("never relabels an old admitted engine when replacement publishes just before open resolves", async () => {
    let generation = 7; const ready = deferred<CloudPeer>(), old = fakePeer(a), replacement = fakePeer(a);
    Object.assign(old.peer, { generation: 7 }); Object.assign(replacement.peer, { generation: 8 });
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(ready.promise).mockResolvedValue(replacement.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => `account:${generation}`,
      wakeOwner: () => ({ account: "account", generation, stopVersion: 0 }) });
    const pending = client.openWorkspace(a); generation++; client.pruneCloudConnections(); ready.resolve(old.peer);
    await pending; expect(open).toHaveBeenCalledTimes(2); expect(old.release).toHaveBeenCalledOnce();
    await client.request({ type: "WORKSPACE_REQUEST", op: "git.status", params: { cwd: cloudWorkspaceKey(a) } } as never);
    expect(old.request).not.toHaveBeenCalled();
    expect(replacement.request.mock.calls.filter(([message]) => message.op === "git.status")).toHaveLength(1); client.dispose();
  });
  it("disposes a late candidate admission after rollback and admits the source once for shared intents", async () => {
    const candidate = fakePeer(a), source = fakePeer(a), late = deferred<CloudPeer>();
    candidate.peer.generation = 8; source.peer.generation = 7;
    let generation = 7;
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(late.promise).mockResolvedValue(source.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => `account:${generation}`,
      wakeOwner: () => ({ account: "account", generation, stopVersion: 0, lifecyclePending: true }) });
    const failed = vi.fn(); const completed = Promise.all([client.openWorkspace(a, { reason: "interaction" }), client.openWorkspace(a)]).catch(failed);
    generation = 8; client.pruneCloudConnections(); generation = 7; client.pruneCloudConnections();
    late.resolve(candidate.peer); await completed;
    expect(failed).not.toHaveBeenCalled(); expect(candidate.release).toHaveBeenCalledOnce();
    expect(candidate.request).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledTimes(2);
    await client.request({ type: "WORKSPACE_REQUEST", op: "file.write", params: { cwd: cloudWorkspaceKey(a), path: "after.txt", content: "one" } });
    expect(source.request.mock.calls.filter(([message]) => message.op === "file.write")).toHaveLength(1);
    client.dispose();
  });
  it("re-admits after a native connection is retired during N to N+1 to N without losing either waiter", async () => {
    let generation = 7, fail!: (error: Error) => void;
    const source = fakePeer(a), first = new Promise<CloudPeer>((_resolve, reject) => { fail = reject; });
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(first).mockResolvedValue(source.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => `account:${generation}`,
      wakeOwner: () => ({ account: "account", generation, stopVersion: 0, lifecyclePending: true }) });
    const failed = vi.fn(); const pending = Promise.all([client.openWorkspace(a, { reason: "interaction" }), client.openWorkspace(a)]).catch(failed);
    generation++; client.pruneCloudConnections(); generation--; client.pruneCloudConnections();
    fail(new Error("Native connection retired while connecting")); await pending;
    try { expect(failed).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledTimes(2); }
    finally { client.dispose(); }
  });
  it.each(["account", "access", "stop", "rollback"])("ends replacement preparation when %s changes", async cause => {
    let owner: { account: string; generation: number; stopVersion: number } | undefined = { account: "account", generation: 7, stopVersion: 0 };
    const ready = deferred<CloudPeer>(), peer = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>(() => ready.promise);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => `account:${owner?.generation}`,
      wakeOwner: () => owner && { ...owner } });
    const pending = client.openWorkspace(a), rejected = expect(pending).rejects.toThrow(/account changed|cancelled/i);
    owner!.generation++; client.pruneCloudConnections();
    if (cause === "account") owner!.account = "other";
    if (cause === "access") owner = undefined;
    if (cause === "stop") owner!.stopVersion++;
    if (cause === "rollback") owner!.generation = 7;
    client.pruneCloudConnections(); expect(open.mock.calls[0][1]?.signal.aborted).toBe(true);
    ready.resolve(peer.peer); await rejected;
    expect(open).toHaveBeenCalledOnce(); expect(peer.release).toHaveBeenCalledOnce(); expect(peer.request).not.toHaveBeenCalled(); client.dispose();
  });

  it("honors cancellation raised synchronously while the shared flight is being published", async () => {
    const controller = new AbortController(), ready = deferred<CloudPeer>(), peer = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>(() => { controller.abort(); return ready.promise; });
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    const result = client.openWorkspace(a, { signal: controller.signal }).then(() => "opened", () => "cancelled");
    try { expect(open.mock.calls[0][1]?.signal.aborted).toBe(true); }
    finally { ready.resolve(peer.peer); await result; client.dispose(); }
    expect(await result).toBe("cancelled");
  });
  it("shares an explicit open and message preparation while keeping passive opens read-only", async () => {
    const ready = deferred<CloudPeer>(), peer = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>(() => ready.promise);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    const navigation = new AbortController(), message = new AbortController();
    const first = client.openWorkspace(a, { signal: navigation.signal, reason: "interaction" });
    const second = client.openWorkspace(a, { signal: message.signal });
    const cancelled = expect(first).rejects.toThrow(/cancel/i);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(a, expect.objectContaining({ wake: true, reason: "interaction" }));
    navigation.abort();
    await cancelled;
    expect(open.mock.calls[0][1]?.signal.aborted).toBe(false);
    ready.resolve(peer.peer); await second;
    await client.request({ type: "WORKSPACE_REQUEST", op: "git.status", params: { cwd: cloudWorkspaceKey(a) } } as never);
    expect(open).toHaveBeenCalledOnce();
    client.dispose();
  });
  it("cancels the shared explicit admission when its last intent leaves, fencing a late peer", async () => {
    const ready = deferred<CloudPeer>(), peer = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>(() => ready.promise);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    const controller = new AbortController();
    const pending = client.openWorkspace(a, { signal: controller.signal });
    const cancelled = expect(pending).rejects.toThrow(/cancel/i);
    controller.abort(); await cancelled;
    expect(open.mock.calls[0][1]?.signal.aborted).toBe(true);
    ready.resolve(peer.peer);
    await vi.waitFor(() => expect(peer.release).toHaveBeenCalledOnce());
    expect(peer.request).not.toHaveBeenCalled();
    client.dispose();
  });
  it("promotes a failed passive attachment only for the explicit waiter", async () => {
    let fail!: (reason: Error) => void;
    const passive = new Promise<CloudPeer>((_resolve, reject) => { fail = reject; });
    const peer = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(passive).mockResolvedValue(peer.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    const warming = client.warmWorkspace(a, { intent: true });
    const failed = expect(warming).rejects.toThrow(/stopped/);
    const explicit = client.openWorkspace(a);
    expect(open.mock.calls[0][1]?.wake).toBeUndefined();
    fail(new Error("workspace stopped")); await failed; await explicit;
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1][1]?.wake).toBe(true);
    client.dispose();
  });
  it("does not retry a rejected wake because a previous account had a passive attachment", async () => {
    const old = deferred<CloudPeer>(), oldPeer = fakePeer(a);
    let identity = "account:1";
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>()
      .mockReturnValueOnce(old.promise).mockRejectedValue(new Error("wake denied"));
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => identity });
    const warming = client.warmWorkspace(a, { intent: true });
    const stale = expect(warming).rejects.toThrow(/account changed/i);
    identity = "account:2";
    await expect(client.openWorkspace(a)).rejects.toThrow("wake denied");
    old.resolve(oldPeer.peer); await stale;
    client.dispose();
    expect(open).toHaveBeenCalledTimes(2);
    expect(oldPeer.release).toHaveBeenCalledOnce();
  });
  it("keeps a replacement wake when the cancelled admission arrives late", async () => {
    const old = deferred<CloudPeer>(), next = deferred<CloudPeer>();
    const oldPeer = fakePeer(a), nextPeer = fakePeer(a);
    const open = vi.fn<WorkspaceRuntimeOptions["open"]>().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    const controller = new AbortController();
    const rejected = expect(client.openWorkspace(a, { signal: controller.signal })).rejects.toThrow(/cancel/);
    controller.abort(); await rejected;
    const replacement = client.openWorkspace(a);
    old.resolve(oldPeer.peer);
    await vi.waitFor(() => expect(oldPeer.release).toHaveBeenCalledOnce());
    const message = client.openWorkspace(a);
    expect(open).toHaveBeenCalledTimes(2);
    next.resolve(nextPeer.peer); await Promise.all([replacement, message]);
    expect(nextPeer.release).not.toHaveBeenCalled();
    client.dispose();
  });

  it("reads the attached worker's current transcript without replacing it with a lagging cloud projection", async () => {
    const peer = fakePeer(a);
    const remote = { messages: [{ msgId: "reply", kind: "text", payload: "old", createdAt: 1 }] };
    const live = { messages: [{ ...remote.messages[0], payload: "complete" }] };
    const readHistory = vi.fn(async (_target, op) => op === "chats.list"
      ? { chats: [], chatDeletions: [], revision: 1 } : remote);
    const open = vi.fn(async () => peer.peer);
    const client = new WorkspaceRuntimeClient({ open, readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId: cloudScopedId(a, "chat"), limit: 100 } };
    try {
      expect(await client.request(request)).toMatchObject({ result: remote });
      expect(open).not.toHaveBeenCalled(); // Cold/stopped history never wakes a VM.
      await client.warmWorkspace(a);
      peer.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", result: live });
      expect(await client.request(request)).toMatchObject({ result: live });
      expect(peer.request).toHaveBeenLastCalledWith(expect.objectContaining({
        op: "messages.window", params: { chatId: "chat", limit: 100 },
      }), { timeoutMs: 5000 });
      Object.defineProperty(peer.peer.client, "status", { value: "disconnected" });
      expect(await client.request(request)).toMatchObject({ result: remote });
      expect(open).toHaveBeenCalledOnce();
    } finally { client.dispose(); }
  });

  it("rejects an attached history response after its workspace connection is retired", async () => {
    const peer = fakePeer(a), pending = deferred<Record<string, unknown>>();
    const readHistory = vi.fn(async () => ({ chats: [], chatDeletions: [], revision: 1 }));
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    try {
      await client.warmWorkspace(a);
      peer.request.mockReturnValueOnce(pending.promise);
      const result = client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: cloudScopedId(a, "chat") } });
      const rejected = expect(result).rejects.toThrow(/changed|retired/i);
      client.clearCloudConnections();
      pending.resolve({ type: "WORKSPACE_RESPONSE", result: { messages: [] } });
      await rejected;
    } finally { client.dispose(); }
  });
  it("publishes cloud history once and keeps unchanged polls quiet without invalidating files or Local", async () => {
    let now = 1_000, revision = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const open = vi.fn();
    const readHistory = vi.fn(async (_target: CloudWorkspaceTarget) => ({
      revision, chats: [{ id: "saved", folder: MIRROR_ROOT }], chatDeletions: [],
    }));
    const client = new WorkspaceRuntimeClient({ open, readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    const changed = vi.fn();
    client.on("DB_CHANGED", changed);
    try {
      await Promise.all([client.warmHistoryWorkspace(a), client.warmHistoryWorkspace(a)]);
      expect(readHistory).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        type: "DB_CHANGED", kinds: ["chats", "messages"],
        workspaceId: cloudWorkspaceKey(a), workspaceIds: [cloudWorkspaceKey(a)], cloudWorkspace: cloudWorkspaceKey(a),
      });
      const request = { type: "WORKSPACE_REQUEST" as const, op: "chats.list", params: { workspaceId: cloudWorkspaceKey(a) } };
      const first = await client.request(request);
      await client.warmHistoryWorkspace(b);
      changed.mockClear();
      now += 2_000;
      await Promise.all([client.warmHistoryWorkspace(a), client.warmHistoryWorkspace(a)]);
      expect(readHistory).toHaveBeenCalledTimes(3);
      expect(changed).not.toHaveBeenCalled();
      expect((await client.request(request) as unknown as { result: unknown }).result)
        .toBe((first as unknown as { result: unknown }).result);
      revision++;
      now += 2_000;
      await client.warmHistoryWorkspace(a);
      expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: cloudWorkspaceKey(a) }));
      expect(open).not.toHaveBeenCalled();
      changed.mockClear();
      now += 2_000;
      readHistory.mockRejectedValueOnce(new Error("offline"));
      await expect(client.warmHistoryWorkspace(a)).rejects.toThrow("offline");
      expect(changed).not.toHaveBeenCalled();
      expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(true);
    } finally { client.dispose(); }
  });

  it("fences a late history warm after account replacement without disturbing its replacement read", async () => {
    const old = deferred<Record<string, unknown>>(), next = deferred<Record<string, unknown>>();
    const readHistory = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    const changed = vi.fn();
    client.on("DB_CHANGED", changed);
    try {
      const rejected = expect(client.warmHistoryWorkspace(a)).rejects.toThrow(/access changed/i);
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledOnce());
      client.clearCloudConnections();
      const replacement = client.warmHistoryWorkspace(a);
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2));
      old.resolve({ revision: 1, chats: [{ id: "old-account" }], chatDeletions: [] });
      await rejected;
      expect(changed).not.toHaveBeenCalled();
      expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(false);
      const shared = client.warmHistoryWorkspace(a);
      next.resolve({ revision: 2, chats: [{ id: "current-account" }], chatDeletions: [] });
      await Promise.all([replacement, shared]);
      expect(readHistory).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledOnce();
    } finally { client.dispose(); }
  });

  it("loads a stopped workspace's chat list and tools without opening its VM", async () => {
    const open = vi.fn();
    vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({
      type: "WORKSPACE_RESPONSE", result: { chats: [{ id: "local-chat" }], chatDeletions: [] },
    } as unknown as BridgeMessage);
    const readHistory = vi.fn(async (_target: CloudWorkspaceTarget, op: string) => op === "chats.list"
      ? { chats: [{ id: "saved", folder: MIRROR_ROOT }], chatDeletions: [] }
      : { messages: [{ msgId: "tool", kind: "tool_call", payload: '{"status":"completed"}', createdAt: 1 }] });
    const client = new WorkspaceRuntimeClient({ open, readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    try {
      await client.warmHistoryWorkspace(a);
      expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(true);
      const result = await client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: cloudScopedId(a, "saved"), limit: 100 } });
      expect(result).toMatchObject({ result: { messages: [{ msgId: "tool" }] } });
      expect(await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list" })).toMatchObject({ result: {
        chats: [{ id: "local-chat" }, { id: cloudScopedId(a, "saved") }], confirmedCloudWorkspaces: [cloudWorkspaceKey(a)],
      } });
      expect(open).not.toHaveBeenCalled();
      expect(client.statusForWorkspace(cloudWorkspaceKey(a))).toBe("disconnected");
    } finally { client.dispose(); }
  });

  it("shares history reads by workspace and fences account replacement", async () => {
    const pending = deferred<Record<string, unknown>>();
    const readHistory = vi.fn(() => pending.promise);
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId: cloudScopedId(a, "saved"), limit: 100 } };
    const first = client.request(request), second = client.request(request);
    const rejected = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledOnce());
    client.clearCloudConnections();
    pending.resolve({ messages: [{ msgId: "old-account" }] });
    expect((await rejected).every(result => result.status === "rejected")).toBe(true);
    expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(false);
    client.dispose();
  });

  it("denies cloud history after access is revoked without returning its warm cache", async () => {
    let allowed = true;
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [], canAccess: () => allowed,
      readHistory: async () => ({ messages: [{ msgId: "saved" }] }), historyRoot: () => MIRROR_ROOT });
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId: cloudScopedId(a, "saved"), limit: 100 } };
    await client.request(request);
    allowed = false;
    await expect(client.request(request)).rejects.toThrow(/access/i);
    client.dispose();
  });

  it("keeps confirmed history after reconnect hydration fails and fences late old responses", async () => {
    vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({
      type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] },
    } as unknown as BridgeMessage);
    const old = fakePeer(a), failed = fakePeer(a), fresh = fakePeer(a);
    old.request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: {
      chats: [{ id: "saved", folder: "/workspace/repo" }], chatDeletions: [],
    } });
    const open = vi.fn().mockResolvedValueOnce(old.peer).mockResolvedValueOnce(failed.peer).mockResolvedValueOnce(fresh.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    try {
      await client.warmWorkspace(a);
      const late = deferred<Record<string, unknown>>();
      old.request.mockImplementationOnce(() => late.promise);
      const stale = client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: {
        workspaceId: cloudWorkspaceKey(a), path: "saved.ts",
      } });
      const rejected = expect(stale).rejects.toThrow(/connection changed/);
      await vi.waitFor(() => expect(old.request).toHaveBeenCalledTimes(2));
      Object.assign(old.peer.client, { status: "disconnected" });
      failed.request.mockRejectedValue(new Error("disconnected while loading history"));
      const reconnection = client.warmWorkspace(a);
      const reconnectRejected = expect(reconnection).rejects.toThrow(/loading history/);
      late.resolve({ type: "WORKSPACE_RESPONSE", result: { content: "stale" } });
      await Promise.all([rejected, reconnectRejected]);
      expect(failed.release).toHaveBeenCalledOnce();
      expect(await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list", params: {} })).toMatchObject({ result: {
        confirmedCloudWorkspaces: [cloudWorkspaceKey(a)],
        chats: [{ id: cloudScopedId(a, "saved"), folder: cloudWorkspaceKey(a) }],
      } });
      await client.warmWorkspace(a);
      expect(open).toHaveBeenCalledTimes(3);
      expect(old.release).toHaveBeenCalledOnce();
      expect(failed.release).toHaveBeenCalledOnce();
    } finally { client.dispose(); }
  });

  it("keeps PR suggestions and create preflight on the selected cloud workspace", async () => {
    const local = vi.spyOn(RuntimeClient.prototype, "request");
    const pa = fakePeer(a), pb = fakePeer(b);
    const client = new WorkspaceRuntimeClient({ open: async target => target.workspaceId === a.workspaceId ? pa.peer : pb.peer, workspaces: () => [] });
    try {
      for (const target of [a, b]) {
        const workspaceId = cloudWorkspaceKey(target);
        await bridgeGhPrList(client, { workspaceId, originUrl: "https://github.com/example/project.git", state: "open" });
        await bridgeGhRepoAccess(client, workspaceId);
      }
      for (const peer of [pa, pb]) {
        expect(peer.request).toHaveBeenCalledWith(expect.objectContaining({ op: "gh.prList", params: {
          workspaceId: "local-main", originUrl: "https://github.com/example/project.git", state: "open",
        } }), expect.any(Number));
        expect(peer.request).toHaveBeenCalledWith(expect.objectContaining({ op: "gh.repoAccess", params: { workspaceId: "local-main" } }), expect.any(Number));
      }
      expect(local).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
  it.each([undefined, {}, { chats: null }, { chats: "invalid" }])("does not confirm a malformed first cloud chat snapshot (%j)", async result => {
    const pa = fakePeer(a);
    pa.request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result });
    const client = new WorkspaceRuntimeClient({ open: async () => pa.peer, workspaces: () => [] });
    await expect(client.warmWorkspace(a)).rejects.toThrow(/cloud conversations/);
    expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(false);
    expect(pa.release).toHaveBeenCalledOnce();
    client.dispose();
  });
  it("retains confirmed cloud history when a later response is malformed", async () => {
    vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] } } as unknown as BridgeMessage);
    const pa = fakePeer(a);
    pa.request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [{ id: "saved", folder: "/workspace/repo" }], chatDeletions: [] } });
    const client = new WorkspaceRuntimeClient({ open: async () => pa.peer, workspaces: () => [] });
    await client.warmWorkspace(a);
    pa.request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: {} });
    expect(await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list", params: {} })).toMatchObject({ result: {
      confirmedCloudWorkspaces: [cloudWorkspaceKey(a)],
      chats: [{ id: cloudScopedId(a, "saved"), folder: cloudWorkspaceKey(a) }],
    } });
    client.dispose();
  });
  it("identifies which cloud chat snapshots can validate a saved selection", async () => {
    vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] } } as unknown as BridgeMessage);
    const pa = fakePeer(a);
    const client = new WorkspaceRuntimeClient({ open: async () => pa.peer, workspaces: () => [] });
    const message = { type: "WORKSPACE_REQUEST", op: "chats.list", params: {} } as const;
    expect(await client.request(message)).toMatchObject({ result: { confirmedCloudWorkspaces: [] } });
    await client.warmWorkspace(a);
    expect(await client.request(message)).toMatchObject({ result: { confirmedCloudWorkspaces: [cloudWorkspaceKey(a)] } });
    client.clearCloudConnections();
    expect(await client.request(message)).toMatchObject({ result: { confirmedCloudWorkspaces: [] } });
    client.dispose();
  });
  it("isolates terminal discovery, shells, input, output, resize and close across identical cloud roots", async () => {
    const local = vi.spyOn(RuntimeClient.prototype, "request");
    const pa = fakePeer(a),
      pb = fakePeer(b);
    for (const peer of [pa, pb]) {
      peer.request.mockImplementation(async (message) => {
        if (message.type === "PTY_LIST")
          return {
            type: "PTY_LIST_RESULT",
            terminals: [
              {
                sessionId: "shell",
                cwd: "/workspace/repo",
                workspaceId: "local-main",
                createdAt: 1,
              },
            ],
          };
        if (message.type === "PTY_CREATE")
          return {
            ...message,
            type: "PTY_CREATED",
            pid: 42,
            reattached: true,
            replay: "remote output",
          };
        return {
          type: "WORKSPACE_RESPONSE",
          result: { chats: [], chatDeletions: [] },
        };
      });
    }
    const client = new WorkspaceRuntimeClient({
      open: async (target) =>
        target.workspaceId === a.workspaceId ? pa.peer : pb.peer,
      workspaces: () => [],
    });
    const data = vi.fn(),
      exit = vi.fn();
    subscribeBridgePtyData(client, data);
    subscribeBridgePtyExit(client, exit);
    for (const target of [a, b]) {
      const folder = cloudWorkspaceKey(target),
        sessionId = cloudScopedId(target, "shell");
      const terminals = await bridgePtyTerminals(client, folder);
      expect(terminals).toEqual([
        { sessionId, cwd: folder, workspaceId: folder, createdAt: 1 },
      ]);
      expect(
        await bridgePtyCreate(client, {
          sessionId,
          cwd: folder,
          cols: 80,
          rows: 24,
        }),
      ).toMatchObject({ sessionId, cwd: folder, reattached: true });
    }
    expect(pa.request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PTY_LIST", workspaceId: "local-main" }),
      10_000,
    );
    expect(pb.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PTY_CREATE",
        sessionId: "shell",
        cwd: "/workspace/repo",
      }),
      10_000,
    );
    bridgePtyWrite(client, {
      sessionId: cloudScopedId(a, "shell"),
      data: "pwd\r",
    });
    bridgePtyResize(client, {
      sessionId: cloudScopedId(a, "shell"),
      cols: 120,
      rows: 40,
    });
    bridgePtyKill(client, { sessionId: cloudScopedId(b, "shell") });
    expect(pa.send.mock.calls.map(([message]) => message)).toEqual([
      { type: "PTY_WRITE", sessionId: "shell", data: "pwd\r" },
      { type: "PTY_RESIZE", sessionId: "shell", cols: 120, rows: 40 },
    ]);
    expect(pb.send).toHaveBeenCalledExactlyOnceWith({
      type: "PTY_KILL",
      sessionId: "shell",
    });
    pa.emit("PTY_DATA", { sessionId: "shell", data: "output A" });
    pb.emit("PTY_DATA", { sessionId: "shell", data: "output B" });
    pb.emit("PTY_EXIT", { sessionId: "shell", exitCode: 0, signal: null });
    expect(data.mock.calls.map(([event]) => event)).toEqual([
      { sessionId: cloudScopedId(a, "shell"), data: "output A" },
      { sessionId: cloudScopedId(b, "shell"), data: "output B" },
    ]);
    expect(exit).toHaveBeenCalledWith({
      sessionId: cloudScopedId(b, "shell"),
      exitCode: 0,
      signal: null,
    });
    expect(local).not.toHaveBeenCalled();
    await expect(
      client.request({
        type: "PTY_CREATE",
        sessionId: cloudScopedId(a, "shell"),
        cwd: cloudWorkspaceKey(b),
      }),
    ).rejects.toThrow(/cross cloud workspace boundaries/);
    client.dispose();
  });

  it.each(["design.context.create", "design.context.inspect", "design.context.capture", "design.verification.open"])("keeps Local %s references outside cloud wire translation", async op => {
    const reference = { workspaceId: "ws_local", directoryId: "local-design", frame: "page-1/home.html" };
    const reply = { type: "WORKSPACE_RESPONSE", op, result: { reference, previewUrl: "http://127.0.0.1:12345/preview/" } } as BridgeMessage;
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(reply);
    const open = vi.fn();
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    const message = { type: "WORKSPACE_REQUEST" as const, op, params: { workspaceId: "ws_local", reference } };
    try {
      expect(await client.request(message)).toBe(reply);
      expect(local).toHaveBeenCalledWith(message, expect.anything());
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("keeps local operations local and isolates two identical cloud checkouts", async () => {
    const local = vi
      .spyOn(RuntimeClient.prototype, "request")
      .mockResolvedValue({
        type: "WORKSPACE_RESPONSE",
        op: "file.read",
        result: { local: true },
      } as BridgeMessage);
    const pa = fakePeer(a),
      pb = fakePeer(b);
    const open = vi.fn(async (target: CloudWorkspaceTarget) =>
      target.workspaceId === a.workspaceId ? pa.peer : pb.peer,
    );
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    await Promise.all(
      [a, b, a].map((target) =>
        client.request({
          type: "WORKSPACE_REQUEST",
          op: "file.read",
          params: { workspaceId: cloudWorkspaceKey(target), path: "same.ts" },
        }),
      ),
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(local).not.toHaveBeenCalled();
    expect(pa.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: { workspaceId: "local-main", path: "same.ts" },
      }),
      5000,
    );
    await client.request({
      type: "WORKSPACE_REQUEST",
      op: "git.status",
      params: { workspaceId: "ws_local" },
    });
    expect(local).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("streams both runtimes and sends Stop to the captured execution", async () => {
    const pa = fakePeer(a),
      pb = fakePeer(b);
    const client = new WorkspaceRuntimeClient({
      open: async (target) =>
        target.workspaceId === a.workspaceId ? pa.peer : pb.peer,
      workspaces: () => [],
    });
    const updates = vi.fn();
    const off = client.on("AGENT_SESSION_UPDATE", updates);
    await Promise.all([client.warmWorkspace(a), client.warmWorkspace(b)]);
    pa.emit("AGENT_SESSION_UPDATE", {
      sessionId: "run",
      update: { text: "A" },
    });
    pb.emit("AGENT_SESSION_UPDATE", {
      sessionId: "run",
      update: { text: "B" },
    });
    expect(updates.mock.calls.map(([event]) => event.sessionId)).toEqual([
      cloudScopedId(a, "run"),
      cloudScopedId(b, "run"),
    ]);
    await client.request({
      type: "AGENT_CANCEL",
      agentId: "codex",
      sessionId: cloudScopedId(a, "run"),
    });
    expect(pa.request).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "run" }), expect.anything(),
    );
    expect(pa.send).not.toHaveBeenCalled();
    expect(pb.send).not.toHaveBeenCalled();
    off();
    client.dispose();
  });

  it("isolates Personal Local → org-A cloud → org-B cloud → organization-local → Personal Local with delayed frames and replies", async () => {
    // Equal native roots, workspace IDs and resolver IDs must still be owned
    // by the exact organization. Both cloud owners initially remain admitted.
    const other = { ...a, organizationId: "44444444-4444-4444-8444-444444444444" };
    const pa = fakePeer(a), pb = fakePeer(other);
    const subscriptionA = vi.spyOn(pa.peer.client, "on");
    const subscriptionB = vi.spyOn(pb.peer.client, "on");
    for (const [peer, title] of [[pa, "Org A"], [pb, "Org B"]] as const) {
      peer.request.mockImplementation(async message => ({ type: "WORKSPACE_RESPONSE", op: message.op,
        result: message.op === "chats.list" ? { chats: [{ id: "chat", folder: "/workspace/repo", title }], chatDeletions: [] } : { content: title } }));
    }
    const localRequest = vi.spyOn(RuntimeClient.prototype, "request").mockImplementation(async message => ({
      type: "WORKSPACE_RESPONSE", op: (message as { op: string }).op,
      result: (message as { op: string }).op === "chats.list"
        ? { chats: [{ id: "chat", folder: "/personal/local", title: "Local" }], chatDeletions: [] }
        : { content: "Local" },
    } as BridgeMessage));
    const localSend = vi.spyOn(RuntimeClient.prototype, "send").mockImplementation(() => {});
    const allowed = new Set([a.organizationId, other.organizationId]);
    const open = vi.fn(async (target: CloudWorkspaceTarget) => target.organizationId === a.organizationId ? pa.peer : pb.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => "same-account",
      canAccess: target => allowed.has(target.organizationId) });
    const updates = vi.fn();
    const off = client.on("AGENT_SESSION_UPDATE", updates);
    const fileRead = (cwd: string) => ({ type: "WORKSPACE_REQUEST" as const, op: "file.read", params: { cwd, path: "same.ts" } });
    const localDecision = { type: "AGENT_PERMISSION_RESPONSE" as const, permissionId: "permission",
      response: { outcome: { outcome: "cancelled" as const } } };
    try {
      await client.request(fileRead("/personal/local"));
      await client.chatSnapshot("local");
      await client.warmWorkspace(a);
      const delayedA = deferred<Record<string, unknown>>();
      pa.request.mockImplementationOnce(() => delayedA.promise);
      const replyA = client.request(fileRead(cloudWorkspaceKey(a)));
      const refusedA = expect(replyA).rejects.toThrow(/connection changed/);
      await vi.waitFor(() => expect(pa.request).toHaveBeenCalledTimes(2));

      await client.warmWorkspace(other);
      const delayedB = deferred<Record<string, unknown>>();
      pb.request.mockImplementationOnce(() => delayedB.promise);
      const replyB = client.request(fileRead(cloudWorkspaceKey(other)));
      const refusedB = expect(replyB).rejects.toThrow(/connection changed/);
      await vi.waitFor(() => expect(pb.request).toHaveBeenCalledTimes(2));
      const retained = await client.chatSnapshot("retained");
      expect(retained.chats).toEqual([
        { id: "chat", folder: "/personal/local", title: "Local" },
        { id: cloudScopedId(a, "chat"), folder: cloudWorkspaceKey(a), title: "Org A" },
        { id: cloudScopedId(other, "chat"), folder: cloudWorkspaceKey(other), title: "Org B" },
      ]);

      // A late frame while B is selected still belongs to A. Exact captured
      // resolver ownership routes each answer to its originating peer.
      const frame = { agentId: "codex", chatId: "chat", executionId: "native", notification: { sessionId: "native",
        update: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text: "late" } } } };
      pa.emit("AGENT_SESSION_UPDATE", frame);
      pb.emit("AGENT_SESSION_UPDATE", frame);
      expect(updates.mock.calls.map(([event]) => [event.chatId, event.executionId, event.notification.sessionId])).toEqual([
        [cloudScopedId(a, "chat"), cloudScopedId(a, "native"), cloudScopedId(a, "native")],
        [cloudScopedId(other, "chat"), cloudScopedId(other, "native"), cloudScopedId(other, "native")],
      ]);
      for (const target of [a, other]) client.send({ ...localDecision, chatId: cloudScopedId(target, "chat"),
        executionId: cloudScopedId(target, "native") });
      for (const peer of [pa, pb]) expect(peer.send).toHaveBeenCalledExactlyOnceWith({ ...localDecision, chatId: "chat", executionId: "native" });
      expect(localSend).not.toHaveBeenCalled();
      expect(() => client.send({ ...localDecision, chatId: cloudScopedId(other, "chat"), executionId: cloudScopedId(a, "native") }))
        .toThrow(/cannot cross cloud workspace boundaries/);
      expect(pa.send).toHaveBeenCalledOnce();
      expect(pb.send).toHaveBeenCalledOnce();

      // Revoke the old owners and retain callback references to reproduce a
      // frame already queued before unsubscribe, rather than an empty emitter.
      const staleA = subscriptionA.mock.calls.find(([type]) => type === "AGENT_SESSION_UPDATE")![1];
      const staleB = subscriptionB.mock.calls.find(([type]) => type === "AGENT_SESSION_UPDATE")![1];
      allowed.delete(a.organizationId);
      client.pruneCloudConnections();
      await client.request(fileRead("/organization/local"));
      client.send(localDecision);
      allowed.delete(other.organizationId);
      client.pruneCloudConnections();
      await client.request(fileRead("/personal/local"));
      for (const receive of [staleA, staleB]) receive({ type: "AGENT_SESSION_UPDATE", ...frame } as BridgeMessage);
      delayedA.resolve({ type: "WORKSPACE_RESPONSE", op: "file.read", result: { content: "stale A" } });
      delayedB.resolve({ type: "WORKSPACE_RESPONSE", op: "file.read", result: { content: "stale B" } });
      await Promise.all([refusedA, refusedB]);
      expect(updates).toHaveBeenCalledTimes(2);
      expect(pa.release).toHaveBeenCalledOnce();
      expect(pb.release).toHaveBeenCalledOnce();
      expect(client.hasChatSnapshot(cloudWorkspaceKey(a))).toBe(false);
      expect(client.hasChatSnapshot(cloudWorkspaceKey(other))).toBe(false);
      expect((await client.chatSnapshot("retained")).chats).toEqual([{ id: "chat", folder: "/personal/local", title: "Local" }]);
      expect(client.executionIdentity).toMatchObject({ kind: "local" });
      expect(localSend).toHaveBeenCalledExactlyOnceWith(localDecision);
      expect(localRequest.mock.calls.map(([message]) => message)).toEqual([
        fileRead("/personal/local"), { type: "WORKSPACE_REQUEST", op: "chats.list" },
        fileRead("/organization/local"), fileRead("/personal/local"),
      ]);
      expect(open.mock.calls.map(([target]) => target)).toEqual([a, other]);
    } finally { off(); client.dispose(); }
  });

  it("owner_a_b_a_never_cross_attaches a retired history response or queued event to the returning owner", async () => {
    const other = { ...a, organizationId: "44444444-4444-4444-8444-444444444444" };
    const old = fakePeer(a), middle = fakePeer(other), current = fakePeer(a);
    const subscriptions = vi.spyOn(old.peer.client, "on");
    const open = vi.fn().mockResolvedValueOnce(old.peer).mockResolvedValueOnce(middle.peer).mockResolvedValueOnce(current.peer);
    let identity = "account-A";
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], identity: () => identity });
    const updates = vi.fn(); client.on("AGENT_SESSION_UPDATE", updates);
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window",
      params: { chatId: cloudScopedId(a, "chat"), limit: 100 } };
    try {
      await client.warmWorkspace(a);
      const pending = deferred<Record<string, unknown>>();
      old.request.mockImplementationOnce(() => pending.promise);
      const response = client.request(request), rejected = expect(response).rejects.toThrow(/changed|retired/i);
      await vi.waitFor(() => expect(old.request).toHaveBeenCalledTimes(2));
      const stale = subscriptions.mock.calls.find(([type]) => type === "AGENT_SESSION_UPDATE")![1];
      identity = "account-B"; client.clearCloudConnections(); await client.warmWorkspace(other);
      identity = "account-A"; client.clearCloudConnections(); await client.warmWorkspace(a);
      const frame = { agentId: "codex", chatId: "chat", executionId: "native", notification: { sessionId: "native",
        update: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text: "retired" } } } };
      stale({ type: "AGENT_SESSION_UPDATE", ...frame } as BridgeMessage);
      middle.emit("AGENT_SESSION_UPDATE", frame);
      pending.resolve({ type: "WORKSPACE_RESPONSE", op: "messages.window", result: { messages: [{ text: "retired" }] } });
      await rejected;
      expect(updates).not.toHaveBeenCalled();
      current.emit("AGENT_SESSION_UPDATE", frame);
      expect(updates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: cloudScopedId(a, "chat") }));
      current.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "messages.window", result: { messages: [{ text: "current" }] } });
      await expect(client.request(request)).resolves.toMatchObject({ result: { messages: [{ text: "current" }] } });
      expect(open.mock.calls.map(([target]) => target)).toEqual([a, other, a]);
      expect(old.release).toHaveBeenCalledOnce(); expect(middle.release).toHaveBeenCalledOnce();
      expect(current.release).not.toHaveBeenCalled();
      for (const peer of [old, middle, current]) expect(peer.send).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("closes late connections after sign-out and never dispatches their pending write", async () => {
    const wait = deferred<CloudPeer>();
    const pa = fakePeer(a);
    const client = new WorkspaceRuntimeClient({
      open: () => wait.promise,
      workspaces: () => [],
    });
    const request = client.request({
      type: "WORKSPACE_REQUEST",
      op: "git.stage",
      params: { workspaceId: cloudWorkspaceKey(a), paths: ["a"] },
    });
    const rejected = expect(request).rejects.toThrow(/account changed/);
    client.clearCloudConnections();
    wait.resolve(pa.peer);
    await rejected;
    expect(pa.request).not.toHaveBeenCalled();
    expect(pa.release).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("reads cloud tombstones before accepting cached chat writes", async () => {
    const pa = fakePeer(a);
    pa.request.mockImplementation(async (message) => ({
      type: "WORKSPACE_RESPONSE",
      op: message.op,
      result:
        message.op === "chats.list"
          ? {
              chats: [
                { id: "newer", folder: "/workspace/repo", updatedAt: 30 },
              ],
              chatDeletions: ["gone"],
            }
          : { target: a.workspaceId },
    }));
    const client = new WorkspaceRuntimeClient({
      open: async () => pa.peer,
      workspaces: () => [],
    });
    const row = (id: string, updatedAt: number) => ({
      id: cloudScopedId(a, id),
      folder: cloudWorkspaceKey(a),
      updatedAt,
    });
    await client.request({
      type: "WORKSPACE_REQUEST",
      op: "chats.bulkUpsert",
      params: { chats: [row("gone", 50), row("newer", 20), row("fresh", 10)] },
    });
    expect(pa.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          chats: [{ id: "fresh", folder: "/workspace/repo", updatedAt: 10 }],
        },
      }),
      5000,
    );
    client.dispose();
  });
});

describe("cloud v2 history ownership", () => {
  it("reads a connected worker's chat list natively and the control plane's mirror while it is away", async () => {
    const peer = fakePeer(a);
    peer.request.mockImplementation(async (message: Record<string, unknown>) => ({ type: "WORKSPACE_RESPONSE", op: message.op,
      result: message.op === "chats.list" ? { chats: [{ id: "live" }], chatDeletions: [] } : {} }));
    const readHistory = vi.fn(async () => ({ chats: [{ id: "mirrored" }], chatDeletions: [] }));
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory, historyRoot: () => MIRROR_ROOT, workspaces: () => [] });
    try {
      // Before any connection the mirror answers, without opening a peer.
      const offline = await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list", params: { workspaceId: cloudWorkspaceKey(a) } } as never);
      expect(JSON.stringify(offline)).toContain("mirrored");
      await client.warmWorkspace(a);
      const live = await client.chatSnapshot("all");
      expect(JSON.stringify(live)).toContain("live");
      expect(peer.request).toHaveBeenCalledWith(expect.objectContaining({ op: "chats.list" }), expect.anything());
    } finally { client.dispose(); }
  });
});
