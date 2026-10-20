import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentConnection } from "../cloud-agent-connection";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { RuntimeClient } from "../ws-client";
import { cloudScopedId, cloudWorkspaceKey, isCloudWorkspace } from "../cloud-workspace-key";
import type { WireRecord } from "../cloud-runtime-wire";
import * as lifecycle from "../../../features/agent/session-reload-lifecycle";
import { closeActivityForSession, closeRouteForSession } from "../../../features/agent/session-close-lifecycle";
import { invalidateTranscriptRequest } from "../../../features/agent/transcript-retention";
import { BLANK, useSessionsStore } from "../../../features/agent/sessions-store";
import type { AgentSessionState } from "../../../features/agent/use-agent-session";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const conversationId = "33333333-3333-4333-8333-333333333333";
const chatId = cloudScopedId(target, conversationId);
const route = cloudScopedId(target, `conversation:${conversationId}`);
const cwd = cloudWorkspaceKey(target);
const binding = {
  ...target, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", generation: 1, authorityEpoch: 1,
  engineInstanceId: "44444444-4444-4444-8444-444444444444", bootId: "55555555-5555-4555-8555-555555555555",
  writerEpoch: "66666666-6666-4666-8666-666666666666", fundingOwnerUserId: "77777777-7777-4777-8777-777777777777",
  fundingOwnerEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })),
};

// The close callback, session store and both cloud bridge adapters are real.
// Only authenticated native I/O is replaced; no close reply is synthesized.
const sourceFile = new URL("../../../features/agent/sessions-provider.tsx", import.meta.url);
const source = ts.createSourceFile(sourceFile.pathname, readFileSync(sourceFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let closeSource = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "closeSession" &&
      node.initializer && ts.isCallExpression(node.initializer)) closeSource = node.initializer.arguments[0].getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
expect(closeSource).not.toBe("");
const code = ts.transpileModule(`globalThis.closeSession = ${closeSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  useSessionsStore.setState({ sessions: {}, executionToChatId: {}, pendingLocalTurns: {}, cancellingChats: new Set() });
  vi.restoreAllMocks();
});

async function harness(shape: "warm" | "route-cleared" | "slot-absent") {
  const nativeRequest = vi.fn(async (message: WireRecord) => {
    let result: unknown;
    if (message.op === "chats.list") result = { chats: [], chatDeletions: [] };
    else if (["cloudCommands.conversation", "cloudCommands.createConversation"].includes(String(message.op)))
      result = { conversationId, modeRevision: 0, nativeCommandsVersion: 1, permissionModeVersion: 1,
        cloudTurnProtocolVersion: 1, cloudLocalCommands: binding };
    else if (message.op === "cloudEvents.request") result = { snapshot: {
      conversationId, activeTurn: null, messages: [], permissions: [], questions: [],
    } };
    else throw new Error(`Unexpected native request: ${String(message.op ?? message.type)}`);
    return { type: "WORKSPACE_RESPONSE", op: message.op, result };
  });
  const client = {
    status: "connected", executionIdentity: { kind: "cloud", ...binding },
    supportsEngineCapability: () => true, on: () => () => {}, onStatusChange: () => () => {},
    request: nativeRequest, send: vi.fn(),
  } as unknown as RuntimeClient;
  const grant = vi.fn(async () => { throw new Error("Closing must not mint a credential grant"); });
  const agents = new CloudAgentConnection(client, "local-main", grant);
  const bridge = new WorkspaceRuntimeClient({
    open: async () => ({ client, agents, generation: 1,
      scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "local-main" }, release: () => agents.dispose() }),
    workspaces: () => [], readHistory: async () => ({ chats: [], chatDeletions: [] }),
  });
  disposals.push(() => bridge.dispose());
  await bridge.request({ type: "AGENT_NEW_SESSION", chatId, agentId: "codex", cwd, env: { OPENAI_MODEL: "test-model" } });
  const request = vi.spyOn(bridge, "request");
  const slot: AgentSessionState = {
    ...BLANK, cwd, agentId: "codex", status: "idle", foregroundTurnId: null, activeTurnStartedAt: null,
    sessionId: shape === "warm" ? route : null, executionId: shape === "warm" ? route : null,
  };
  useSessionsStore.setState({ sessions: shape === "slot-absent" ? {} : { [chatId]: slot },
    executionToChatId: shape === "warm" ? { [route]: chatId } : {}, pendingLocalTurns: {}, cancellingChats: new Set() });
  const mapRef = () => ({ current: new Map() });
  const cancel = vi.fn(async () => {});
  const context = vm.createContext({
    ...lifecycle, isCloudWorkspace, closeActivityForSession, closeRouteForSession, invalidateTranscriptRequest,
    crypto: { randomUUID }, bridge, getStore: useSessionsStore.getState,
    cancel, cloudClosesRef: mapRef(), cloudStopsRef: mapRef(), cloudCatalogGeneration: () => 1,
    cancelGenerationsRef: mapRef(), cloudSendPreparationRef: { current: { cancel: vi.fn() } },
    cloudSendWaitRef: { current: { cancel: vi.fn() } }, cloudFlushRef: mapRef(),
    sendingChatsRef: { current: new Set() }, sendQueueRef: mapRef(), prebindDirtySessionsRef: mapRef(),
    prebindGoalSnapshotsRef: mapRef(), prebindBackgroundTasksRef: { current: { clearChat: vi.fn() } },
    pendingHydratesRef: { current: new Set() }, hydrateInFlightRef: mapRef(), reconcileInFlightRef: mapRef(),
    nativeTranscriptSnapshotsRef: mapRef(), ensureInFlightRef: mapRef(), loadFlightKeysRef: mapRef(),
    loadFlightAdoptOnlyRef: mapRef(), queueHeldRef: mapRef(), flushBubbleRef: mapRef(), authPromptsRef: mapRef(),
    turnProducedOutputRef: mapRef(), announcedDirsRef: mapRef(), promptActivityRef: mapRef(),
    useWorkspaceStore: { getState: () => ({ chats: [{ id: chatId, folder: cwd, agentId: "codex" }] }) },
  });
  vm.runInContext(code, context);
  return {
    bridge, request, nativeRequest, grant, cancel,
    close: () => (context.closeSession as (id: string) => void | Promise<boolean>)(chatId),
    slot: () => useSessionsStore.getState().sessions[chatId],
  };
}

describe("W3 real cloud close acknowledgement pairing", () => {
  it("accepts the real adapter acknowledgement with a warm conversation route", async () => {
    const h = await harness("warm");
    expect(await h.close()).toBe(true);
    expect(h.slot()).toBeUndefined();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledOnce();
  });

  it.each(["route-cleared", "slot-absent"] as const)("accepts the same actual adapter acknowledgement for %s close", async shape => {
    const h = await harness(shape);
    const closed = h.close();
    expect(h.request).toHaveBeenCalledOnce();
    const reply = await h.request.mock.results[0]!.value;
    expect(reply).toMatchObject({ type: "AGENT_SESSION_CLOSED", agentId: "codex", sessionId: route, executionId: route });
    expect(await closed).toBe(true);
    expect(h.slot()).toBeUndefined();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.grant).not.toHaveBeenCalled();
  });

  it("refuses an acknowledgement that names a foreign conversation", async () => {
    const h = await harness("warm");
    const actualRequest = h.request.getMockImplementation()!;
    h.request.mockImplementationOnce(async (...args) => ({ ...await actualRequest(...args),
      chatId: cloudScopedId(target, "99999999-9999-4999-8999-999999999999") }));
    expect(await h.close()).toBe(false);
    expect(h.slot()).toBeDefined();
  });
});
