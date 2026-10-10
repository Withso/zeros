import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../db.js";
import { applyCompactCloudAgentEvent, CloudCompactControlEventSchema } from "./event-streams.js";
import { canonicalCloudHistoryJson } from "./history-local-contract.js";

const ids = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(8,"0")}-1111-4111-8111-111111111111`);
const scope = { organizationId: ids[0], workspaceId: ids[1], writerEpoch: ids[2], outboxSequence: 3, conversationId: "chat", commandId: ids[3] };
const origin = { organizationId: ids[0], workspaceId: ids[1], generation: 1, engineInstanceId: ids[4], bootId: ids[5], writerEpoch: ids[2], fundingOwnerUserId: ids[6], fundingOwnerEpoch: 1 };
function frame(type: "AGENT_PERMISSION_REQUEST" | "AGENT_PERMISSION_SETTLED" | "AGENT_QUESTION_REQUEST" | "AGENT_QUESTION_SETTLED") {
  const base = { id: "frame", source: "engine", timestamp: 1, agentId: "cursor", cloudStream: { streamId: ids[4], sequence: 9 } };
  if (type === "AGENT_PERMISSION_REQUEST") return { ...base, type, permissionId: "permission", request: { sessionId: "execution", toolCall: { toolCallId: "tool", title: "Read", rawInput: { path: "file" } }, options: [{ optionId: "project", name: "Allow for this project", kind: "allow_always_project" }] } };
  if (type === "AGENT_PERMISSION_SETTLED") return { ...base, type, permissionId: "permission", sessionId: "execution" };
  if (type === "AGENT_QUESTION_REQUEST") return { ...base, type, questionId: "question", request: { sessionId: "execution", questionId: "question", nativeRequestId: "native", source: "native_rpc", blocking: true, questions: [{ id: "choice", prompt: "Continue?", allowOther: true, options: [] }] } };
  return { ...base, type, questionId: "question", outcome: { outcome: "dismissed" } };
}
function setup() {
  const parent = { id: scope.commandId, workspace_id: scope.workspaceId, org_id: scope.organizationId,
    conversation_id: "chat", writer_epoch: scope.writerEpoch, projection_epoch: scope.writerEpoch,
    execution_id: "execution", user_message_id: "turn", agent_id: "cursor", generation: 1,
    projection_state: "active", origin_engine_instance_id: origin.engineInstanceId, origin_boot_id: origin.bootId,
    origin_generation: 1, origin_funding_owner_user_id: origin.fundingOwnerUserId, origin_funding_owner_epoch: "1",
    actor_provenance: { scope: { ...origin }, actor: { userId: origin.fundingOwnerUserId, deviceId: ids[7], deviceKeyVersion: 1, fingerprint: "a".repeat(64), role: "owner" },
      actorSessionId: ids[8], authorityEpoch: 1, confirmedUntilMs: 1, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } } };
  let exists = true, prior = true, replay: Record<string, unknown> | null = null;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/FROM cloud_workspace_local_commands c/.test(sql)) return { rows: exists ? [parent] : [], rowCount: exists ? 1 : 0 };
    if (/FROM cloud_workspace_local_agent_controls/.test(sql)) return { rows: /type\s*(?:=|IN)/.test(sql)
      ? (prior ? [{ command_id: scope.commandId, execution_id: "execution", user_message_id: "turn", agent_id: "cursor", conversation_id: "chat", local_stream_id: ids[4], local_sequence: "8", type: params?.includes("question") ? "AGENT_QUESTION_REQUEST" : "AGENT_PERMISSION_REQUEST", resolver_id: params?.includes("question") ? "question" : "permission" }] : []) : (replay ? [replay] : []), rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  return { tx: { query } as unknown as Tx, query, parent, missingParent: () => { exists = false; }, missingRequest: () => { prior = false; }, setReplay: (value: Record<string, unknown>) => { replay = value; } };
}
const inserted = (query: ReturnType<typeof setup>["query"]) => query.mock.calls.filter(([sql]) => /INSERT INTO cloud_workspace_local_agent_controls/.test(sql));

describe("new-mode compact controls keep exact native ownership", () => {
  it("preserves bounded native JSON keys rather than silently changing raw tool input", () => {
    const native = frame("AGENT_PERMISSION_REQUEST");
    const event = { version: 1, eventSequence: 9, executionId: "execution", frame: { ...native,
      request: { ...(native as { request: object }).request, toolCall: { toolCallId: "tool", title: "Read",
        rawInput: JSON.parse('{"__proto__":{"literal":true},"constructor":"value","kept":true}') } } } };
    const parsed = CloudCompactControlEventSchema.parse(event);
    expect(canonicalCloudHistoryJson(parsed)).toBe(canonicalCloudHistoryJson(event));
    expect(Object.getPrototypeOf({})).not.toHaveProperty("literal");
  });
  it.each(["AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED", "AGENT_QUESTION_REQUEST", "AGENT_QUESTION_SETTLED"] as const)(
    "retains native %s envelope even when native optional ownership IDs are absent", async type => {
      const f = setup(), event = { version: 1, eventSequence: 9, executionId: "execution", frame: frame(type) };
      await applyCompactCloudAgentEvent(f.tx, scope, event);
      expect(inserted(f.query)).toHaveLength(1);
      const parentRead = f.query.mock.calls.find(([sql]) => /FROM cloud_workspace_local_commands c/.test(sql))!;
      expect(parentRead[0]).not.toMatch(/ORDER BY/i);
      expect(f.query.mock.calls.at(-1)!.flat()).toContain(scope.commandId);
    });
  it.each(["id", "workspace_id", "org_id", "conversation_id", "projection_epoch", "execution_id", "agent_id", "origin_boot_id", "origin_engine_instance_id"] as const)(
    "rejects foreign stored parent %s before writing any control", async field => {
      const f = setup(); f.parent[field] = field === "conversation_id" ? "other" : randomUUID();
      await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution", frame: frame("AGENT_PERMISSION_REQUEST") })).rejects.toThrow();
      expect(inserted(f.query)).toHaveLength(0);
    });
  it("does not substitute a newest command on a reused warm execution", async () => {
    const f = setup(); f.missingParent();
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution", commandId: ids[9], frame: frame("AGENT_PERMISSION_REQUEST") })).rejects.toThrow();
    expect(inserted(f.query)).toHaveLength(0);
  });
  it("requires retained original actor and an earlier exact request before settlement", async () => {
    const f = setup(); f.missingRequest();
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution", frame: frame("AGENT_PERMISSION_SETTLED") })).rejects.toThrow();
    expect(inserted(f.query)).toHaveLength(0);
    f.parent.actor_provenance.scope.bootId = ids[9];
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution", frame: frame("AGENT_PERMISSION_REQUEST") })).rejects.toThrow();
  });
  it("preserves scoped project-allow as data without creating repo permission authority", () => {
    const event = { version: 1, eventSequence: 9, executionId: "execution", frame: frame("AGENT_PERMISSION_REQUEST") };
    expect(CloudCompactControlEventSchema.parse(event)).toEqual(event);
  });
  it("keeps the original local live cursor separate from the CP outbox sequence", async () => {
    const f = setup(), event = { version: 1, eventSequence: 9, executionId: "execution", frame: frame("AGENT_PERMISSION_REQUEST") };
    await applyCompactCloudAgentEvent(f.tx, scope, event);
    const params = inserted(f.query)[0][1]!;
    expect(params).toContain(9); expect(params).toContain(scope.outboxSequence);
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { ...event, eventSequence: 10 })).rejects.toThrow();
  });
  it("replays only an exact already-stored control and refuses changed native content", async () => {
    const f = setup(), native = frame("AGENT_PERMISSION_REQUEST");
    f.setReplay({ command_id: scope.commandId, execution_id: "execution", user_message_id: "turn", agent_id: "cursor",
      conversation_id: "chat", local_stream_id: ids[4], local_sequence: "9", resolver_id: "permission", type: native.type, frame: native });
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution", frame: native })).resolves.toEqual({ replayed: true });
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution", frame: { ...native, timestamp: 2 } })).rejects.toThrow();
    expect(inserted(f.query)).toHaveLength(0);
  });
  it("bounds UTF8/complexity and refuses delta or inconsistent native ownership before SQL", async () => {
    const f = setup(), valid = { version: 1, eventSequence: 9, executionId: "execution", frame: frame("AGENT_PERMISSION_REQUEST") };
    let deep: unknown = "leaf"; for (let n = 0; n < 34; n++) deep = { child: deep };
    for (const event of [{ ...valid, frame: { ...valid.frame, type: "AGENT_SESSION_UPDATE" } },
      { ...valid, frame: { ...valid.frame, request: { ...(valid.frame as { request: object }).request, executionId: "other" } } },
      { ...valid, frame: { ...valid.frame, permissionId: "界".repeat(100000) } },
      { ...valid, frame: { ...valid.frame, request: { ...(valid.frame as { request: object }).request, toolCall: { toolCallId: "tool", title: "Read", rawInput: deep } } } }]) {
      await expect(applyCompactCloudAgentEvent(f.tx, scope, event)).rejects.toThrow();
    }
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, { lost: undefined }, [undefined], new Date(0)])("refuses lossy raw native JSON %j before SQL", async rawInput => {
    const f = setup(), native = frame("AGENT_PERMISSION_REQUEST");
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution",
      frame: { ...native, request: { ...(native as { request: object }).request,
        toolCall: { toolCallId: "tool", title: "Read", rawInput } } } })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects absent original actor rather than accepting terminal payload or current funding owner", async () => {
    const f = setup(); Object.assign(f.parent, { actor_provenance: null });
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution",
      frame: frame("AGENT_PERMISSION_REQUEST") })).rejects.toThrow();
    expect(inserted(f.query)).toHaveLength(0);
  });
  it.each(["viewer", "unfunded"] as const)("rejects stored %s command provenance as native-run authority", async kind => {
    const f = setup();
    if (kind === "viewer") f.parent.actor_provenance.actor.role = "viewer";
    else Object.assign(f.parent.actor_provenance, { fundingConsentVersion: null, fundingGrant: null });
    await expect(applyCompactCloudAgentEvent(f.tx, scope, { version: 1, eventSequence: 9, executionId: "execution",
      frame: frame("AGENT_PERMISSION_REQUEST") })).rejects.toThrow();
    expect(inserted(f.query)).toHaveLength(0);
  });
});
