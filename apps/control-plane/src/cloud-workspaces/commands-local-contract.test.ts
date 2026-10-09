import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as local from "./commands.js";
import * as wire from "../../../../packages/protocol/src/cloud-commands.js";

const goal = { agentId: "codex", userMessageId: "turn", model: "qualified-model", permissionMode: "read-only",
  modeRevision: 2, prompt: [{ type: "text", text: "Synthetic prompt" }], operation: { version: 1, kind: "goal", action: "get" } };
const entry = (payload: unknown = goal) => ({ commandId: randomUUID(), position: 1, state: "queued", payload,
  executionId: null, generation: 3, resultCode: null, result: null,
  createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" });

describe("standalone negotiated local command contracts", () => {
  it("keeps grant-free goal payloads separate from legacy admission", () => {
    expect(local.CloudBootCommandPayloadSchema.parse(goal)).toEqual(wire.CloudBootCommandPayloadSchema.parse(goal));
    expect(local.CloudQueuedPromptSchema.safeParse(goal).success).toBe(false);
    expect(local.CloudQueuedPromptSchema.safeParse({ ...goal, agentCredentialGrantId: randomUUID() }).success).toBe(true);
  });
  it.each(["claude", "cursor", "codex"])("retains qualified %s transcript forks", agentId => {
    const payload = { ...goal, agentId, permissionMode: undefined,
      operation: { version: 1, kind: "fork", strategy: "transcript", sourceConversationId: "source" } };
    expect(local.CloudBootCommandPayloadSchema.parse(payload)).toEqual(wire.CloudBootCommandPayloadSchema.parse(payload));
  });
  it("mirrors invalid provider/model/permission/native operation shapes without accepting a legacy grant", () => {
    for (const value of [goal, { ...goal, operation: undefined }, { ...goal, agentId: "claude" },
      { ...goal, agentId: "unknown" }, { ...goal, model: undefined }, { ...goal, model: "" },
      { ...goal, model: "model\nforeign" }, { ...goal, permissionMode: "bypass" },
      { ...goal, agentCredentialGrantId: undefined }, { ...goal, agentCredentialGrantId: randomUUID() },
      { ...goal, privateMaterial: "synthetic" }, { ...goal, operation: { version: 1, kind: "goal", action: "set" } },
      { ...goal, agentId: "cursor", permissionMode: "agent",
        operation: { version: 1, kind: "fork", strategy: "native", sourceConversationId: "source" } }])
      expect(local.CloudBootCommandPayloadSchema.safeParse(value).success).toBe(wire.CloudBootCommandPayloadSchema.safeParse(value).success);
  });
  it("retains strict entry/snapshot privacy, native outcomes and collection bounds", () => {
    const pending = entry(), receipt = { ...entry(null), state: "succeeded", executionId: "execution", result: { version: 1,
      terminal: { conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "codex", status: "completed", stopReason: "end_turn" } } };
    const snapshot = { version: 1, conversationId: "chat", revision: 3, paused: false, pending: [pending], receipts: [receipt] };
    expect(local.CloudBootCommandEntrySchema.parse(pending)).toEqual(wire.CloudBootCommandEntrySchema.parse(pending));
    expect(local.CloudBootCommandSnapshotSchema.parse(snapshot)).toEqual(wire.CloudBootCommandSnapshotSchema.parse(snapshot));
    for (const value of [snapshot, { ...snapshot, pending: Array(33).fill(pending) }, { ...snapshot, receipts: Array(51).fill(receipt) },
      { ...snapshot, pending: [{ ...pending, privateActor: {} }] }, { ...snapshot, receipts: [{ ...receipt, result: { version: 1, private: true } }] },
      { ...snapshot, nativeGoal: { version: 1, conversationId: "chat", revision: 2, goal: null } }, { ...snapshot, private: true }])
      expect(local.CloudBootCommandSnapshotSchema.safeParse(value).success).toBe(wire.CloudBootCommandSnapshotSchema.safeParse(value).success);
  });
});
