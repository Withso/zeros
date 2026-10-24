import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/shared/ui/primitives/tooltip";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { ActionsCtx } from "../sessions-context";
import { BLANK, useSessionsStore } from "../sessions-store";
import { TranscriptTurn, type TranscriptTurnShared } from "../transcript-turn";
import { cloudPromptTurnActivity, projectCloudPromptSession } from "../cloud-prompt-presentation";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { tailTurnInFlight } from "../tail-indicators";
import { agentActivity } from "../agent-activity";

vi.mock("dompurify", () => ({ default: { addHook: vi.fn(), sanitize: (value: string) => value } }));

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chatId = cloudScopedId(target, "chat"), cwd = cloudWorkspaceKey(target), route = cloudScopedId(target, "conversation:chat");
const store = useSessionsStore.getState;
const shared: TranscriptTurnShared = {
  chatId, folder: cwd, agentDisplayName: "Codex", signInAgentId: null, surfaceActive: true, deferContent: false,
  scrollRoot: null, readOnly: false, transcriptReadOnly: false, interactive: true, hasChatThread: true, designRole: false,
  setEditingMessageId: vi.fn(), setActivePromptEl: vi.fn(),
  ctx: { isStreaming: false, activeTurnStartedAt: 10_000, lastMessageId: null, editBaselines: new Map(), pendingPermission: null,
    pendingQuestionToolCallIds: new Set(), respondToQuestion: vi.fn(), respondToPermission: vi.fn(),
    retrySafetyReview: async () => {}, recordPolicy: vi.fn(), chatId, setMode: null, subagentChildren: new Map(), editAndResubmit: vi.fn() },
  actions: { editAndResubmit: vi.fn(), retryTurn: async () => {}, warmRetryTranscript: vi.fn(), continueTurn: vi.fn(),
    forkToNewTab: vi.fn(), warmForkToNewTab: vi.fn(), signIn: vi.fn() },
};
function render(index = 0) {
  const state = store(), slot = projectCloudPromptSession(state.sessions[chatId]!);
  const turns = groupMessagesIntoTurns(slot.messages), turn = turns[index]!;
  const activity = cloudPromptTurnActivity(slot, turns, index);
  const pending = state.pendingLocalTurns[chatId] === turn.userPrompt?.id;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ActionsCtx.Provider, { value: {} as never },
    createElement(TranscriptTurn, {
      turn, shared, isVisualTail: index === turns.length - 1, isActiveProviderSegment: activity.active,
      isActivityTail: activity.activityTail, durablePrompt: activity.durable, receiptState: activity.state,
      ...activity, ownsProviderFooter: true, turnIsPendingLocal: pending,
      turnInFlight: tailTurnInFlight({ sessionStreaming: agentActivity(slot, state.pendingLocalTurns[chatId]) === "running" && activity.active,
        pendingLocalTurn: pending, hasEvents: turn.events.length > 0 }),
      recovered: false, initialContent: true, editing: false,
      tail: activity.current ? { failure: slot.failure, failureKind: slot.failure?.kind, sessionStreaming: slot.status === "streaming",
        lastStopReason: slot.lastStopReason, activeTurnStartedAt: slot.activeTurnStartedAt, backgroundContinuationActive: false,
        backgroundStartedAt: null, backgroundTasks: [], workflow: null } : null,
    }))));
}
function terminal(turnId = "one", state: "completed" | "cancelled" | "failed" = "completed") {
  store().applyBridgeUpdate({ sessionId: route, update: { sessionUpdate: "turn_state", turnId, state, startedAt: 10_000,
    stopReason: state === "cancelled" ? "cancelled" : "end_turn" } });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(30_000);
  store().clearAll();
  const user = { id: "one", kind: "text" as const, role: "user" as const, text: "Do the task", createdAt: 10_000 };
  store().setSession(chatId, { ...BLANK, cwd, agentId: "codex", sessionId: route, status: "streaming", transcriptState: "resident",
    foregroundTurnId: "one", activeTurnStartedAt: 10_000, messages: [user],
    cloudOutbox: { rows: [user], states: { one: "accepted" }, activeId: "one", waiting: false, pendingCount: 1 } });
});
afterEach(() => { store().clearAll(); vi.useRealTimers(); });

it("mounts the exact native terminal footer while the receipt remains accepted and freezes its duration", () => {
  expect(render()).toContain('aria-label="Agent working"');
  expect(render()).not.toContain('aria-label="Copy output"');
  terminal();
  const settled = render();
  expect(store().sessions[chatId]?.cloudOutbox?.states.one).toBe("accepted");
  expect(settled).toContain('aria-label="Copy output"');
  expect(settled).toContain('aria-label="Turn usage, 20s"');
  expect(settled).not.toContain('aria-label="Agent working"');
  vi.setSystemTime(90_000);
  store().patchSession(chatId, { messages: [...store().sessions[chatId]!.messages,
    { id: "late", kind: "text", role: "agent", phase: "final_answer", text: "A delayed final chunk", createdAt: 90_000 }] });
  expect(render()).toContain('aria-label="Turn usage, 20s"');
});

it("does not settle from final text or another turn's native terminal", () => {
  store().patchSession(chatId, { messages: [...store().sessions[chatId]!.messages,
    { id: "answer", kind: "text", role: "agent", phase: "final_answer", text: "Final text", createdAt: 29_000 }] });
  terminal("older");
  expect(render()).toContain('aria-label="Agent working"');
  expect(render()).not.toContain('aria-label="Copy output"');
});

it("keeps a settled footer when later saved bubbles follow it", () => {
  terminal();
  const outbox = store().sessions[chatId]!.cloudOutbox!;
  store().patchSession(chatId, { cloudOutbox: { ...outbox, pendingCount: 2, states: { ...outbox.states, two: "queued" },
    rows: [...outbox.rows, { id: "two", kind: "text", role: "user", text: "Next task", createdAt: 30_000 }] } });
  expect(render()).toContain('aria-label="Turn usage, 20s"');
  expect(render(1)).not.toContain('aria-label="Copy output"');
});

it("renders Stop and its frozen footer before any asynchronous work, then lets native completion win", () => {
  store().presentCloudStop(chatId);
  expect(render()).toContain("STOPPED BY USER");
  expect(render()).toContain('aria-label="Turn usage, 20s"');
  expect(render()).not.toContain('aria-label="Agent working"');
  vi.setSystemTime(35_000); terminal();
  expect(render()).not.toContain("STOPPED BY USER");
  expect(render()).toContain('aria-label="Turn usage, 20s"');
  expect(render()).not.toContain('aria-label="Agent working"');
});

it("preserves a true provider failure instead of the optimistic stopped pill", () => {
  store().presentCloudStop(chatId);
  store().patchSession(chatId, { failure: { kind: "protocol-error", stage: "prompt", message: "The provider failed." } });
  terminal("one", "failed");
  const html = render();
  expect(html).toContain("The provider failed.");
  expect(html).not.toContain("STOPPED BY USER");
  expect(html).toContain('aria-label="Turn usage, 20s"');
});

it.each([false, true])("immediately promotes a stopped undispatched head out of the unavailable-VM queue (prior turn: %s)", prior => {
  const slot = store().sessions[chatId]!, user = slot.cloudOutbox!.rows[0]!;
  store().setSession(chatId, { ...BLANK, cwd, agentId: "codex", transcriptState: "resident",
    ...(prior ? { foregroundTurnId: "older", cloudTurnPresentations: { older: { startedAt: 1, endedAt: 2, source: "native" as const, status: "completed" as const } } } : {}), cloudOutbox: {
    rows: [{ ...user, queued: true, queuedDelivery: "sending" }], states: { one: "inboxed" }, waiting: true, pendingCount: 1,
  } });
  store().presentCloudStop(chatId);
  const projected = projectCloudPromptSession(store().sessions[chatId]!);
  expect(projected.messages[0]).toMatchObject({ id: "one", queued: false });
  expect(render()).toContain("STOPPED BY USER");
  expect(render()).not.toContain('aria-label="Agent working"');
  const operation = store().sessions[chatId]!.cloudStop;
  store().patchSession(chatId, { error: null });
  expect(store().sessions[chatId]?.cloudStop).toBe(operation);
});

it("records the stopped turn's native completion without consuming a newer pending owner", () => {
  store().presentCloudStop(chatId);
  store().setPendingLocalTurn(chatId, "two");
  terminal();
  expect(store().sessions[chatId]?.cloudTurnPresentations?.one?.status).toBe("completed");
  expect(store().pendingLocalTurns[chatId]).toBe("two");
  expect(render()).not.toContain("STOPPED BY USER");
});
