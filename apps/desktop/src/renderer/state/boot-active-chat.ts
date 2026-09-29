// ──────────────────────────────────────────────────────────
// boot-active-chat — which chat to select when the app starts
// ──────────────────────────────────────────────────────────
//
// Restore a chat within the remembered owner whenever one is available.
// Legacy explicit-null selections no longer strand a warm workspace without
// a chat, but a cold owner must wait for its own history instead of displaying
// a different workspace or creating a default tab prematurely.
//
// Restore priority (first hit wins):
//   1. the persisted active chat id, if that chat is still live
//   2. the chat the user was last VIEWING in the workspace they left
//      (activeChatByFolder[lastWorkspaceFolder], validated) — this is the
//      "last opened chat", which `updatedAt` can't give us because merely
//      viewing a chat never bumps it
//   3. the most-recently-touched live chat in that workspace
//   4. with no remembered workspace, the most-recent live Local chat
//   5. null — preserve the remembered workspace while its list revalidates.
// A saved cloud id can precede its authorized chat row. Preserve that identity
// until the exact cloud snapshot proves deletion; Local's snapshot cannot.
//
// Pure and side-effect-free so the policy is unit-testable without the
// app shell.
// ──────────────────────────────────────────────────────────

import type { ChatThread } from "./store";
import { cloudWorkspaceKey, parseCloudScopedId, isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";

export interface BootRestoreContext {
  /** Workspace folder the user left off in (persisted UI state). */
  lastWorkspaceFolder: string | null;
  /** Per-workspace last-viewed chat map (persisted UI state). */
  activeChatByFolder: Record<string, string>;
  /** Only an exact cloud snapshot can prove a saved remote chat was deleted. */
  confirmedCloudWorkspaces?: readonly string[];
  confirmedLocalChats?: boolean;
}

/** Identity only: this does not authorize or release cached cloud content. */
export function cloudFolderForChatId(id: string | null): string | null {
  try {
    const target = parseCloudScopedId(id);
    return target ? cloudWorkspaceKey(target) : null;
  } catch {
    return null;
  }
}

/** Most-recently-touched live chat matching `pred`, or null. */
function mostRecentLive(
  chats: ChatThread[],
  pred: (c: ChatThread) => boolean = () => true,
): string | null {
  let best: ChatThread | null = null;
  for (const c of chats) {
    if (c.archived || !pred(c)) continue;
    if (!best || (c.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = c;
  }
  return best?.id ?? null;
}

/** Resolve the chat to activate at boot. `persistedId` is the parsed
 *  active-chat-id setting: a string id, or null when the key was absent,
 *  unparsable, or stored the legacy explicit-null. */
export function resolveBootActiveChatId(
  chats: ChatThread[],
  persistedId: string | null,
  ctx: BootRestoreContext,
): string | null {
  // 1. The exact chat the user had open, when still live.
  if (persistedId) {
    const hit = chats.find((c) => c.id === persistedId && !c.archived);
    if (hit) return hit.id;
    const cloudFolder = cloudFolderForChatId(persistedId);
    if (!cloudFolder && ctx.confirmedLocalChats === false) return persistedId;
    if (cloudFolder && !ctx.confirmedCloudWorkspaces?.includes(cloudFolder) &&
        !chats.some((c) => c.id === persistedId && c.archived)) return persistedId;
  }
  // 2./3. Land in the workspace the user left, on the chat they were viewing.
  const folder = ctx.lastWorkspaceFolder;
  if (folder) {
    const remembered = ctx.activeChatByFolder[folder];
    if (remembered) {
      const hit = chats.find(
        (c) => c.id === remembered && !c.archived && c.folder === folder,
      );
      if (hit) return hit.id;
      if (!isCloudWorkspace(folder) && ctx.confirmedLocalChats === false) return remembered;
      if (cloudFolderForChatId(remembered) === folder &&
          !ctx.confirmedCloudWorkspaces?.includes(folder) &&
          !chats.some((c) => c.id === remembered && c.archived)) return remembered;
    }
    const inFolder = mostRecentLive(chats, (c) => c.folder === folder);
    return inFolder;
  }
  // A cold Local/cloud list is not evidence that a remembered owner is gone.
  // With no remembered owner, only device-local history is a safe fallback.
  return mostRecentLive(chats, (chat) => !isCloudWorkspace(chat.folder));
}
