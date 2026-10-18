import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLANK, canBatchLocalTranscriptUpdate, useSessionsStore } from "../sessions-store";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import type { SessionNotification } from "../../../platform/bridge/agent-events";

// The actual notification flush, including the effects after the reducer.
// Rejecting an old event in the store alone must not release a successor's
// queue, clear its review or attribute that successor's telemetry to the past.
const source = readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("provider.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function collect(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "startTransition" &&
      node.arguments[0]?.getText(ast).includes("s.applyBridgeUpdate(n)")) callback = node.arguments[0].getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
if (!callback) throw new Error("Production update flush was not found");
const code = ts.transpileModule(`(${callback})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const placements = [
  { owner: "Personal Local", cwd: "/personal/project", chat: "personal-chat", route: "personal-execution" },
  { owner: "organization-local", cwd: "/organization/project", chat: "organization-chat", route: "organization-execution" },
  { owner: "cloud", cwd: cloudWorkspaceKey(target), chat: cloudScopedId(target, "chat"), route: cloudScopedId(target, "conversation:chat") },
];
const cases = placements.flatMap(placement => ["claude", "codex", "cursor"].map(agentId => ({ ...placement, agentId })));
beforeEach(() => useSessionsStore.getState().clearAll());

function event(input: typeof cases[number], turnId: string, state: "running" | "completed"): SessionNotification & { chatId: string } {
  return { chatId: input.chat, sessionId: input.route, update: { sessionUpdate: "turn_state", turnId, state,
    startedAt: turnId === "older" ? 1_000 : turnId === "current" ? 2_000 : 3_000,
    ...(state === "completed" ? { stopReason: "end_turn" } : {}) } };
}
function open(input: typeof cases[number], local: boolean) {
  const store = useSessionsStore.getState();
  store.setSession(input.chat, { ...BLANK, agentId: input.agentId, cwd: input.cwd, sessionId: input.route, status: "ready" });
  store.applyBridgeUpdate(event(input, "current", "running"));
  if (local) store.setPendingLocalTurn(input.chat, "current");
  store.applyBridgePermissionRequest(input.agentId, "current-plan", { sessionId: input.route, nativeRequestId: "current-plan",
    toolCall: { toolCallId: "current-plan", title: "ExitPlanMode", kind: "other", status: "pending" }, options: [] });
}
function flush(updates: SessionNotification[]) {
  const release = vi.fn(), finish = vi.fn(), reconcile = vi.fn(async () => {}), takeDirty = vi.fn(() => true);
  vm.runInNewContext(code, { updates, stderrs: [], useSessionsStore, canBatchLocalTranscriptUpdate,
    releaseQueueRef: { current: release }, peekAgentPromptId: () => "current-diagnostic",
    sendingChatsRef: { current: new Set() }, trackAgentPromptFinished: finish,
    takePrebindDirty: takeDirty, prebindDirtySessionsRef: { current: new Map() }, reconcileChatMessagesRef: { current: reconcile } });
  return { release, finish, reconcile, takeDirty };
}

describe("only an accepted terminal event runs terminal effects", () => {
  it.each(cases)("$owner / $agentId applies text before terminal effects in a mixed flush", input => {
    open(input, false);
    const completion = event(input, "current", "completed");
    const text: SessionNotification = { sessionId: input.route, update: {
      sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "Final answer" },
    } };
    const states: Array<{ status: string; text?: string }> = [];
    const unsubscribe = useSessionsStore.subscribe(state => {
      const slot = state.sessions[input.chat];
      const last = slot.messages.at(-1);
      states.push({ status: slot.status, text: last?.kind === "text" ? last.text : undefined });
    });
    const effects = flush([text, completion]);
    unsubscribe();
    expect(states[0]).toEqual({ status: "streaming", text: "Final answer" });
    expect(states.at(-1)).toEqual({ status: "ready", text: "Final answer" });
    expect(effects.release).toHaveBeenCalledExactlyOnceWith(input.chat);
    expect(effects.reconcile).toHaveBeenCalledExactlyOnceWith(input.chat);
    expect(effects.finish).toHaveBeenCalledOnce();
  });

  it.each(cases.flatMap(input => [false, true].map(local => ({ ...input, local })) ))(
    "$owner / $agentId keeps the current review and queue after stale completion (local=$local)", input => {
      open(input, input.local);
      const current = useSessionsStore.getState().sessions[input.chat];
      const stale = flush([event(input, "older", "completed")]);
      expect(useSessionsStore.getState().sessions[input.chat]).toBe(current);
      for (const effect of Object.values(stale)) expect(effect).not.toHaveBeenCalled();
      const accepted = flush([event(input, "current", "completed")]);
      expect(useSessionsStore.getState().sessions[input.chat]).toMatchObject({ status: "ready", pendingPermission: null });
      expect(accepted.release).toHaveBeenCalledExactlyOnceWith(input.chat);
      expect(accepted.reconcile).toHaveBeenCalledExactlyOnceWith(input.chat);
      expect(accepted.finish).toHaveBeenCalledOnce();
    },
  );

  it.each(cases)("$owner / $agentId rechecks the live state between events in one flush", input => {
    open(input, false);
    const effects = flush([event(input, "successor", "running"), event(input, "current", "completed"), event(input, "successor", "completed")]);
    expect(effects.release).toHaveBeenCalledExactlyOnceWith(input.chat);
    expect(effects.finish).toHaveBeenCalledOnce();
    expect(effects.reconcile).toHaveBeenCalledExactlyOnceWith(input.chat);
  });

  it.each(cases)("$owner / $agentId ignores a removed execution even with a stamped chat ID", input => {
    open(input, false);
    useSessionsStore.getState().patchSession(input.chat, { sessionId: "replacement" });
    const current = useSessionsStore.getState().sessions[input.chat];
    const effects = flush([event(input, "current", "completed")]);
    expect(useSessionsStore.getState().sessions[input.chat]).toBe(current);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });
});
