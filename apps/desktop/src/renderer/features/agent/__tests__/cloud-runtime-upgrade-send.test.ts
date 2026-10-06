import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { recoverCloudAdmissionFailure } from "../cloud-runtime-upgrade";
import { getLiveChatDraft, setLiveChatDraft } from "../composer-live-drafts";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { AuthPromptRecovery } from "../auth-prompt-recovery";
import * as lifecycle from "../session-reload-lifecycle";
import { SendQueue } from "../send-queue";
import { classifyCloudAdmissionFailure, cloudAdmissionFailureCode } from "../cloud-admission-failure";
import { reportCloudAgentRuntimeUpgrade, invalidateCloudAgentRegistry } from "../workspace-agent-registry";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), workspace: { chats: [{ id: "chat", additionalDirectories: [], model: "gpt-6.1-sol" }], chatComposerDrafts: {}, dispatch: vi.fn() } }));
vi.mock("../workspace-agent-registry", () => ({ reportCloudAgentRuntimeUpgrade: mocks.refresh, invalidateCloudAgentRegistry: mocks.refresh }));
vi.mock("../../../state/store", () => ({ useWorkspaceStore: { getState: () => mocks.workspace } }));
vi.mock("../../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => mocks.workspace } }));
// The production send callback, with only native I/O, telemetry and unrelated
// preparation replaced. This covers its early-return/finally/queue behavior.
const source = readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("provider.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
let promotion = "";
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "promoteToEnd") promotion = node.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "sendPrompt" && node.initializer && ts.isCallExpression(node.initializer))
    callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(`${promotion}\nglobalThis.send = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(folder: string, cause = "cloud_runtime_upgrade_required", duringRequest?: () => void, queued = false) {
  vi.clearAllMocks();
  const draft = { text: "Preserve my prompt", json: { type: "doc" }, attachments: [] };
  setLiveChatDraft("chat", draft);
  useSessionsStore.setState({ sessions: { chat: { ...BLANK, cwd: folder, agentId: "codex", sessionId: "session", status: "ready", messages: [] } } });
  const request = vi.fn(async (_message: unknown) => { duringRequest?.(); return { type: "AGENT_PROMPT_FAILED", error: cause }; });
  const sending = new Set<string>(), pauseQueue = vi.fn(), drainOrDropQueue = vi.fn();
  const queue = new SendQueue<any>(), readiness = vi.fn(() => useSessionsStore.getState().patchSession("chat", { cloudSendWait: { state: "waiting" } }));
  const entry = { cloud: true, bubbleId: "accepted-prompt", args: ["chat", draft.text, draft.text], waitStartedAt: 42 };
  const failure = { kind: "protocol-error", stage: "prompt", message: cause };
  const context: Record<string, unknown> = {
    ...lifecycle, Error, DOMException, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
    bridge: { request }, cloudComputerV2: !isCloudWorkspace(folder) || queued, prepareForSend: () => null, getStore: useSessionsStore.getState,
    // Exercise post-readiness dispatch; cloud FIFO preparation has its own
    // integration suite and hands off the already-claimed stable bubble id.
    flushBubbleRef: { current: new Map(queued ? [["chat", "accepted-prompt"]] : []) },
    cloudFlushRef: { current: new Map(queued ? [["chat", entry]] : []) }, cloudCatalogGeneration: () => 1,
    beginCloudSendWaitRef: { current: readiness }, classifyCloudAdmissionFailure, cloudAdmissionFailureCode,
    reportCloudAgentRuntimeUpgrade, invalidateCloudAgentRegistry,
    getAgentsSnapshot: () => [], isCloudWorkspace,
    resumeQueue: () => false, sendingChatsRef: { current: sending }, sendQueueRef: { current: queue },
    queueHeldRef: { current: new Set() }, ensureSessionRef: { current: null }, chatComposerEnv: () => null,
    startCloudSubmitSpan: () => undefined, cancelGenerationsRef: { current: new Map() },
    capUserAppend: (messages: unknown[], message: unknown) => [...messages, message],
    useWorkspaceStore: { getState: () => mocks.workspace }, announcedDirsRef: { current: new Map() },
    pendingAuthenticationPrompts: () => [], prependSystemInstruction: (_notice: string, text: string) => text,
    turnProducedOutputRef: { current: new Map() }, getLiveChatDraft, recoverCloudAdmissionFailure, pauseQueue,
    newPromptDiagnosticId: () => "diagnostic", promptActivityRef: { current: new Map() },
    PROMPT_INACTIVITY_TIMEOUT_MS: 10_000, PROMPT_ABSOLUTE_TIMEOUT_MS: 10_000,
    awaitComposerMode: () => null, requestLocalPrompt: request,
    countPromptAttachments: () => ({ image: 0, text: 0 }), trackAgentPromptStarted: vi.fn(), trackAgentTurnStarted: vi.fn(),
    trackAgentPromptFinished: vi.fn(), failureFromAgentError: () => failure, classifyRpcError: () => failure,
    statusForFailure: () => "failed", lastUserPrompt: (messages: Array<{ role: string }>) => [...messages].reverse().find(m => m.role === "user"),
    redactLogSecrets: (text: string) => text, persistAuthPrompt: vi.fn(), authPromptsRef: { current: new AuthPromptRecovery() },
    drainNextQueued: vi.fn(), drainOrDropQueue, evictUnretainedTranscripts: vi.fn(),
  };
  vm.runInNewContext(code, context);
  const send = () => (context.send as (...args: unknown[]) => Promise<void>)("chat", draft.text, draft.text, undefined, undefined, undefined, undefined,
    () => setLiveChatDraft("chat", null));
  return { request, pauseQueue, drainOrDropQueue, sending, draft, queue, readiness, send,
    retry: () => {
      const next = queue.get("chat")![0]; queue.delete("chat");
      (context.flushBubbleRef as { current: Map<string, string> }).current.set("chat", next.bubbleId);
      (context.cloudFlushRef as { current: Map<string, unknown> }).current.set("chat", next);
      return send();
    },
  };
}

describe("production send callback on runtime rejection", () => {
  it.each(["cloud_workspace_not_ready", "CLOUD_WORKSPACE_CHECKPOINTING"])("returns accepted %s to its stable editable queue without an error or replay", async cause => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", cause, undefined, true);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce(); expect(h.readiness).toHaveBeenCalledOnce();
    expect(h.queue.get("chat")![0]).toMatchObject({ bubbleId: "accepted-prompt", waitStartedAt: 42, prepared: false });
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ failure: null, error: null, cloudSendWait: { state: "waiting" },
      messages: [expect.objectContaining({ id: "accepted-prompt", queued: true, queuedEditable: true })] });
    expect(getLiveChatDraft("chat")).toBeNull(); expect(mocks.refresh).not.toHaveBeenCalled();
    await h.retry();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls[1]![0]).toMatchObject({ userMessageId: "accepted-prompt" });
    expect(h.queue.get("chat")![0]).toMatchObject({ bubbleId: "accepted-prompt", waitStartedAt: 42 });
    expect(useSessionsStore.getState().sessions.chat.messages).toHaveLength(1);
  });
  it.each(["cloud_runtime_upgrade_required", "cloud_agent_model_not_authorized", "cloud_agent_credential_expired"])("keeps accepted %s editable with AG's terminal inline reason", async cause => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", cause, undefined, true);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce(); expect(h.readiness).not.toHaveBeenCalled();
    expect(h.queue.get("chat")![0].bubbleId).toBe("accepted-prompt"); expect(h.pauseQueue).toHaveBeenCalledWith("chat");
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ failure: null, error: null,
      cloudSendWait: { state: "failed", message: expect.any(String) }, cloudAdmissionFailure: { code: cause } });
    expect(getLiveChatDraft("chat")).toBeNull(); expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("renews a terminal refused delivery only on explicit retry, avoiding its durable denial receipt", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "cloud_agent_model_not_authorized", undefined, true);
    await h.send(); expect(h.request).toHaveBeenCalledOnce(); expect(h.readiness).not.toHaveBeenCalled();
    await h.retry();
    const first = h.request.mock.calls[0]![0] as { userMessageId: string };
    const second = h.request.mock.calls[1]![0] as { userMessageId: string };
    expect(first.userMessageId).toBe("accepted-prompt"); expect(second.userMessageId).not.toBe(first.userMessageId);
    expect(useSessionsStore.getState().sessions.chat.messages).toHaveLength(1);
    expect(h.queue.get("chat")![0].bubbleId).toBe(second.userMessageId);
  });
  it.each(["cloud_runtime_upgrade_required", "cloud_agent_model_not_authorized", "cloud_agent_credential_expired", "cloud_agent_credential_revoked", "cloud_agent_credential_refresh_required"])("restores %s once with no resend or local auth failure", async code => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", code);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.pauseQueue).toHaveBeenCalledWith("chat");
    expect(getLiveChatDraft("chat")).toBe(h.draft);
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ status: "ready", failure: null, error: null, messages: [] });
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure).toMatchObject({ code, agentId: "codex" });
    expect(h.sending.size).toBe(0);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("labels the submitted model even when the user switches models during admission", async () => {
    mocks.workspace.chats[0].model = "gpt-6.1-sol";
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "cloud_agent_model_not_authorized", () => {
      mocks.workspace.chats[0].model = "gpt-5.5";
    });
    await h.send();
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure).toMatchObject({ model: "gpt-6.1-sol", message: "GPT-6.1 Sol isn't enabled for this workspace" });
  });
  it("never calls an ambiguous dispatch failure a proved admission refusal", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "command_dispatch_rejected");
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(getLiveChatDraft("chat")).toBeNull();
    expect(useSessionsStore.getState().sessions.chat.messages).toHaveLength(1);
    expect(useSessionsStore.getState().sessions.chat.messages[0]).not.toHaveProperty("recoveryFailure");
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure?.message).toContain("Review the conversation");
  });
  it("never requeues an accepted message after an ambiguous dispatch result", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "command_dispatch_rejected", undefined, true);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce(); expect(h.queue.size).toBe(0); expect(h.readiness).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().sessions.chat.messages[0]).toMatchObject({ id: "accepted-prompt" });
    expect(useSessionsStore.getState().sessions.chat.messages[0]).not.toMatchObject({ queued: true });
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure?.message).toContain("Review the conversation");
  });
  it.each(["/personal/local/workspace", "/organization/local/workspace"])("keeps %s on the existing local failure path", async folder => {
    const h = harness(folder);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(useSessionsStore.getState().sessions.chat.status).toBe("failed");
    expect(h.pauseQueue).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(getLiveChatDraft("chat")).toBeNull();
    expect(h.sending.size).toBe(0);
  });
});
