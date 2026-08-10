import type { ChatRow } from "../db/chats";
import type { NativeThreadAction } from "./types";

/** Translate durable Zeros chat metadata mutations into the corresponding
 * provider-native operations. Comparing confirmed rows prevents hydration and
 * unchanged bulk upserts from replaying lifecycle RPCs on every render. */
export function nativeThreadActionsForChatMutation(
  before: ChatRow | null,
  after: ChatRow | null,
): NativeThreadAction[] {
  const nativeThreadId = before?.nativeSessionId ?? before?.sessionId;
  if (
    !before ||
    before.agentId !== "codex" ||
    !before.sessionId ||
    !nativeThreadId
  ) {
    return [];
  }

  const base = {
    sessionId: before.sessionId,
    nativeThreadId,
    cwd: before.folder,
  };
  if (!after) return [{ ...base, action: "delete" }];
  if (
    after.agentId !== "codex" ||
    after.sessionId !== before.sessionId ||
    (after.nativeSessionId ?? after.sessionId) !== nativeThreadId
  ) {
    return [];
  }

  const actions: NativeThreadAction[] = [];
  if (before.archived !== after.archived) {
    actions.push({
      ...base,
      cwd: after.folder,
      action: after.archived ? "archive" : "unarchive",
    });
  }
  if (before.pinned !== after.pinned) {
    actions.push({
      ...base,
      cwd: after.folder,
      action: after.pinned ? "pin" : "unpin",
    });
  }
  if (before.title !== after.title && after.title.trim()) {
    actions.push({
      ...base,
      cwd: after.folder,
      action: "rename",
      name: after.title.trim(),
    });
  }
  return actions;
}
