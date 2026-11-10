import { toast } from "../shared/ui/primitives/elements";
import { selectActiveFolder, useWorkspaceStore } from "./store";

const CHAT_UNAVAILABLE = "You don't have access to that chat.";
const CHAT_FAILED = "Couldn't open that chat. Try the link again in a moment.";
/** A chat link waits this long for its workspace's chats to load. */
export const CLOUD_CHAT_LINK_WAIT_MS = 30_000;

let waiting: (() => void) | null = null;

/** A newer link replaces a chat link still waiting for its chats, so the old
 * one can never select a chat over it, or retire it by navigating. */
export function cancelCloudChatLinkSelection(): void {
  waiting?.();
}

/** A cloud chat link lands on its chat once the opened workspace's chats have
 * loaded. It settles in the same store update that loads them, before the
 * pane's selection keeper runs, and leaving the workspace ends the wait
 * quietly. A chat the loaded list lacks, or one that is archived or a
 * terminal, is unavailable. */
export function selectCloudChatWhenLoaded(folder: string, chatId: string): void {
  cancelCloudChatLinkSelection();
  let done = false;
  /** True once the link is settled: selected, unavailable, or left behind. */
  const settle = (): boolean => {
    if (done) return true;
    const state = useWorkspaceStore.getState();
    if (state.activePage !== "workspace" || selectActiveFolder(state) !== folder) return (done = true);
    if (state.pendingChatHydrationFolder === folder) return false;
    done = true;
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (chat && !chat.archived && chat.kind !== "terminal") {
      if (state.activeChatId !== chatId) state.dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
    } else {
      toast.error(CHAT_UNAVAILABLE);
    }
    return true;
  };
  if (settle()) return;
  // Store updates and the timer arrive only after this returns, so every
  // binding end() uses exists before it runs.
  const stop = useWorkspaceStore.subscribe(() => {
    if (settle()) end();
  });
  const timer = setTimeout(() => {
    const state = useWorkspaceStore.getState();
    if (!done && state.activePage === "workspace" && selectActiveFolder(state) === folder) toast.error(CHAT_FAILED);
    done = true;
    end();
  }, CLOUD_CHAT_LINK_WAIT_MS);
  const cancel = () => {
    done = true;
    end();
  };
  waiting = cancel;
  function end() {
    stop();
    clearTimeout(timer);
    if (waiting === cancel) waiting = null;
  }
}
