import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { recoverCloudRuntimeUpgrade } from "../cloud-runtime-upgrade";
import { getLiveChatDraft, setLiveChatDraft } from "../composer-live-drafts";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { AuthPromptRecovery } from "../auth-prompt-recovery";
import * as lifecycle from "../session-reload-lifecycle";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), workspace: { chats: [{ id: "chat", additionalDirectories: [] }], chatComposerDrafts: {}, dispatch: vi.fn() } }));
vi.mock("../workspace-agent-registry", () => ({ reportCloudAgentRuntimeUpgrade: mocks.refresh }));
vi.mock("../../../state/store", () => ({ useWorkspaceStore: { getState: () => mocks.workspace } }));
vi.mock("../../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => mocks.workspace } }));
// The production send callback, with only native I/O, telemetry and unrelated
// preparation replaced. This covers its early-return/finally/queue behavior.
const source = readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("provider.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "sendPrompt" && node.initializer && ts.isCallExpression(node.initializer))
    callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(`globalThis.send = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(folder: string) {
  vi.clearAllMocks();
  const draft = { text: "Preserve my prompt", json: { type: "doc" }, attachments: [] };
  setLiveChatDraft("chat", draft);
  useSessionsStore.setState({ sessions: { chat: { ...BLANK, cwd: folder, agentId: "codex", sessionId: "session", status: "ready", messages: [] } } });
  const request = vi.fn(async () => ({ type: "AGENT_PROMPT_FAILED", error: "cloud_runtime_upgrade_required" }));
  const sending = new Set<string>(), pauseQueue = vi.fn(), drainOrDropQueue = vi.fn();
  const failure = { kind: "protocol-error", stage: "prompt", message: "cloud_runtime_upgrade_required" };
  const context: Record<string, unknown> = {
    ...lifecycle, Error, DOMException, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
    bridge: { request }, prepareForSend: () => null, getStore: useSessionsStore.getState,
    flushBubbleRef: { current: new Map() }, getAgentsSnapshot: () => [], isCloudWorkspace,
    resumeQueue: () => false, sendingChatsRef: { current: sending }, sendQueueRef: { current: new Map() },
    queueHeldRef: { current: new Set() }, ensureSessionRef: { current: null }, chatComposerEnv: () => null,
    startCloudSubmitSpan: () => undefined, cancelGenerationsRef: { current: new Map() },
    capUserAppend: (messages: unknown[], message: unknown) => [...messages, message],
    useWorkspaceStore: { getState: () => mocks.workspace }, announcedDirsRef: { current: new Map() },
    pendingAuthenticationPrompts: () => [], prependSystemInstruction: (_notice: string, text: string) => text,
    turnProducedOutputRef: { current: new Map() }, getLiveChatDraft, recoverCloudRuntimeUpgrade, pauseQueue,
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
  return { request, pauseQueue, drainOrDropQueue, sending, draft,
    send: () => (context.send as (...args: unknown[]) => Promise<void>)("chat", draft.text, draft.text, undefined, undefined, undefined, undefined,
      () => setLiveChatDraft("chat", null)),
  };
}

describe("production send callback on runtime rejection", () => {
  it("restores once, does not retry, and exits ready with the follow-up queue paused", async () => {
    const h = harness("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222");
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.pauseQueue).toHaveBeenCalledWith("chat");
    expect(getLiveChatDraft("chat")).toBe(h.draft);
    expect(useSessionsStore.getState().sessions.chat).toMatchObject({ status: "ready", failure: null, error: null, messages: [] });
    expect(h.sending.size).toBe(0);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("keeps the existing local failure path and never applies cloud draft/registry recovery", async () => {
    const h = harness("/local/workspace");
    await h.send();
    expect(h.request).toHaveBeenCalledOnce();
    expect(useSessionsStore.getState().sessions.chat.status).toBe("failed");
    expect(h.pauseQueue).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(getLiveChatDraft("chat")).toBeNull();
    expect(h.sending.size).toBe(0);
  });
});
