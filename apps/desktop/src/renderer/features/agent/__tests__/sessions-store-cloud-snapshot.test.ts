import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLANK, useSessionsStore } from "../sessions-store";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { turnRowCache, turnRowKey } from "@/renderer/state/read-caches";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = cloudScopedId(target, "chat"), route = cloudScopedId(target, "conversation:chat");
beforeEach(() => useSessionsStore.getState().clearAll());
afterEach(() => vi.restoreAllMocks());
function snapshot(active = false) {
  const message = { id: "user", kind: "text", role: "user", text: "test", createdAt: 1 };
  return { version: 1 as const, conversationId: chat, agentId: "codex", executionId: active ? cloudScopedId(target, "native") : null,
    session: null, initialize: null, messages: [{ msgId: "user", kind: "text", payload: JSON.stringify(message), createdAt: 1 }],
    activeTurn: active ? { turnId: "user", startedAt: 10 } : null,
    latestTurn: active ? null : { conversationId: chat, executionId: null, agentId: "codex", turnId: "user", status: "failed" as const,
      stopReason: null, failure: { kind: "auth-required" as const, stage: "prompt" as const, message: "Sign in", agentId: "codex" } },
    permissions: active ? [{ agentId: "codex", permissionId: "new", request: { sessionId: route, executionId: cloudScopedId(target, "native"), toolCall: { toolCallId: "tool", kind: "execute" as const, title: "Shell" }, options: [] } }] : [], questions: [] };
}
describe("atomic cloud snapshot installation", () => {
  it.each([
    ["Personal Local", "/personal/local", "local"],
    ["organization-local", "/organization/local", "local"],
    ["missing cloud session", cloudWorkspaceKey(target), "missing"],
    ["another conversation", cloudWorkspaceKey(target), "conversation"],
    ["another provider", cloudWorkspaceKey(target), "provider"],
  ] as const)("keeps state and turn caches unchanged when rejecting %s", (_label, cwd, reason) => {
    const chatId = reason === "local" ? "local-chat" : chat;
    if (reason !== "missing") useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd, agentId: "codex", sessionId: chatId });
    const before = useSessionsStore.getState();
    const observed = vi.fn();
    const off = useSessionsStore.subscribe(observed);
    const invalidate = vi.spyOn(turnRowCache, "invalidate");
    const conversationId = reason === "conversation" ? cloudScopedId(target, "other-chat") : chatId;
    const agentId = reason === "provider" ? "cursor" : "codex";
    const refused = snapshot();
    try {
      useSessionsStore.getState().installCloudSnapshot(chatId, { ...refused, conversationId, agentId,
        latestTurn: { ...refused.latestTurn!, conversationId, agentId } });
      expect(useSessionsStore.getState()).toBe(before);
      expect(observed).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it("invalidates only the accepted cloud snapshot's exact terminal turn", () => {
    useSessionsStore.getState().setSession(chat, { ...BLANK, cwd: cloudWorkspaceKey(target), agentId: "codex", sessionId: route });
    const invalidate = vi.spyOn(turnRowCache, "invalidate");
    useSessionsStore.getState().installCloudSnapshot(chat, snapshot());
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(turnRowKey(chat, "user"));
  });

  it("clears only the pending local turn proved terminal by this snapshot", () => {
    useSessionsStore.getState().setSession(chat, { ...BLANK, cwd: cloudWorkspaceKey(target), agentId: "codex", sessionId: route, executionId: route, status: "streaming" });
    useSessionsStore.setState({ pendingLocalTurns: { [chat]: "user" } });
    useSessionsStore.getState().installCloudSnapshot(chat, snapshot());
    expect(useSessionsStore.getState().pendingLocalTurns[chat]).toBeUndefined();
    expect(useSessionsStore.getState().sessions[chat].status).toBe("failed");
  });
  it.each(["failed", "cancelled", "max_tokens", "running"] as const)("retains a newer optimistic turn and its clock/stop reason when an older %s snapshot finishes", outcome => {
    useSessionsStore.getState().setSession(chat, { ...BLANK, cwd: cloudWorkspaceKey(target), agentId: "codex", sessionId: route, executionId: route,
      status: "streaming", activeTurnStartedAt: 30, lastStopReason: null, messages: [{ id: "new-user", kind: "text", role: "user", text: "new", createdAt: 30 }] });
    useSessionsStore.setState({ pendingLocalTurns: { [chat]: "new-user" } });
    const older = snapshot(outcome === "running");
    useSessionsStore.getState().installCloudSnapshot(chat, outcome === "cancelled" || outcome === "max_tokens" ? {
      ...older, latestTurn: { conversationId: chat, executionId: null, agentId: "codex", turnId: "user",
        status: outcome === "cancelled" ? "cancelled" : "completed", stopReason: outcome },
    } : older);
    expect(useSessionsStore.getState().sessions[chat]).toMatchObject({ status: "streaming", failure: null,
      activeTurnStartedAt: 30, lastStopReason: null, messages: [{ id: "user" }, { id: "new-user" }] });
    expect(useSessionsStore.getState().pendingLocalTurns[chat]).toBe("new-user");
  });
  it("restores transcript, terminal status and empty controls in one store notification after execution retirement", () => {
    useSessionsStore.getState().setSession(chat, { ...BLANK, cwd: cloudWorkspaceKey(target), agentId: "codex", sessionId: route, executionId: route, status: "streaming",
      pendingPermission: { agentId: "codex", permissionId: "old", request: {} as never } });
    const observed = vi.fn(); const off = useSessionsStore.subscribe(observed);
    try {
      useSessionsStore.getState().installCloudSnapshot(chat, snapshot());
      expect(observed).toHaveBeenCalledOnce();
      expect(useSessionsStore.getState().sessions[chat]).toMatchObject({ status: "failed", failure: { kind: "auth-required" }, error: "Sign in", messages: [{ id: "user" }],
        pendingPermission: null, pendingPermissions: [], pendingQuestions: [], activeTurnStartedAt: null });
    } finally { off(); }
  });
  it("installs an active turn and its exact resolver together and leaves Local unchanged", () => {
    useSessionsStore.getState().setSession(chat, { ...BLANK, cwd: cloudWorkspaceKey(target), agentId: "codex", sessionId: route, executionId: route });
    useSessionsStore.getState().setSession("local", { ...BLANK, cwd: "/organization/local", agentId: "codex", sessionId: "local" });
    const local = useSessionsStore.getState().sessions.local;
    useSessionsStore.getState().installCloudSnapshot(chat, snapshot(true));
    expect(useSessionsStore.getState().sessions[chat]).toMatchObject({ status: "streaming", activeTurnStartedAt: 10, pendingPermission: { permissionId: "new", request: { executionId: cloudScopedId(target, "native") } } });
    useSessionsStore.getState().installCloudSnapshot("local", { ...snapshot(), conversationId: "local" });
    expect(useSessionsStore.getState().sessions.local).toBe(local);
  });
});
