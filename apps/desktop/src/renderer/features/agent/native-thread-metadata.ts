import type { LoadSessionResponse } from "@zeros/protocol/agent-events";

import type { ChatThread } from "../../state/store";

type Metadata = NonNullable<LoadSessionResponse["nativeThreadMetadata"]>;

function sameGitInfo(
  left: ChatThread["nativeGitInfo"],
  right: Metadata["gitInfo"],
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.sha === right.sha &&
    left.branch === right.branch &&
    left.originUrl === right.originUrl
  );
}

/** Reconcile provider-owned stored metadata in one immutable chat update. A
 * null native name means "not titled yet" and must not erase a useful local
 * label. Git metadata is descriptive only; it never changes the checkout. */
export function mergeNativeThreadMetadata(
  chat: ChatThread,
  metadata: Metadata,
  now = Date.now(),
): ChatThread {
  const title = metadata.name?.trim() || chat.title;
  if (
    chat.title === title &&
    !!chat.pinned === metadata.isPinned &&
    sameGitInfo(chat.nativeGitInfo, metadata.gitInfo)
  ) return chat;
  return {
    ...chat,
    title,
    pinned: metadata.isPinned,
    nativeGitInfo: metadata.gitInfo ?? undefined,
    updatedAt: now,
  };
}
