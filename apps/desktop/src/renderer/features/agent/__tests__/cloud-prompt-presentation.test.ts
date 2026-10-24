import { expect, it } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import { cloudPromptView, cloudPromptSessionPatch, projectCloudPromptSession, cloudPromptTurnActivity } from "../cloud-prompt-presentation";
import { emptyPromptJournal, type PromptJournalRecord } from "../cloud-prompt-channel";
import { groupMessagesIntoTurns } from "../turn-grouping";
const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
function journal(): PromptJournalRecord {
  const record = emptyPromptJournal({ backend: "https://api.example.test", accountId: "account", organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" });
  record.entries = ["one", "two"].map((id, order) => ({ order, phase: "saved", state: "queued", updatedAt: 1, payload: {
    chatId: "chat", userMessageId: id, agentId: "codex", prompt: [{ type: "text", text: id }], startedAt: order + 1,
  } })); return record;
}
it("shows instant ordinary bubbles while running even with no bridge or driver, and queues only while the VM is unavailable", () => {
  const slot = { ...BLANK, cwd, agentId: "codex", status: "reconnecting" as const }, record = journal();
  for (const vmState of ["ready", "busy", "provisioning", "waking", "stopped"]) {
    const view = cloudPromptView(record, vmState), patch = cloudPromptSessionPatch(slot, view);
    const visible = projectCloudPromptSession({ ...slot, ...patch });
    expect(visible.messages.map(row => row.kind === "text" && !!row.queued)).toEqual(Array(2).fill(!["ready", "busy"].includes(vmState)));
    expect(visible.status === "streaming").toBe(["ready", "busy"].includes(vmState));
    expect(view.states.one).toBe("queued");
    expect(visible.cloudPromptPending).toBeFalsy();
  }
});
it("keeps future sends out of native reducers and below the active turn's output, without duplicate bubbles", () => {
  const record = journal(); record.entries[0]!.state = "accepted";
  const canonical = [{ id: "one", kind: "text" as const, role: "user" as const, text: "one", createdAt: 1 },
    { id: "answer", kind: "text" as const, role: "agent" as const, text: "ok", createdAt: 3 }];
  const slot = { ...BLANK, cwd, agentId: "codex", messages: canonical, ...cloudPromptSessionPatch({ ...BLANK, cwd }, cloudPromptView(record, "ready")) };
  const view = projectCloudPromptSession(slot), turns = groupMessagesIntoTurns(view.messages);
  expect(turns[0]?.events.map(row => row.id)).toEqual(["answer"]); expect(turns[1]?.userPrompt?.id).toBe("two");
  expect(slot.messages).toBe(canonical); expect(view.messages.map(row => row.id)).toEqual(["one", "answer", "two"]);
  expect(projectCloudPromptSession(slot)).toBe(view);
});
it("keeps an unadmitted failure before a later native turn, using message identities rather than matching text", () => {
  const record = journal(); record.entries[0]!.phase = "refused";
  record.entries[0]!.failure = "This message wasn't accepted. Retry to send it again.";
  record.entries[1]!.state = "completed";
  const slot = { ...BLANK, cwd, messages: [
    { id: "two", kind: "text" as const, role: "user" as const, text: "two", createdAt: 2 },
    { id: "answer", kind: "text" as const, role: "agent" as const, text: "ok", createdAt: 3 },
  ], cloudOutbox: cloudPromptView(record, "ready") };
  expect(projectCloudPromptSession(slot).messages.map(row => row.id)).toEqual(["one", "two", "answer"]);
});
it("does not recreate completed prompt-only history before the native resident window", () => {
  const record = journal(); record.entries[0]!.state = "completed";
  const slot = { ...BLANK, cwd, transcriptState: "resident" as const, messages: [
    { id: "two", kind: "text" as const, role: "user" as const, text: "two", createdAt: 2 },
  ], cloudOutbox: cloudPromptView(record, "ready") };
  expect(projectCloudPromptSession(slot).messages.map(row => row.id)).toEqual(["two"]);
});
it("settles an interrupted receipt after a mid-turn restart and preserves the failed prompt for retry", () => {
  const record = journal(); record.entries[0]!.state = "interrupted"; record.entries.splice(1);
  const slot = { ...BLANK, cwd, agentId: "codex", status: "streaming" as const, foregroundTurnId: "one", activeTurnStartedAt: 1 };
  const view = projectCloudPromptSession({ ...slot, ...cloudPromptSessionPatch(slot, cloudPromptView(record, "ready")) });
  expect(view).toMatchObject({ status: "ready", activeTurnStartedAt: null, cloudPromptPending: false });
  expect(view.messages[0]).toMatchObject({ id: "one", recoveryFailure: { message: "The worker restarted before this turn finished", kind: "transport-closed" } });
});
it("settles idle Stop without an error or duplicate banner and preserves Local Personal and organization-local by identity", () => {
  const record = journal(); record.entries = [];
  const slot = { ...BLANK, cwd, cloudStop: { operationId: "stop", turnId: null, state: "pending" as const } };
  expect(cloudPromptSessionPatch(slot, cloudPromptView(record, "stopped"))).toMatchObject({ cloudStop: undefined, error: null });
  for (const cwd of ["/personal", "/organization-local"]) { const local = { ...BLANK, cwd }; expect(projectCloudPromptSession(local)).toBe(local); }
});
it("puts activity on the running provider turn even when later saved messages form the visual tail", () => {
  const record = journal(); record.entries[0]!.state = "accepted";
  const slot = { ...BLANK, cwd, ...cloudPromptSessionPatch({ ...BLANK, cwd }, cloudPromptView(record, "ready")) };
  const turns = groupMessagesIntoTurns(projectCloudPromptSession(slot).messages);
  expect(cloudPromptTurnActivity(slot, turns, 0)).toMatchObject({ active: true, activityTail: true, durable: true });
  expect(cloudPromptTurnActivity(slot, turns, 1)).toMatchObject({ active: false, activityTail: false, durable: true });
});
it("cannot restart a natively completed turn from a lagging accepted receipt", () => {
  const record = journal(); record.entries[0]!.state = "accepted";
  const view = cloudPromptView(record, "ready");
  const slot = { ...BLANK, cwd, status: "ready" as const, foregroundTurnId: "one", activeTurnStartedAt: null, cloudOutbox: view };
  record.entries.push({ ...record.entries[1]!, order: 2, payload: { ...record.entries[1]!.payload, userMessageId: "three" } });
  const patched = { ...slot, ...cloudPromptSessionPatch(slot, cloudPromptView(record, "ready")) };
  expect(patched.status).toBe("ready"); expect(patched.activeTurnStartedAt).toBeNull();
  const turns = groupMessagesIntoTurns(projectCloudPromptSession(patched).messages);
  expect(cloudPromptTurnActivity(patched, turns, 0).active).toBe(false);
});
it("preserves saved cloud sends when an execution is re-adopted, without transferring them to a Local slot", () => {
  const record = journal(), view = cloudPromptView(record, "ready");
  const state = useSessionsStore.getState();
  state.setSession("rebind", { ...BLANK, cwd, agentId: "codex", cloudOutbox: view });
  state.setSession("rebind", { ...BLANK, cwd, agentId: "codex", executionId: "new-process", sessionId: "new-process" });
  expect(useSessionsStore.getState().sessions.rebind?.cloudOutbox).toBe(view);
  state.setSession("rebind", { ...BLANK, cwd: "/personal", agentId: "codex" });
  expect(useSessionsStore.getState().sessions.rebind?.cloudOutbox).toBeUndefined(); state.removeSession("rebind");
});

it("does not clear a legacy turn or its admission wait when the capability arrives with an empty outbox", () => {
  const record = journal(); record.entries = [];
  const legacy = { ...BLANK, cwd, status: "streaming" as const, foregroundTurnId: "older", activeTurnStartedAt: 1,
    cloudPromptPending: true, queuePaused: true, cloudSendWait: { state: "waiting" as const, phase: "sending" as const, startedAt: 1 } };
  const next = { ...legacy, ...cloudPromptSessionPatch(legacy, cloudPromptView(record, "ready")) };
  expect(next.cloudPromptPending).toBe(true); expect(next.cloudSendWait).toBe(legacy.cloudSendWait); expect(next.queuePaused).toBe(true);
  const stopping = { ...next, cloudStop: { operationId: "stop", state: "pending" as const, turnId: "older" } };
  const settled = { ...stopping, ...cloudPromptSessionPatch(stopping, cloudPromptView(record, "ready")) };
  expect(settled.status).toBe("streaming"); expect(settled.activeTurnStartedAt).toBe(1);
});
