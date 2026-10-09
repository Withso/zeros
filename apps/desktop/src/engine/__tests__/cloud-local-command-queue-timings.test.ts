import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudAgentTurnTimingsSchema } from "@zeros/protocol/cloud-events";
import { CloudAgentTurnTimings } from "../cloud-local-command-queue-timings";

const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3, engineInstanceId: randomUUID() };
function fixture(limits?: { total?: number; perConversation?: number; bytes?: number; retentionMs?: number }) {
  let now = 10;
  const timings = new CloudAgentTurnTimings({ scope, mode: "legacy", now: () => now, limits });
  const intent = { commandId: randomUUID(), conversationId: "chat", turnId: randomUUID(), provider: "codex" as const };
  const claim = { ...intent, executionId: randomUUID() };
  return { timings, intent, claim, advance: (value = 1) => { now += value; }, sample: () => timings.sample("chat") };
}

describe("closed engine-owned cloud turn observations", () => {
  it("accepts the actual full boot-owner scope while retaining only closed measurement identity", () => {
    const bootScope = { ...scope, bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
    const timings = new CloudAgentTurnTimings({ scope: bootScope, mode: "boot-owner-v1", bootId: bootScope.bootId, writerEpoch: bootScope.writerEpoch });
    const packet = timings.sample("chat");
    expect(CloudAgentTurnTimingsSchema.parse(packet)).toMatchObject({ ...scope, mode: "boot-owner-v1", bootId: bootScope.bootId, writerEpoch: bootScope.writerEpoch });
    expect(packet).not.toHaveProperty("fundingOwnerUserId"); expect(packet).not.toHaveProperty("fundingOwnerEpoch");
  });
  it("binds early engine receive/accept marks to the exact subsequently claimed execution and engine clock", () => {
    const f = fixture(); f.timings.receive(f.intent); f.advance(); f.timings.mark(f.intent.commandId, "accepted");
    f.advance(); f.timings.bindClaim(f.claim); f.advance(); f.timings.native(f.claim, "native_write");
    const sample = CloudAgentTurnTimingsSchema.parse(f.sample());
    expect(sample).toMatchObject({ version: 1, ...scope, conversationId: "chat", mode: "legacy", bootId: null, writerEpoch: null,
      sampledAtMs: 13, coverage: { truncated: false, retired: false, unknown: false } });
    expect(sample.clockId).toMatch(/^[a-f0-9-]{36}$/);
    expect(sample.records.map(row => [row.stage, row.atMs])).toEqual([["engine_received", 10], ["accepted", 11], ["dispatch_committed", 12], ["native_write", 13]]);
    expect(sample.records.every(row => row.executionId === f.claim.executionId && row.commandId === f.claim.commandId && row.turnId === f.claim.turnId)).toBe(true);
    expect(f.sample().clockId).toBe(sample.clockId);
  });

  it("cannot mint native marks or rebind a recorded command with foreign conversation/turn/execution", () => {
    const f = fixture();
    expect(f.timings.native(f.claim, "native_write")).toBe(false);
    f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    for (const bad of [{ ...f.claim, conversationId: "other" }, { ...f.claim, turnId: "other" },
      { ...f.claim, executionId: "other" }, { ...f.claim, provider: "claude" as const }]) {
      expect(f.timings.bindClaim(bad)).toBe(false);
      expect(f.timings.native(bad, "native_write")).toBe(false);
    }
    expect(f.sample().records.map(row => row.stage)).toEqual(["engine_received", "dispatch_committed"]);
  });

  it("fences an old turn's native callback when a qualified warm execution is assigned to the next command", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    const next = { ...f.intent, commandId: randomUUID(), turnId: randomUUID() };
    f.timings.receive(next); f.timings.bindClaim({ ...next, executionId: f.claim.executionId });
    expect(f.timings.native(f.claim, "native_acceptance_ack")).toBe(false);
    expect(f.timings.native({ ...next, executionId: f.claim.executionId }, "native_acceptance_ack")).toBe(true);
    expect(f.sample().records.filter(row => row.stage === "native_acceptance_ack").map(row => row.commandId)).toEqual([next.commandId]);
  });

  it("retains a valid native first-output-before-ACK race without inventing an acceptance timestamp", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim); f.timings.native(f.claim, "native_write");
    f.advance(); f.timings.mark(f.claim.commandId, "first_delta"); f.advance(); f.timings.native(f.claim, "native_acceptance_ack");
    expect(CloudAgentTurnTimingsSchema.parse(f.sample()).records.filter(row => ["first_delta", "native_acceptance_ack"].includes(row.stage))
      .map(row => [row.stage, row.atMs])).toEqual([["first_delta", 11], ["native_acceptance_ack", 12]]);
  });
  it("retains original output at40 when matched native ACK at200 confirms a buffered frame", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.advance(190); f.timings.native(f.claim, "native_acceptance_ack");
    Reflect.apply(f.timings.mark, f.timings, [f.claim.commandId, "first_delta", { outputKind: "text", receivedAtMs: 40 }]);
    expect(f.sample().records.filter(row => ["first_delta", "native_acceptance_ack"].includes(row.stage))
      .map(row => [row.stage, row.atMs])).toEqual([["native_acceptance_ack", 200], ["first_delta", 40]]);
  });
  it.each([9, 201, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid or foreign original output time %s", receivedAtMs => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim); f.advance(190);
    Reflect.apply(f.timings.mark, f.timings, [f.claim.commandId, "first_delta", { outputKind: "tool", receivedAtMs }]);
    expect(f.sample().records.some(row => row.stage === "first_delta")).toBe(false);
    expect(f.sample().coverage.unknown).toBe(true);
  });

  it("deduplicates retried receive/first-delta observations while retaining each actual closed CP dependency", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.timings.mark(f.claim.commandId, "first_delta"); f.timings.mark(f.claim.commandId, "first_delta");
    f.timings.dependency(f.claim.commandId, "credentials.validate", "cp_request_started");
    f.advance(); f.timings.dependency(f.claim.commandId, "credentials.validate", "cp_request_finished");
    expect(f.sample().records.map(row => row.stage)).toEqual(["engine_received", "dispatch_committed", "first_delta", "cp_request_started", "cp_request_finished"]);
    expect(f.sample().records.at(-1)).toMatchObject({ dependency: "credentials.validate", atMs: 11 });
  });

  it("bounds per-conversation and total records and reports truncated coverage instead of a false zero", () => {
    const f = fixture({ total: 4, perConversation: 3 }); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.timings.native(f.claim, "native_write"); f.timings.mark(f.claim.commandId, "first_delta");
    expect(f.sample()).toMatchObject({ coverage: { truncated: true }, records: expect.any(Array) });
    expect(f.sample().records).toHaveLength(3);
    for (let i = 0; i < 5; i++) f.timings.receive({ ...f.intent, commandId: randomUUID(), conversationId: `other-${i}` });
    expect(f.timings.retainedCount()).toBeLessThanOrEqual(4);
    expect(f.sample().coverage.truncated).toBe(true);
  });

  it("bounds encoded metadata bytes and retention, and flags unavailable old evidence", () => {
    const f = fixture({ bytes: 700, retentionMs: 20 }); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.timings.native(f.claim, "native_write");
    expect(f.timings.retainedBytes()).toBeLessThanOrEqual(700);
    expect(f.sample().coverage.truncated).toBe(true);
    f.advance(21);
    expect(f.sample()).toMatchObject({ records: [], coverage: { truncated: true } });
  });

  it("clears all retained observations on exact engine authority retirement", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim); f.timings.retire();
    expect(f.timings.native(f.claim, "native_write")).toBe(false);
    expect(f.timings.receive(f.intent)).toBe(false);
    expect(f.sample()).toMatchObject({ records: [], coverage: { retired: true, unknown: true } });
  });

  it("keeps the boot and workspace binding immutable after construction", () => {
    const binding = { ...scope };
    const options = { scope: binding, mode: "boot-owner-v1" as const, bootId: randomUUID(), writerEpoch: randomUUID(), now: () => 10 };
    const original = { ...binding, bootId: options.bootId, writerEpoch: options.writerEpoch };
    const timings = new CloudAgentTurnTimings(options);
    binding.workspaceId = randomUUID(); options.bootId = randomUUID(); options.writerEpoch = randomUUID();
    expect(timings.sample("chat")).toMatchObject(original);
  });

  it("refuses a byte budget smaller than the empty encoded record array", () => {
    expect(() => fixture({ bytes: 1 })).toThrow();
    const f = fixture({ bytes: 2 }); f.timings.receive(f.intent);
    expect(f.timings.retainedBytes()).toBe(2);
    expect(f.sample()).toMatchObject({ records: [], coverage: { truncated: true } });
  });

  it("reports a regressed clock as unknown coverage rather than certifying a timing window", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.advance(-1); f.timings.native(f.claim, "native_write");
    expect(f.sample().coverage.unknown).toBe(true);
    expect(f.sample().records.every(row => row.atMs <= f.sample().sampledAtMs)).toBe(true);
  });

  it("rejects arbitrary diagnostic fields/stages and a fabricated native dependency in the shared inspection schema", () => {
    const f = fixture(); f.timings.receive(f.intent); const sample = f.sample();
    expect(CloudAgentTurnTimingsSchema.safeParse({ ...sample, prompt: "synthetic data" }).success).toBe(false);
    const row = sample.records[0]!;
    for (const bad of [{ ...row, stage: "gateway_received" }, { ...row, stage: "native_write", dependency: "credentials.validate" },
      { ...row, atMs: -1 }, { ...row, argv: [] }])
      expect(CloudAgentTurnTimingsSchema.safeParse({ ...sample, records: [bad] }).success).toBe(false);
  });

  it("retains verified text-versus-tool metadata only on the first native output", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.timings.mark(f.claim.commandId, "first_delta", { outputKind: "tool" });
    expect(CloudAgentTurnTimingsSchema.parse(f.sample()).records.at(-1)).toMatchObject({ stage: "first_delta", outputKind: "tool" });
    const row = f.sample().records.at(-1)!;
    expect(CloudAgentTurnTimingsSchema.safeParse({ ...f.sample(), records: [{ ...row, stage: "native_write" }] }).success).toBe(false);
  });

  it("reports unspecified first-output classification as unavailable coverage", () => {
    const f = fixture(); f.timings.receive(f.intent); f.timings.bindClaim(f.claim);
    f.timings.mark(f.claim.commandId, "first_delta");
    expect(f.sample().coverage.unknown).toBe(true);
  });
});
