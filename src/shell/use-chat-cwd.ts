// ──────────────────────────────────────────────────────────
// useChatCwd — active workspace folder, for scoping IDE panels
// ──────────────────────────────────────────────────────────
//
// Git / Env / Todo / Terminal all want to operate on the current
// workspace's folder, not the global engine root. Resolution order:
//
//   1. Active chat's `folder` (when a chat is open).
//   2. `state.newAgentFolder` (when the user clicked a worktree row
//      in Column 1 or a "+" surface but hasn't created a chat yet).
//      Without this fallback the floating terminal panel would spawn
//      in the engine project root (main repo) the moment the user
//      opens a fresh worktree — bug from screenshot 2026-05-28
//      10:42:10 AM where the worktree was `cinquefoil-942c` but the
//      terminal prompt read `… Zeros %` (main repo).
//   3. `undefined` — callers fall back to the engine root themselves.
// ──────────────────────────────────────────────────────────

import { useWorkspaceStore } from "../zeros/store/store";

export function useChatCwd(): string | undefined {
  // Resolve inside the selector so this returns a primitive string — the
  // subscriber re-renders only when the resolved cwd actually changes, not
  // on every unrelated `chats` mutation. Semantics (|| chain) unchanged.
  return useWorkspaceStore((s) => {
    const chat = s.chats.find((c) => c.id === s.activeChatId);
    return chat?.folder || s.newAgentFolder || undefined;
  });
}
