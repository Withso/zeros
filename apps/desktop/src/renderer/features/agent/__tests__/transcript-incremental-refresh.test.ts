import { afterEach, describe, expect, it } from "vitest";
import { BLANK, mergeWindowedTail, useSessionsStore } from "../sessions-store";
import { stabilizeTurns } from "../stable-turns";
import { groupMessagesIntoTurns } from "../turn-grouping";
import type { AgentMessage } from "../use-agent-session";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

const rows = (): AgentMessage[] => [
  { id: "prompt-a", kind: "text", role: "user", text: "First prompt", createdAt: 1 },
  { id: "answer-a", kind: "text", role: "agent", text: "First answer", createdAt: 2 },
  { id: "prompt-b", kind: "text", role: "user", text: "Follow-up", createdAt: 3 },
  { id: "answer-b", kind: "text", role: "agent", text: "Partial answer", createdAt: 4 },
];
afterEach(() => useSessionsStore.getState().clearAll());

describe("incremental transcript reconciliation across Local and cloud", () => {
  it("keeps unchanged rows through a real cloud session snapshot refresh", () => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const chat = cloudScopedId(target, "chat");
    const store = useSessionsStore.getState;
    store().clearAll();
    const before = rows();
    store().setSession(chat, { ...BLANK, agentId: "claude", cwd: cloudWorkspaceKey(target), transcriptState: "resident", messages: before });
    const incoming = structuredClone(before);
    incoming[3] = { ...incoming[3], text: "Completed answer" } as AgentMessage;
    store().installCloudSnapshot(chat, { version: 1, conversationId: chat, agentId: "claude", executionId: null,
      session: null, initialize: null, activeTurn: null, permissions: [], questions: [],
      messages: incoming.map(message => ({ msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: message.createdAt })) });
    const updated = store().sessions[chat].messages;
    expect(updated[0]).toBe(before[0]);
    expect(updated[1]).toBe(before[1]);
    expect(updated[3]).toEqual(incoming[3]);
  });

  it("retains unchanged rows and completed turns when one message is updated", () => {
    const before = rows();
    const turns = groupMessagesIntoTurns(before);
    const incoming = structuredClone(before);
    incoming[3] = { ...incoming[3], text: "Completed answer" } as AgentMessage;
    const after = mergeWindowedTail(before, incoming);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toEqual(incoming[3]);
    const updatedTurns = stabilizeTurns(turns, groupMessagesIntoTurns(after));
    expect(updatedTurns[0]).toBe(turns[0]);
    expect(updatedTurns[1]).not.toBe(turns[1]);
  });

  it("reuses an unchanged array after a serialized history read", () => {
    const before = rows();
    expect(mergeWindowedTail(before, structuredClone(before))).toBe(before);
  });

  it("keeps older mounted rows while accepting truncation and distinct same-text messages", () => {
    const before = rows();
    const repeated = { ...before[1], id: "distinct-answer" };
    const after = mergeWindowedTail(before, [structuredClone(before[2]), repeated]);
    expect(after.map(row => row.id)).toEqual(["prompt-a", "answer-a", "prompt-b", "distinct-answer"]);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).not.toBe(before[1]);
  });
});
