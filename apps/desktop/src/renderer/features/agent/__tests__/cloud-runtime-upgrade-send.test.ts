import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { recoverCloudAdmissionFailure } from "../cloud-runtime-upgrade";
import { getLiveChatDraft, setLiveChatDraft } from "../composer-live-drafts";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { AuthPromptRecovery } from "../auth-prompt-recovery";
import * as lifecycle from "../session-reload-lifecycle";
import { SendQueue } from "../send-queue";
import { classifyCloudAdmissionFailure, cloudAdmissionFailureCode } from "../cloud-admission-failure";
import { reportCloudAgentRuntimeUpgrade, invalidateCloudAgentRegistry } from "../workspace-agent-registry";
import { notifyAgentSendFailure } from "../agent-send-failure-toast";
import { turnFailureForCard } from "../turn-failure";
import type { AgentMessage } from "../use-agent-session";
import type { AgentFailure } from "../../../platform/bridge/failure";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), toast: vi.fn(), workspace: { chats: [{ id: "chat", additionalDirectories: [], model: "gpt-6.1-sol" }], chatComposerDrafts: {}, dispatch: vi.fn() } }));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({ toast: { error: mocks.toast } }));
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

function harness(folder: string, cause = "cloud_runtime_upgrade_required", duringRequest?: () => void, queued = false,
  options: { success?: boolean; history?: () => Promise<AgentMessage[]>; failureKind?: AgentFailure["kind"] } = {}) {
  vi.clearAllMocks();
  const draft = { text: "Preserve my prompt", json: { type: "doc" }, attachments: [] };
  setLiveChatDraft("chat", draft);
  useSessionsStore.setState({ sessions: { chat: { ...BLANK, cwd: folder, agentId: "codex", sessionId: "session", status: "ready", messages: [] } } });
  const request = vi.fn(async (_message: unknown) => { duringRequest?.(); return options.success
    ? { type: "AGENT_PROMPT_COMPLETE", sessionId: "session", executionId: "session", stopReason: "end_turn", response: {} }
    : { type: "AGENT_PROMPT_FAILED", error: cause }; });
  const sending = new Set<string>(), pauseQueue = vi.fn(), drainOrDropQueue = vi.fn(), failureNotice = vi.fn(notifyAgentSendFailure);
  const queue = new SendQueue<any>(), readiness = vi.fn(() => useSessionsStore.getState().patchSession("chat", { cloudSendWait: { state: "waiting" } }));
  const entry = { cloud: true, bubbleId: "accepted-prompt", args: ["chat", draft.text, draft.text], waitStartedAt: 42 };
  const failure = { kind: options.failureKind ?? "protocol-error", stage: "prompt", message: cause };
  const finished = vi.fn(), persist = vi.fn(), output = new Map<string, boolean>();
  const history = vi.fn(options.history ?? (async () => useSessionsStore.getState().sessions.chat.messages));
  const context: Record<string, unknown> = {
    ...lifecycle, Error, DOMException, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
    parseCloudWorkspaceKey, hasCloudWorkspaceAccountAccess: () => true,
    bridge: { request }, cloudComputerV2: !isCloudWorkspace(folder) || queued, prepareForSend: () => null, getStore: useSessionsStore.getState,
    // Exercise post-readiness dispatch; cloud FIFO preparation has its own
    // integration suite and hands off the already-claimed stable bubble id.
    flushBubbleRef: { current: new Map(queued ? [["chat", "accepted-prompt"]] : []) },
    cloudFlushRef: { current: new Map(queued ? [["chat", entry]] : []) }, cloudCatalogGeneration: () => 1,
    beginCloudSendWaitRef: { current: readiness }, classifyCloudAdmissionFailure, cloudAdmissionFailureCode,
    reportCloudAgentRuntimeUpgrade, invalidateCloudAgentRegistry, notifyAgentSendFailure: failureNotice,
    getAgentsSnapshot: () => [], isCloudWorkspace,
    resumeQueue: () => false, sendingChatsRef: { current: sending }, sendQueueRef: { current: queue },
    queueHeldRef: { current: new Set() }, ensureSessionRef: { current: null }, chatComposerEnv: () => null,
    startCloudSubmitSpan: () => undefined, cancelGenerationsRef: { current: new Map() },
    capUserAppend: (messages: unknown[], message: unknown) => [...messages, message],
    useWorkspaceStore: { getState: () => mocks.workspace }, announcedDirsRef: { current: new Map() },
    pendingAuthenticationPrompts: () => [], prependSystemInstruction: (_notice: string, text: string) => text,
    turnProducedOutputRef: { current: output }, getLiveChatDraft, recoverCloudAdmissionFailure, pauseQueue,
    newPromptDiagnosticId: () => "diagnostic", promptActivityRef: { current: new Map() },
    PROMPT_INACTIVITY_TIMEOUT_MS: 10_000, PROMPT_ABSOLUTE_TIMEOUT_MS: 10_000,
    awaitComposerMode: () => null, requestLocalPrompt: request,
    countPromptAttachments: () => ({ image: 0, text: 0 }), trackAgentPromptStarted: vi.fn(), trackAgentTurnStarted: vi.fn(),
    trackAgentPromptFinished: finished, trackAgentPromptCompleted: vi.fn(), trackAiGeneration: vi.fn(),
    failureFromAgentError: () => failure, classifyRpcError: () => failure,
    statusForFailure: () => "failed", lastUserPrompt: (messages: Array<{ role: string }>) => [...messages].reverse().find(m => m.role === "user"),
    redactLogSecrets: (text: string) => text, persistAuthPrompt: persist, authPromptsRef: { current: new AuthPromptRecovery() },
    persistWindowMessages: history, HYDRATE_WINDOW: 100, reconcileHistoryMessages: (messages: AgentMessage[]) => messages,
    mergeWindowedTail: (_current: AgentMessage[], messages: AgentMessage[]) => messages,
    drainNextQueued: vi.fn(), drainOrDropQueue, evictUnretainedTranscripts: vi.fn(),
  };
  vm.runInNewContext(code, context);
  const send = () => (context.send as (...args: unknown[]) => Promise<void>)("chat", draft.text, draft.text, undefined, undefined, undefined, undefined,
    () => setLiveChatDraft("chat", null));
  return { request, pauseQueue, drainOrDropQueue, sending, draft, queue, readiness, send, failureNotice, finished, persist, history,
    markOutput: () => output.set("chat", true),
    retry: () => {
      const next = queue.get("chat")![0]; queue.delete("chat");
      (context.flushBubbleRef as { current: Map<string, string> }).current.set("chat", next.bubbleId);
      (context.cloudFlushRef as { current: Map<string, unknown> }).current.set("chat", next);
      return send();
    },
  };
}

describe("production send callback on runtime rejection", () => {
  it("accepts a successful empty native turn when the durable transcript tail is empty", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "", undefined, false,
      { success: true, history: async () => [] });
    await h.send();
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ status: "ready", error: null, failure: null });
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" })); expect(h.request).toHaveBeenCalledOnce();
  });
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
  it.each(["cloud_runtime_upgrade_required", "cloud_agent_model_not_authorized", "cloud_agent_credential_expired"])("keeps accepted %s editable and sends its cause to the shared one-time toast", async cause => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", cause, undefined, true);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce(); expect(h.readiness).not.toHaveBeenCalled();
    expect(h.queue.get("chat")![0].bubbleId).toBe("accepted-prompt"); expect(h.pauseQueue).toHaveBeenCalledWith("chat");
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ failure: null, error: null,
      cloudSendWait: { state: "failed", message: expect.any(String) }, cloudAdmissionFailure: { code: cause } });
    expect(getLiveChatDraft("chat")).toBeNull(); expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "chat", attemptId: "accepted-prompt", error: expect.anything() }));
  });
  it("renews a terminal refused delivery only on explicit retry, avoiding its durable denial receipt", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333", "cloud_agent_model_not_authorized", undefined, true);
    await h.send(); expect(h.request).toHaveBeenCalledOnce(); expect(h.readiness).not.toHaveBeenCalled();
    await h.retry();
    const first = h.request.mock.calls[0]![0] as { userMessageId: string };
    const second = h.request.mock.calls[1]![0] as { userMessageId: string };
    expect(first.userMessageId).toBe("accepted-prompt"); expect(second.userMessageId).not.toBe(first.userMessageId);
    expect(useSessionsStore.getState().sessions.chat.messages).toHaveLength(1);
    expect(h.queue.get("chat")![0].bubbleId).toBe(second.userMessageId);
    expect(h.failureNotice).toHaveBeenCalledTimes(2);
    expect(h.failureNotice.mock.calls.map(([input]) => input.attemptId)).toEqual(["accepted-prompt", "accepted-prompt"]);
    expect(mocks.toast).toHaveBeenCalledOnce();
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
    expect(mocks.toast).toHaveBeenCalledOnce();
    if (code === "cloud_runtime_upgrade_required") {
      expect(mocks.toast).toHaveBeenCalledWith("This workspace is on an older runtime", expect.objectContaining({
        description: "Gets the new cloud runtime the next time this workspace wakes", action: undefined,
      }));
    }
  });
  it("labels the submitted model even when the user switches models during admission", async () => {
    mocks.workspace.chats[0].model = "gpt-6.1-sol";
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "cloud_agent_model_not_authorized", () => {
      mocks.workspace.chats[0].model = "gpt-5.5";
    });
    await h.send();
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure).toMatchObject({ model: "gpt-6.1-sol", message: "GPT-6.1 Sol isn't enabled for this workspace" });
  });
  it.each(["command_dispatch_rejected", "The cloud command outcome is unknown. Review the transcript before retrying."])("never calls ambiguous %s a proved admission refusal", async code => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", code);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(getLiveChatDraft("chat")).toBeNull();
    expect(useSessionsStore.getState().sessions.chat.messages).toHaveLength(1);
    const saved = useSessionsStore.getState().sessions.chat.messages[0];
    expect(saved).toMatchObject({ recoveryFailure: { kind: "protocol-error", message: expect.stringContaining("Review the conversation") } });
    const recoveryFailure = saved.kind === "text" ? saved.recoveryFailure : undefined;
    expect(turnFailureForCard({ turnId: saved.id, events: [], recoveryFailure })).toMatchObject({
      kind: "protocol-error", message: expect.stringContaining("Review the conversation"),
    });
    expect(h.persist).toHaveBeenCalledWith("chat", expect.objectContaining({ id: saved.id, recoveryFailure }));
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", retryCount: 0 }));
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure?.message).toContain("Review the conversation");
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Cloud request couldn't be completed", expect.objectContaining({
      description: "Review the conversation before retrying.",
    }));
  });
  it.each(["cloud_agent_model_not_authorized", "command_dispatch_rejected"])("shares the original queue toast identity across renewed %s deliveries", code => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const h = harness(folder, code);
    for (const id of ["first-delivery", "renewed-delivery"]) {
      const message = { id, kind: "text" as const, role: "user" as const, text: h.draft.text, createdAt: 1 };
      useSessionsStore.getState().patchSession("chat", { messages: [message] });
      expect(recoverCloudAdmissionFailure({ folder, chatId: "chat", error: code, message, draft: h.draft,
        toastAttemptId: `original-queue-entry-${code}`, store: useSessionsStore.getState(), pauseQueue: h.pauseQueue })).toBe(true);
    }
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("never requeues an accepted message after an ambiguous dispatch result", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "command_dispatch_rejected", undefined, true);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce(); expect(h.queue.size).toBe(0); expect(h.readiness).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().sessions.chat.messages[0]).toMatchObject({ id: "accepted-prompt" });
    expect(useSessionsStore.getState().sessions.chat.messages[0]).not.toMatchObject({ queued: true });
    expect(useSessionsStore.getState().sessions.chat.cloudAdmissionFailure?.message).toContain("Review the conversation");
  });
  it("reports a refused ready cloud slot as failed rather than completed", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222");
    await h.send();
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", retryCount: 0 }));
  });
  it("retains partial output and reports uncertain dispatch as interrupted", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "command_dispatch_rejected", () => {
      h.markOutput();
      const slot = useSessionsStore.getState().sessions.chat;
      useSessionsStore.getState().patchSession("chat", { messages: [...slot.messages,
        { kind: "text", role: "agent", id: "partial", text: "Partial answer", createdAt: 2, updatedAt: 2 }] });
    });
    await h.send();
    expect(useSessionsStore.getState().sessions.chat.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "partial", text: "Partial answer" }),
    ]));
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "interrupted", retryCount: 0 }));
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("does not overwrite or persist to a replacement owner after late dispatch failure", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "command_dispatch_rejected", () => {
      useSessionsStore.getState().patchSession("chat", { ...BLANK, cwd: "/organization/replacement", agentId: "claude",
        sessionId: "replacement", status: "ready" });
      useSessionsStore.getState().setPendingLocalTurn("chat", "replacement-turn");
    });
    await h.send();
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ cwd: "/organization/replacement", agentId: "claude",
      status: "ready", failure: null, messages: [] });
    expect(useSessionsStore.getState().pendingLocalTurns.chat).toBe("replacement-turn");
    expect(h.persist).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
  });
  it.each(["timeout", "transport-closed", "session-expired"] as const)("never rebuilds and replays a claimed cloud %s prompt", async failureKind => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "Provider observation failed", undefined, true, { failureKind });
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ status: "failed", failure: { kind: failureKind } });
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", retryCount: 0 }));
  });
  it("holds final completion until the saved cloud transcript has caught up", async () => {
    let finish!: (messages: AgentMessage[]) => void;
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "", undefined, true,
      { success: true, history: () => new Promise(resolve => { finish = resolve; }) });
    const flight = h.send();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    expect(h.finished).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().pendingLocalTurns.chat).toBe("accepted-prompt");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish([...useSessionsStore.getState().sessions.chat.messages,
      { kind: "text", role: "agent", id: "saved-answer", text: "Saved answer", createdAt: 2, updatedAt: 2 }]);
    await flight;
    expect(useSessionsStore.getState().sessions.chat.messages.at(-1)).toMatchObject({ id: "saved-answer", text: "Saved answer" });
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(h.request).toHaveBeenCalledOnce();
  });
  it.each([false, true])("accepts an empty or tool-only native success (tool=%s)", async tool => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "", undefined, true,
      { success: true, history: async () => [...useSessionsStore.getState().sessions.chat.messages,
        ...(tool ? [{ id: "tool", kind: "tool" as const, title: "Read", toolKind: "read", status: "completed" as const, createdAt: 2, updatedAt: 2, toolCallId: "tool" }] : [])] });
    await h.send();
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(useSessionsStore.getState().sessions.chat.failure).toBeNull(); expect(h.request).toHaveBeenCalledOnce();
  });
  it("accepts a proved successful empty turn and retains its optimistic user row", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "Cloud transcript unavailable", undefined, true,
      { success: true, history: async () => [] });
    await h.send();
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed", retryCount: 0 }));
    expect(useSessionsStore.getState().sessions.chat.status).toBe("ready");
    expect(useSessionsStore.getState().sessions.chat.messages[0]).toMatchObject({ id: "accepted-prompt", role: "user" });
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("accepts a saved tool tail when a long successful turn has paged its user row out", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "", undefined, true,
      { success: true, history: async () => [{ id: "tool-tail", kind: "tool", title: "Read", toolKind: "read",
        status: "completed", createdAt: 2, updatedAt: 2, toolCallId: "tool-tail" }] });
    await h.send();
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("discards a late transcript read after the cloud chat changes owner", async () => {
    let finish!: (messages: AgentMessage[]) => void;
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "", undefined, true,
      { success: true, history: () => new Promise(resolve => { finish = resolve; }) });
    const flight = h.send();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    useSessionsStore.getState().patchSession("chat", { ...BLANK, cwd: "/organization/replacement", agentId: "claude",
      sessionId: "replacement", status: "ready", lastStopReason: "cancelled" });
    useSessionsStore.getState().setPendingLocalTurn("chat", "replacement-turn");
    finish([{ id: "old-answer", kind: "text", role: "agent", text: "Old answer", createdAt: 2, updatedAt: 2 }]);
    await flight;
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ cwd: "/organization/replacement", messages: [], failure: null });
    expect(useSessionsStore.getState().pendingLocalTurns.chat).toBe("replacement-turn");
    expect(h.finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", stopReason: undefined }));
    expect(h.persist).not.toHaveBeenCalled();
  });
  it.each(["/personal/local/workspace", "/organization/local/workspace"])("keeps %s on the existing local failure path", async folder => {
    const h = harness(folder);
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(useSessionsStore.getState().sessions.chat.status).toBe("failed");
    expect(h.pauseQueue).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(getLiveChatDraft("chat")).toBeNull();
    expect(h.sending.size).toBe(0);
  });
});
