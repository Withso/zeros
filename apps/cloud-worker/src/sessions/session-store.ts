import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { applyUpdate, type AgentMessage, type AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { AgentPromptBubble, SteerOutcome } from "@zeros/protocol/messages";
import { CloudV2MessageRowSchema, type CloudV2MessageRow } from "@zeros/protocol/cloud-v2-relay";
import { providerBindingForResume } from "@zeros/protocol/identities";
import { coerceChat, messageWindow, upsertRows, type ChatRow, type MessageWindow } from "./chat-history";

export interface PromptInput {
  requestId: string;
  userMessageId: string;
  prompt: ContentBlock[];
  bubble?: AgentPromptBubble;
  startedAt: number;
  promptId?: string;
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
  workspaceKey: string;
  chatId: string;
  chat: ChatRow | null;
  nativeSessionId?: string;
  paused: boolean;
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
}

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
          (value.chat !== null && (!coerceChat(value.chat) || value.chat.id !== value.chatId))) throw new Error("Invalid persisted chat.");
      value.messages = transcript(value.rows);
      store.sessions.set(value.chatId, value);
      // Mark native dispatch BEFORE calling the driver. After a crash there is
      // no evidence that it was unconsumed, so only a fresh explicit send resumes.
      if (value.inbox.some((entry) => entry.state === "running") || value.steers.some((entry) => entry.outcome === "pending")) {
        await store.update(value.chatId, (draft) => {
          draft.paused = true;
          for (const entry of draft.inbox) if (entry.state === "running") {
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
    return store;
  }

  snapshot(chatId: string): SessionData | undefined {
    const value = this.sessions.get(chatId);
    return value ? structuredClone(value) : undefined;
  }

  list(): { chats: ChatRow[]; chatDeletions: string[] } {
    return structuredClone({
      chats: [...this.sessions.values()].flatMap((value) => value.chat ? [value.chat] : []).sort((a, b) => b.updatedAt - a.updatedAt),
      chatDeletions: [...this.sessions.values()].filter((value) => !value.chat).map((value) => value.chatId),
    });
  }

  async upsert(input: unknown): Promise<void> {
    const chat = coerceChat(input);
    if (!chat) return;
    await this.change(chat.id, (draft) => {
      const previous = draft.chat;
      if (previous) {
        if (draft.nativeSessionId && chat.agentId !== previous.agentId) throw new Error("This chat belongs to a different agent.");
        draft.chat = { ...chat, createdAt: previous.createdAt, composerModeRevision: previous.composerModeRevision,
          sessionId: previous.sessionId, providerBinding: previous.providerBinding, providerMetadata: previous.providerMetadata };
      } else draft.chat = chat;
    }, chat);
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
      draft.nativeSessionId = undefined; draft.paused = true;
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
    await this.update(chatId, (draft) => {
      const previous = draft.messages;
      const folded = applyUpdate(previous, notification);
      draft.messages = folded;
      const unchanged = new Set(previous);
      upsertRows(draft.rows, folded.filter((message) => !unchanged.has(message)).map(persisted));
    });
  }

  async enqueue(chatId: string, input: PromptInput): Promise<{ entry: InboxEntry; duplicate: boolean }> {
    return this.change(chatId, (draft) => {
      const existing = draft.inbox.find((entry) => entry.requestId === input.requestId || entry.userMessageId === input.userMessageId);
      if (existing) {
        if (JSON.stringify(existing.prompt) !== JSON.stringify(input.prompt) || JSON.stringify(existing.bubble) !== JSON.stringify(input.bubble))
          throw new Error("That message was already submitted with different content.");
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
      if (draft.paused || draft.inbox.some((entry) => entry.state === "running")) return undefined;
      const entry = draft.inbox.find((entry) => entry.state === "queued");
      if (entry) { entry.state = "running"; recordUser(draft, entry); }
      return entry;
    });
  }

  async finish(chatId: string, requestId: string, response?: PromptResponse, error?: string): Promise<void> {
    await this.update(chatId, (draft) => {
      const entry = draft.inbox.find((entry) => entry.requestId === requestId);
      if (!entry || entry.state !== "running") return;
      entry.state = entry.cancelRequested || response?.stopReason === "cancelled" ? "cancelled" : error ? "failed" : "completed";
      entry.response = entry.state === "cancelled" ? { ...response, stopReason: "cancelled" } : response;
      entry.error = error;
    });
  }

  async stop(chatId: string): Promise<void> {
    await this.update(chatId, (draft) => {
      draft.paused = true;
      for (const entry of draft.inbox) if (entry.state === "running") entry.cancelRequested = true;
    });
  }

  async update(chatId: string, edit: (draft: SessionData) => void): Promise<void> { await this.change(chatId, edit); }
  onChange(listener: (change: SessionChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async flush(): Promise<void> { await Promise.all(this.pending.values()); }

  private change<T>(chatId: string, edit: (draft: SessionData) => T, initial?: ChatRow | null, allowDeleted = false): Promise<T> {
    const operation = (this.pending.get(chatId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const previous = this.sessions.get(chatId);
      if (previous?.chat === null && !allowDeleted) throw new Error("Cloud conversation was deleted.");
      if (!previous && initial === undefined) throw new Error("Unknown chat.");
      const draft: SessionData = structuredClone(previous ?? {
        version: 1, workspaceKey: this.workspaceKey, chatId, chat: initial ?? null, paused: false, messages: [], rows: [], inbox: [], steers: [],
      });
      const result = edit(draft);
      if (JSON.stringify(draft) === JSON.stringify(previous)) return structuredClone(result);
      await this.save(draft);
      this.sessions.set(chatId, draft);
      const oldRows = new Map(previous?.rows.map((row) => [row.msgId, row]));
      const changed = draft.rows.filter((row) => JSON.stringify(oldRows.get(row.msgId)) !== JSON.stringify(row));
      const chatChanged = JSON.stringify(previous?.chat) !== JSON.stringify(draft.chat);
      if (changed.length || chatChanged) for (const listener of this.listeners) listener(structuredClone({
        chatId, rows: changed, ...(chatChanged ? draft.chat ? { chat: draft.chat } : { deleted: true as const } : {}),
      }));
      return structuredClone(result);
    });
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
