import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey, isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import * as wire from "../../../platform/bridge/cloud-runtime-wire";

// Run the production callbacks with transport/telemetry replaced. In particular,
// do not manufacture a reply shape that the composer never actually sends.
const source = ts.createSourceFile("provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: Record<string, string> = {};
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "admissionMetadata" && node.initializer)
    callbacks.admissionMetadata = node.initializer.getText(source);
  if (ts.isVariableDeclaration(node) && ["respondToPermission", "respondToQuestion"].includes(node.name.getText(source)) && node.initializer && ts.isCallExpression(node.initializer))
    callbacks[node.name.getText(source)] = node.initializer.arguments[0].getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chatId = cloudScopedId(target, "chat"), executionId = cloudScopedId(target, "native-execution");
function harness(cloud = true) {
  const request = { sessionId: cloud ? cloudScopedId(target, "conversation:chat") : "local-session", executionId: cloud ? executionId : undefined,
    nativeRequestId: "native-question", blocking: true, expiresAt: Date.now() + 90_000, questions: [], options: [{ optionId: "approve-plan", kind: "allow_once" }] };
  const slot = { cwd: cloud ? cloudWorkspaceKey(target) : "/local/organization/repo", agentId: "claude", sessionId: request.sessionId,
    status: "streaming", messages: [], pendingPermission: { permissionId: "permission", request }, pendingQuestions: [{ questionId: "question", request }] };
  const send = vi.fn(), cancel = vi.fn(async () => {}), prompt = vi.fn(async () => {});
  const store = { sessions: { [chatId]: slot }, patchSession: (_id: string, patch: object) => Object.assign(slot, patch), settlePendingPermission: vi.fn(), stampQuestionAnswer: vi.fn() };
  const context: Record<string, unknown> = { ...wire, isCloudWorkspace, bridge: { send }, getStore: () => store, crypto: { randomUUID: () => "reply-operation" },
    Date, setTimeout, clearTimeout, ANSWER_ACK_TIMEOUT_MS: 10_000, answerAcksRef: { current: new Map() }, retriedAnswersRef: { current: new Set() },
    promptActivityRef: { current: new Map() }, trackAgentPermissionDecided: vi.fn(), trackAgentQuestionAnswered: vi.fn(), externalUrlsForQuestionResponse: () => [],
    toast: { warning: vi.fn() }, cancel, sendPromptRef: { current: prompt }, questionFallbackPrompt: () => "answer", buildQuestionStamp: () => ({}) };
  for (const [name, callback] of Object.entries(callbacks)) vm.runInNewContext(ts.transpileModule(`globalThis.${name} = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { slot, send, cancel, prompt, permission: context.respondToPermission as (id: string, answer: unknown) => void,
    question: context.respondToQuestion as (id: string, answer: unknown) => void };
}
afterEach(() => vi.useRealTimers());
describe("production cloud decision replies", () => {
  it("discards only the restoring conversation's buffered controls before atomic snapshot publication", () => {
    const own = cloudScopedId(target, "conversation:chat"), other = cloudScopedId(target, "conversation:other");
    const buffers = { updateBuffer: [{ sessionId: own }, { sessionId: other }], permBuffer: [{ request: { sessionId: own } }, { request: { sessionId: other } }],
      questionBuffer: [{ request: { sessionId: own } }, { request: { sessionId: other } }],
      permissionSettledBuffer: [{ permissionId: "old", sessionId: own }, { permissionId: "other", sessionId: other }],
      questionSettledBuffer: [{ questionId: "old", chatId }, { questionId: "other", chatId: "other" }] };
    const install = vi.fn(() => {
      expect(buffers.permissionSettledBuffer).toEqual([{ permissionId: "other", sessionId: other }]);
      expect(buffers.questionSettledBuffer).toEqual([{ questionId: "other", chatId: "other" }]);
    });
    const context: Record<string, unknown> = { ...buffers, cloudSessionMetadata: () => null,
      useSessionsStore: { getState: () => ({ sessions: {}, executionToChatId: {}, installCloudSnapshot: install }) } };
    vm.runInNewContext(ts.transpileModule(`globalThis.install = ${callbacks.admissionMetadata}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    (context.install as (frame: unknown) => void)({ type: "AGENT_SESSION_CREATED", session: { sessionId: own },
      cloudSnapshot: { version: 1, conversationId: chatId, executionId: null, agentId: "claude", messages: [], initialize: null, activeTurn: null, permissions: [], questions: [] } });
    expect(install).toHaveBeenCalledOnce();
    expect(buffers.updateBuffer).toEqual([{ sessionId: other }]);
    expect(buffers.permBuffer).toEqual([{ request: { sessionId: other } }]);
    expect(buffers.questionBuffer).toEqual([{ request: { sessionId: other } }]);
  });
  it("sends plan/permission decisions to the owning chat and exact native execution", () => {
    const f = harness(); f.permission(chatId, { outcome: { outcome: "selected", optionId: "approve-plan" } });
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "AGENT_PERMISSION_RESPONSE", chatId, executionId }));
  });
  it("keeps Local replies unchanged", () => {
    const f = harness(false), response = { outcome: { outcome: "cancelled" } }; f.permission(chatId, response);
    expect(f.send).toHaveBeenCalledWith({ type: "AGENT_PERMISSION_RESPONSE", permissionId: "permission", response });
  });
  it("retries the same owned cloud question operation without cancelling or submitting another prompt", async () => {
    vi.useFakeTimers(); const f = harness(); f.question(chatId, { outcome: { outcome: "dismissed" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [reply] of f.send.mock.calls) expect(reply).toMatchObject({ type: "AGENT_QUESTION_RESPONSE", chatId, executionId, id: "reply-operation", nativeRequestId: "native-question" });
    expect(f.cancel).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled();
  });
  it("does not retry a cloud question after the view switches execution", async () => {
    vi.useFakeTimers(); const f = harness(); f.question(chatId, { outcome: { outcome: "dismissed" } });
    f.slot.sessionId = "new-view-execution"; await vi.advanceTimersByTimeAsync(30_000);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled();
  });
});
