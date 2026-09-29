import {
  cloudWorkspaceKey,
  parseCloudScopedId,
  parseCloudWorkspaceKey,
} from "../platform/bridge/cloud-workspace-key";

/** Select open transcripts for a database message-change notification. */
export function chatChangeTargets(
  message: {
    type?: string;
    kinds?: unknown;
    chatIds?: unknown;
    cloudWorkspace?: unknown;
    workspaceId?: unknown;
  },
  openChatIds: readonly string[],
): readonly string[] {
  const kinds = Array.isArray(message.kinds) ? message.kinds : [];
  if (!kinds.includes("messages")) return [];
  const ids = Array.isArray(message.chatIds) ? message.chatIds : [];
  const open = new Set(openChatIds);
  try {
    const owner = parseCloudWorkspaceKey(
      message.cloudWorkspace ?? message.workspaceId,
    );
    // A malformed cloud envelope cannot become a Local/global notification.
    if (message.cloudWorkspace !== undefined && !owner) return [];
    const key = owner ? cloudWorkspaceKey(owner) : null;
    return [...new Set(ids.length ? ids : openChatIds)].filter(
      (id): id is string => {
        if (typeof id !== "string" || !open.has(id)) return false;
        const chat = parseCloudScopedId(id);
        return (chat ? cloudWorkspaceKey(chat) : null) === key;
      },
    );
  } catch {
    return [];
  }
}
