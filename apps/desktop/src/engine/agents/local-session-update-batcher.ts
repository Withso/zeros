import type { SessionNotification, SessionUpdate, TextContent } from "@zeros/protocol/agent-events";

type TextUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }> & { content: TextContent };
interface Stream {
  agentId: string;
  key: string;
  kind: "text" | "output";
  pending?: SessionNotification;
  timer?: ReturnType<typeof setTimeout>;
}

const DELAY_MS = 50;
const MAX_PENDING_CHARS = 64 * 1024;
const MAX_EXECUTIONS = 128;
const OUTPUT_FIELDS = new Set(["sessionUpdate", "toolCallId", "status", "rawOutput", "at"]);

/** Only append-only keyed prose and simple whole-output snapshots can be
 * combined. Native starts, terminal states, corrections, links and interaction
 * records are ordering boundaries and always pass through immediately. */
function candidate(agentId: string, notification: SessionNotification): { key: string; kind: Stream["kind"]; length: number } | null {
  const update = notification.update;
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    if (!update.messageId || update.textMode || update.content.type !== "text" || !update.content.text ||
        (update.sessionUpdate === "agent_thought_chunk" && update.durationMs != null)) return null;
    const { content, ...metadata } = update;
    return { key: JSON.stringify([agentId, notification.executionId, metadata, content.annotations]), kind: "text", length: content.text.length };
  }
  if (update.sessionUpdate === "tool_call_update" && typeof update.rawOutput === "string" &&
      update.status !== "completed" && update.status !== "failed" && Object.keys(update).every((key) => OUTPUT_FIELDS.has(key))) {
    return { key: JSON.stringify([agentId, notification.executionId, update.sessionUpdate, update.toolCallId, update.status]), kind: "output", length: update.rawOutput.length };
  }
  return null;
}

/** A Local execution retains at most one pending update and one short timer.
 * First output stays immediate; no timer or polling exists without a delta.
 * Cloud callers bypass the buffer with their original notification object. */
export class LocalSessionUpdateBatcher {
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly emit: (agentId: string, notification: SessionNotification) => void) {}

  push(agentId: string, notification: SessionNotification, local = true): void {
    const executionId = notification.executionId ?? notification.sessionId;
    const next = local ? candidate(agentId, notification) : null;
    if (!next || next.length > MAX_PENDING_CHARS) {
      this.flush(executionId);
      this.emit(agentId, notification);
      return;
    }
    let stream = this.streams.get(executionId);
    if (!stream || stream.key !== next.key) {
      this.flush(executionId);
      if (this.streams.size >= MAX_EXECUTIONS) this.flush(this.streams.keys().next().value!);
      stream = { agentId, key: next.key, kind: next.kind };
      this.streams.set(executionId, stream);
      this.emit(agentId, notification);
      return;
    }
    let pending = notification;
    if (stream.kind === "text" && stream.pending) {
      const previous = stream.pending.update as TextUpdate;
      const update = notification.update as TextUpdate;
      if (previous.content.text.length + update.content.text.length > MAX_PENDING_CHARS) {
        this.flushPending(stream);
        this.emit(agentId, notification);
        return;
      }
      pending = { ...notification, update: { ...update, content: { ...update.content, text: previous.content.text + update.content.text } } };
    } else if (notification.update.sessionUpdate === "tool_call_update") {
      // Tools already carry an event time on the existing wire. Preserve the
      // last native observation's clock even when its delivery is combined.
      pending = { ...notification, update: { ...notification.update, at: notification.update.at ?? Date.now() } };
    }
    stream.pending = pending;
    if (!stream.timer) {
      stream.timer = setTimeout(() => this.flushPending(stream!), DELAY_MS);
      stream.timer.unref?.();
    }
  }

  /** Drain before permission/turn/lifecycle boundaries or route retirement. */
  flush(executionId?: string): void {
    const executions = executionId === undefined ? [...this.streams.keys()] : [executionId];
    for (const id of executions) {
      const stream = this.streams.get(id);
      if (!stream) continue;
      this.streams.delete(id);
      this.flushPending(stream);
    }
  }

  private flushPending(stream: Stream): void {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
    const notification = stream.pending;
    stream.pending = undefined;
    if (notification) this.emit(stream.agentId, notification);
  }
}
