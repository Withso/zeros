import { beforeEach, describe, expect, it } from "vitest";
import { agentActivity, chatWorkingActivity } from "../agent-activity";
import { BLANK, useSessionsStore } from "../sessions-store";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import type { SessionNotification } from "../../../platform/bridge/agent-events";
import type { AgentSessionState } from "../use-agent-session";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const placements = [
  { owner: "Personal Local", cwd: "/personal/project", chat: "personal-chat", route: "personal-execution" },
  { owner: "organization-local", cwd: "/organization/project", chat: "organization-chat", route: "organization-execution" },
  { owner: "cloud", cwd: cloudWorkspaceKey(target), chat: cloudScopedId(target, "chat"), route: cloudScopedId(target, "conversation:chat") },
];
const cases = placements.flatMap(placement => ["claude", "codex", "cursor"].map(agentId => ({ ...placement, agentId })));
const store = () => useSessionsStore.getState();
beforeEach(() => store().clearAll());
function open(input: typeof cases[number]) {
  store().setSession(input.chat, { ...BLANK, agentId: input.agentId, cwd: input.cwd, sessionId: input.route, status: "ready",
    messages: [{ id: "current", kind: "text", role: "user", text: "Keep working", createdAt: 2_000 },
      { id: "output", kind: "text", role: "agent", text: "I am checking the next file", createdAt: 2_100 }] });
}
function turn(input: typeof cases[number], turnId: string, state: "running" | "completed" | "failed" | "cancelled", startedAt = 2_000) {
  store().applyBridgeUpdate({ chatId: input.chat, sessionId: input.route, update: {
    sessionUpdate: "turn_state", turnId, state, startedAt,
    ...(state === "running" ? {} : { stopReason: state === "cancelled" ? "cancelled" : "end_turn" }),
  } } as SessionNotification);
}

describe("the whole foreground turn owns its working indication", () => {
  it.each(cases)("keeps $owner / $agentId working through a transport reconnect after output", input => {
    open(input);
    turn(input, "current", "running");
    for (const status of ["reconnecting", "warming"] as const) {
      store().patchSession(input.chat, { status });
      const slot = store().sessions[input.chat];
      expect(agentActivity(slot)).toBe("running");
      expect(chatWorkingActivity(slot)).toBe("running");
      expect(slot.activeTurnStartedAt).toBe(2_000);
    }
  });

  it.each(cases.flatMap(input => ["completed", "failed", "cancelled"].map(state => ({ ...input, state: state as "completed" | "failed" | "cancelled" }))))(
    "ignores an older $state receipt while $owner / $agentId has a current adopted turn", input => {
      open(input);
      turn(input, "older", "running", 1_000);
      turn(input, "older", "completed", 1_000);
      turn(input, "current", "running");
      // No local prompt/RPC owns an adopted turn after renderer reopen.
      expect(store().pendingLocalTurns[input.chat]).toBeUndefined();
      const current = store().sessions[input.chat];
      turn(input, "older", input.state, 1_000);
      expect(store().sessions[input.chat]).toBe(current);
      expect(chatWorkingActivity(store().sessions[input.chat])).toBe("running");
      turn(input, "current", input.state);
      expect(store().sessions[input.chat]).toMatchObject({ status: "ready", activeTurnStartedAt: null });
      expect(chatWorkingActivity(store().sessions[input.chat])).toBeNull();
    },
  );

  it.each(cases.filter(input => input.owner === "cloud"))("keeps a snapshot-adopted $agentId turn running when an older terminal event arrives", input => {
    open(input);
    store().installCloudSnapshot(input.chat, { version: 1, conversationId: input.chat, agentId: input.agentId,
      executionId: cloudScopedId(target, "native"), session: null, initialize: null,
      messages: store().sessions[input.chat].messages.map(message => ({ msgId: message.id, kind: message.kind,
        payload: JSON.stringify(message), createdAt: message.createdAt })),
      activeTurn: { turnId: "current", startedAt: 2_000 }, latestTurn: null, permissions: [], questions: [],
    });
    const current = store().sessions[input.chat];
    turn(input, "older", "completed", 1_000);
    expect(store().sessions[input.chat]).toBe(current);
    expect(chatWorkingActivity(store().sessions[input.chat])).toBe("running");
    turn(input, "current", "completed");
    expect(chatWorkingActivity(store().sessions[input.chat])).toBeNull();
  });

  it.each(cases)("does not resurrect $owner / $agentId's stopped or cold turn on reopen", input => {
    open(input);
    turn(input, "current", "running");
    turn(input, "current", "cancelled");
    store().patchSession(input.chat, { status: "warming" });
    expect(chatWorkingActivity(store().sessions[input.chat])).toBeNull();
    store().setSession(input.chat, { ...BLANK, agentId: input.agentId, cwd: input.cwd, status: "warming" });
    expect(chatWorkingActivity(store().sessions[input.chat])).toBeNull();
  });

  it.each(cases)("keeps $owner / $agentId's settled successor authoritative over old receipts", input => {
    open(input);
    turn(input, "older", "running", 1_000);
    turn(input, "older", "completed", 1_000);
    turn(input, "current", "running");
    turn(input, "current", "cancelled");
    const settled = store().sessions[input.chat];
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      turn(input, "older", outcome, 1_000);
      expect(store().sessions[input.chat]).toBe(settled);
    }
    expect(settled).toMatchObject({ foregroundTurnId: "current", activeTurnStartedAt: null, lastStopReason: "cancelled" });
    expect(chatWorkingActivity(settled)).toBeNull();
  });

  it.each(placements)("retires exact turn identity with $owner's dead execution", input => {
    const current = { ...input, agentId: "claude" };
    open(current); turn(current, "current", "running");
    store().applyBridgeAgentExit("claude");
    expect(store().sessions[input.chat]).toMatchObject({ executionId: null, sessionId: null, foregroundTurnId: null });
  });

  it.each(placements)("starts a successor clock independently of $owner's prior adopted turn", input => {
    const current = { ...input, agentId: "codex" };
    open(current); turn(current, "older", "running", 1_000); turn(current, "current", "running", 2_000);
    expect(store().sessions[input.chat]).toMatchObject({ foregroundTurnId: "current", activeTurnStartedAt: 2_000 });
    store().evictTranscript(input.chat);
    const cold = store().sessions[input.chat];
    turn(current, "older", "completed", 1_000);
    expect(store().sessions[input.chat]).toBe(cold);
    expect(chatWorkingActivity(cold)).toBe("running");
  });

  it.each(["codex", "cursor"])("does not mistake %s's background task for foreground work", agentId => {
    const slot: AgentSessionState = { ...BLANK, agentId, status: "ready", activeTurnStartedAt: 2_000,
      backgroundTasks: [{ taskId: "dev-server", name: "Server", startedAt: 1_000, updatedAt: 2_000 }] };
    expect(chatWorkingActivity(slot)).toBeNull();
  });
});
