// Response shapes follow engine/workspace/service.ts at 4baf69ec. Only the
// shared protocol is imported by the worker; Local remains a separate runtime.
import { coerceChat } from "../sessions/chat-history";
import type { SessionStore } from "../sessions/session-store";
import { reqString, unsupported, WorkspaceError, type WorkspaceScope } from "./scope";
import { TurnService } from "./turns";
import { randomUUID } from "node:crypto";

export const UNSUPPORTED_CHAT_OPS = [
  "messages.clear",
] as const;

export interface ChatMutationOptions {
  historyReplacement?: () => boolean;
  mutate?: <T>(chatId: string, resetContext: boolean, action: () => Promise<T>) => Promise<T>;
  files?: <T>(action: () => Promise<T>) => Promise<T>;
}

export class ChatService {
  constructor(private readonly store: SessionStore, private readonly scope: WorkspaceScope, private readonly closeChat: (chatId: string) => Promise<void>,
    private readonly turns = new TurnService(store, scope), private readonly mutations: ChatMutationOptions = {}) {}

  private mutate<T>(chatId: string, resetContext: boolean, action: () => Promise<T>): Promise<T> {
    if (resetContext && !this.mutations.historyReplacement?.()) return unsupported();
    if (this.mutations.mutate) return this.mutations.mutate(chatId, resetContext, action);
    return this.closeChat(chatId).then(action);
  }

  private files<T>(action: () => Promise<T>): Promise<T> { return this.mutations.files ? this.mutations.files(action) : action(); }

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    if (params.folder !== undefined) this.scope.folder(params.folder);
    const number = (key: string): number | undefined => typeof params[key] === "number" && Number.isFinite(params[key]) ? params[key] : undefined;
    const chatId = () => reqString(params, "chatId");
    switch (op) {
      case "turns.get": case "turns.list": case "turns.diff": return this.turns.handle(op, params);
      case "turns.reset": {
        const id = chatId(), turnId = reqString(params, "turnId"), mode = params.mode ?? "filesAndTranscript";
        if (!["filesAndTranscript", "filesOnly", "transcriptOnly"].includes(String(mode)))
          throw new WorkspaceError("VALIDATION_FAILED", "Invalid turn reset mode.");
        const truncate = mode !== "filesOnly";
        return this.mutate(id, truncate, async () => {
          const turn = this.store.turnRecord(id, turnId);
          if (!turn || truncate && !this.store.history(id).some(row => row.msgId === turnId))
            throw new WorkspaceError("VALIDATION_FAILED", "This turn is no longer available.");
          const span = this.store.turnRecords(id).filter(item => item.ord >= turn.ord).sort((a, b) => a.ord - b.ord);
          const resetPaths = [...new Set(span.flatMap(item => item.files.map(file => file.path)))];
          return this.files(async () => {
            const result = mode === "transcriptOnly" ? { applied: [], conflicts: [], skipped: [], preResetSnapshot: null, postResetSnapshot: null }
              : await this.turns.reset(id, span);
            const resetId = `reset-${randomUUID()}`;
            const truncated = await this.store.saveReset(id, { resetId, snapshot: result.preResetSnapshot,
              postSnapshot: result.postResetSnapshot, paths: resetPaths, rows: [], turns: [] }, truncate ? turnId : undefined);
            await this.turns.prune(id).catch(() => {});
            return { ...result, resetId, resetPaths, truncated };
          });
        });
      }
      case "turns.undoReset": {
        const resetId = reqString(params, "resetId"), saved = this.store.resetRecord(resetId);
        if (!saved) return { restored: [], transcriptRestored: false, messagesRestored: 0 };
        return this.mutate(saved.chatId, !!saved.record.rows.length, () => this.files(async () => {
          const current = this.store.resetRecord(resetId);
          if (!current) return { restored: [], transcriptRestored: false, messagesRestored: 0 };
          const { record, chatId: id } = current;
          const restored = record.snapshot ? await this.turns.undo(record.snapshot, record.paths, record.postSnapshot) : [];
          const result = await this.store.undoReset(id, resetId);
          await this.turns.prune(id).catch(() => {});
          return { restored, ...result, chatId: id };
        }));
      }
      case "messages.truncateFrom": {
        const id = chatId(), from = reqString(params, "fromMsgId");
        return this.mutate(id, true, async () => {
          const removed = await this.store.truncateMessages(id, from);
          await this.turns.prune(id).catch(() => {});
          return { removed };
        });
      }
      case "chats.list": return this.store.list();
      case "chats.titleSeeds": return { seeds: this.store.titleSeeds(Array.isArray(params.chatIds) ? params.chatIds.filter((id): id is string => typeof id === "string") : []) };
      case "chats.summariesForFolder": return { summaries: this.store.summariesForFolder(this.scope.folder(reqString(params, "folder")), typeof params.excludeChatId === "string" ? params.excludeChatId : undefined) };
      case "chats.upsert": {
        const chat = this.chat(params.chat);
        if (chat) await this.store.upsert(chat);
        return { ok: true };
      }
      case "chats.bulkUpsert": {
        const raw = Array.isArray(params.chats) ? params.chats : [];
        if (raw.length > 5000) throw new WorkspaceError("VALIDATION_FAILED", "Too many chats in one request.");
        const chats = raw.map((value) => this.chat(value)).filter((value) => value !== null);
        // Validate all identities/tombstones before changing any metadata.
        for (const chat of chats) if (this.store.metadata(chat.id)?.chat === null) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Cloud conversation was deleted.");
        for (const chat of chats) await this.store.upsert(chat);
        return { ok: true };
      }
      case "chats.delete": {
        const id = reqString(params, "id");
        await this.closeChat(id);
        await this.store.delete(id);
        await this.turns.deleteChatSnapshots(id).catch(() => {});
        return { ok: true };
      }
      case "messages.window": {
        const id = chatId();
        return { ...this.store.window(id, number("limit"), number("before")), ...(this.mutations.historyReplacement?.() ? { historyState: this.store.historyState(id) } : {}) };
      }
      case "messages.search": return this.store.search(params.query, params.limit, params.chatId === undefined ? undefined : chatId());
      case "messages.windowOlder": {
        const id = chatId();
        return { ...this.store.older(id, reqString(params, "beforeMsgId"), number("limit")), ...(this.mutations.historyReplacement?.() ? { historyState: this.store.historyState(id) } : {}) };
      }
      case "messages.import": {
        const id = chatId();
        if (!this.store.metadata(id)?.chat) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Unknown chat.");
        return { ok: true, imported: await this.store.importMessages(id, Array.isArray(params.messages) ? params.messages : []) };
      }
      case "chats.setComposerMode": {
        if (params.mode !== "code") return unsupported();
        const id = chatId();
        const expected = params.expectedRevision;
        if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0))
          throw new WorkspaceError("VALIDATION_FAILED", "Invalid composer mode revision.");
        if (!this.store.metadata(id)) {
          const initial = this.chat(params.initialChat);
          if (initial?.id === id && !initial.archived && initial.kind !== "terminal" && (expected === undefined || expected === 0)) await this.store.upsert(initial);
        }
        const chat = this.store.metadata(id)?.chat;
        if (!chat || chat.archived || chat.kind === "terminal" || this.scope.folder(params.folder) !== chat.folder)
          throw new WorkspaceError("WORKSPACE_NOT_FOUND", "The conversation workspace changed.");
        if (expected !== undefined && expected !== chat.composerModeRevision) throw new WorkspaceError("VALIDATION_FAILED", "Composer mode changed. Reload the conversation.");
        return { mode: "code", revision: chat.composerModeRevision };
      }
      case "chats.clearProviderIdentity": {
        const id = chatId(), agentId = reqString(params, "agentId"), resumeId = reqString(params, "resumeId");
        const chat = this.store.metadata(id)?.chat;
        if (!chat || chat.agentId !== agentId || (chat.providerBinding?.resumeId ?? chat.sessionId) !== resumeId) return { ok: false };
        await this.closeChat(id);
        await this.store.update(id, (draft) => {
          draft.nativeSessionId = undefined;
          draft.chat!.sessionId = null; draft.chat!.providerBinding = null; draft.chat!.providerMetadata = null;
        });
        return { ok: true };
      }
      default: return unsupported();
    }
  }

  private chat(raw: unknown) {
    const chat = coerceChat(raw);
    return chat ? { ...chat, folder: this.scope.folder(chat.folder), additionalDirectories: chat.additionalDirectories.map((dir) => this.scope.folder(dir)) } : null;
  }
}
