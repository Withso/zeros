import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as commands from "../cloud-commands";

function fixture() {
  const payload = { agentId: "codex", userMessageId: "turn", prompt: [{ type: "text", text: "Synthetic prompt" }],
    modeRevision: 0, model: "qualified-model", permissionMode: "ask",
    operation: { version: 1, kind: "goal", action: "set", update: { objective: "Synthetic goal", tokenBudget: null } } };
  const mutation = { conversationId: "destination", operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId: randomUUID(), payload } };
  return { payload, mutation };
}

describe("negotiated boot-mode command contracts", () => {
  it("parses a genuine grant-free claim while keeping the actor dispatch pairing", () => {
    const f = fixture(), actor = { userId: randomUUID(), deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner", fingerprint: "a".repeat(64) };
    const claim = { commandId: randomUUID(), claimId: randomUUID(), conversationId: "destination",
      executionId: "native-execution", payload: f.payload, dispatchAllowed: true, actor };
    expect(commands.CloudBootCommandClaimSchema.parse(claim)).toEqual(claim);
    expect(commands.CloudCommandClaimSchema.safeParse(claim).success).toBe(false);
    const { actor: _actor, ...missingActor } = claim;
    for (const changed of [missingActor, { ...claim, dispatchAllowed: false },
      { ...claim, payload: { ...f.payload, agentCredentialGrantId: randomUUID() } }])
      expect(commands.CloudBootCommandClaimSchema.safeParse(changed).success).toBe(false);
    const legacy = { ...claim, payload: { ...f.payload, agentCredentialGrantId: randomUUID() } };
    expect(commands.CloudCommandClaimSchema.safeParse(legacy).success).toBe(true);
  });

  it("uses strict boot client and engine-only claim/settle/goal requests without a legacy grant", () => {
    const f = fixture(), commandId = randomUUID(), claimId = randomUUID();
    const requests = [{ kind: "snapshot", conversationId: "destination" }, { kind: "read", commandId },
      { kind: "stop", conversationId: "destination", operationId: randomUUID() },
      { kind: "mutate", mutation: f.mutation, admissionError: null },
      { kind: "claim", conversationId: "destination", executionId: "native-execution", claimId },
      { kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null,
        result: { version: 1, model: "qualified-model" } } },
      { kind: "confirm-goal", commandId, claimId, sequence: 1, goal: null }];
    for (const request of requests) expect(commands.CloudBootCommandEngineRequestSchema.parse(request)).toEqual(request);
    for (const request of [{ ...requests[3], admissionError: "untrusted" }, { ...requests[4], actor: {} },
      { ...requests[5], result: { commandId, claimId, state: "uncertain", resultCode: null } },
      { ...requests[6], sequence: 0 }, { ...requests[4], claimId: "untrusted" },
      { ...requests[3], mutation: { ...f.mutation, action: { ...f.mutation.action,
        payload: { ...f.payload, agentCredentialGrantId: randomUUID() } } } }])
      expect(commands.CloudBootCommandEngineRequestSchema.safeParse(request).success).toBe(false);
    for (const request of requests.slice(4)) expect(commands.CloudBootCommandClientRequestSchema.safeParse(request).success).toBe(false);
  });
  it("admits goal work with an exact provider/model and no fabricated legacy grant", () => {
    const f = fixture();
    expect(commands.CloudBootCommandPayloadSchema.parse(f.payload)).toEqual(f.payload);
    expect(commands.CloudBootCommandMutationSchema.parse(f.mutation)).toEqual(f.mutation);
    expect(commands.CloudBootCommandClientRequestSchema.parse({ kind: "mutate", mutation: f.mutation })).toEqual({ kind: "mutate", mutation: f.mutation });
    expect(commands.CloudQueuedPromptSchema.safeParse(f.payload).success).toBe(false);
    expect(commands.CloudCommandMutationSchema.safeParse(f.mutation).success).toBe(false);
    expect(commands.CloudQueuedPromptSchema.safeParse({ ...f.payload, agentCredentialGrantId: randomUUID() }).success).toBe(true);
  });
  it.each(["claude", "cursor", "codex"])("supports an explicit %s transcript fork without a legacy grant", agentId => {
    const f = fixture(), payload = { ...f.payload, agentId, permissionMode: undefined,
      operation: { version: 1, kind: "fork", strategy: "transcript", sourceConversationId: "source" } };
    const mutation = { ...f.mutation, action: { ...f.mutation.action, kind: "fork", payload } };
    expect(commands.CloudBootCommandMutationSchema.parse(mutation)).toEqual(mutation);
    expect(commands.CloudCommandMutationSchema.safeParse(mutation).success).toBe(false);
  });
  it("keeps native fork restricted to qualified Codex provider identity", () => {
    const f = fixture(), payload = { ...f.payload, operation: { version: 1, kind: "fork", strategy: "native", sourceConversationId: "source" } };
    expect(commands.CloudBootCommandMutationSchema.safeParse({ ...f.mutation, action: { ...f.mutation.action, kind: "fork", payload } }).success).toBe(true);
    for (const agentId of ["claude", "cursor"])
      expect(commands.CloudBootCommandPayloadSchema.safeParse({ ...payload, agentId, permissionMode: undefined }).success).toBe(false);
  });
  it.each(["model", "agentId"])("requires explicit %s even for an ordinary boot prompt", field => {
    const f = fixture(), payload: Record<string, unknown> = { ...f.payload, operation: undefined };
    delete payload[field]; expect(commands.CloudBootCommandPayloadSchema.safeParse(payload).success).toBe(false);
  });
  it("rejects caller-supplied legacy grants and unsupported provider/permission/model choices", () => {
    const f = fixture();
    for (const payload of [{ ...f.payload, agentCredentialGrantId: randomUUID() }, { ...f.payload, agentCredentialGrantId: undefined },
      { ...f.payload, agentId: "unknown" }, { ...f.payload, model: "" }, { ...f.payload, permissionMode: "bypass" },
      { ...f.payload, agentId: "claude" }, { ...f.payload, model: "model\nforeign" }])
      expect(commands.CloudBootCommandPayloadSchema.safeParse(payload).success).toBe(false);
  });
  it("preserves distinct source/destination and explicit fork-action invariants", () => {
    const f = fixture(), payload = { ...f.payload, operation: { version: 1, kind: "fork", strategy: "transcript", sourceConversationId: "source" } };
    expect(commands.CloudBootCommandMutationSchema.safeParse({ ...f.mutation, action: { ...f.mutation.action, payload } }).success).toBe(false);
    expect(commands.CloudBootCommandMutationSchema.safeParse({ ...f.mutation, conversationId: "source", action: { ...f.mutation.action, kind: "fork", payload } }).success).toBe(false);
  });
  it("uses the boot payload in durable entry/snapshot parsing while legacy readers keep refusing it", () => {
    const f = fixture(), entry = { commandId: randomUUID(), position: 1, state: "queued", payload: f.payload,
      executionId: null, generation: 7, resultCode: null, result: null,
      createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" };
    const snapshot = { version: 1, conversationId: "destination", revision: 1, paused: false, pending: [entry], receipts: [] };
    expect(commands.CloudBootCommandEntrySchema.parse(entry)).toEqual(entry);
    expect(commands.CloudBootCommandSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(commands.CloudCommandEntrySchema.safeParse(entry).success).toBe(false);
    expect(commands.CloudCommandSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(commands.CloudBootCommandEntrySchema.safeParse({ ...entry, payload: { ...f.payload, agentCredentialGrantId: randomUUID() } }).success).toBe(false);
  });
});
