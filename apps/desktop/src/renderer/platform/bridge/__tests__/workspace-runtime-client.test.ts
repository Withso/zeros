import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../ws-client";
import { CloudAgentConnection } from "../cloud-agent-connection";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
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
    ): Promise<Record<string, unknown>> => ({
      type: "WORKSPACE_RESPONSE",
      op: message.op,
      result:
        message.op === "chats.list"
          ? { chats: [], chatDeletions: [] }
          : { target: target.workspaceId },
    }),
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

describe("workspace runtime routing", () => {
  it("uses the Local transport for replica controls while a cloud workspace is open", async () => {
    const peer = fakePeer(a);
    const open = vi.fn(async () => peer.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    try {
      await client.warmWorkspace(a);
      peer.request.mockClear();
      open.mockClear();
      const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({
        type: "WORKSPACE_RESPONSE", result: [],
      } as never);
      const message = {
        type: "WORKSPACE_REQUEST", op: "cloudReplica.create",
        params: { workspaceId: cloudWorkspaceKey(a), organizationId, rootPath: "/Users/test/downloads" },
      } as const;
      await client.request(message);
      expect(local).toHaveBeenCalledWith(message, expect.anything());
      expect(open).not.toHaveBeenCalled();
      expect(peer.request).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("authorizes the exact translated PR request without changing shared UI operations", async () => {
    const peer = fakePeer(a), prepareGithubWrite = vi.fn(async () => "test-write-grant");
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, workspaces: () => [], prepareGithubWrite });
    await client.request({ type: "WORKSPACE_REQUEST", op: "gh.prComment", params: { workspaceId: cloudScopedId(a, "local-main"), number: 12, body: "A review comment" } } as never);
    expect(prepareGithubWrite).toHaveBeenCalledWith(a, "gh.prComment", { workspaceId: "local-main", number: 12, body: "A review comment" });
    expect(peer.request).toHaveBeenCalledWith(expect.objectContaining({ op: "gh.prComment", params: { workspaceId: "local-main", number: 12, body: "A review comment", $cloudGithubWriteGrant: "test-write-grant" } }), expect.anything());
    client.dispose();
  });
  it.each(["account", "retirement", "abort"])("does not dispatch a write after %s changes during GitHub authorization", async cause => {
    const peer = fakePeer(a), grant = deferred<string>(), preparing = deferred<void>(), abort = new AbortController();
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, workspaces: () => [], prepareGithubWrite: async () => { preparing.resolve(); return grant.promise; } });
    peer.peer.runtimeId = "old-engine";
    const pending = client.request({ type: "WORKSPACE_REQUEST", op: "git.push", params: { workspaceId: cloudScopedId(a, "local-main") } } as never, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await preparing.promise;
    if (cause === "account") client.clearCloudConnections();
    else if (cause === "retirement") client.retireCloudRuntime("old-engine");
    else abort.abort();
    grant.resolve("test-write-grant"); await rejected;
    expect(peer.request.mock.calls.some(([message]) => message.op === "git.push")).toBe(false);
    client.dispose();
  });
  it.each(["disconnected", "retired", "account-reset", "access-pruned"])("keeps command routes within their admitted workspace owner after %s", async cause => {
    const chat = "44444444-4444-4444-8444-444444444444";
    const old = fakePeer(a), replacement = fakePeer(a);
    const authorize = vi.fn(async () => "55555555-5555-4555-8555-555555555555");
    for (const peer of [old, replacement]) {
      peer.peer.agents = new CloudAgentConnection(peer.peer.client, "local-main", authorize);
      peer.release.mockImplementation(() => peer.peer.agents!.dispose());
      peer.request.mockImplementation(async message => {
        if (message.type !== "WORKSPACE_REQUEST") throw new Error("Native cloud prompt bypassed its command adapter");
        const request = (message.params as Record<string, unknown>)?.request as Record<string, unknown> | undefined;
        const result = message.op === "chats.list" ? { chats: [], chatDeletions: [] }
          : message.op === "cloudCommands.conversation" || message.op === "cloudCommands.createConversation"
            ? { conversationId: chat, agentId: "codex", modeRevision: 0 }
            : request?.kind === "snapshot"
              ? { version: 1, conversationId: chat, revision: 0, paused: false, pending: [], receipts: [] }
              : request?.kind === "read"
                ? { commandId: request.commandId, conversationId: chat, position: 1, state: "succeeded", payload: null,
                    executionId: "replacement-execution", generation: 2, resultCode: null,
                    createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" }
                : {};
        return { type: "WORKSPACE_RESPONSE", op: message.op, result };
      });
    }
    old.peer.runtimeId = "retired-conversation-owner";
    const open = vi.fn().mockResolvedValueOnce(old.peer).mockResolvedValueOnce(replacement.peer);
    let allowed = true;
    const client = new WorkspaceRuntimeClient({ open, canAccess: () => allowed, workspaces: () => [] });
    const sessionId = cloudScopedId(a, `conversation:${chat}`);
    try {
      await client.request({ type: "AGENT_NEW_SESSION", chatId: cloudScopedId(a, chat), agentId: "codex",
        cwd: cloudWorkspaceKey(a), env: { OPENAI_MODEL: "gpt-5.6" } } as never);
      client.send({ type: "AGENT_UPDATE_CONFIG", sessionId, agentId: "codex",
        env: { OPENAI_MODEL: "gpt-5.6-luna", ZEROS_THINKING_EFFORT: "high" } } as never);
      old.peer.agents!.incoming({ type: "AGENT_SESSION_CREATED", agentId: "codex", chatId: chat,
        session: { sessionId: "old-execution", executionId: "old-execution" } });
      if (cause === "account-reset") client.clearCloudConnections();
      else if (cause === "access-pruned") {
        allowed = false; client.pruneCloudConnections(); allowed = true;
      } else if (cause === "retired") client.retireCloudRuntime(old.peer.runtimeId!);
      else Object.assign(old.peer.client, { status: "disconnected" });
      const pending = client.request({ type: "AGENT_PROMPT", sessionId, agentId: "codex",
        userMessageId: "after-reconnect", prompt: [{ type: "text", text: "continue" }] } as never);
      if (cause === "account-reset" || cause === "access-pruned") {
        await expect(pending).rejects.toThrow(/conversation.*reconnect/i);
        expect(authorize).not.toHaveBeenCalled();
        expect(replacement.request.mock.calls.every(([m]) => m.op === "chats.list")).toBe(true);
        return;
      }
      const response = await pending;
      expect(response).toMatchObject({ type: "AGENT_PROMPT_COMPLETE", sessionId });
      expect(authorize).toHaveBeenCalledWith("codex", "gpt-5.6-luna");
      const enqueue = replacement.request.mock.calls.find(([m]) =>
        (m.params as { request?: { kind: string } } | undefined)?.request?.kind === "mutate")?.[0];
      expect(enqueue).toMatchObject({ op: "cloudCommands.request", params: { request: { mutation: { action: {
        kind: "enqueue", payload: { agentId: "codex", model: "gpt-5.6-luna", effort: "high" },
      } } } } });
      expect(replacement.request.mock.calls.every(([m]) => m.type === "WORKSPACE_REQUEST")).toBe(true);
      expect(replacement.request.mock.calls.some(([m]) => m.op === "cloudCommands.createConversation")).toBe(false);
      expect(old.release).toHaveBeenCalledOnce();
    } finally { client.dispose(); }
  });

  it("reads the attached worker's current transcript without replacing it with a lagging cloud projection", async () => {
    const peer = fakePeer(a);
    const remote = { messages: [{ msgId: "reply", kind: "text", payload: "old", createdAt: 1 }] };
    const live = { messages: [{ ...remote.messages[0], payload: "complete" }] };
    const readHistory = vi.fn(async (_target, op) => op === "chats.list"
      ? { chats: [], chatDeletions: [], revision: 1 } : remote);
    const open = vi.fn(async () => peer.peer);
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId: cloudScopedId(a, "chat"), limit: 100 } };
    try {
      expect(await client.request(request)).toMatchObject({ result: remote });
      expect(open).not.toHaveBeenCalled(); // Cold/stopped history never wakes a VM.
      await client.warmWorkspace(a);
      peer.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", result: live });
      expect(await client.request(request)).toMatchObject({ result: live });
      expect(peer.request).toHaveBeenLastCalledWith(expect.objectContaining({
        op: "messages.window", params: { chatId: "chat", limit: 100 },
      }));
      Object.defineProperty(peer.peer.client, "status", { value: "disconnected" });
      expect(await client.request(request)).toMatchObject({ result: remote });
      expect(open).toHaveBeenCalledOnce();
    } finally { client.dispose(); }
  });

  it("rejects an attached history response after its workspace connection is retired", async () => {
    const peer = fakePeer(a), pending = deferred<Record<string, unknown>>();
    const readHistory = vi.fn(async () => ({ chats: [], chatDeletions: [], revision: 1 }));
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory, workspaces: () => [] });
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
    const readHistory = vi.fn(async (target: CloudWorkspaceTarget) => ({
      revision, chats: [{ id: cloudScopedId(target, "saved"), folder: cloudWorkspaceKey(target) }], chatDeletions: [],
    }));
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
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
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, workspaces: () => [] });
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
      ? { chats: [{ id: cloudScopedId(a, "saved"), folder: cloudWorkspaceKey(a) }], chatDeletions: [] }
      : { messages: [{ msgId: "tool", kind: "tool_call", payload: '{"status":"completed"}', createdAt: 1 }] });
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
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
    const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory, workspaces: () => [] });
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
      readHistory: async () => ({ messages: [{ msgId: "saved" }] }) });
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId: cloudScopedId(a, "saved"), limit: 100 } };
    await client.request(request);
    allowed = false;
    await expect(client.request(request)).rejects.toThrow(/access/i);
    client.dispose();
  });

  it("refreshes exact workspace metadata on database changes without rereading Local", async () => {
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({
      type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] },
    } as unknown as BridgeMessage);
    const peer = fakePeer(a);
    let version = 1, allowed = true;
    const readHistory = vi.fn(async (target: CloudWorkspaceTarget) => ({ chats: [{ id: cloudScopedId(target, `chat-${version}`) }], chatDeletions: [] }));
    const client = new WorkspaceRuntimeClient({ open: async () => peer.peer, readHistory, workspaces: () => [], canAccess: () => allowed });
    client.on("DB_CHANGED", () => {});
    try {
      await client.warmHistoryWorkspace(b);
      await client.warmWorkspace(a);
      version = 2;
      peer.emit("DB_CHANGED", { kinds: ["chats"] });
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(3));
      await vi.waitFor(async () => expect(await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list" })).toMatchObject({ result: {
        chats: [{ id: cloudScopedId(a, "chat-2") }, { id: cloudScopedId(b, "chat-1") }],
      } }));
      expect(peer.request).not.toHaveBeenCalled();
      expect(local.mock.calls.every(([message]) => message.type === "WORKSPACE_REQUEST" && message.op === "chats.list")).toBe(true);
      client.retireCloudRuntime(peer.peer.runtimeId ?? "none");
      allowed = false;
      expect(await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list" })).toMatchObject({ result: { chats: [], confirmedCloudWorkspaces: [] } });
    } finally { client.dispose(); }
  });

  it.each(["disconnected", "connecting"])("reopens only the %s workspace and retains its history while reconnecting", async status => {
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({
      type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] },
    } as unknown as BridgeMessage);
    const old = fakePeer(a), other = fakePeer(b), replacement = fakePeer(a);
    old.peer.runtimeId = "retired-for-reconnect";
    old.request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: {
      chats: [{ id: "saved", folder: "/workspace/repo" }], chatDeletions: [],
    } });
    const opening = deferred<CloudPeer>();
    let first = true;
    const open = vi.fn(async (target: CloudWorkspaceTarget) => {
      if (target.workspaceId === b.workspaceId) return other.peer;
      if (first) { first = false; return old.peer; }
      return opening.promise;
    });
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    try {
      await Promise.all([client.warmWorkspace(a), client.warmWorkspace(b)]);
      Object.assign(old.peer.client, { status });
      const warming = client.warmWorkspace(a);
      const write = client.request({ type: "WORKSPACE_REQUEST", op: "file.write", params: {
        workspaceId: cloudWorkspaceKey(a), path: "saved.ts", content: "new",
      } });
      void warming.catch(() => {});
      void write.catch(() => {});
      expect(old.release).toHaveBeenCalledOnce();
      expect(other.release).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(3);
      expect(replacement.request).not.toHaveBeenCalled();
      // Native close acknowledges the old transport after replacement began.
      client.retireCloudRuntime("retired-for-reconnect");
      const history = await client.request({ type: "WORKSPACE_REQUEST", op: "chats.list", params: {} });
      expect(history).toMatchObject({ result: {
        confirmedCloudWorkspaces: [cloudWorkspaceKey(a), cloudWorkspaceKey(b)],
        chats: [{ id: cloudScopedId(a, "saved"), folder: cloudWorkspaceKey(a) }],
      } });
      expect(local.mock.calls.every(([message]) => message.type === "WORKSPACE_REQUEST" && message.op === "chats.list")).toBe(true);
      opening.resolve(replacement.peer);
      await Promise.all([warming, write]);
      expect(replacement.request.mock.calls.map(([message]) => message.op)).toEqual(["chats.list", "file.write"]);
      expect(other.release).not.toHaveBeenCalled();
    } finally { client.dispose(); }
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
    client.send({
      type: "AGENT_CANCEL",
      agentId: "codex",
      sessionId: cloudScopedId(a, "run"),
    });
    expect(pa.send).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "run" }),
    );
    expect(pb.send).not.toHaveBeenCalled();
    off();
    client.dispose();
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

  it("rejects a response from a retired runtime even if the account is unchanged", async () => {
    const pa = fakePeer(a);
    pa.peer.runtimeId = "old-runtime";
    const client = new WorkspaceRuntimeClient({
      open: async () => pa.peer,
      workspaces: () => [],
    });
    await client.warmWorkspace(a);
    const wait = deferred<Record<string, unknown>>();
    pa.request.mockImplementationOnce(() => wait.promise);
    const request = client.request({
      type: "WORKSPACE_REQUEST",
      op: "file.read",
      params: { workspaceId: cloudWorkspaceKey(a), path: "same.ts" },
    });
    const rejected = expect(request).rejects.toThrow(/connection changed/);
    await vi.waitFor(() => expect(pa.request).toHaveBeenCalledTimes(2));
    client.retireCloudRuntime("old-runtime");
    wait.resolve({
      type: "WORKSPACE_RESPONSE",
      op: "file.read",
      result: { content: "obsolete" },
    });
    await rejected;
    client.dispose();
  });
});
