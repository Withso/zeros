// PURPOSE: "Ask agent to sync" and "Ask agent to fix" for Design style
// sources. Nothing syncs automatically: the person's agent sets syncing up for
// their repository by editing meta/canvas.json, following the packaged Zeros
// Design skill (briefs: design-agent-brief.ts).

import { useCallback } from "react";

import type { DesignAgentBrief } from "./design-agent-brief";
import { useOptionalAgentSessions } from "../agent/sessions-hooks";
import { spawnNewChatTab } from "../../state/spawn-default-chat";
import { useWorkspaceDispatch, useWorkspaceStore } from "../../state/workspace-store";
import { useSendToChat } from "../../shell/pr/use-send-to-active-chat";
import { toast } from "../../shared/ui/primitives";

const AGENT_BIND_TIMEOUT_MS = 15_000;

/** A new chat gets its agent synchronously from a warm cache, or when its
 * tab mounts; wait for either before sending. */
function whenChatHasAgent(chatId: string): Promise<void> {
  const bound = () => Boolean(useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId)?.agentId);
  if (bound()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("No agent is available for a new chat. Choose one in the composer, then try again."));
    }, AGENT_BIND_TIMEOUT_MS);
    const unsubscribe = useWorkspaceStore.subscribe(() => {
      if (!bound()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** Open a new chat with the person's default agent and model in this
 * workspace, and send it a brief marked as sent by Zeros. */
export function useAskDesignAgent(
  workspacePath: string | null | undefined,
): (brief: DesignAgentBrief) => void {
  const sessions = useOptionalAgentSessions();
  const dispatch = useWorkspaceDispatch();
  const sendToChat = useSendToChat(workspacePath ?? "");
  return useCallback(
    (brief: DesignAgentBrief) => {
      if (!workspacePath) return;
      void (async () => {
        if (!sessions) throw new Error("Agent chats are unavailable here.");
        const chat = await spawnNewChatTab({ folder: workspacePath, sessions, dispatch });
        await whenChatHasAgent(chat.id);
        sendToChat(chat.id, {
          text: brief.text,
          displayText: brief.label,
          autoAction: "design-sync",
        });
      })().catch((error: unknown) => {
        toast.error("Couldn't ask the agent", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [dispatch, sendToChat, sessions, workspacePath],
  );
}
