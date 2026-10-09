import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";
import { RuntimeClient } from "../ws-client";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { createMessage } from "@zeros/protocol";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const projection = { ...target, generation: 2, engineInstanceId: "33333333-3333-4333-8333-333333333333",
  bootId: "44444444-4444-4444-8444-444444444444", writerEpoch: "55555555-5555-4555-8555-555555555555",
  fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1,
  version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10, sealedSequence: null, complete: false };
const head = { conversationId: "chat", originWriterEpoch: projection.writerEpoch,
  source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "repair" },
  restoreRevision: 1, deleted: false, recordSequence: 4, eventSequence: 9, manifestSha256: "a".repeat(64), incompleteReason: null };
const row = { msgId: "reply", kind: "text", payload: JSON.stringify({ id: "reply", kind: "text", role: "agent", text: "old transcript", createdAt: 1 }), createdAt: 1 };
const complete = { messages: [row], revision: 10, projection, historyHeads: [head] };
const incomplete = { chats: [], chatDeletions: [], revision: 20, projection: { ...projection, mirroredSequence: 20 },
  historyHeads: [{ ...head, restoreRevision: 2, recordSequence: null, manifestSha256: null, incompleteReason: "history_limit" }] };
const message = (op = "messages.window", chat = "chat") => ({ type: "WORKSPACE_REQUEST" as const, op,
  params: { chatId: cloudScopedId(target, chat), limit: 200, ...(op === "messages.windowOlder" ? { beforeMsgId: "reply" } : {}) } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function nativePeer(owner: typeof target = target) {
  const handlers = new Map<string, Set<(value: Record<string, unknown>) => void>>();
  const peerProjection = { ...projection, ...owner };
  const { mirroredSequence: _mirrored, sealedSequence: _sealed, complete: _complete, ...identity } = peerProjection;
  const binding = CloudAgentBootConversationSchema.parse({ ...identity, authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  const request = vi.fn(async (message: Record<string, unknown>): Promise<Record<string, unknown>> => ({ type: "WORKSPACE_RESPONSE", op: message.op,
    result: message.op === "chats.list" ? { chats: [{ id: "chat", folder: "/workspace/repo" }], chatDeletions: [], projection: peerProjection, historyHeads: [head] }
      : { ...complete, projection: peerProjection } }));
  const client = { request, status: "connected", activatedCloudAgentBootBinding: binding,
    executionIdentity: { kind: "cloud", ...owner, generation: binding.generation, engineInstanceId: binding.engineInstanceId,
      authorityEpoch: 1, bootScope: identity }, onStatusChange: () => () => {},
    on: (type: string, callback: (value: Record<string, unknown>) => void) => {
      const set = handlers.get(type) ?? new Set(); set.add(callback); handlers.set(type, set); return () => set.delete(callback);
    } } as unknown as RuntimeClient;
  return { request, projection: peerProjection, peer: { client, scope: { ...owner, root: "/workspace/repo", engineWorkspaceId: "main" },
    generation: binding.generation, runtimeId: "exact-admission", release: vi.fn() },
    emit: (type: string, fields: Record<string, unknown>) => { for (const callback of handlers.get(type) ?? []) callback({ type, ...fields }); } };
}
describe("cloud projection keyed-cache restore authority", () => {
  it("fences a delayed live window before it can repaint a newer exact incomplete head", async () => {
    const peer = nativePeer(), old = deferred<Record<string, unknown>>();
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory: vi.fn(async () => complete), workspaces: () => [] });
    client.on("DB_CHANGED", () => {});
    try {
      await client.warmWorkspace(target);
      expect(await client.request(message())).toMatchObject({ result: { messages: [row] } });
      peer.request.mockImplementationOnce(async () => old.promise);
      const pending = client.request(message("messages.windowOlder"));
      const rejected = expect(pending).rejects.toThrow(/restore|retired/u);
      await vi.waitFor(() => expect(peer.request).toHaveBeenCalledTimes(3));
      peer.emit("DB_CHANGED", { kinds: ["messages"], chatIds: ["chat"],
        cloudHistoryRestore: { projection: incomplete.projection, historyHeads: incomplete.historyHeads } });
      expect(client.hasCloudMessageSnapshot(cloudScopedId(target, "chat"), 200)).toBe(false);
      old.resolve({ type: "WORKSPACE_RESPONSE", result: complete }); await rejected;
    } finally { client.dispose(); }
  });
  it("publishes an exact live snapshot head before forwarding the snapshot and rejects stale or foreign heads", async () => {
    const peer = nativePeer(), delivered: unknown[] = [];
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, workspaces: () => [] });
    client.on("DB_CHANGED", () => {}); client.on("AGENT_SESSION_LOADED", value => delivered.push(value));
    try {
      await client.warmWorkspace(target);
      const snapshot = { conversationId: "chat", executionId: null,
        historyRestore: { projection: incomplete.projection, historyHeads: incomplete.historyHeads } };
      peer.emit("AGENT_SESSION_LOADED", { sessionId: "execution", cloudSnapshot: snapshot });
      expect(delivered).toHaveLength(1);
      peer.emit("AGENT_SESSION_LOADED", { sessionId: "execution", cloudSnapshot: { ...snapshot,
        historyRestore: { projection, historyHeads: [head] } } });
      peer.emit("AGENT_SESSION_LOADED", { sessionId: "execution", cloudSnapshot: { ...snapshot,
        historyRestore: { projection: { ...projection, writerEpoch: target.organizationId }, historyHeads: [head] } } });
      expect(delivered).toHaveLength(1);
    } finally { client.dispose(); }
  });
  it("rejects an older page returned by a retired keyed-cache flight after a newer incomplete head", async () => {
    const old = deferred<Record<string, unknown>>();
    const readHistory = vi.fn().mockResolvedValueOnce(complete).mockReturnValueOnce(old.promise).mockResolvedValueOnce(incomplete);
    const open = vi.fn(), client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
    try {
      expect(await client.request(message())).toMatchObject({ result: { messages: [row] } });
      const pending = client.request(message("messages.windowOlder"));
      const rejected = expect(pending).rejects.toThrow(/restore|retired/u);
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2));
      await client.warmHistoryWorkspace(target);
      expect(client.hasCloudMessageSnapshot(cloudScopedId(target, "chat"), 200)).toBe(false);
      old.resolve(complete); await rejected;
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
  it("invalidates cached search and current/older windows for the fenced chat while preserving a sibling", async () => {
    const readHistory = vi.fn(async (_target: typeof target, op: string, params: Record<string, unknown>) => {
      if (op === "messages.search") return { hits: [{ chatId: cloudScopedId(target, "chat"), ...row }], projection, historyHeads: [head] };
      if (op === "chats.list") return incomplete;
      const id = params.chatId === cloudScopedId(target, "sibling") ? "sibling" : "chat";
      return { ...complete, historyHeads: [{ ...head, conversationId: id }] };
    });
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, workspaces: () => [] });
    try {
      await client.request(message()); await client.request(message("messages.windowOlder")); await client.request(message("messages.window", "sibling"));
      const search = { type: "WORKSPACE_REQUEST" as const, op: "messages.search", params: { folder: cloudWorkspaceKey(target), query: "old", limit: 20 } };
      await client.request(search); await client.warmHistoryWorkspace(target);
      expect(client.hasCloudMessageSnapshot(cloudScopedId(target, "chat"), 200)).toBe(false);
      expect(client.hasCloudMessageSnapshot(cloudScopedId(target, "sibling"), 200)).toBe(true);
      readHistory.mockRejectedValueOnce(Object.assign(new Error("Synthetic offline"), { status: 503 }));
      await expect(client.request(search)).rejects.toThrow("Synthetic offline");
    } finally { client.dispose(); }
  });
});

describe("live cloud search result ownership", () => {
  it.each([false,true])("scopes raw engine hits before page-head validation (chat filter %s)", async byChat => {
    const peer = nativePeer();
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory: vi.fn(async () => complete), workspaces: () => [] });
    const rawHit = { chatId: "chat", msgId: row.msgId, payload: row.payload, createdAt: row.createdAt };
    try {
      await client.warmWorkspace(target);
      const original = peer.request.getMockImplementation()!;
      peer.request.mockImplementation(async request => request.op === "messages.search"
        ? { type: "WORKSPACE_RESPONSE", op: "messages.search", result: { hits: [rawHit], projection, historyHeads: [head] } }
        : original(request));
      const params = byChat ? { chatId: cloudScopedId(target,"chat"), query: "old", limit: 20 }
        : { folder: cloudWorkspaceKey(target), query: "old", limit: 20 };
      const result = await client.request({ type: "WORKSPACE_REQUEST", op: "messages.search", params });
      expect(result).toMatchObject({ result: { hits: [{ ...rawHit, chatId: cloudScopedId(target,"chat") }], projection, historyHeads: [head] } });
      expect(peer.request).toHaveBeenCalledWith({ type: "WORKSPACE_REQUEST", op: "messages.search", params: byChat
        ? { chatId: "chat", query: "old", limit: 20 } : { folder: "/workspace/repo", query: "old", limit: 20 } });
      expect(rawHit).toEqual({ chatId: "chat", msgId: row.msgId, payload: row.payload, createdAt: row.createdAt });
    } finally { client.dispose(); }
  });
  it("keeps identical native search chat IDs isolated across organizations and workspaces", async () => {
    const other = { organizationId: "88888888-8888-4888-8888-888888888888", workspaceId: "99999999-9999-4999-8999-999999999999" };
    const peers = [nativePeer(),nativePeer(other)], readHistory = vi.fn(async (owner: typeof target, _op: string) => ({
      chats: [{ id: cloudScopedId(owner,"chat"), folder: cloudWorkspaceKey(owner) }], chatDeletions: [],
      projection: { ...projection, ...owner }, historyHeads: [head] }));
    const client = new WorkspaceRuntimeClient({ open: async owner => peers[owner.organizationId === target.organizationId ? 0 : 1]!.peer,
      readHistory, workspaces: () => [] });
    try {
      for (const [index,owner] of [target,other].entries()) {
        const peer = peers[index]!; await client.warmWorkspace(owner);
        const original = peer.request.getMockImplementation()!;
        peer.request.mockImplementation(async request => request.op === "messages.search"
          ? { type: "WORKSPACE_RESPONSE", op: "messages.search", result: {
            hits: [{ chatId: "chat", msgId: row.msgId, payload: row.payload, createdAt: row.createdAt }],
            projection: peer.projection, historyHeads: [head] } } : original(request));
      }
      for (const owner of [target,other]) {
        expect(await client.request({ type: "WORKSPACE_REQUEST", op: "messages.search",
          params: { folder: cloudWorkspaceKey(owner), query: "old", limit: 20 } }))
          .toMatchObject({ result: { hits: [{ chatId: cloudScopedId(owner,"chat"), payload: row.payload }] } });
      }
      expect(cloudScopedId(target,"chat")).not.toBe(cloudScopedId(other,"chat"));
      expect(readHistory.mock.calls.map(([,op]) => op)).toEqual(["chats.list","chats.list"]);
    } finally { client.dispose(); }
  });
  it("rejects a foreign scoped search hit before its head can publish a result", async () => {
    const peer = nativePeer(), other = { ...target, workspaceId: "99999999-9999-4999-8999-999999999999" };
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory: vi.fn(async () => complete), workspaces: () => [] });
    try {
      await client.warmWorkspace(target); const original = peer.request.getMockImplementation()!;
      peer.request.mockImplementation(async request => request.op === "messages.search"
        ? { type: "WORKSPACE_RESPONSE", op: "messages.search", result: {
          hits: [{ chatId: cloudScopedId(other,"chat"), msgId: row.msgId, payload: row.payload, createdAt: row.createdAt }],
          projection, historyHeads: [head] } } : original(request));
      await expect(client.request({ type: "WORKSPACE_REQUEST", op: "messages.search",
        params: { chatId: cloudScopedId(target,"chat"), query: "old" } })).rejects.toThrow(/Cloud workspace changed/);
    } finally { client.dispose(); }
  });
  it.each(["/personal/local","/organization/local"])("leaves %s search ownership and payload on the Local transport", async folder => {
    const hit = { chatId: "chat", msgId: row.msgId, payload: row.payload, createdAt: row.createdAt };
    const request = createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op: "messages.search",
      params: { folder, chatId: "chat", query: "old", limit: 20 } });
    const reply = createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: request.id, op: "messages.search", result: { hits: [hit] } });
    const local = vi.spyOn(RuntimeClient.prototype,"request").mockResolvedValue(reply), open = vi.fn(), readHistory = vi.fn();
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
    try {
      expect(await client.request(request,3210)).toBe(reply);
      expect(local).toHaveBeenCalledWith(request,3210);
      expect(open).not.toHaveBeenCalled(); expect(readHistory).not.toHaveBeenCalled();
      expect(hit.chatId).toBe("chat");
    } finally { client.dispose(); local.mockRestore(); }
  });
});
