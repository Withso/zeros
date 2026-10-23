import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { applyUpdate, type AgentMessage, type AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { AgentPromptBubble, SteerOutcome } from "@zeros/protocol/messages";
import { CloudV2MessageRowSchema, type CloudV2MessageRow } from "@zeros/protocol/cloud-v2-relay";
import { providerBindingForResume } from "@zeros/protocol/identities";
import { coerceChat, messageWindow, upsertRows, type ChatRow, type MessageWindow } from "./chat-history";
import { WorkspaceError } from "../workspace/scope";
import { CloudV2PromptCounterSchema, CloudV2PromptStateSchema, type CloudV2PromptDelivery, type CloudV2PromptState } from "@zeros/protocol/cloud-v2-prompts";

const outboxInputSchema = z.object({ deliveryId: z.string().uuid(), epoch: CloudV2PromptCounterSchema, sequence: CloudV2PromptCounterSchema,
  model: z.string().max(256).optional(), effort: z.string().max(64).optional(), mode: z.enum(["prompt", "steer"]).optional(),
  acknowledged: z.boolean(), dispatchId: z.string().uuid().optional(), accepted: z.boolean().optional(),
  steerDeclined: z.boolean().optional(), reported: CloudV2PromptStateSchema.optional() }).strict();

export interface OutboxInput {
  deliveryId: string; epoch: string; sequence: string;
  model?: string; effort?: string; mode?: "prompt" | "steer";
  acknowledged: boolean; dispatchId?: string; accepted?: boolean;
  steerDeclined?: boolean;
  reported?: CloudV2PromptState;
}

export interface PromptInput {
  requestId: string;
  userMessageId: string;
  prompt: ContentBlock[];
  bubble?: AgentPromptBubble;
  startedAt: number;
  promptId?: string;
  /** Present only for capability-gated HTTPS sends, never for Local/legacy. */
  outbox?: OutboxInput;
}
export interface InboxEntry extends PromptInput {
  state: "queued" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
  response?: PromptResponse;
  error?: string;
  cancelRequested?: boolean;
}
export interface SteerReceipt extends Omit<PromptInput, "startedAt"> {
  attemptId: string;
  executionId: string;
  turnId?: string;
  createdAt: number;
  outcome: SteerOutcome | "pending";
}
export interface SessionData {
  version: 1;
  /** Persisted insertion order, matching Local's rowid tie-break for summaries. */
  ordinal?: number;
  workspaceKey: string;
  chatId: string;
  chat: ChatRow | null;
  nativeSessionId?: string;
  /** The worker route the app holds for this chat. A restarted worker
   * re-adopts only this one, so replaced or closed routes stay refused. */
  executionId?: string;
  paused: boolean;
  deliveryEpoch?: string;
  /** Live reducer state; only rows are serialized to disk. */
  messages: AgentMessage[];
  rows: CloudV2MessageRow[];
  inbox: InboxEntry[];
  steers: SteerReceipt[];
}
export interface SessionChange {
  chatId: string;
  chat?: ChatRow;
  deleted?: true;
  rows: CloudV2MessageRow[];
  /** A durable control/turn boundary must flush any pending mirrored rows. */
  flush?: true;
}

const established = (data: SessionData | undefined): boolean => !!data && !!(
  data.nativeSessionId || data.chat?.providerBinding || data.chat?.sessionId ||
  data.rows.length || data.inbox.length || data.steers.length
);

export function userMessage(input: PromptInput, steeredTurnId?: string): AgentTextMessage {
  const { bubble } = input;
  return {
    id: input.userMessageId, kind: "text", role: "user",
    text: bubble?.displayText ?? input.prompt.map((block) => block.type === "text" ? block.text : "").join(""),
    createdAt: input.startedAt,
    ...(steeredTurnId ? { steeredTurnId } : {}),
    ...(bubble?.retryText != null ? { retryText: bubble.retryText } : {}),
    ...(bubble?.segments?.length ? { segments: bubble.segments } : {}),
    ...(bubble?.attachments?.length ? { attachments: bubble.attachments } : {}),
    ...(bubble?.autoAction != null ? { autoAction: bubble.autoAction } : {}),
  };
}
const persisted = (message: AgentMessage): CloudV2MessageRow => ({ msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: message.createdAt });
const transcript = (rows: CloudV2MessageRow[]): AgentMessage[] => rows.flatMap((row) => {
  try {
    const value = JSON.parse(row.payload);
    return value && typeof value === "object" && typeof value.id === "string" && typeof value.kind === "string" && typeof value.createdAt === "number" ? [value as AgentMessage] : [];
  } catch { return []; }
});

export function recordUser(draft: SessionData, input: PromptInput, steeredTurnId?: string): void {
  const message = userMessage(input, steeredTurnId);
  draft.messages = applyUpdate(draft.messages, { sessionId: "", update: { sessionUpdate: "user_message_recorded", message } });
  upsertRows(draft.rows, [persisted(draft.messages.find((entry) => entry.id === message.id)!)]);
}

/** One atomic JSON snapshot per chat. The VM disk owns the inbox and native
 * identity; changed canonical rows are also mirrored to the control plane. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(change: SessionChange) => void>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writeFailures = new Map<string, unknown>();
  private readonly errorListeners = new Set<(chatId: string) => void>();
  private nextOrdinal = 0;

  private constructor(private readonly directory: string, readonly workspaceKey: string) {}

  static async open(directory: string, workspaceKey: string): Promise<SessionStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new SessionStore(directory, workspaceKey);
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: SessionData;
      try {
        if (!(await file.stat()).isFile()) throw new Error("Invalid session store file.");
        value = JSON.parse(await file.readFile("utf8")) as SessionData;
      } catch { throw new Error("Cannot read a persisted chat. Its data has been retained."); }
      finally { await file.close(); }
      if (value.version !== 1 || value.workspaceKey !== workspaceKey) throw new Error("Session store belongs to a different workspace or version.");
      if (typeof value.chatId !== "string" || store.filename(value.chatId) !== name ||
          !Array.isArray(value.rows) || !Array.isArray(value.inbox) || !Array.isArray(value.steers) ||
          (value.executionId !== undefined && typeof value.executionId !== "string") ||
          (value.deliveryEpoch !== undefined && !CloudV2PromptCounterSchema.safeParse(value.deliveryEpoch).success) ||
          value.inbox.some(entry => entry.outbox !== undefined && !outboxInputSchema.safeParse(entry.outbox).success) ||
          (value.chat !== null && (!coerceChat(value.chat) || value.chat.id !== value.chatId))) throw new Error("Invalid persisted chat.");
      value.messages = transcript(value.rows);
      if (Number.isSafeInteger(value.ordinal) && value.ordinal! > store.nextOrdinal) store.nextOrdinal = value.ordinal!;
      store.sessions.set(value.chatId, value);
      // Mark native dispatch BEFORE calling the driver. After a crash there is
      // no evidence that it was unconsumed, so only a fresh explicit send resumes.
      if (value.inbox.some((entry) => entry.state === "running" || entry.state === "queued" && (entry.outbox?.acknowledged || !!entry.outbox?.dispatchId)) || value.steers.some((entry) => entry.outcome === "pending")) {
        await store.update(value.chatId, (draft) => {
          draft.paused = true;
          // A prior boot's inbox ACK is no authority for this process. Pull
          // again before dispatch so Stop and authorization are revalidated.
          for (const entry of draft.inbox) if (entry.state === "queued" && entry.outbox) entry.outbox.acknowledged = false;
          for (const entry of draft.inbox) if (entry.state === "running" || entry.state === "queued" && !!entry.outbox?.dispatchId) {
            entry.state = "interrupted";
            entry.error = "The worker restarted before this turn finished. Send a new message to continue.";
          }
          for (const receipt of draft.steers) if (receipt.outcome === "pending") {
            receipt.outcome = "interrupted";
            recordUser(draft, { ...receipt, startedAt: receipt.createdAt }, receipt.turnId);
          }
        });
      }
    }
    for (const value of store.sessions.values()) if (!Number.isSafeInteger(value.ordinal) || value.ordinal! <= 0) value.ordinal = ++store.nextOrdinal;
    return store;
  }

  snapshot(chatId: string): SessionData | undefined {
    const value = this.sessions.get(chatId);
    return value ? structuredClone(value) : undefined;
  }

  /** Routing reads must not clone the transcript on every prompt or event. */
  metadata(chatId: string): Pick<SessionData, "chat" | "nativeSessionId" | "executionId" | "paused"> | undefined {
    const value = this.sessions.get(chatId);
    return value ? structuredClone({ chat: value.chat, nativeSessionId: value.nativeSessionId, executionId: value.executionId, paused: value.paused }) : undefined;
  }

  chatForExecution(executionId: string): string | undefined {
    for (const value of this.sessions.values()) if (value.chat && value.executionId === executionId) return value.chatId;
    return undefined;
  }

  history(chatId: string): readonly CloudV2MessageRow[] { return this.sessions.get(chatId)?.rows ?? []; }

  canRebind(chatId: string): boolean {
    const data = this.sessions.get(chatId);
    return data?.chat !== null && !established(data);
  }

  hasQueued(chatId: string): boolean {
    const value = this.sessions.get(chatId);
    const entry = value?.chat && value.inbox.find(entry => entry.state === "queued" && (!value.paused || !!entry.outbox));
    return !!entry && (!entry.outbox || entry.outbox.acknowledged);
  }

  receipt(chatId: string, requestId: string): InboxEntry | undefined {
    return structuredClone(this.sessions.get(chatId)?.inbox.find((entry) => entry.requestId === requestId));
  }

  latestReceipt(chatId: string): InboxEntry | undefined {
    const inbox = this.sessions.get(chatId)?.inbox;
    for (let i = (inbox?.length ?? 0) - 1; i >= 0; i--) {
      if (inbox![i].state !== "queued") return structuredClone(inbox![i]);
    }
    return undefined;
  }

  steerReceipt(chatId: string, executionId: string, attemptId: string): SteerReceipt | undefined {
    return structuredClone(this.sessions.get(chatId)?.steers.find((entry) => entry.executionId === executionId && entry.attemptId === attemptId));
  }

  list(): { chats: ChatRow[]; chatDeletions: string[] } {
    return structuredClone({
      chats: [...this.sessions.values()].flatMap((value) => value.chat ? [value.chat] : []).sort((a, b) => b.updatedAt - a.updatedAt),
      chatDeletions: [...this.sessions.values()].filter((value) => !value.chat).map((value) => value.chatId),
    });
  }

  titleSeeds(chatIds: readonly string[]) {
    return [...new Set(chatIds.slice(0, 50))].flatMap(chatId => {
      const session = this.sessions.get(chatId);
      if (!session?.chat) return [];
      const index = session.messages.findIndex(message => message.kind === "text" && message.role === "user"
        && message.localNote == null && typeof message.text === "string");
      const first = session.messages[index];
      if (first?.kind !== "text" || !first.text.trim()) return [];
      const answered = session.messages.slice(index + 1).some(message => message.kind === "tool" ||
        (message.kind === "text" && message.role === "agent" && message.modelFallback == null && !!message.text.trim())) ||
        session.inbox.some(entry => entry.userMessageId === first.id && ["completed", "failed", "cancelled", "interrupted"].includes(entry.state));
      // The renderer's title request keeps the first 400 and last 100 Unicode
      // characters. Bound the wire payload to that same input, without secrets
      // or full transcripts leaving the VM just to name a chat.
      const chars = Array.from(first.text.trim());
      const prompt = chars.length <= 500 ? chars.join("") : chars.slice(0, 400).join("") + chars.slice(-100).join("");
      return [{ chatId, messageId: first.id, prompt, answered }];
    });
  }

  summariesForFolder(folder: string, excludeChatId?: string) {
    return [...this.sessions.values()].filter(session => session.chat?.folder === folder && session.chatId !== excludeChatId)
      .sort((a, b) => b.chat!.createdAt - a.chat!.createdAt || (b.ordinal ?? 0) - (a.ordinal ?? 0)).flatMap(session => {
        const chat = session.chat!;
        const user = session.messages.filter(message => message.kind === "text" && message.role === "user");
        if (!user.length) return [];
        const first = user.find(message => message.kind === "text" && typeof message.text === "string");
        return [{ chatId: chat.id, title: chat.title, folder: chat.folder, summary: first?.kind === "text" ? first.text : "", summaryAt: 0,
          agentId: chat.agentId, agentName: chat.agentName, userMessageCount: user.length,
          lastMessageAt: session.rows.reduce((latest, row) => Math.max(latest, row.createdAt), 0) }];
      });
  }

  async upsert(input: unknown): Promise<void> {
    const chat = coerceChat(input);
    if (!chat) return;
    await this.change(chat.id, (draft) => {
      const previous = draft.chat;
      if (previous) {
        if (established(draft) && chat.agentId !== previous.agentId) throw new Error("This chat belongs to a different agent.");
        draft.chat = { ...chat, createdAt: previous.createdAt, composerModeRevision: previous.composerModeRevision,
          sessionId: previous.sessionId, providerBinding: previous.providerBinding, providerMetadata: previous.providerMetadata };
      } else draft.chat = chat;
    }, chat);
  }

  /** Serialize selection with the inbox and imported history. Only untouched
   * conversations may change provider; a queued first Send already owns it. */
  async selectAgent(input: { id: string; folder: string; agentId: string; agentName: string; model?: string; effort?: string; executionId: string }, admit: () => void): Promise<ChatRow> {
    const { executionId, ...selection } = input;
    const initial = coerceChat({ ...selection, createdAt: Date.now(), updatedAt: Date.now() })!;
    return this.change(input.id, (draft) => {
      admit();
      draft.executionId = executionId;
      const chat = draft.chat!;
      if (chat.agentId !== input.agentId) {
        if (established(draft)) throw new WorkspaceError("session-expired", "This conversation belongs to another agent.");
        chat.agentId = input.agentId; chat.agentName = input.agentName;
        chat.model = input.model ?? null; chat.effort = input.effort ?? "";
        chat.updatedAt = Date.now();
      } else if (!established(draft)) {
        if (input.model !== undefined && input.model !== chat.model) { chat.model = input.model; chat.effort = ""; }
        if (input.effort !== undefined) chat.effort = input.effort;
      }
      return chat;
    }, initial);
  }

  async bind(chatId: string, agentId: string, nativeSessionId: string): Promise<void> {
    await this.update(chatId, (draft) => {
      if (draft.chat!.agentId && draft.chat!.agentId !== agentId) throw new Error("This chat belongs to a different agent.");
      draft.nativeSessionId = nativeSessionId;
      draft.chat!.agentId = agentId;
      draft.chat!.sessionId = nativeSessionId;
      draft.chat!.providerBinding = providerBindingForResume(agentId, nativeSessionId);
    });
  }

  async delete(chatId: string): Promise<void> {
    // Tombstones also cover an unknown id, so a delayed renderer upsert cannot
    // resurrect a conversation after a deletion races its initial creation.
    await this.change(chatId, (draft) => {
      draft.chat = null; draft.rows = []; draft.messages = []; draft.inbox = []; draft.steers = [];
      draft.nativeSessionId = undefined; draft.executionId = undefined; draft.paused = true;
    }, null, true);
  }

  window(chatId: string, limit = 200, before?: number): MessageWindow {
    return messageWindow(this.sessions.get(chatId)?.rows ?? [], limit, before);
  }

  older(chatId: string, beforeMsgId: string, limit = 200): MessageWindow {
    const rows = this.sessions.get(chatId)?.rows ?? [];
    const index = rows.findIndex((row) => row.msgId === beforeMsgId);
    return index < 0 ? { messages: [] } : messageWindow(rows, limit, index + 1);
  }

  async importMessages(chatId: string, input: unknown[]): Promise<number> {
    if (input.length > 5000) throw new Error("messages.import: batch too large (max 5000 messages).");
    const rows = input.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      const parsed = CloudV2MessageRowSchema.safeParse({ msgId: row.msgId, kind: typeof row.kind === "string" ? row.kind : "", payload: row.payload, createdAt: typeof row.createdAt === "number" ? row.createdAt : 0 });
      if (!parsed.success) return [];
      try { JSON.parse(parsed.data.payload); return [parsed.data]; } catch { return []; }
    });
    await this.update(chatId, (draft) => {
      upsertRows(draft.rows, rows);
      const current = new Map(draft.messages.map((message) => [message.id, message]));
      const incoming = new Map(transcript(rows).map((message) => [message.id, message]));
      draft.messages = draft.rows.flatMap((row) => {
        const message = incoming.get(row.msgId) ?? current.get(row.msgId);
        return message ? [message] : [];
      });
    });
    return rows.length;
  }

  async fold(chatId: string, notification: SessionNotification): Promise<void> {
    await this.serialize(chatId, () => {
      const current = this.sessions.get(chatId);
      if (!current) throw new Error("Unknown chat.");
      if (!current.chat) throw new Error("Cloud conversation was deleted.");
      if (this.writeFailures.has(chatId)) throw new Error("Cannot save this conversation.");
      const previous = current.messages;
      const folded = applyUpdate(previous, notification);
      if (folded === previous) return;
      const unchanged = new Set(previous);
      const changed = folded.filter((message) => !unchanged.has(message)).map(persisted);
      if (!changed.length) return;
      // Keep immutable message objects and row payload strings shared. A token
      // must not clone or JSON-encode all earlier turns in a long conversation.
      const rows = current.rows.slice();
      upsertRows(rows, changed);
      this.sessions.set(chatId, { ...current, messages: folded, rows });
      this.dirty.add(chatId);
      if (!this.timers.has(chatId)) {
        // Crash window: 500 ms of streamed transcript plus in-flight disk I/O.
        // Inbox, metadata and turn completion remain immediately durable.
        const timer = setTimeout(() => {
          this.timers.delete(chatId);
          void this.flushChat(chatId).catch((error: unknown) => {
            this.writeFailures.set(chatId, error);
            for (const listener of this.errorListeners) listener(chatId);
          });
        }, 500);
        timer.unref?.();
        this.timers.set(chatId, timer);
      }
      for (const listener of this.listeners) listener(structuredClone({ chatId, rows: changed }));
    });
  }

  async enqueue(chatId: string, input: PromptInput, admit?: () => void): Promise<{ entry: InboxEntry; duplicate: boolean }> {
    return this.change(chatId, (draft) => {
      admit?.();
      if (input.outbox && BigInt(input.outbox.epoch) > BigInt(draft.deliveryEpoch ?? "0")) draft.deliveryEpoch = input.outbox.epoch;
      const existing = draft.inbox.find((entry) => entry.requestId === input.requestId || entry.userMessageId === input.userMessageId);
      if (existing) {
        if (JSON.stringify(existing.prompt) !== JSON.stringify(input.prompt) || JSON.stringify(existing.bubble) !== JSON.stringify(input.bubble))
          throw new Error("That message was already submitted with different content.");
        if (input.outbox) existing.outbox = { ...input.outbox, ...existing.outbox, deliveryId: input.outbox.deliveryId,
          acknowledged: false, reported: undefined };
        return { entry: existing, duplicate: true };
      }
      const entry: InboxEntry = { ...input, state: "queued" };
      // A new explicit Send resumes Stop's pause and takes precedence over
      // retained follow-ups; a duplicate receipt lookup never releases it.
      const firstQueued = draft.inbox.findIndex((item) => item.state === "queued");
      if (draft.paused && firstQueued >= 0) draft.inbox.splice(firstQueued, 0, entry);
      else draft.inbox.push(entry);
      draft.paused = false;
      return { entry, duplicate: false };
    });
  }

  async claim(chatId: string): Promise<InboxEntry | undefined> {
    return this.change(chatId, (draft) => {
      if (draft.inbox.some((entry) => entry.state === "running")) return undefined;
      const entry = draft.inbox.find((entry) => entry.state === "queued" && (!draft.paused || !!entry.outbox));
      if (entry?.outbox) return entry.outbox.acknowledged ? entry : undefined;
      if (entry) { entry.state = "running"; recordUser(draft, entry); }
      return entry;
    });
  }

  async finish(chatId: string, requestId: string, response?: PromptResponse, error?: string): Promise<void> {
    await this.update(chatId, (draft) => {
      const entry = draft.inbox.find((entry) => entry.requestId === requestId);
      if (!entry || (entry.state !== "running" && !(entry.outbox && entry.state === "queued"))) return;
      if (entry.outbox) recordUser(draft, entry);
      entry.state = entry.cancelRequested || response?.stopReason === "cancelled" ? "cancelled" : error ? "failed" : "completed";
      entry.response = entry.state === "cancelled" ? { ...response, stopReason: "cancelled" } : response;
      entry.error = error;
    });
  }

  async retireExecution(chatId: string, executionId: string): Promise<void> {
    if (this.sessions.get(chatId)?.executionId !== executionId) return;
    await this.update(chatId, (draft) => { if (draft.executionId === executionId) draft.executionId = undefined; });
  }

  outboxEntries(chatId?: string): Array<{ chatId: string; entry: InboxEntry }> {
    return structuredClone([...this.sessions.values()].filter(value => value.chat && (!chatId || value.chatId === chatId))
      .flatMap(value => value.inbox.filter(entry => entry.outbox).map(entry => ({ chatId: value.chatId, entry }))));
  }

  async receiveOutbox(item: CloudV2PromptDelivery): Promise<InboxEntry> {
    const { payload, receipt, deliveryId } = item;
    const { entry } = await this.enqueue(payload.chatId, { requestId: `outbox:${payload.userMessageId}`,
      userMessageId: payload.userMessageId, prompt: payload.prompt, bubble: payload.bubble, startedAt: payload.startedAt,
      outbox: { deliveryId, epoch: receipt.epoch, sequence: receipt.sequence, model: payload.model, effort: payload.effort, mode: payload.mode, acknowledged: false } });
    return entry;
  }

  async acknowledgeOutbox(chatId: string, requestId: string, state: CloudV2PromptState): Promise<void> {
    await this.update(chatId, draft => {
      const entry = draft.inbox.find(value => value.requestId === requestId);
      if (!entry?.outbox) return;
      entry.outbox.acknowledged = true;
      if (entry.state === "queued" && (["cancelled", "failed", "interrupted", "completed"].includes(state) ||
          BigInt(entry.outbox.epoch) < BigInt(draft.deliveryEpoch ?? "0"))) {
        entry.state = state === "failed" || state === "interrupted" || state === "completed" ? state : "cancelled";
        entry.cancelRequested = true;
      }
    });
  }

  /** This is the narrow uncertainty boundary: after this fsync a crash may
   * have reached the provider. A new process reports interrupted, never replay. */
  async prepareOutboxDispatch(chatId: string, requestId: string, steering = false): Promise<InboxEntry | undefined> {
    return this.change(chatId, draft => {
      const entry = draft.inbox.find(value => value.requestId === requestId);
      if (!entry?.outbox || entry.state !== "queued" || !entry.outbox.acknowledged || entry.cancelRequested ||
          BigInt(entry.outbox.epoch) < BigInt(draft.deliveryEpoch ?? "0")) return undefined;
      entry.outbox.dispatchId ??= randomUUID();
      entry.state = "running";
      if (!steering) recordUser(draft, entry);
      return entry;
    });
  }

  async finishOutboxSteer(chatId: string, requestId: string, outcome: SteerOutcome, turnId: string): Promise<void> {
    await this.update(chatId, draft => {
      const entry = draft.inbox.find(value => value.requestId === requestId);
      if (!entry?.outbox || entry.state !== "running") return;
      if (entry.cancelRequested) entry.state = "cancelled";
      else if (outcome === "queued") { entry.state = "queued"; entry.outbox.steerDeclined = true; }
      else if (outcome === "delivered") { entry.state = "completed"; entry.outbox.accepted = true; recordUser(draft, entry, turnId); }
      else entry.state = "interrupted";
    });
  }

  async acceptOutbox(chatId: string, requestId: string): Promise<void> {
    await this.update(chatId, draft => {
      const entry = draft.inbox.find(value => value.requestId === requestId);
      if (entry?.outbox && entry.state === "running") entry.outbox.accepted = true;
    });
  }

  async reportOutbox(chatId: string, requestId: string, state: CloudV2PromptState): Promise<void> {
    await this.update(chatId, draft => {
      const entry = draft.inbox.find(value => value.requestId === requestId);
      if (entry?.outbox) entry.outbox.reported = state;
    });
  }

  async stopOutbox(chatId: string, epoch: string): Promise<void> {
    if (!this.metadata(chatId)?.chat) return;
    await this.update(chatId, draft => {
      if (BigInt(epoch) > BigInt(draft.deliveryEpoch ?? "0")) draft.deliveryEpoch = epoch;
      for (const entry of draft.inbox) if (entry.outbox && BigInt(entry.outbox.epoch) < BigInt(epoch)) {
        if (entry.state === "queued") entry.state = "cancelled";
        if (entry.state === "running" || entry.state === "cancelled") entry.cancelRequested = true;
      }
    });
  }

  deliveryEpoch(chatId: string): string { return this.sessions.get(chatId)?.deliveryEpoch ?? "0"; }

  async stop(chatId: string, current: () => boolean = () => true): Promise<void> {
    await this.update(chatId, (draft) => {
      if (!current()) return;
      draft.paused = true;
      for (const entry of draft.inbox) if (entry.state === "running") entry.cancelRequested = true;
    });
  }

  async update(chatId: string, edit: (draft: SessionData) => void): Promise<void> { await this.change(chatId, edit); }
  onChange(listener: (change: SessionChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onError(listener: (chatId: string) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  async flush(): Promise<void> {
    await Promise.all(this.pending.values());
    await Promise.all([...this.dirty].map((chatId) => this.flushChat(chatId)));
    if (this.writeFailures.size) throw new Error("Cannot save this conversation.");
  }

  private async flushChat(chatId: string): Promise<void> {
    await this.serialize(chatId, async () => {
      this.clearTimer(chatId);
      if (!this.dirty.has(chatId)) return;
      await this.save(this.sessions.get(chatId)!);
      this.dirty.delete(chatId);
      this.writeFailures.delete(chatId);
    });
  }

  private clearTimer(chatId: string): void {
    clearTimeout(this.timers.get(chatId));
    this.timers.delete(chatId);
  }

  private change<T>(chatId: string, edit: (draft: SessionData) => T, initial?: ChatRow | null, allowDeleted = false): Promise<T> {
    return this.serialize(chatId, async () => {
      const previous = this.sessions.get(chatId);
      if (previous?.chat === null && !allowDeleted) throw new Error("Cloud conversation was deleted.");
      if (!previous && initial === undefined) throw new Error("Unknown chat.");
      const draft: SessionData = structuredClone(previous ?? {
        version: 1, ordinal: ++this.nextOrdinal, workspaceKey: this.workspaceKey, chatId, chat: initial ?? null, paused: false, messages: [], rows: [], inbox: [], steers: [],
      });
      const result = edit(draft);
      if (JSON.stringify(draft) === JSON.stringify(previous)) return structuredClone(result);
      await this.save(draft);
      this.clearTimer(chatId);
      this.dirty.delete(chatId);
      this.writeFailures.delete(chatId);
      this.sessions.set(chatId, draft);
      const oldRows = new Map(previous?.rows.map((row) => [row.msgId, row]));
      const changed = draft.rows.filter((row) => JSON.stringify(oldRows.get(row.msgId)) !== JSON.stringify(row));
      const chatChanged = JSON.stringify(previous?.chat) !== JSON.stringify(draft.chat);
      for (const listener of this.listeners) listener(structuredClone({
        chatId, rows: changed, flush: true as const, ...(chatChanged ? draft.chat ? { chat: draft.chat } : { deleted: true as const } : {}),
      }));
      return structuredClone(result);
    });
  }

  private serialize<T>(chatId: string, action: () => T | Promise<T>): Promise<T> {
    const operation = (this.pending.get(chatId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(chatId, operation);
    // Observe rejections for the event-stream callers; the returned operation
    // still rejects to its owner. A failed write never publishes a new snapshot.
    void operation.catch(() => {}).finally(() => { if (this.pending.get(chatId) === operation) this.pending.delete(chatId); });
    return operation;
  }

  private filename(chatId: string): string { return `${createHash("sha256").update(chatId).digest("hex")}.json`; }
  private async save(data: SessionData): Promise<void> {
    const destination = join(this.directory, this.filename(data.chatId));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      const { messages: _liveMessages, ...saved } = data;
      try { await file.writeFile(JSON.stringify(saved)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, destination);
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
}
