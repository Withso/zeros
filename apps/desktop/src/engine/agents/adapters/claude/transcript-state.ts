import { randomUUID } from "node:crypto";
import type { SessionNotification } from "../../types";

type Block = { type: string; id?: string; text?: string; thinking?: string };
const MAX_RETAINED_MESSAGES = 2_000;
type TextBlock = {
  id: string;
  text: string;
  thought: boolean;
  retracted?: boolean;
  redacted?: boolean;
  phase?: "commentary" | "final_answer";
};
type Message = {
  nativeId?: string;
  completed: boolean;
  snapshotCompleted: boolean;
  hasTools?: boolean;
  blocks: Map<number, TextBlock>;
  nativeBlocks: Map<number, { type: string; id?: string }>;
  completedBlocks: Set<number>;
  frames: Set<string>;
};
type StreamEvent = {
  type?: string;
  index?: number;
  message?: { id?: string };
  content_block?: Block;
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null };
};

/** Anthropic message ids and block indices identify snapshots, not their text.
 * Each instance belongs to one provider execution. Parent streams have separate
 * active messages; retained native records let reconnects reconcile in place. */
export class ClaudeTranscriptState {
  private readonly frames = new Map<string, { parent: string; message: Message; indices: number[] }>();
  private readonly messages = new Map<string, Message>();
  private readonly active = new Map<string, Message>();
  private readonly unparented = new Map<string, Set<string>>();
  private readonly parents = new Map<string, string>();
  private finalResult: { text: string; id?: string } | undefined;

  constructor(
    private readonly emit: (update: SessionNotification["update"]) => void,
  ) {}

  boundary(parent = ""): void {
    const message = this.active.get(parent);
    if (message) message.completed = true;
    this.active.delete(parent);
  }
  beginTurn(): void {
    this.active.delete("");
    this.finalResult = undefined;
  }

  /** A wire UUID owns completed SDK blocks, not the entire API message. */
  retract(frameId: string): { messageIds: string[]; tools: Array<{ parent: string; id: string }> } {
    const frame = this.frames.get(frameId);
    const messageIds: string[] = [];
    const tools: Array<{ parent: string; id: string }> = [];
    if (!frame) return { messageIds, tools };
    for (const index of frame.indices) {
      const block = frame.message.blocks.get(index);
      if (block && !block.retracted) { block.retracted = true; block.text = ""; messageIds.push(block.id); }
      const native = frame.message.nativeBlocks.get(index);
      if (native?.type === "tool_use" && native.id) tools.push({ parent: frame.parent, id: native.id });
    }
    this.frames.delete(frameId);
    return { messageIds, tools };
  }

  isReplay(nativeId: string | undefined, parent = "", frameId?: string): boolean {
    if (!nativeId) return false;
    const message = this.messages.get(this.key(parent, nativeId));
    return frameId ? message?.frames.has(frameId) === true : message?.snapshotCompleted === true;
  }

  isStreamReplay(event: StreamEvent, parent = ""): boolean {
    if (event.type === "message_start")
      return !!event.message?.id && this.messages.get(this.key(parent, event.message.id))?.completed === true;
    const message = this.active.get(parent);
    return message?.completed === true ||
      ((event.type === "content_block_start" || event.type === "content_block_delta") && message?.completedBlocks.has(event.index ?? 0) === true);
  }

  trackParent(parent: string, id: string): void {
    if (!parent || this.parents.has(parent)) return;
    const ids = this.unparented.get(parent) ?? new Set<string>();
    ids.add(id);
    if (ids.size > MAX_RETAINED_MESSAGES)
      ids.delete(ids.values().next().value!);
    this.unparented.set(parent, ids);
    if (this.unparented.size > MAX_RETAINED_MESSAGES)
      this.unparented.delete(this.unparented.keys().next().value!);
  }

  attachParent(parent: string, toolCallId: string): void {
    this.parents.set(parent, toolCallId);
    if (this.parents.size > MAX_RETAINED_MESSAGES)
      this.parents.delete(this.parents.keys().next().value!);
    const ids = this.unparented.get(parent);
    if (ids?.size)
      this.emit({
        sessionUpdate: "message_parent_update",
        messageIds: [...ids],
        parentToolId: toolCallId,
      });
    this.unparented.delete(parent);
  }

  stream(event: StreamEvent, parent = "", parentToolId?: string): void {
    if (event.type === "message_start") {
      const message = this.message(event.message?.id, parent);
      if (!message.completed) this.resumeOutput(parent);
      this.active.set(parent, message);
      return;
    }
    if (event.type === "message_delta") {
      this.endMessage(event.delta?.stop_reason, parent, parentToolId);
      return;
    }
    if (event.type === "message_stop") {
      const message = this.active.get(parent);
      if (message) message.completed = true;
      return;
    }
    if (
      event.type !== "content_block_delta" &&
      event.type !== "content_block_start"
    )
      return;
    let message = this.active.get(parent);
    if (!message) {
      message = this.message(undefined, parent);
      this.active.set(parent, message);
    }
    if (message.completed || message.completedBlocks.has(event.index ?? 0)) return;
    this.resumeOutput(parent);
    const index = event.index ?? 0;
    const delta = event.delta;
    const initial = event.content_block;
    if (initial) message.nativeBlocks.set(index, { type: initial.type, id: initial.id });
    if (initial?.type === "tool_use") message.hasTools = true;
    const thought =
      delta?.type === "thinking_delta" || initial?.type === "thinking";
    const text =
      delta?.type === "text_delta"
        ? delta.text
        : delta?.type === "thinking_delta"
          ? delta.thinking
          : initial?.type === "text"
            ? initial.text
            : initial?.type === "thinking"
              ? initial.thinking
              : undefined;
    if (typeof text !== "string" || !text) return;
    if (!message.nativeBlocks.has(index)) message.nativeBlocks.set(index, { type: thought ? "thinking" : "text" });
    const block = this.block(message, index, thought);
    // Non-empty block starts are snapshots. Ordinary deltas are incremental.
    this.write(
      block,
      event.type === "content_block_start" ? text : block.text + text,
      parentToolId,
      parent,
    );
  }

  complete(
    nativeId: string | undefined,
    blocks: Block[],
    parent = "",
    parentToolId?: string,
    onTool?: (index: number) => void,
    frameId?: string,
  ): void {
    const active = this.active.get(parent);
    let message = nativeId
      ? this.messages.get(this.key(parent, nativeId))
      : undefined;
    // Old/synthetic SDK frames can omit message_start. Adopt only an unnamed
    // live stream owned by this parent, never another native message's text.
    if (!message && active && !active.completed && !active.nativeId)
      message = active;
    if (!message) message = this.message(nativeId, parent);
    if (nativeId && !message.nativeId) {
      message.nativeId = nativeId;
      this.remember(this.key(parent, nativeId), message);
    }
    if (frameId ? message.frames.has(frameId) : message.snapshotCompleted) return;
    if (frameId) message.frames.add(frameId);
    this.resumeOutput(parent);
    if (!active || active === message || !active.nativeId || active.completed)
      this.active.set(parent, message);
    // The SDK emits one completed block per assistant UUID. Several of those
    // frames share an API message id; local content[0] is not API block zero.
    const fragment = !!frameId && blocks.length === 1;
    const indices: number[] = [];
    blocks.forEach((value, localIndex) => {
      const index = fragment ? this.fragmentIndex(message, value) : localIndex;
      indices.push(index);
      message.nativeBlocks.set(index, { type: value.type, id: value.id });
      if (value.type === "text" && typeof value.text === "string") {
        this.write(
          this.block(message, index, false),
          value.text,
          parentToolId,
          parent,
        );
      } else if (
        value.type === "thinking" &&
        typeof value.thinking === "string"
      ) {
        this.write(
          this.block(message, index, true),
          value.thinking,
          parentToolId,
          parent,
        );
      } else if (value.type === "redacted_thinking") {
        // A redacted sentinel annotates its preceding readable reasoning; it
        // must not print encrypted bytes or create a second empty thought.
        const previous = message.blocks.get(index - 1);
        const block = previous?.thought
          ? previous
          : this.block(message, index, true);
        if (!block.redacted) {
          block.redacted = true;
          this.write(block, block.text + " ", parentToolId, parent);
        }
      } else if (value.type === "tool_use") {
        message.hasTools = true;
        onTool?.(localIndex);
      }
      message.completedBlocks.add(index);
    });
    if (frameId) {
      this.frames.set(frameId, { parent, message, indices });
      if (this.frames.size > MAX_RETAINED_MESSAGES) this.frames.delete(this.frames.keys().next().value!);
    }
    if (!fragment) {
      message.completed = true;
      message.snapshotCompleted = true;
    }
  }

  private fragmentIndex(message: Message, block: Block): number {
    if (block.id) {
      for (const [index, value] of message.nativeBlocks)
        if (value.id === block.id) return index;
    }
    for (const [index, value] of message.nativeBlocks)
      if (!message.completedBlocks.has(index) && value.type === block.type) return index;
    return message.nativeBlocks.size ? Math.max(...message.nativeBlocks.keys()) + 1 : 0;
  }

  final(result: unknown, resultId?: string): void {
    if (
      typeof result !== "string" ||
      !result.trim() ||
      (result === this.finalResult?.text && resultId === this.finalResult?.id)
    )
      return;
    const message = this.active.get("");
    const text = message
      ? [...message.blocks.values()].filter((block) => !block.thought && !block.retracted)
      : [];
    if (message && !message.hasTools && text.length) {
      const full = text.map((block) => block.text).join("");
      if (
        full === result ||
        text.map((block) => block.text).join("\n\n") === result
      ) {
        for (const block of text) this.markFinal(block, block.text);
        this.finalResult = { text: result, id: resultId };
        return;
      }
      if (!message.completed && text.length === 1) {
        this.markFinal(text[0], result);
        message.completed = true;
        this.finalResult = { text: result, id: resultId };
        return;
      }
    }
    const recovered = this.message(undefined, "");
    this.markFinal(this.block(recovered, 0, false), result);
    recovered.completed = true;
    this.finalResult = { text: result, id: resultId };
  }

  /** An API reply can finish while the SDK waits for background children.
   * Its output remains an answer even if another reply follows in this send. */
  endMessage(
    stopReason: string | null | undefined,
    parent = "",
    parentToolId?: string,
    nativeId?: string,
  ): void {
    if (stopReason !== "end_turn") return;
    const message = nativeId
      ? this.messages.get(this.key(parent, nativeId))
      : this.active.get(parent);
    if (!message || message.hasTools) return;
    for (const block of message.blocks.values())
      if (!block.thought) this.markFinal(block, block.text, parent, parentToolId);
  }

  private markFinal(
    block: TextBlock,
    text: string,
    parent = "",
    parentToolId?: string,
  ): void {
    this.write(block, text, parentToolId, parent, "final_answer");
  }

  private resumeOutput(parent: string): void {
    if (parent) return;
    this.finalResult = undefined;
  }

  private key(parent: string, nativeId: string): string {
    return JSON.stringify([parent, nativeId]);
  }
  private message(nativeId: string | undefined, parent: string): Message {
    const key = nativeId ? this.key(parent, nativeId) : undefined;
    const previous = key ? this.messages.get(key) : undefined;
    if (previous) return previous;
    const message: Message = {
      nativeId, completed: false, snapshotCompleted: false, blocks: new Map(),
      nativeBlocks: new Map(), completedBlocks: new Set(), frames: new Set(),
    };
    if (key) this.remember(key, message);
    return message;
  }
  private remember(key: string, message: Message): void {
    this.messages.set(key, message);
    if (this.messages.size > MAX_RETAINED_MESSAGES) {
      const active = new Set(this.active.values());
      for (const [id, value] of this.messages) {
        if (!active.has(value)) {
          this.messages.delete(id);
          break;
        }
      }
      if (this.messages.size > MAX_RETAINED_MESSAGES)
        this.messages.delete(this.messages.keys().next().value!);
    }
  }
  private block(message: Message, index: number, thought: boolean) {
    let block = message.blocks.get(index);
    if (!block) {
      block = { id: randomUUID(), text: "", thought };
      message.blocks.set(index, block);
    }
    return block;
  }
  private write(
    block: TextBlock,
    text: string,
    parentToolId?: string,
    parent = "",
    phase?: "commentary" | "final_answer",
  ): void {
    if (block.retracted) return;
    if (text === block.text && (!phase || block.phase === phase)) return;
    if (phase) block.phase = phase;
    parentToolId ??= this.parents.get(parent);
    if (!parentToolId) this.trackParent(parent, block.id);
    const replace = !text.startsWith(block.text);
    const delta = replace ? text : text.slice(block.text.length);
    block.text = text;
    this.emit({
      sessionUpdate: block.thought
        ? "agent_thought_chunk"
        : "agent_message_chunk",
      messageId: block.id,
      content: { type: "text", text: delta },
      ...(replace ? { textMode: "replace" as const } : {}),
      ...(block.redacted ? { redacted: true } : {}),
      ...(block.phase ? { phase: block.phase } : {}),
      ...(parentToolId ? { parentToolId } : {}),
    });
  }
}
