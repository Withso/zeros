import {
  sameProviderBinding,
  sameProviderMetadata,
} from "@zeros/protocol/identities";

import type { ChatThread } from "./store";

function sameComposerMode(left: ChatThread, right: ChatThread): boolean {
  return (left.composerMode ?? "code") === (right.composerMode ?? "code") &&
    (left.composerModeRevision ?? 0) === (right.composerModeRevision ?? 0);
}

function sameDirectories(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((directory, index) => directory === right[index])
  );
}

/** Semantic equality for a persisted chat row. `updatedAt` alone is not enough:
 * older builds did not consistently touch it for every picker field. */
export function samePersistedChat(
  left: ChatThread,
  right: ChatThread,
): boolean {
  return (
    left.id === right.id &&
    left.folder === right.folder &&
    left.kind === right.kind &&
    left.agentId === right.agentId &&
    left.agentName === right.agentName &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.fast === right.fast &&
    left.permissionMode === right.permissionMode &&
    left.lastModeId === right.lastModeId &&
    left.prePlanModeId === right.prePlanModeId &&
    (left.composerMode ?? "code") === (right.composerMode ?? "code") &&
    (left.composerModeRevision ?? 0) === (right.composerModeRevision ?? 0) &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.sessionId === right.sessionId &&
    sameProviderBinding(left.providerBinding, right.providerBinding) &&
    sameProviderMetadata(left.providerMetadata, right.providerMetadata) &&
    left.pinned === right.pinned &&
    left.archived === right.archived &&
    left.sourceChatId === right.sourceChatId &&
    sameDirectories(
      left.additionalDirectories ?? [],
      right.additionalDirectories ?? [],
    )
  );
}

export interface ReconciledChatSnapshot {
  /** Stable local array when the authoritative snapshot changes nothing. */
  chats: ChatThread[];
  /** Local-only/newer rows that genuinely need write-through to the engine. */
  rowsToPush: ChatThread[];
  /** Cached rows removed by an authoritative engine tombstone. */
  removedIds: string[];
}

/**
 * Reconcile the synchronous boot cache with one complete engine snapshot.
 *
 * The engine wins timestamp ties, tombstones win over stale cache rows, and a
 * genuinely newer/local-only renderer row is retained for crash-safe
 * write-through. Unchanged local objects and arrays retain identity so a
 * background DB_CHANGED read cannot remount the chat surface.
 */
export function reconcileChatSnapshot(
  local: ChatThread[],
  remote: ChatThread[],
  remoteDeletedIds: Iterable<string>,
): ReconciledChatSnapshot {
  const deleted = new Set(remoteDeletedIds);
  const remoteById = new Map<string, ChatThread>();
  for (const chat of remote) {
    remoteById.set(chat.id, chat);
    // A live row represents a recreation and is newer than an old tombstone.
    deleted.delete(chat.id);
  }

  const chats: ChatThread[] = [];
  const rowsToPush: ChatThread[] = [];
  const removedIds: string[] = [];

  for (const localChat of local) {
    if (deleted.has(localChat.id)) {
      removedIds.push(localChat.id);
      continue;
    }

    let remoteChat = remoteById.get(localChat.id);
    if (!remoteChat) {
      // The row may have been created immediately before a crash, before the
      // bridge write landed. No tombstone means preserving and backfilling it
      // is safer than silently losing the user's chat.
      chats.push(localChat);
      rowsToPush.push(localChat);
      continue;
    }
    remoteById.delete(localChat.id);

    // Product mode is engine-owned, with its own revision. A title/model edit
    // must neither hide a newer mode nor restore an older in-flight snapshot.
    const modeOwner = (remoteChat.composerModeRevision ?? 0) >= (localChat.composerModeRevision ?? 0)
      ? remoteChat : localChat;
    const modeFields = { composerMode: modeOwner.composerMode, composerModeRevision: modeOwner.composerModeRevision };
    if (modeOwner === localChat && remoteChat.composerModeRevision !== localChat.composerModeRevision)
      remoteChat = { ...remoteChat, ...modeFields };

    if (localChat.updatedAt > remoteChat.updatedAt) {
      const merged = modeOwner === remoteChat && !sameComposerMode(localChat, remoteChat)
        ? { ...localChat, ...modeFields } : localChat;
      chats.push(merged);
      rowsToPush.push(merged);
    } else if (samePersistedChat(localChat, remoteChat)) {
      chats.push(localChat);
    } else {
      // The durable engine row wins older values and timestamp ties. A tie can
      // happen with legacy rows whose settings changed without touching time.
      chats.push(remoteChat);
    }
  }

  // Engine-created chats that this renderer has never seen are appended in the
  // engine's stable order; presentation layers apply their own updatedAt sort.
  for (const chat of remote) {
    if (remoteById.has(chat.id) && !deleted.has(chat.id)) {
      chats.push(chat);
      remoteById.delete(chat.id);
    }
  }

  const stable =
    chats.length === local.length &&
    chats.every((chat, index) => chat === local[index]);
  return {
    chats: stable ? local : chats,
    rowsToPush,
    removedIds,
  };
}
