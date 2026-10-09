import { z } from "zod";
import { CloudEventAppendResultSchema, CloudEventReplayResultSchema, type CloudTurnOutcome } from "@zeros/protocol/cloud-events";
import { canonical, clone, FixtureRefusal, parse, ScopeSchema, sha256 } from "./contracts";

// Private append input is the CP route's frame envelope. Replay/ACK outputs
// are the real package schemas; arbitrary native payloads remain opaque.
const FrameSchema = z.object({ id: z.string().min(1).max(128), source: z.literal("engine"), timestamp: z.number().finite(),
  type: z.enum(["AGENT_SESSION_UPDATE", "AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED", "AGENT_QUESTION_REQUEST",
    "AGENT_QUESTION_SETTLED", "AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED", "DB_CHANGED"]),
  cloudStream: z.object({ streamId: z.uuid(), sequence: z.number().int().safe().positive(), requiresSnapshot: z.literal(true).optional() }).strict(),
}).passthrough();
const RequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("append"), batchId: z.uuid(), events: z.array(z.object({ sequence: z.number().int().safe().positive(), frame: FrameSchema }).strict()).min(1).max(128) }).strict(),
  z.object({ kind: z.literal("replay"), streamId: z.uuid(), after: z.number().int().safe().nonnegative() }).strict(),
]);
export const EventBodySchema = ScopeSchema.extend({ request: RequestSchema }).strict();
type Event = { sequence: number; frame: z.infer<typeof FrameSchema> };

export class FixtureEvents {
  private events: Event[] = [];
  private head = 0;
  private lastBatch: { id: string; hash: string } | null = null;
  constructor(private readonly streamId: string, private readonly retainedCount = 10_000) {
    if (!Number.isSafeInteger(retainedCount) || retainedCount < 1 || retainedCount > 10_000) throw new Error("fixture_event_retention_invalid");
  }
  handle(raw: unknown): unknown {
    const request = parse(RequestSchema, raw, "invalid_event");
    if (request.kind === "append") {
      const encoded = JSON.stringify(request.events);
      if (Buffer.byteLength(encoded) > 1024 * 1024 || request.events.some((event, index) =>
        event.sequence !== request.events[0]!.sequence + index || event.frame.cloudStream.streamId !== this.streamId ||
        event.frame.cloudStream.sequence !== event.sequence || Buffer.byteLength(JSON.stringify(event.frame)) > 256 * 1024))
        throw new FixtureRefusal("invalid_event", 422);
      const hash = sha256(encoded);
      if (this.lastBatch?.id === request.batchId) {
        if (this.lastBatch.hash !== hash) throw new FixtureRefusal("event_conflict");
        return CloudEventAppendResultSchema.parse({ streamId: this.streamId, head: this.head, replayed: true });
      }
      if (request.events[0]!.sequence !== this.head + 1) throw new FixtureRefusal("event_conflict");
      this.events.push(...clone(request.events)); this.head = request.events.at(-1)!.sequence;
      this.lastBatch = { id: request.batchId, hash };
      let bytes = this.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.frame)), 0);
      // Keep the current batch whole, as production does. Count and byte
      // bounds prune only already acknowledged older batches.
      while (this.events.length > request.events.length && (this.events.length > this.retainedCount || bytes > 16 * 1024 * 1024)) {
        bytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!.frame));
      }
      return CloudEventAppendResultSchema.parse({ streamId: this.streamId, head: this.head, replayed: false });
    }
    if (request.streamId !== this.streamId) throw new FixtureRefusal("event_stream_changed");
    const firstRetained = this.events[0]?.sequence ?? 1;
    if (request.after < firstRetained - 1) throw new FixtureRefusal("event_cursor_expired");
    if (request.after > this.head) throw new FixtureRefusal("event_conflict");
    let bytes = 0;
    const events = this.events.filter(event => event.sequence > request.after).slice(0, 128).filter(event => {
      bytes += Buffer.byteLength(JSON.stringify(event.frame)); return bytes <= 1024 * 1024;
    });
    return CloudEventReplayResultSchema.parse({ streamId: this.streamId, head: this.head, firstRetained, cursor: events.at(-1)?.sequence ?? request.after, events });
  }
  read(after = 0) { return clone(this.events.filter(event => event.sequence > after)); }
  assertTerminal(entry: { commandId: string; conversationId: string; state: string; executionId: string | null; resultCode: string | null;
    agentId: string; result?: { terminal?: CloudTurnOutcome } | null }): void {
    if (!["succeeded", "failed", "cancelled"].includes(entry.state)) throw new Error("fixture_receipt_not_terminal");
    const terminal = this.events.filter(({ frame }) => ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].includes(frame.type) &&
      frame.requestId === entry.commandId);
    if (!terminal.length) throw new Error("fixture_terminal_missing");
    if (terminal.length !== 1) throw new Error("fixture_terminal_conflict");
    const frame = terminal[0]!.frame;
    if ((frame.executionId ?? frame.sessionId) !== entry.executionId || frame.agentId !== entry.agentId) throw new Error("fixture_terminal_conflict");
    if ((entry.state === "failed") !== (frame.type === "AGENT_PROMPT_FAILED") ||
      (entry.state === "failed" && frame.error !== entry.resultCode)) throw new Error("fixture_terminal_conflict");
    if (frame.type === "AGENT_PROMPT_COMPLETE" && ((entry.state === "cancelled") !== (frame.stopReason === "cancelled")))
      throw new Error("fixture_terminal_conflict");
    const retained = entry.result?.terminal;
    if (retained) {
      const failure = frame.failure && typeof frame.failure === "object" ? frame.failure as Record<string, unknown> : {};
      // The publisher retains human failure text; the dispatched receiver
      // retains the typed code. Both native frames carry that exact code,
      // already bound to resultCode above, plus the same failure object.
      const failureMessage = typeof failure.message === "string" ? failure.message : frame.error;
      if ((retained.commandId !== undefined && retained.commandId !== entry.commandId) || retained.conversationId !== entry.conversationId ||
          retained.executionId !== entry.executionId || retained.agentId !== entry.agentId ||
          retained.status !== (entry.state === "succeeded" ? "completed" : entry.state) ||
          (frame.type === "AGENT_PROMPT_COMPLETE" && retained.stopReason !== frame.stopReason) ||
          (frame.type === "AGENT_PROMPT_FAILED" && retained.error !== undefined &&
            retained.error !== frame.error && retained.error !== failureMessage))
        throw new Error("fixture_terminal_conflict");
      const response = frame.response && typeof frame.response === "object" ? frame.response as Record<string, unknown> : {};
      if (Object.entries(retained.response ?? {}).some(([key, value]) => canonical(value) !== canonical(response[key])))
        throw new Error("fixture_terminal_conflict");
      if (retained.failure && canonical(retained.failure) !== canonical(failure))
        throw new Error("fixture_terminal_conflict");
    }
  }
  inspect() { return { eventHead: this.head, eventFirstRetained: this.events[0]?.sequence ?? 1, eventCount: this.events.length,
    terminals: this.events.filter(({ frame }) => ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].includes(frame.type)).map(({ sequence, frame }) => ({
      sequence, type: frame.type, requestId: typeof frame.requestId === "string" ? frame.requestId : null,
      executionId: typeof (frame.executionId ?? frame.sessionId) === "string" ? frame.executionId ?? frame.sessionId : null,
    })) }; }
}
