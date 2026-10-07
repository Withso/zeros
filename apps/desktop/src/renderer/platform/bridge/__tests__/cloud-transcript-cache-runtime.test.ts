import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient, type CloudPeer } from "../workspace-runtime-client";
import type { RuntimeClient } from "../ws-client";
import { cloudScopedId } from "../cloud-workspace-key";
import { wireCloudTranscriptCheckpoints } from "../cloud-transcript-checkpoints";
import { createStore } from "zustand/vanilla";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const clients: WorkspaceRuntimeClient[] = [];
function fixture(readHistory: (target: unknown, op: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, checkpointHistory = false, identity?: () => string) {
  const live = { messages: [{ msgId: "m", kind: "text", payload: "current stream", createdAt: 1 }] };
  const listeners = new Map<string, Set<(message: never) => void>>();
  const request = vi.fn(async (message: { type?: string; op?: string; chatId?: string }) => message.type === "AGENT_PROMPT"
    ? { type: "AGENT_PROMPT_COMPLETE", chatId: message.chatId, sessionId: "execution-a" }
    : { type: "WORKSPACE_RESPONSE", result: message.op === "chats.list" ? { chats: [], chatDeletions: [] } : live });
  const peer: CloudPeer = { client: { request, send: vi.fn(), status: "connected", on: (type: string, handler: (message: never) => void) => {
    const set = listeners.get(type) ?? new Set(); set.add(handler); listeners.set(type, set); return () => { set.delete(handler); };
  }, onStatusChange: () => () => {} } as unknown as RuntimeClient,
    runtimeId: "runtime-a", scope: { ...target, engineWorkspaceId: "local-main", root: "/workspace/repo" }, release: vi.fn() };
  const open = vi.fn(async () => peer);
  const client = new WorkspaceRuntimeClient({ open, readHistory, checkpointHistory, identity, workspaces: () => [], canAccess: () => true }); clients.push(client);
  return { client, open, request, live, emit: (type: string, message: Record<string, unknown>) => {
    for (const handler of listeners.get(type) ?? []) handler(message as never);
  } };
}
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.restoreAllMocks(); });
describe("durable cache versus runtime history authority", () => {
  it("re-reads an already attached runtime when a cold projection completes after attachment", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const projection = new Promise<Record<string, unknown>>(done => { resolve = done; });
    const h = fixture(async (_target, op) => op === "chats.list" ? { chats: [], chatDeletions: [], revision: 1 } : projection);
    const result = h.client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: cloudScopedId(target, "chat-a"), limit: 200 } });
    expect(h.open).not.toHaveBeenCalled();
    await h.client.warmWorkspace(target);
    resolve({ revision: 1, messages: [{ msgId: "m", kind: "text", payload: "older projection", createdAt: 1 }] });
    expect(await result).toMatchObject({ result: h.live });
    expect(h.open).toHaveBeenCalledOnce();
  });
  it("recognizes only confirmed exact-key in-memory windows without opening a runtime", async () => {
    const h = fixture(async () => ({ messages: [], revision: 2 }));
    const chatId = cloudScopedId(target, "chat-a");
    expect(h.client.hasCloudMessageSnapshot(chatId, 200)).toBe(false);
    await h.client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId, limit: 200 } });
    expect(h.client.hasCloudMessageSnapshot(chatId, 200)).toBe(true);
    expect(h.client.hasCloudMessageSnapshot(chatId, 100)).toBe(false);
    expect(h.client.hasCloudMessageSnapshot(cloudScopedId(target, "chat-b"), 200)).toBe(false);
    expect(h.client.hasCloudMessageSnapshot("local-chat", 200)).toBe(false);
    h.client.clearCloudConnections(); expect(h.client.hasCloudMessageSnapshot(chatId, 200)).toBe(false);
    expect(h.open).not.toHaveBeenCalled();
  });
  it("does not checkpoint ordinary native transcript windows", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>(done => { resolve = done; });
    const readHistory = vi.fn(async (_target: unknown, op: string) => op === "chats.list" ? { chats: [], chatDeletions: [] } : pending);
    const h = fixture(readHistory, true); await h.client.warmWorkspace(target);
    const params = { chatId: cloudScopedId(target, "chat-a"), limit: 200 };
    expect(await h.client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params })).toMatchObject({ result: h.live });
    expect(await h.client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params })).toMatchObject({ result: h.live });
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toHaveLength(0);
    expect(h.open).toHaveBeenCalledOnce();
    resolve({ revision: 8, messages: [{ msgId: "m", kind: "text", payload: "projection checkpoint", createdAt: 1 }] });
    await Promise.resolve();
  });
  it("starts a bounded passive checkpoint at native turn completion without awaiting it", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>(done => { resolve = done; });
    const readHistory = vi.fn(async (_target: unknown, op: string, _params: Record<string, unknown>) => op === "chats.list" ? { chats: [], chatDeletions: [] } : pending);
    const h = fixture(readHistory, true), chatId = cloudScopedId(target, "chat-a");
    const response = await h.client.request({ type: "AGENT_PROMPT", chatId, sessionId: "execution-a" } as never);
    expect(response).toMatchObject({ type: "AGENT_PROMPT_COMPLETE", chatId });
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toEqual([[expect.anything(), "messages.window", { chatId, limit: 200 }]]);
    expect(h.open).toHaveBeenCalledOnce();
    resolve({ revision: 8, messages: [] });
    await Promise.resolve();
  });
  it("coalesces turn/departure events for 30s even after DB invalidation or failure, and removes the root listeners", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const readHistory = vi.fn(async (_target: unknown, op: string, _params: Record<string, unknown>) => {
      if (op === "chats.list") return { chats: [], chatDeletions: [] };
      throw new Error("offline projection");
    });
    let generation = "1";
    const h = fixture(readHistory, true, () => generation), chatId = cloudScopedId(target, "chat-a");
    const selection = createStore(() => ({ activeChatId: chatId as string | null, activePage: "workspace" }));
    const stop = wireCloudTranscriptCheckpoints(h.client, selection);
    const stopChanged = h.client.on("DB_CHANGED", () => {});
    await h.client.warmWorkspace(target);
    h.emit("AGENT_SESSION_UPDATE", { chatId: "chat-a" });
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toHaveLength(0);
    h.emit("AGENT_PROMPT_FAILED", { chatId: "chat-a" });
    await new Promise(resolve => setTimeout(resolve, 0));
    h.emit("DB_CHANGED", { kinds: ["messages"] });
    selection.setState({ activeChatId: "local-personal" });
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toHaveLength(1);
    generation = "2";
    now = 29_999; h.client.checkpointCloudTranscript(chatId);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toHaveLength(1);
    now = 30_000; selection.setState({ activeChatId: chatId }); selection.setState({ activePage: "settings" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toHaveLength(2);
    stop(); stopChanged(); now = 60_000;
    h.emit("AGENT_PROMPT_COMPLETE", { chatId: "chat-a" });
    selection.setState({ activeChatId: null });
    expect(readHistory.mock.calls.filter(call => call[1] === "messages.window")).toHaveLength(2);
    expect(h.open).toHaveBeenCalledOnce();
  });
  it("leaves both Local chat owners, denied cloud targets and disabled checkpoint clients inert", async () => {
    const readHistory = vi.fn(async () => ({ messages: [] }));
    const h = fixture(readHistory, true);
    const selection = createStore(() => ({ activeChatId: "local-personal" as string | null, activePage: "workspace" }));
    const stop = wireCloudTranscriptCheckpoints(h.client, selection);
    selection.setState({ activeChatId: "local-org" }); selection.setState({ activeChatId: null });
    const disabled = fixture(readHistory); disabled.client.checkpointCloudTranscript(cloudScopedId(target, "chat-a"));
    const denied = new WorkspaceRuntimeClient({ open: h.open, readHistory, checkpointHistory: true, workspaces: () => [], canAccess: () => false }); clients.push(denied);
    denied.checkpointCloudTranscript(cloudScopedId(target, "chat-a"));
    expect(readHistory).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled(); stop();
  });
});
