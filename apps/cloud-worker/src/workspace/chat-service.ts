// Response shapes follow engine/workspace/service.ts at 4baf69ec. Only the
// shared protocol is imported by the worker; Local remains a separate runtime.
import { coerceChat } from "../sessions/chat-history";
import type { SessionStore } from "../sessions/session-store";
import { reqString, unsupported, WorkspaceError, type WorkspaceScope } from "./scope";

export const UNSUPPORTED_CHAT_OPS = [
  "messages.clear", "messages.truncateFrom", "turns.list", "turns.get", "turns.diff", "turns.reset", "turns.undoReset", "messages.search",
] as const;

export class ChatService {
  constructor(private readonly store: SessionStore, private readonly scope: WorkspaceScope, private readonly closeChat: (chatId: string) => Promise<void>) {}

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    if (params.folder !== undefined) this.scope.folder(params.folder);
    const number = (key: string): number | undefined => typeof params[key] === "number" && Number.isFinite(params[key]) ? params[key] : undefined;
    const chatId = () => reqString(params, "chatId");
    switch (op) {
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
        return { ok: true };
      }
      case "messages.window": return this.store.window(chatId(), number("limit"), number("before"));
      case "messages.windowOlder": return this.store.older(chatId(), reqString(params, "beforeMsgId"), number("limit"));
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
