import { afterEach, describe, expect, it } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CodexAppServerTranslator } from "@/engine/agents/adapters/codex/app-server-translator";
import { CodexThreadNotifications } from "@/engine/agents/adapters/codex/thread-notifications";
import { cloudIncoming, type CloudRuntimeScope } from "../../../platform/bridge/cloud-runtime-wire";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { partitionTurnSequence } from "../turn-partition";

const cloud: CloudRuntimeScope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/srv/zeros/workspace", engineWorkspaceId: "workspace",
};
const owners: { name: string; cwd: string; scope?: CloudRuntimeScope }[] = [
  { name: "Personal local", cwd: "/personal/workspace" },
  { name: "organization-local", cwd: "/organization/workspace" },
  { name: "organization-cloud", cwd: cloudWorkspaceKey(cloud), scope: cloud },
  { name: "another organization-cloud", cwd: cloudWorkspaceKey({ ...cloud, organizationId: "33333333-3333-4333-8333-333333333333" }),
    scope: { ...cloud, organizationId: "33333333-3333-4333-8333-333333333333" } },
];

afterEach(() => useSessionsStore.getState().clearAll());

describe("Codex 0.162 transcript across owners and placements", () => {
  it.each(owners)("retains partial output, child metadata and the turn clock through $name history and switching", (owner) => {
    const sessions = owners.map((entry) => {
      const chatId = entry.scope ? cloudScopedId(entry.scope, "chat") : entry.name;
      const executionId = entry.scope ? cloudScopedId(entry.scope, "run") : `${entry.name}-run`;
      useSessionsStore.getState().setSession(chatId, {
        ...BLANK, cwd: entry.cwd, agentId: "codex", sessionId: executionId, executionId,
        status: "streaming", activeTurnStartedAt: 1000,
      });
      return { ...entry, chatId, executionId };
    });
    const current = sessions.find((entry) => entry.name === owner.name)!;
    const others = sessions.filter((entry) => entry !== current).map((entry) => [entry.chatId, useSessionsStore.getState().sessions[entry.chatId]] as const);
    const slot = () => useSessionsStore.getState().sessions[current.chatId];
    const emit = (notification: SessionNotification) => {
      const wire = { type: "AGENT_SESSION_UPDATE", ...notification };
      const mapped = current.scope ? cloudIncoming(current.scope, wire) : wire;
      useSessionsStore.getState().applyBridgeUpdate(mapped as unknown as SessionNotification);
    };
    const translator = new CodexAppServerTranslator({ sessionId: current.scope ? "run" : current.executionId, emit });
    const router = new CodexThreadNotifications("parent", translator);
    const native = (method: string, item: Record<string, unknown>) => router.handle(method, { threadId: "parent", turnId: "turn", item });
    router.handle("turn/started", { threadId: "parent", turn: { id: "turn" } });
    native("item/completed", { type: "agentMessage", id: "progress", text: "Checking source.", phase: "commentary" });
    native("item/started", { type: "agentMessage", id: "report", text: "" });
    router.handle("item/agentMessage/delta", { threadId: "parent", turnId: "turn", itemId: "report", delta: "First finding." });
    native("item/started", { type: "commandExecution", id: "command", command: "pnpm test", status: "inProgress" });
    // The report's phase arrives after another row. Reclassify only that report.
    native("item/completed", { type: "agentMessage", id: "report", text: "First finding.", phase: "partial_answer" });
    const activity = { type: "subAgentActivity", id: "spawn", agentThreadId: "child", agentPath: "/root/research", kind: "started" };
    native("item/started", activity);
    native("item/completed", { ...activity, model: "gpt-6.1-sol", reasoningEffort: "max" });
    expect(translator.sawTurnTerminal).toBe(false);
    expect(slot()).toMatchObject({ status: "streaming", activeTurnStartedAt: 1000 });
    expect(partitionTurnSequence(slot().messages, { live: true }).map((segment) => segment.kind)).toEqual(["working", "output", "working"]);
    const report = slot().messages.find((message) => message.kind === "text" && message.text === "First finding.")!;
    const group = slot().messages.find((message) => message.kind === "tool" && message.toolKind === "subagent")!;

    const saved = slot().messages.map((message) => ({ msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: message.createdAt }));
    if (current.scope) {
      const mapped = cloudIncoming(current.scope, { cloudSnapshot: {
        version: 1, conversationId: "chat", agentId: "codex", executionId: "run", session: null, initialize: null,
        messages: saved, activeTurn: { turnId: "turn", startedAt: 1000 }, latestTurn: null, permissions: [], questions: [],
      } });
      useSessionsStore.getState().installCloudSnapshot(current.chatId, mapped.cloudSnapshot as Parameters<ReturnType<typeof useSessionsStore.getState>["installCloudSnapshot"]>[1]);
    } else {
      useSessionsStore.getState().setSession(current.chatId, { ...slot(), messages: saved.map((row) => JSON.parse(row.payload)) });
    }
    expect(slot().messages.find((message) => message.id === report.id)).toMatchObject({ phase: "partial_answer", text: "First finding." });
    expect(slot().messages.find((message) => message.id === group.id)).toMatchObject({ rawInput: { model: "gpt-6.1-sol", reasoningEffort: "max" } });
    expect(slot()).toMatchObject({ status: "streaming", activeTurnStartedAt: 1000 });

    native("item/completed", { ...activity, id: "done", kind: "completed" });
    native("item/completed", { type: "commandExecution", id: "command", command: "pnpm test", status: "completed", exitCode: 0, aggregatedOutput: "Tests passed." });
    native("item/completed", { type: "agentMessage", id: "answer", text: "All findings confirmed.", phase: "final_answer" });
    // Neither an answer nor the child's completion ends the parent turn.
    expect(slot()).toMatchObject({ status: "streaming", activeTurnStartedAt: 1000 });
    router.handle("turn/completed", { threadId: "parent", turn: { id: "turn", status: "completed" } });
    expect(translator.sawTurnTerminal).toBe(true);
    emit({ sessionId: current.scope ? "run" : current.executionId, update: { sessionUpdate: "turn_state", turnId: "turn", state: "completed", startedAt: 1000, stopReason: "end_turn" } });
    expect(slot()).toMatchObject({ status: "ready", activeTurnStartedAt: null });
    expect(partitionTurnSequence(slot().messages).map((segment) => segment.kind)).toEqual(["working", "output", "working", "output"]);
    expect(slot().messages.find((message) => message.id === group.id)).toMatchObject({ status: "completed", rawInput: { model: "gpt-6.1-sol", reasoningEffort: "max" } });
    // Returning to any other owner observes its exact unchanged snapshot.
    for (const [chatId, previous] of others) expect(useSessionsStore.getState().sessions[chatId]).toBe(previous);
  });
});
