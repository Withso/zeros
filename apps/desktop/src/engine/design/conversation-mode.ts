import path from "node:path";
import { getChat, setChatComposerMode, wasChatDeleted } from "../db/chats";
import type { AgentSessionToolInput } from "../agents/session-tools";
import type {
  ComposerMode,
  ComposerModeSnapshot,
} from "@zeros/protocol/composer-mode";

export interface ConversationModePort {
  get(): ComposerModeSnapshot;
  set(mode: ComposerMode, expectedRevision: number): ComposerModeSnapshot;
}

/** The execution is bound to its Zeros conversation, never a tool-supplied ID. */
export function conversationModePort(
  input: AgentSessionToolInput,
  onChanged: () => void,
): ConversationModePort {
  if (!input.conversationId)
    return {
      get: () => ({ mode: "code", revision: 0 }),
      set: () => {
        throw new Error(
          "A persistent conversation is required to select Design mode.",
        );
      },
    };
  let hasPersistedOwner = false;
  const chat = () => {
    input.signal.throwIfAborted();
    const row = input.conversationId ? getChat(input.conversationId) : null;
    // A first Code prompt can beat the ordinary sidebar write-through. Never
    // make Code depend on that timing, but require a durable owner to select
    // Design, and never turn a deleted/retired owner into a fresh Code actor.
    if (!row && !hasPersistedOwner && !wasChatDeleted(input.conversationId!))
      return null;
    if (
      !row ||
      row.archived ||
      row.kind === "terminal" ||
      path.resolve(row.folder) !== path.resolve(input.cwd)
    )
      throw new Error(
        "The conversation owning these Design tools is no longer available.",
      );
    hasPersistedOwner = true;
    return row;
  };
  return {
    get: () => {
      const row = chat();
      return {
        mode: row?.composerMode ?? "code",
        revision: row?.composerModeRevision ?? 0,
      };
    },
    set: (mode, expectedRevision) => {
      const row = chat();
      if (!row)
        throw new Error(
          "The conversation owning these Design tools is no longer available.",
        );
      const result = setChatComposerMode(row.id, mode, expectedRevision);
      onChanged();
      return result;
    },
  };
}
