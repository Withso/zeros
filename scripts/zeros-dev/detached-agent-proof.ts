import { createHash } from "node:crypto";
import { CloudAgentBootIdentitySchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CLOUD_REPLAY_EVENT_TYPES, type CloudTurnOutcome } from "@zeros/protocol/cloud-events";
import { DETACHED_AGENT_INPUT_BYTES, DETACHED_AGENT_LAUNCH_FLOOR_MS, DETACHED_AGENT_MIN_MS,
  DetachedAgentOfflineCheckSchema, DetachedAgentProofInputSchema, DetachedAgentTaskRowSchema,
  type DetachedAgentOfflineCheck, type DetachedAgentProofInput } from "./detached-agent-proof-contract";
import { ZerosDevError, type ErrorCode } from "./errors";

type Input = DetachedAgentProofInput;
type Row = Input["before"]["events"]["snapshot"]["messages"][number];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
const fail = (code: ErrorCode = "detached_proof_incomplete"): never => { throw new ZerosDevError(code); };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function parse(source: string): Input {
  if (typeof source !== "string" || Buffer.byteLength(source) > DETACHED_AGENT_INPUT_BYTES) return fail("bad_response");
  try {
    const value: unknown = JSON.parse(source);
    // Replay frames contain opaque JSON. Bound their shape before schema/hash
    // traversal; a small but deeply nested document must still fail closed.
    const pending = [{ value, depth: 0 }]; let nodes = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (++nodes > 100_000 || item.depth > 32) return fail("bad_response");
      if (typeof item.value === "number" && !Number.isFinite(item.value)) return fail("bad_response");
      if (item.value && typeof item.value === "object")
        for (const child of Object.values(item.value)) {
          if (pending.length + nodes >= 100_000) return fail("bad_response");
          pending.push({ value: child, depth: item.depth + 1 });
        }
    }
    const parsed = DetachedAgentProofInputSchema.safeParse(value);
    if (!parsed.success) return fail("bad_response");
    return parsed.data;
  } catch { return fail("bad_response"); }
}

function scope(input: Input) {
  const stable = (context: Input["before"] | Input["after"]) => {
    const { binding, executionIdentity: actual } = context;
    const value = CloudAgentBootIdentitySchema.parse(Object.fromEntries(
      Object.keys(CloudAgentBootIdentitySchema.shape).map(key => [key, binding[key as keyof typeof binding]])));
    for (const key of ["organizationId", "workspaceId", "generation", "engineInstanceId", "authorityEpoch"] as const)
      if (actual[key] !== value[key]) fail("runtime_changed");
    for (const key of Object.keys(actual.bootScope) as Array<keyof typeof actual.bootScope>)
      if (actual.bootScope[key] !== value[key]) fail("runtime_changed");
    return value;
  };
  const before = stable(input.before), after = stable(input.after);
  if (hash(before) !== hash(after)) fail("runtime_changed");
  return before;
}

function timings(input: Input) {
  const { launchAuth: auth, detached } = input;
  if (auth.expiresAtMs - auth.observedAtMs < DETACHED_AGENT_LAUNCH_FLOOR_MS ||
      auth.expiresAtMs - detached.startedAtMs <= 3000) fail("detached_auth_window");
  if (auth.observedAtMs > detached.startedAtMs || detached.completedAtMs <= detached.startedAtMs ||
      auth.expiresAtMs >= detached.completedAtMs || detached.durationMs <= DETACHED_AGENT_MIN_MS) fail();
  // Wall time, monotonic client time and task time are independent observations.
  // None of these timestamps establish WorkOS or agent authority.
  return { startedAtMs: detached.startedAtMs, completedAtMs: detached.completedAtMs, durationMs: detached.durationMs };
}

function terminalMatches(terminal: CloudTurnOutcome | null | undefined, accepted: Input["accepted"]): terminal is CloudTurnOutcome {
  return !!terminal && terminal.commandId === accepted.commandId && terminal.conversationId === accepted.conversationId &&
    terminal.executionId === accepted.executionId && terminal.turnId === accepted.turnId && terminal.agentId === accepted.agentId &&
    terminal.status === "completed" && terminal.stopReason === "end_turn" && terminal.error === undefined && terminal.failure === undefined &&
    (terminal.response?.userMessageId === undefined || terminal.response.userMessageId === accepted.turnId) &&
    (terminal.response?.stopReason === undefined || terminal.response.stopReason === "end_turn");
}

function command(input: Input) {
  const { accepted, before, after } = input, queue = before.commands;
  const first = before.events.snapshot, last = after.events.snapshot;
  const entries = [...queue.pending, ...queue.receipts], entry = queue.pending[0];
  if (queue.conversationId !== accepted.conversationId || queue.paused || queue.pending.length !== 1 || !entry ||
      new Set(entries.map(row => row.commandId)).size !== entries.length ||
      entry.commandId !== accepted.commandId || entry.executionId !== accepted.executionId || entry.generation !== before.binding.generation ||
      entry.state !== "dispatching" || entry.resultCode !== null || entry.result?.terminal || entry.payload?.operation ||
      entry.payload?.userMessageId !== accepted.turnId || entry.payload.agentId !== accepted.agentId) fail();
  for (const snapshot of [first, last])
    if (snapshot.conversationId !== accepted.conversationId || snapshot.agentId !== accepted.agentId ||
        snapshot.permissions.length || snapshot.questions.length) fail();
  if (first.executionId !== accepted.executionId || first.activeTurn?.turnId !== accepted.turnId ||
      first.latestTurn?.turnId === accepted.turnId || last.activeTurn ||
      last.executionId !== null && last.executionId !== accepted.executionId) fail();
  const read = after.command, terminal = read.result?.terminal;
  if (read.commandId !== accepted.commandId || read.conversationId !== accepted.conversationId || read.executionId !== accepted.executionId ||
      read.generation !== entry.generation || read.position !== entry.position || read.createdAt !== entry.createdAt ||
      Date.parse(read.updatedAt) < Date.parse(entry.updatedAt) || read.state !== "succeeded" || read.resultCode !== null ||
      read.payload !== null && hash(read.payload) !== hash(entry.payload) ||
      !terminalMatches(terminal, accepted) || !terminalMatches(last.latestTurn, accepted)) return fail();
  const startedAtMs = terminal.startedAt, endedAtMs = terminal.endedAt;
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(endedAtMs) || startedAtMs === undefined || endedAtMs == null ||
      first.activeTurn!.startedAt !== startedAtMs || startedAtMs > input.detached.startedAtMs ||
      endedAtMs - input.detached.startedAtMs <= DETACHED_AGENT_MIN_MS ||
      Date.parse(read.updatedAt) < endedAtMs || last.latestTurn!.startedAt !== startedAtMs || last.latestTurn!.endedAt !== endedAtMs) return fail();
  return { terminal, nativeTurn: { startedAtMs, endedAtMs, durationMs: endedAtMs - startedAtMs } };
}

function payload(row: Row): Record<string, unknown> {
  try {
    const value = object(JSON.parse(row.payload));
    if (!value || value.id !== row.msgId || value.kind !== row.kind || value.createdAt !== row.createdAt) return fail("history_changed");
    return value;
  } catch { return fail("history_changed"); }
}

function history(input: Input) {
  const before = input.before.events.snapshot.messages, after = input.after.events.snapshot.messages;
  const first = before.map(payload), last = after.map(payload);
  if (new Set(before.map(row => row.msgId)).size !== before.length || new Set(after.map(row => row.msgId)).size !== after.length)
    fail("history_changed");
  const userIndex = before.findIndex(row => row.msgId === input.accepted.turnId);
  if (userIndex < 0 || before[userIndex]!.kind !== "text" || first[userIndex]!.role !== "user") fail("history_changed");
  const positions = new Map(after.map((row, index) => [row.msgId, index]));
  let previous = -1, immutableRows = 0, mutableRows = 0;
  const retained = before.map((row, index) => {
    const position = positions.get(row.msgId);
    if (position === undefined || position <= previous) return fail("history_changed");
    previous = position;
    const next = after[position]!, oldPayload = first[index]!, newPayload = last[position]!;
    if (row.kind !== next.kind || row.createdAt !== next.createdAt) fail("history_changed");
    // Never exempt an entire active suffix. Settled tools and all user rows
    // remain immutable; a positively pending tool may also precede this turn.
    const tool = row.kind === "tool" && typeof oldPayload.toolCallId === "string" && oldPayload.toolCallId.length > 0 &&
      (oldPayload.status === "pending" || oldPayload.status === "in_progress" || oldPayload.resultRetracted === true);
    const text = index > userIndex && (row.kind === "thinking" || row.kind === "text" &&
      (oldPayload.role === "agent" || oldPayload.role === "thought"));
    const mutable = tool || text;
    if (!mutable && row.payload !== next.payload) fail("history_changed");
    if (mutable) {
      for (const key of ["role", "toolCallId", "nativeToolCallId", "parentToolId", "messageId"])
        if (oldPayload[key] !== undefined && oldPayload[key] !== newPayload[key]) fail("history_changed");
      if (tool && !["pending", "in_progress", "completed", "failed"].includes(String(newPayload.status)) ||
          text && (typeof oldPayload.text !== "string" || typeof newPayload.text !== "string")) fail("history_changed");
      mutableRows++;
    } else immutableRows++;
    return { msgId: row.msgId, kind: row.kind, createdAt: row.createdAt, mutable,
      beforeSha256: sha(row.payload), afterSha256: sha(next.payload) };
  });
  return { historySha256: hash(retained), baselineRows: before.length, immutableRows, mutableRows, finalRows: after.length };
}

function replay(input: Input, endedAtMs: number) {
  const { accepted } = input, start = input.before.events.cursor, high = input.after.events.cursor;
  if (start.streamId !== high.streamId || high.sequence <= start.sequence) fail();
  let cursor = start.sequence, head = high.sequence, terminals = 0;
  const covered: Input["replay"][number]["response"]["events"] = [];
  for (const page of input.replay) {
    const value = page.response;
    if (cursor >= high.sequence || page.requested.streamId !== start.streamId || page.requested.sequence !== cursor ||
        value.streamId !== start.streamId || value.firstRetained > cursor + 1 || value.head < head ||
        !value.events.length || value.cursor > value.head || value.cursor !== value.events.at(-1)!.sequence) fail();
    head = value.head;
    for (const event of value.events) {
      if (event.sequence !== cursor + 1) fail();
      cursor = event.sequence;
      if (cursor > high.sequence) continue;
      const frame = event.frame, stream = frame.cloudStream === undefined ? undefined : object(frame.cloudStream);
      if (frame.cloudStream !== undefined && (!stream || stream.streamId !== start.streamId || stream.sequence !== cursor ||
          stream.requiresSnapshot !== undefined) || typeof frame.type !== "string" || !CLOUD_REPLAY_EVENT_TYPES.has(frame.type)) fail();
      covered.push(event);
      const response = object(frame.response);
      const target = frame.requestId === accepted.commandId || frame.sessionId === accepted.executionId ||
        frame.executionId === accepted.executionId || response?.userMessageId === accepted.turnId;
      if (!target || frame.type !== "AGENT_PROMPT_COMPLETE" && frame.type !== "AGENT_PROMPT_FAILED") continue;
      if (++terminals !== 1 || frame.type !== "AGENT_PROMPT_COMPLETE" || frame.requestId !== accepted.commandId ||
          frame.sessionId !== accepted.executionId || frame.executionId !== undefined && frame.executionId !== accepted.executionId ||
          frame.chatId !== undefined && frame.chatId !== accepted.conversationId || frame.agentId !== accepted.agentId ||
          frame.stopReason !== "end_turn" || response?.userMessageId !== accepted.turnId ||
          response.stopReason !== undefined && response.stopReason !== "end_turn" || frame.source !== "engine" ||
          typeof frame.id !== "string" || !frame.id.length || typeof frame.timestamp !== "number" ||
          !Number.isSafeInteger(frame.timestamp) || frame.timestamp < endedAtMs) fail();
    }
  }
  if (cursor < high.sequence || terminals !== 1) fail();
  return { replaySha256: hash(covered), replayEvents: covered.length };
}

function activity(input: Input) {
  const { intent, activity } = input;
  if (activity.programSha256 !== intent.programSha256 || !activity.output.endsWith("\n")) fail();
  const lines = activity.output.slice(0, -1).split("\n");
  if (lines.length !== 32) fail();
  const rows = lines.map((line, n) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return fail(); }
    const parsed = DetachedAgentTaskRowSchema.safeParse(value);
    if (!parsed.success || parsed.data.n !== n || parsed.data.run !== intent.runId || parsed.data.nonce !== intent.nonce) return fail();
    return parsed.data;
  });
  if (rows[0]!.ms > 10_000 || hash(rows[0]) !== hash(activity.firstRow)) fail();
  const gaps = rows.slice(1).map((row, index) => row.ms - rows[index]!.ms), durationMs = rows[31]!.ms - rows[0]!.ms;
  if (gaps.some(gap => gap < 45_000 || gap > 90_000) || durationMs <= DETACHED_AGENT_MIN_MS) fail();
  return { durationMs, rowCount: 32 as const, maxHeartbeatGapMs: Math.max(...gaps),
    programSha256: intent.programSha256, outputSha256: sha(activity.output) };
}

/** Pure offline consistency check. It makes no requests, signs nothing and
 * cannot authenticate a recorder or establish a server session's authority. */
export function validateDetachedAgentProof(source: string): DetachedAgentOfflineCheck {
  try {
    const input = parse(source), binding = scope(input), detached = timings(input), native = command(input);
    const { historySha256, ...historyCoverage } = history(input), { replaySha256, replayEvents } = replay(input, native.nativeTurn.endedAtMs);
    return DetachedAgentOfflineCheckSchema.parse({ schema: "zeros.detached-agent-offline-check/v1", validation: "consistent",
      qualification: "not_performed", authority: "not_verified", nativeDispatches: null,
      inputSha256: sha(source), scopeSha256: hash(binding), commandSha256: hash(input.accepted),
      beforeContextSha256: hash(input.before.binding), afterContextSha256: hash(input.after.binding), historySha256, replaySha256,
      launchAuth: input.launchAuth, detached, nativeTurn: native.nativeTurn, task: activity(input),
      coverage: { kind: "bounded_task_observations", fullChat: "not_proven", ...historyCoverage, replayEvents } });
  } catch (error) {
    if (error instanceof ZerosDevError) throw error;
    return fail("bad_response");
  }
}
