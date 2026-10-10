import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";
import { CloudAgentConnection } from "../../../platform/bridge/cloud-agent-connection";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { BLANK, useSessionsStore } from "../sessions-store";
import type { AgentMessage } from "../use-agent-session";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import type { WireRecord } from "../../../platform/bridge/cloud-runtime-wire";
import { CloudHistoryRestoreMetadataSchema } from "../../../platform/cloud-transcript-cache-contract";
import { onCloudHistoryRestoreHead, installCloudHistoryRestoreMetadata, setCloudTranscriptCacheOwner } from "../../../platform/cloud-transcript-cache";

const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let helper = "", callback = "";
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "cloudHasNativeTranscript") helper = node.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "installCloudRestoreHead" && node.initializer && ts.isCallExpression(node.initializer))
    callback = node.initializer.arguments[0]!.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
if (!helper || !callback) throw new Error("Provider callback missing");
const source = ts.transpileModule(`${helper}\nglobalThis.install = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const metadata = CloudHistoryRestoreMetadataSchema.parse({ projection: { ...target, generation: 2,
  engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10,
  sealedSequence: null, complete: false }, historyHeads: [{ conversationId: "chat",
    originWriterEpoch: "55555555-5555-4555-8555-555555555555",
    source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "repair" },
    restoreRevision: 1, deleted: false, recordSequence: 4, eventSequence: 9, manifestSha256: "a".repeat(64), incompleteReason: null }] });
const projection = metadata.projection, head = metadata.historyHeads[0]!;
const newer = CloudHistoryRestoreMetadataSchema.parse({ projection: { ...projection, mirroredSequence: 20 },
  historyHeads: [{ ...head, restoreRevision: 2, recordSequence: null, manifestSha256: null, incompleteReason: "history_limit" }] });
const chatId = cloudScopedId(target, "chat");
const live: AgentMessage = { id: "live", kind: "text", role: "agent", text: "original running native transcript", createdAt: 1 };
beforeEach(() => { useSessionsStore.getState().clearAll(); setCloudTranscriptCacheOwner("88888888-8888-4888-8888-888888888888"); });
afterEach(() => { setCloudTranscriptCacheOwner(null); useSessionsStore.getState().clearAll(); });

async function fixture(withGlobalHeads = false) {
  const handlers = new Map<string, Set<(frame: WireRecord) => void>>();
  const { mirroredSequence: _m, sealedSequence: _s, complete: _c, ...identity } = projection;
  const binding = CloudAgentBootConversationSchema.parse({ ...identity, authorityEpoch: 1, cacheRevision: 1,
    desiredCacheRevision: 1, initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  const request = vi.fn(async (message: WireRecord): Promise<WireRecord> => ({ type: "WORKSPACE_RESPONSE", op: message.op,
    result: { chats: [{ id: "chat", folder: "/workspace/repo" }], chatDeletions: [], ...metadata } }));
  const peerClient = { status: "connected", activatedCloudAgentBootBinding: binding,
    executionIdentity: { kind: "cloud", ...target, generation: 2, engineInstanceId: projection.engineInstanceId,
      authorityEpoch: 1, bootScope: identity }, onStatusChange: () => () => {},
    request,
    on: (type: string, listener: (frame: WireRecord) => void) => {
      const set = handlers.get(type) ?? new Set(); set.add(listener); handlers.set(type, set); return () => set.delete(listener);
    } } as unknown as RuntimeClient;
  const agents = new CloudAgentConnection(peerClient, target.workspaceId, vi.fn(async () => { throw new Error("No provider admission in this fixture"); }));
  const bridge = new WorkspaceRuntimeClient({ open: async () => ({ client: peerClient, agents,
    scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "main" }, generation: 2, runtimeId: "exact-admission", release: vi.fn() }),
    workspaces: () => [], ...(withGlobalHeads ? { onHistoryRestoreHead: onCloudHistoryRestoreHead } : {}),
    readHistory: vi.fn(async () => ({ chats: [{ id: chatId, folder: cloudWorkspaceKey(target) }],
      chatDeletions: [], ...metadata })) });
  bridge.on("DB_CHANGED", () => {});
  await bridge.warmWorkspace(target);
  agents.restoreAttachments([{ id: "chat", agentId: "codex", model: "fixture", fast: false, modeRevision: 1 }]);
  const loaded = agents.incoming({ type: "AGENT_SESSION_LOADED", chatId: "chat", agentId: "codex", sessionId: "native-execution",
    executionId: "native-execution", promptActive: true, response: {} })!;
  expect(agents.hasCurrentExecution("chat", "native-execution")).toBe(true);
  const routedExecution = cloudScopedId(target, String(loaded.executionId));
  expect(routedExecution).toBe(cloudScopedId(target, "conversation:chat"));
  useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd: cloudWorkspaceKey(target), agentId: "codex",
    executionId: routedExecution, sessionId: routedExecution, messages: [live], transcriptState: "resident", status: "streaming", hasTranscript: true });
  const context: Record<string, unknown> = { WorkspaceRuntimeClient, HYDRATE_WINDOW: 200,
    getStore: useSessionsStore.getState, bridge, persistedMessageRefsRef: { current: new Map() }, pendingHydratesRef: { current: new Set() } };
  vm.runInNewContext(source, context);
  const stop = onCloudHistoryRestoreHead(context.install as Parameters<typeof onCloudHistoryRestoreHead>[0], true);
  return { bridge, agents, routedExecution, request,
    emit: (frame: WireRecord) => { for (const listener of handlers.get(String(frame.type)) ?? []) listener(frame); },
    close: () => { stop(); bridge.dispose(); } };
}

describe("actual conversation alias and live-versus-projection head", () => {
  it("recognizes its original native execution through the actual CloudAgentConnection renderer alias", async () => {
    const f = await fixture();
    try {
      expect(f.bridge.hasCloudNativeTranscript(chatId, f.routedExecution, 200)).toBe(true);
      expect(f.agents.hasCurrentExecution("missing", "conversation:missing")).toBe(false);
      expect(f.agents.hasCurrentExecution("chat", "conversation:sibling")).toBe(false);
      expect(f.agents.hasCurrentExecution("chat", "retired-native")).toBe(false);
    } finally { f.close(); }
  });
  it("preserves the original live transcript when a CP projection publishes a newer incomplete head", async () => {
    const f = await fixture();
    try {
      const before = useSessionsStore.getState().sessions[chatId];
      await installCloudHistoryRestoreMetadata(target, newer, ["chat"]);
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
      expect(useSessionsStore.getState().sessions[chatId]).toBe(before);
    } finally { f.close(); }
  });
  it.each(["repair", "prune", "delete"] as const)("invalidates old visible rows for the ORIGINAL VM %s head while preserving queued intent", async operation => {
    const f = await fixture();
    try {
      const queued: AgentMessage = { id: "queued", kind: "text", role: "user", text: "next turn", queued: true, createdAt: 2 };
      useSessionsStore.getState().patchSession(chatId, { messages: [live, queued] });
      const vmHead = { ...newer, historyHeads: [{ ...newer.historyHeads[0]!,
        source: { kind: "mutation" as const, mutationId: "99999999-9999-4999-8999-999999999999", operation }, deleted: operation === "delete" }] };
      f.emit({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["chat"], cloudHistoryRestore: vmHead });
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([queued]);
      expect(useSessionsStore.getState().cloudHistoryRestoreHeads[chatId]?.head?.restoreRevision).toBe(2);
    } finally { f.close(); }
  });
  it.each([false, true])("does not confuse a CP-first head with the later identical VM confirmation or clear a duplicate accepted VM head (complete %s)", async complete => {
    const f = await fixture();
    try {
      const replacement = complete ? { ...newer, historyHeads: [{ ...newer.historyHeads[0]!, recordSequence: 5,
        eventSequence: 10, manifestSha256: "b".repeat(64), incompleteReason: null }] } : newer;
      await installCloudHistoryRestoreMetadata(target, replacement, ["chat"]);
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
      f.emit({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["chat"], cloudHistoryRestore: replacement });
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([]);
      const repaired: AgentMessage = { ...live, text: "current repaired native history" };
      useSessionsStore.getState().patchSession(chatId, { messages: [repaired] });
      const accepted = useSessionsStore.getState().sessions[chatId];
      f.emit({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["chat"], cloudHistoryRestore: replacement });
      expect(useSessionsStore.getState().sessions[chatId]).toBe(accepted);
    } finally { f.close(); }
  });
  it("preserves the current native transcript for a VM metadata edit", async () => {
    const f = await fixture();
    try {
      f.emit({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["chat"], cloudHistoryRestore: { ...newer,
        historyHeads: [{ ...newer.historyHeads[0]!, source: { kind: "mutation", mutationId: "99999999-9999-4999-8999-999999999999", operation: "edit" } }] } });
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
    } finally { f.close(); }
  });
  it("cannot relabel retained CP head B as native when only a delayed VM head A arrived", async () => {
    const f = await fixture(), observed: string[] = [];
    const stop = onCloudHistoryRestoreHead((_id, _head, origin) => observed.push(origin));
    const delivered: WireRecord[] = [];
    f.bridge.on("DB_CHANGED", frame => delivered.push(frame as unknown as WireRecord));
    try {
      await installCloudHistoryRestoreMetadata(target, newer, ["chat"]);
      expect(observed).toEqual(["control-plane"]);
      f.emit({ type: "DB_CHANGED", kinds: ["messages"], chatIds: ["chat"], cloudHistoryRestore: metadata });
      expect(observed).toEqual(["control-plane"]);
      expect(delivered).toEqual([]);
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
    } finally { stop(); f.close(); }
  });
  it("does not forward a stale VM snapshot after the parallel CP read confirmed a newer head", async () => {
    const f = await fixture(), delivered = vi.fn();
    f.bridge.on("AGENT_SESSION_LOADED", delivered);
    try {
      await installCloudHistoryRestoreMetadata(target, newer, ["chat"]);
      f.emit({ type: "AGENT_SESSION_LOADED", agentId: "codex", chatId: "chat", sessionId: "native-execution",
        cloudSnapshot: { conversationId: "chat", executionId: "native-execution", historyRestore: metadata } });
      expect(delivered).not.toHaveBeenCalled();
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
    } finally { f.close(); }
  });
  it("refuses a stale VM window instead of labelling its rows with retained CP head B", async () => {
    const f = await fixture();
    try {
      await installCloudHistoryRestoreMetadata(target, newer, ["chat"]);
      f.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "messages.window", result: {
        messages: [{ msgId: "old-a", kind: "text", payload: JSON.stringify(live), createdAt: 1 }], ...metadata } });
      await expect(f.bridge.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId, limit: 200 } })).rejects.toThrow(/restore|retired/u);
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
    } finally { f.close(); }
  });
  it("checks a cached native page at the outer return after the production global subscription installs CP head B", async () => {
    const f = await fixture(true), row = { msgId: "cached-a", kind: "text", payload: JSON.stringify(live), createdAt: 1 };
    const message = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId, limit: 200 } };
    try {
      f.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "messages.window", result: { messages: [row], ...metadata } });
      expect(await f.bridge.request(message)).toMatchObject({ result: { messages: [row], historyHeads: metadata.historyHeads } });
      await installCloudHistoryRestoreMetadata(target, newer, ["chat"]);
      await expect(f.bridge.request(message)).rejects.toThrow(/restore|retired/u);
      expect(f.request.mock.calls.filter(([request]) => request.op === "messages.window")).toHaveLength(1);
      expect(useSessionsStore.getState().sessions[chatId]?.messages).toEqual([live]);
    } finally { f.close(); }
  });
});
