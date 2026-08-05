// ──────────────────────────────────────────────────────────
// boot-active-chat — which chat to select when the app starts
// ──────────────────────────────────────────────────────────
//
// 2026-07-06 invariant fix: the app must NEVER boot into a "no chat
// selected" Conversation pane — that pane renders nothing since the EmptyComposer
// landing was deleted (conversation/chat-view.tsx returns null for a null
// active chat). The old policy honored a persisted `"null"` active-chat
// key as "user explicitly cleared → land on the EmptyComposer"; with that
// surface gone, honoring it stranded the user on a dead black pane after
// every restart that happened to persist a null (mid workspace-swap,
// after a tab close, after an archive). The explicit-null case is
// therefore retired: boot ALWAYS restores a chat when one exists.
//
// Restore priority (first hit wins):
//   1. the persisted active chat id, if that chat is still live
//   2. the chat the user was last VIEWING in the workspace they left
//      (activeChatByFolder[lastWorkspaceFolder], validated) — this is the
//      "last opened chat", which `updatedAt` can't give us because merely
//      viewing a chat never bumps it
//   3. the most-recently-touched live chat in that workspace
//   4. the most-recently-touched live chat anywhere
//   5. null — only when there are no live chats at all; the tab strip's
//      selection keeper then auto-spawns a default chat for whatever
//      workspace comes into view.
//
// Pure and side-effect-free so the policy is unit-testable without the
// app shell.
// ──────────────────────────────────────────────────────────

import type { ChatThread } from "./store";

export interface BootRestoreContext {
  /** Workspace folder the user left off in (persisted UI state). */
  lastWorkspaceFolder: string | null;
  /** Per-workspace last-viewed chat map (persisted UI state). */
  activeChatByFolder: Record<string, string>;
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
    }
    const inFolder = mostRecentLive(chats, (c) => c.folder === folder);
    if (inFolder) return inFolder;
  }
  // 4./5. Anywhere, else nothing to restore.
  return mostRecentLive(chats);
}
