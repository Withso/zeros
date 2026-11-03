import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient, type CloudPeer, type WorkspaceRuntimeOptions } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey, type CloudWorkspaceTarget } from "../cloud-workspace-key";
import type { BridgeMessage } from "../messages";
import { RuntimeClient, type ConnectionStatus } from "../ws-client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const target = (index: number): CloudWorkspaceTarget => ({
  organizationId,
  workspaceId: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`,
});
const key = (index: number) => cloudWorkspaceKey(target(index));
const chats = { chats: [{ id: "chat", folder: "/workspace/repo" }], chatDeletions: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve };
}
function fakePeer(scope: CloudWorkspaceTarget) {
  const handlers = new Map<string, (message: BridgeMessage) => void>();
  const statuses = new Set<(status: ConnectionStatus) => void>();
  const release = vi.fn();
  const request = vi.fn(async (message: Record<string, unknown>) => ({
    type: "WORKSPACE_RESPONSE", op: message.op, result: message.op === "chats.list" ? chats : {},
  }));
  const on = vi.fn((type: string, handler: (message: BridgeMessage) => void) => {
    handlers.set(type, handler);
    return () => { handlers.delete(type); };
  });
  const runtime = {
    status: "connected", lastRejection: undefined as unknown, request, on,
    onStatusChange: (handler: (status: ConnectionStatus) => void) => {
      statuses.add(handler);
      return () => { statuses.delete(handler); };
    },
  };
  const peer: CloudPeer = { client: runtime as unknown as RuntimeClient,
    scope: { ...scope, root: "/workspace/repo", engineWorkspaceId: scope.workspaceId }, release };
  return { peer, request, release, on, handlers, retire: () => {
    runtime.status = "disconnected";
    runtime.lastRejection = { reason: "cloud-unavailable" };
    for (const status of statuses) status("disconnected");
  } };
}
const clients: WorkspaceRuntimeClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.restoreAllMocks();
});
function harness(options: Partial<WorkspaceRuntimeOptions> = {}) {
  const peers = new Map<string, ReturnType<typeof fakePeer>>();
  const createPeer = (scope: CloudWorkspaceTarget) => {
    const peer = fakePeer(scope);
    peers.set(cloudWorkspaceKey(scope), peer);
    return peer;
  };
  const open = vi.fn(async (scope: CloudWorkspaceTarget) => createPeer(scope).peer);
  const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canReuseForWork: () => true, ...options });
  clients.push(client);
  return { client, open, peers, createPeer };
}

describe("cloud connection retention", () => {
  it("refreshes a reused connection's recency while skipping older live work", async () => {
    const { client, open, peers } = harness({ liveWork: scope => scope.workspaceId === target(2).workspaceId });
    for (let index = 1; index <= 16; index++) await client.openWorkspace(target(index));
    await client.openWorkspace(target(1));
    expect(open).toHaveBeenCalledTimes(16);
    await client.openWorkspace(target(17));
    expect(peers.get(key(1))!.release).not.toHaveBeenCalled();
    expect(peers.get(key(2))!.release).not.toHaveBeenCalled();
    expect(peers.get(key(3))!.release).toHaveBeenCalledOnce();
  });

  it("reserves capacity when a retired workspace reopens into an already full pool", async () => {
    const { client, peers } = harness();
    for (let index = 1; index <= 16; index++) await client.openWorkspace(target(index));
    const first = peers.get(key(1))!;
    first.retire();
    await client.openWorkspace(target(17));
    await client.openWorkspace(target(1));
    expect(first.release).toHaveBeenCalledOnce();
    expect(peers.get(key(2))!.release).toHaveBeenCalledOnce();
    expect(Array.from({ length: 17 }, (_, index) => client.statusForWorkspace(key(index + 1)))
      .filter(status => status === "connected")).toHaveLength(16);
  });

  it("counts each pending first history read once and never evicts an opening connection", async () => {
    const { client, open, createPeer, peers } = harness();
    const reads = Array.from({ length: 16 }, () => deferred<ReturnType<typeof chatsResponse>>());
    const started = Array.from({ length: 16 }, () => deferred<void>());
    const attempts: Promise<unknown>[] = [];
    open.mockImplementation(async scope => {
      const index = Number(scope.workspaceId.slice(0, 8)) - 1;
      const peer = createPeer(scope);
      peer.request.mockImplementation(async () => { started[index]!.resolve(); return reads[index]!.promise; });
      return peer.peer;
    });
    try {
      for (let index = 0; index < 16; index++) {
        const attempt = client.openWorkspace(target(index + 1)).catch(error => error);
        attempts.push(attempt);
        await expect(Promise.race([started[index]!.promise, attempt])).resolves.toBeUndefined();
        expect(client.statusForWorkspace(key(index + 1))).toBe("connecting");
      }
      await expect(client.openWorkspace(target(17))).rejects.toThrow(/connections/i);
      expect(open).toHaveBeenCalledTimes(16);
      for (const peer of peers.values()) expect(peer.release).not.toHaveBeenCalled();
    } finally {
      for (const read of reads) read.resolve(chatsResponse());
      await Promise.all(attempts);
    }
    open.mockImplementation(async scope => createPeer(scope).peer);
    await client.openWorkspace(target(17));
    expect(peers.get(key(1))!.release).toHaveBeenCalledOnce();
  });

  it("keeps cancelled native admissions in the bound until their replies settle", async () => {
    const { client, open, createPeer, peers } = harness();
    const admissions = Array.from({ length: 16 }, () => deferred<CloudPeer>());
    const controllers = admissions.map(() => new AbortController());
    open.mockImplementation(scope => admissions[Number(scope.workspaceId.slice(0, 8)) - 1]!.promise);
    const attempts = admissions.map((_, index) => client.openWorkspace(target(index + 1), { signal: controllers[index]!.signal }).catch(error => error));
    try {
      expect(open).toHaveBeenCalledTimes(16);
      for (const controller of controllers) controller.abort();
      await Promise.all(attempts);
      await expect(client.openWorkspace(target(17))).rejects.toThrow(/connections/i);
      expect(open).toHaveBeenCalledTimes(16);
      admissions[0]!.resolve(createPeer(target(1)).peer);
      await vi.waitFor(() => expect(peers.get(key(1))!.release).toHaveBeenCalledOnce());
      open.mockImplementation(async scope => createPeer(scope).peer);
      await client.openWorkspace(target(17));
    } finally {
      for (let index = 1; index < 16; index++) admissions[index]!.resolve(createPeer(target(index + 1)).peer);
      await vi.waitFor(() => {
        for (let index = 1; index <= 16; index++) expect(peers.get(key(index))!.release).toHaveBeenCalledOnce();
      });
    }
  });

  it("bounds retired snapshots to 64 and keeps a recently read retired snapshot", async () => {
    const { client, peers } = harness();
    for (let index = 1; index <= 64; index++) {
      await client.openWorkspace(target(index));
      peers.get(key(index))!.retire();
    }
    expect(client.hasChatSnapshot(key(1))).toBe(true);
    await client.openWorkspace(target(65));
    peers.get(key(65))!.retire();
    expect(client.hasChatSnapshot(key(2))).toBe(false);
    expect(client.hasChatSnapshot(key(1))).toBe(true);
    expect(client.hasChatSnapshot(key(65))).toBe(true);
    expect(Array.from({ length: 65 }, (_, index) => client.hasChatSnapshot(key(index + 1))).filter(Boolean)).toHaveLength(64);
    for (const peer of peers.values()) expect(peer.release).toHaveBeenCalledOnce();
  });

  it("retires subscriptions, fences late replies, and publishes disconnection without losing chat metadata", async () => {
    const { client, peers } = harness();
    for (let index = 1; index <= 16; index++) await client.openWorkspace(target(index));
    const first = peers.get(key(1))!;
    const updates = vi.fn();
    client.on("DB_CHANGED", updates);
    const queuedEvent = first.handlers.get("DB_CHANGED")!;
    const read = deferred<ReturnType<typeof chatsResponse>>();
    first.request.mockReturnValueOnce(read.promise);
    const result = client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: { workspaceId: key(1), path: "a.ts" } })
      .then(() => undefined, error => error as Error);
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledTimes(2));
    for (let index = 2; index <= 16; index++) await client.openWorkspace(target(index));
    const statuses: ConnectionStatus[] = [];
    client.onWorkspaceStatusChange(key(1), () => statuses.push(client.statusForWorkspace(key(1))));
    try {
      await client.openWorkspace(target(17));
    } finally {
      read.resolve(chatsResponse());
    }
    expect(await result).toMatchObject({ message: expect.stringMatching(/connection changed/i) });
    expect(statuses).toEqual(["disconnected"]);
    expect(first.release).toHaveBeenCalledOnce();
    expect(client.hasChatSnapshot(key(1))).toBe(true);
    const subscriptions = first.on.mock.calls.length;
    client.on("AGENT_SESSION_UPDATE", vi.fn());
    expect(first.on).toHaveBeenCalledTimes(subscriptions);
    updates.mockClear();
    queuedEvent({ type: "DB_CHANGED", kinds: ["chats"], id: "late-event", source: "engine", timestamp: 1 });
    expect(updates).not.toHaveBeenCalled();
  });

  it("reads a released workspace's transcript from the mirror without reconnecting", async () => {
    const mirror = vi.fn(async (_scope: CloudWorkspaceTarget, op: string) => op === "chats.list"
      ? chats : { messages: [{ msgId: "saved", kind: "text", payload: "saved", createdAt: 1 }] });
    const { client, open, peers } = harness({ readHistory: mirror, historyRoot: () => "/workspace/repo" });
    for (let index = 1; index <= 17; index++) await client.openWorkspace(target(index));
    expect(peers.get(key(1))!.release).toHaveBeenCalledOnce();
    await expect(client.request({ type: "WORKSPACE_REQUEST", op: "messages.window",
      params: { chatId: cloudScopedId(target(1), "chat") } })).resolves.toMatchObject({ result: { messages: [{ msgId: "saved" }] } });
    expect(mirror).toHaveBeenLastCalledWith(expect.objectContaining(target(1)), "messages.window", { chatId: "chat" });
    expect(open).toHaveBeenCalledTimes(17);
  });

  it("clears retired snapshots and live peers on account A → B → A without affecting Local routing", async () => {
    let account = "A";
    const { client, peers, open } = harness({ identity: () => account });
    const localReply = { type: "WORKSPACE_RESPONSE", result: { ok: true } } as BridgeMessage;
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(localReply);
    for (let index = 1; index <= 17; index++) await client.openWorkspace(target(index));
    const old = [...peers.values()];
    account = "B";
    client.clearCloudConnections();
    for (let index = 1; index <= 17; index++) expect(client.hasChatSnapshot(key(index))).toBe(false);
    for (const peer of old) expect(peer.release).toHaveBeenCalledOnce();
    const other = { ...target(1), organizationId: "33333333-3333-4333-8333-333333333333" };
    await client.openWorkspace(other);
    expect(client.hasChatSnapshot(key(1))).toBe(false);
    account = "A";
    client.clearCloudConnections();
    await client.openWorkspace(target(1));
    expect(client.hasChatSnapshot(cloudWorkspaceKey(other))).toBe(false);
    expect(open).toHaveBeenCalledTimes(19);
    for (const workspaceId of ["local-personal", "organization-local"]) {
      const request = { type: "WORKSPACE_REQUEST" as const, op: "git.status", params: { workspaceId } };
      expect(await client.request(request)).toBe(localReply);
      expect(local).toHaveBeenLastCalledWith(request, expect.anything());
    }
    expect(open).toHaveBeenCalledTimes(19);
  });
});

function chatsResponse() {
  return { type: "WORKSPACE_RESPONSE", op: "chats.list", result: chats };
}
