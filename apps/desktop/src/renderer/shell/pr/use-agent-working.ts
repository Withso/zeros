// ──────────────────────────────────────────────────────────
// useWorkspaceAgentWorking — is an agent actively reshaping this workspace?
// ──────────────────────────────────────────────────────────
//
// True while any live chat rooted in the workspace's folder — or the ACTIVE
// chat, which is where every PR-surface prompt actually lands (see
// useSendToActiveChat) — has a session that is warming, streaming, or
// reconnecting. The PR surfaces use this to park their git-mutating actions
// (Create PR, Commit and push, Push, Merge, …) until the turn lands: a prompt
// sent now would queue behind the very turn that is still changing the branch,
// and a merge could ship a half-pushed state. Read-only / deliberate actions
// (Show checks, Archive — which stops the agent on purpose) are NOT gated.
// ──────────────────────────────────────────────────────────

import { useMemo } from "react";

import { useAnyChatWorking } from "../../features/agent/sessions-store";
import { useActiveChatId, useChats } from "../../state/store";
import type { Workspace } from "../../platform/git";

/** Shared tooltip copy for controls disabled by this gate. */
export const AGENT_WORKING_REASON =
  "Agent is working — available when the turn finishes";

export function useWorkspaceAgentWorking(
  workspace: Workspace | null,
): boolean {
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const chatIds = useMemo(() => {
    const ids = workspace
      ? chats
          .filter((c) => !c.archived && c.folder === workspace.path)
          .map((c) => c.id)
      : [];
    // The active chat is the prompt TARGET — normally one of the workspace's
    // own chats, but include it explicitly so a mid-turn chat can never be
    // prompted from here regardless of which folder it belongs to.
    if (activeChatId && !ids.includes(activeChatId)) ids.push(activeChatId);
    return ids;
  }, [chats, workspace, activeChatId]);
  return useAnyChatWorking(chatIds);
}
