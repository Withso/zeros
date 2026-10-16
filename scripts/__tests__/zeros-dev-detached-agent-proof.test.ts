import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudAgentBootConversationSchema, CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema, CloudBootCommandSnapshotSchema } from "@zeros/protocol/cloud-commands";
import { validateDetachedAgentProof } from "../zeros-dev/detached-agent-proof";
import { DETACHED_AGENT_INPUT_BYTES, DetachedAgentOfflineCheckSchema, type DetachedAgentProofInput } from "../zeros-dev/detached-agent-proof-contract";
import { InfrastructureSchema } from "../zeros-dev/infrastructure-contract";
import { Gate0Schema } from "../zeros-dev/gate0-contract";

const start = Date.parse("2026-10-15T00:00:00Z");
function fixture(): DetachedAgentProofInput {
  const binding = CloudAgentBootConversationSchema.parse({ version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2, authorityEpoch: 4,
    cacheRevision: 1, desiredCacheRevision: 1, initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  const bootScope = CloudAgentBootScopeSchema.parse(Object.fromEntries(Object.entries(binding).filter(([key]) =>
    !["version", "mode", "fundingScope", "authorityEpoch", "cacheRevision", "desiredCacheRevision", "initialAdoptions"].includes(key))));
  const executionIdentity = { kind: "cloud" as const, organizationId: binding.organizationId, workspaceId: binding.workspaceId,
    generation: binding.generation, engineInstanceId: binding.engineInstanceId, authorityEpoch: binding.authorityEpoch, bootScope };
  const accepted = { conversationId: randomUUID(), commandId: randomUUID(), turnId: randomUUID(), executionId: randomUUID(), agentId: "codex" as const };
  const command = CloudBootCommandEntrySchema.parse({ commandId: accepted.commandId, executionId: accepted.executionId, generation: 3,
    position: 1, state: "dispatching", resultCode: null, createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(),
    payload: { agentId: accepted.agentId, userMessageId: accepted.turnId, prompt: [{ type: "text", text: "synthetic long task" }],
      modeRevision: 0, model: "synthetic-model", permissionMode: "auto-edit" } });
  const terminal = { ...accepted, status: "completed" as const, stopReason: "end_turn" as const,
    startedAt: start, endedAt: start + 1_864_000,
    response: { userMessageId: accepted.turnId, stopReason: "end_turn" as const } };
  const makeRow = (kind: string, values: object, msgId = randomUUID()) => ({ msgId, kind, createdAt: start,
    payload: JSON.stringify({ id: msgId, kind, createdAt: start, ...values }) });
  const messages = [makeRow("text", { role: "user", text: "earlier question" }),
    makeRow("text", { role: "agent", text: "settled earlier answer" }),
    makeRow("tool", { status: "completed", toolCallId: "settled-tool", rawOutput: "settled" }),
    makeRow("text", { role: "user", text: "synthetic long task" }, accepted.turnId),
    makeRow("tool", { status: "in_progress", toolCallId: "active-tool", rawOutput: "working" }),
    makeRow("text", { role: "agent", text: "still working" })];
  const streamId = randomUUID();
  const events = { cursor: { streamId, sequence: 10 }, snapshot: { conversationId: accepted.conversationId, agentId: accepted.agentId,
    executionId: accepted.executionId, messages, activeTurn: { turnId: accepted.turnId, startedAt: start }, latestTurn: null,
    permissions: [], questions: [] } };
  const afterEvents = { cursor: { streamId, sequence: 13 }, snapshot: { ...events.snapshot, activeTurn: null, latestTurn: terminal,
    messages: messages.map((row, index) => index < 4 ? { ...row } : { ...row, payload: JSON.stringify({ ...JSON.parse(row.payload),
      ...(index === 4 ? { status: "completed", rawOutput: "done" } : { text: "finished" }) }) }) } };
  const intent = { runId: randomUUID(), nonce: randomUUID(), programSha256: "a".repeat(64) };
  const rows = Array.from({ length: 32 }, (_, n) => ({ n, ms: n * 60_000, run: intent.runId, nonce: intent.nonce }));
  const frame = { type: "AGENT_PROMPT_COMPLETE", id: randomUUID(), timestamp: start + 1_864_000, source: "engine",
    requestId: accepted.commandId, sessionId: accepted.executionId, executionId: accepted.executionId,
    agentId: accepted.agentId, stopReason: "end_turn", response: { userMessageId: accepted.turnId, stopReason: "end_turn" } };
  return { schema: "zeros.detached-agent-offline-input/v1", intent, accepted,
    before: { binding, executionIdentity, commands: CloudBootCommandSnapshotSchema.parse({ version: 1, conversationId: accepted.conversationId,
      revision: 1, paused: false, pending: [command], receipts: [] }), events },
    after: { binding: structuredClone(binding), executionIdentity: structuredClone(executionIdentity),
      command: { ...command, conversationId: accepted.conversationId, state: "succeeded", payload: null,
        updatedAt: new Date(terminal.endedAt).toISOString(), result: { version: 1, terminal } }, events: afterEvents },
    launchAuth: { observedAtMs: start, expiresAtMs: start + 300_000 },
    detached: { startedAtMs: start + 3000, completedAtMs: start + 1_863_000, durationMs: 1_860_000,
      clientRequests: 0, tokenRefreshes: 0, openTransports: 0, commandsIssued: 0 },
    activity: { programSha256: intent.programSha256, firstRow: rows[0]!, output: rows.map(row => JSON.stringify(row)).join("\n") + "\n" },
    replay: [{ requested: events.cursor, response: { streamId, firstRetained: 1, head: 13, cursor: 13, events: [
      { sequence: 11, frame: { type: "DB_CHANGED" } }, { sequence: 12, frame: { type: "AGENT_SESSION_UPDATE" } }, { sequence: 13, frame },
    ] } }],
  };
}
const validate = (input: DetachedAgentProofInput) => validateDetachedAgentProof(JSON.stringify(input));
const rejected = (input: DetachedAgentProofInput, code = "detached_proof_incomplete") =>
  expect(() => validate(input)).toThrowError(expect.objectContaining({ code }));

describe("offline detached agent proof consistency", () => {
  it.each(["claude", "codex", "cursor"] as const)("uses the same cloud observation boundary for %s", agentId => {
    const f = fixture(); f.accepted.agentId = agentId;
    const payload = f.before.commands.pending[0]!.payload!;
    payload.agentId = agentId;
    payload.permissionMode = { claude: "accept-edits", codex: "auto-edit", cursor: "agent" }[agentId];
    f.before.events.snapshot.agentId = agentId; f.after.events.snapshot.agentId = agentId;
    f.after.command.result!.terminal!.agentId = agentId;
    f.replay[0]!.response.events[2]!.frame.agentId = agentId;
    expect(validate(f).qualification).toBe("not_performed");
  });
  it("checks a 31-minute task past a 300-second token while reporting no live authority or qualification", () => {
    const f = fixture(), result = validate(f);
    expect(result).toMatchObject({ schema: "zeros.detached-agent-offline-check/v1", validation: "consistent",
      qualification: "not_performed", authority: "not_verified", nativeDispatches: null,
      launchAuth: f.launchAuth, detached: { durationMs: 1_860_000 }, task: { durationMs: 1_860_000, rowCount: 32 },
      coverage: { kind: "bounded_task_observations", fullChat: "not_proven", baselineRows: 6, immutableRows: 4, mutableRows: 2, replayEvents: 3 } });
    expect(result.launchAuth.expiresAtMs).toBeLessThan(result.detached.completedAtMs);
    expect(DetachedAgentOfflineCheckSchema.safeParse(result).success).toBe(true);
    expect(InfrastructureSchema.safeParse(result).success).toBe(false);
    expect(Gate0Schema.safeParse(result).success).toBe(false);
  });
  it("does not mutate observations, return transcript contents or echo scope identities", () => {
    const f = fixture(), before = structuredClone(f), text = JSON.stringify(validate(f));
    expect(f).toEqual(before);
    for (const value of ["synthetic long task", "earlier question", "settled earlier answer", f.accepted.commandId,
      f.accepted.conversationId, f.before.binding.workspaceId, f.intent.nonce]) expect(text).not.toContain(value);
  });
  it("allows legitimate active tool/result and assistant text updates without relaxing baseline identities", () => {
    const f = fixture();
    expect(validate(f).coverage.mutableRows).toBe(2);
    f.after.events.snapshot.messages.splice(4, 1);
    rejected(f, "history_changed");
  });
  it("permits a retired execution only with the matching saved native terminal", () => {
    const f = fixture(); f.after.events.snapshot.executionId = null;
    expect(validate(f).coverage.finalRows).toBe(6);
  });
  it("keeps metadata cache refresh separate from immutable boot and funding identity", () => {
    const f = fixture(); f.after.binding.cacheRevision++; f.after.binding.desiredCacheRevision++;
    expect(validate(f).beforeContextSha256).not.toBe(validate(f).afterContextSha256);
  });
  it("permits a positively identified in-flight tool before the current user row to settle", () => {
    const f = fixture(), before = f.before.events.snapshot.messages[2]!, after = f.after.events.snapshot.messages[2]!;
    before.payload = JSON.stringify({ ...JSON.parse(before.payload), status: "in_progress" });
    after.payload = JSON.stringify({ ...JSON.parse(after.payload), rawOutput: "finished background result" });
    expect(validate(f).coverage).toMatchObject({ immutableRows: 3, mutableRows: 3 });
  });
  it("does not exempt settled tools inside the active turn from content stability", () => {
    const f = fixture(), before = f.before.events.snapshot.messages[4]!;
    before.payload = JSON.stringify({ ...JSON.parse(before.payload), status: "completed" });
    rejected(f, "history_changed");
  });
  it.each(["id", "kind", "createdAt", "toolCallId", "role"])("preserves native row identity inside mutable payloads: %s", key => {
    const f = fixture(), row = f.after.events.snapshot.messages[key === "role" ? 5 : 4]!;
    row.payload = JSON.stringify({ ...JSON.parse(row.payload), [key]: key === "createdAt" ? start + 1 : "changed" });
    rejected(f, "history_changed");
  });
  it.each(["organizationId", "workspaceId", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId"] as const)(
    "refuses a changed %s", key => { const f = fixture(); f.after.binding[key] = randomUUID(); rejected(f, "runtime_changed"); });
  it.each(["generation", "authorityEpoch", "fundingOwnerEpoch"] as const)("refuses a changed %s", key => {
    const f = fixture(); f.after.binding[key]++; rejected(f, "runtime_changed");
  });
  it("requires the actual runtime execution identity to match its activated binding", () => {
    const f = fixture(); f.before.executionIdentity.bootScope.writerEpoch = randomUUID(); rejected(f, "runtime_changed");
  });
  it.each(["short_launch", "consumed_launch", "token_not_expired", "backwards_wall", "short_monotonic", "exact_30_minutes"])(
    "rejects %s timing", kind => {
      const f = fixture();
      if (kind === "short_launch") f.launchAuth.expiresAtMs = start + 119_999;
      if (kind === "consumed_launch") f.detached.startedAtMs = f.launchAuth.expiresAtMs - 2000;
      if (kind === "token_not_expired") f.launchAuth.expiresAtMs = f.detached.completedAtMs + 1;
      if (kind === "backwards_wall") f.detached.completedAtMs = f.detached.startedAtMs - 1;
      if (kind === "short_monotonic") f.detached.durationMs = 1000;
      if (kind === "exact_30_minutes") f.detached.durationMs = 1_800_000;
      rejected(f, ["short_launch", "consumed_launch"].includes(kind) ? "detached_auth_window" : "detached_proof_incomplete");
    });
  it("does not replace monotonic detached duration with the wall-clock or task duration", () => {
    const f = fixture(); f.detached.completedAtMs += 5000; f.detached.durationMs += 99.962993;
    const result = validate(f);
    expect(result.detached.durationMs).toBe(1_860_099.962993); expect(result.task.durationMs).toBe(1_860_000);
  });
  it.each(["queued", "succeeded", "failed", "cancelled", "uncertain"] as const)("requires dispatching before detach, not %s", state => {
    const f = fixture(); f.before.commands.pending[0]!.state = state; rejected(f);
  });
  it.each(["commandId", "executionId", "generation", "turnId", "agentId", "duplicate", "paused", "permission", "question"])(
    "rejects an invalid accepting %s", kind => {
      const f = fixture(), entry = f.before.commands.pending[0]!;
      if (kind === "commandId") entry.commandId = randomUUID();
      if (kind === "executionId") entry.executionId = randomUUID();
      if (kind === "generation") entry.generation++;
      if (kind === "turnId") entry.payload!.userMessageId = randomUUID();
      if (kind === "agentId") { entry.payload!.agentId = "claude"; entry.payload!.permissionMode = "accept-edits"; }
      if (kind === "duplicate") f.before.commands.receipts.push(structuredClone(entry));
      if (kind === "paused") f.before.commands.paused = true;
      if (kind === "permission") f.before.events.snapshot.permissions.push({});
      if (kind === "question") f.before.events.snapshot.questions.push({});
      rejected(f);
    });
  it.each(["missing", "wrong_command", "wrong_turn", "wrong_execution", "wrong_conversation", "wrong_agent", "failed", "wrong_stop"])(
    "requires the accepted command's native terminal: %s", kind => {
      const f = fixture(), terminal = f.after.command.result!.terminal!;
      if (kind === "missing") f.after.command.result = null;
      if (kind === "wrong_command") terminal.commandId = randomUUID();
      if (kind === "wrong_turn") terminal.turnId = randomUUID();
      if (kind === "wrong_execution") terminal.executionId = randomUUID();
      if (kind === "wrong_conversation") terminal.conversationId = randomUUID();
      if (kind === "wrong_agent") terminal.agentId = "claude";
      if (kind === "failed") terminal.status = "failed";
      if (kind === "wrong_stop") terminal.stopReason = "cancelled";
      rejected(f);
    });
  it.each(["missing_start", "missing_end", "early", "different_start", "latest_turn", "native_response"])(
    "refuses unavailable or inconsistent native turn timing/outcome: %s", kind => {
      const f = fixture(), terminal = f.after.command.result!.terminal!;
      if (kind === "missing_start") delete terminal.startedAt;
      if (kind === "missing_end") delete terminal.endedAt;
      if (kind === "early") terminal.endedAt = start + 60_000;
      if (kind === "different_start") terminal.startedAt = start + 1;
      if (kind === "latest_turn") f.after.events.snapshot.latestTurn = { ...terminal, endedAt: start + 60_000 };
      if (kind === "native_response") terminal.response!.userMessageId = randomUUID();
      rejected(f);
    });
  it.each(["settled_text", "settled_tool", "user", "row_kind", "row_time", "duplicate_id", "reordered"])(
    "preserves immutable prefix and every baseline identity: %s", kind => {
      const f = fixture(), rows = f.after.events.snapshot.messages;
      if (kind === "settled_text") rows[1]!.payload = JSON.stringify({ role: "agent", text: "changed" });
      if (kind === "settled_tool") rows[2]!.payload = JSON.stringify({ kind: "tool", status: "completed", rawOutput: "changed" });
      if (kind === "user") rows[3]!.payload = JSON.stringify({ role: "user", text: "changed" });
      if (kind === "row_kind") rows[4]!.kind = "text";
      if (kind === "row_time") rows[4]!.createdAt++;
      if (kind === "duplicate_id") rows.push(structuredClone(rows[0]!));
      if (kind === "reordered") [rows[1], rows[2]] = [rows[2]!, rows[1]!];
      rejected(f, "history_changed");
    });
  it.each(["wrong_request", "wrong_stream", "gap", "first_retained", "regressed_cursor", "head_behind", "requires_snapshot", "missing_terminal", "duplicate_terminal", "foreign_terminal", "wrong_native_session"])(
    "refuses replay that cannot cover the original stream: %s", kind => {
      const f = fixture(), page = f.replay[0]!, last = page.response.events[2]!;
      if (kind === "wrong_request") page.requested = { ...page.requested, sequence: 9 };
      if (kind === "wrong_stream") page.response.streamId = randomUUID();
      if (kind === "gap") page.response.events[1]!.sequence++;
      if (kind === "first_retained") page.response.firstRetained = 12;
      if (kind === "regressed_cursor") page.response.cursor = 10;
      if (kind === "head_behind") page.response.head = 12;
      if (kind === "requires_snapshot") last.frame.cloudStream = { streamId: page.response.streamId, sequence: 13, requiresSnapshot: true };
      if (kind === "missing_terminal") last.frame = { type: "DB_CHANGED" };
      if (kind === "duplicate_terminal") page.response.events[1]!.frame = structuredClone(last.frame);
      if (kind === "foreign_terminal") last.frame.chatId = randomUUID();
      if (kind === "wrong_native_session") last.frame.sessionId = randomUUID();
      rejected(f);
    });
  it("accepts contiguous pages and caps coverage at the original after-snapshot high-water", () => {
    const f = fixture(), p = f.replay[0]!;
    f.replay = [{ requested: p.requested, response: { ...p.response, cursor: 11, events: p.response.events.slice(0, 1) } },
      { requested: { ...p.requested, sequence: 11 }, response: { ...p.response, head: 14, cursor: 14,
        events: [...p.response.events.slice(1), { sequence: 14, frame: { type: "DB_CHANGED" } }] } }];
    expect(validate(f).coverage.replayEvents).toBe(3);
    f.replay.push(structuredClone(f.replay[1]!)); rejected(f);
  });
  it.each(["program", "run", "nonce", "duplicate", "gap", "short", "missing", "initial", "malformed"])(
    "requires the complete bounded task witness as well as the native terminal: %s", kind => {
      const f = fixture(), rows = f.activity.output.trimEnd().split("\n").map(line => JSON.parse(line));
      if (kind === "program") f.activity.programSha256 = "b".repeat(64);
      if (kind === "run") rows[10].run = randomUUID();
      if (kind === "nonce") rows[10].nonce = randomUUID();
      if (kind === "duplicate") rows[10] = rows[9];
      if (kind === "gap") rows[10].ms += 40_000;
      if (kind === "short") for (const row of rows) row.ms = row.n * 1000;
      if (kind === "missing") rows.pop();
      if (kind === "initial") f.activity.firstRow.ms++;
      f.activity.output = kind === "malformed" ? "untrusted provider response" : rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      rejected(f);
    });
  it.each(["clientRequests", "tokenRefreshes", "openTransports", "commandsIssued"] as const)("refuses any recorded detached %s", key => {
    const f: unknown = fixture(); (f as { detached: Record<string, number> }).detached[key] = 1;
    expect(() => validateDetachedAgentProof(JSON.stringify(f))).toThrowError(expect.objectContaining({ code: "bad_response" }));
  });
  it.each(["serverSessionVerified", "providerExpiresAt", "signature", "privateKey"])("never accepts %s as authority", field => {
    const f = { ...fixture(), [field]: "synthetic" };
    expect(() => validateDetachedAgentProof(JSON.stringify(f))).toThrowError(expect.objectContaining({ code: "bad_response" }));
  });
  it("rejects Local input, oversized bytes and malformed JSON using only a closed error", () => {
    const f = fixture(); Object.assign(f.before.executionIdentity, { kind: "local", sidecar: "active" });
    for (const raw of [JSON.stringify(f), "untrusted secret-like body", '"' + "x".repeat(DETACHED_AGENT_INPUT_BYTES) + '"']) {
      expect(() => validateDetachedAgentProof(raw)).toThrowError(expect.objectContaining({ code: "bad_response", message: "zeros_dev_bad_response" }));
    }
  });
  it("bounds opaque JSON depth and UTF-8 row bytes before producing a report", () => {
    const deep = fixture(), large = fixture();
    let value: unknown = null;
    for (let i = 0; i < 40; i++) value = { child: value };
    deep.replay[0]!.response.events[0]!.frame.extra = value;
    const row = large.before.events.snapshot.messages[0]!;
    row.payload = JSON.stringify({ ...JSON.parse(row.payload), text: "λ".repeat(300_000) });
    rejected(deep, "bad_response"); rejected(large, "bad_response");
    const overflow = JSON.stringify(fixture()).replace('"sequence":11', '"sequence":1e999');
    expect(() => validateDetachedAgentProof(overflow)).toThrowError(expect.objectContaining({ code: "bad_response" }));
  });
});
