import { toast } from "../shared/ui/primitives/elements";
import { selectActiveFolder, useWorkspaceStore } from "./store";

const CHAT_UNAVAILABLE = "You don't have access to that chat.";
const CHAT_FAILED = "Couldn't open that chat. Try the link again in a moment.";
/** A chat link waits this long for its workspace's chats to load. */
export const CLOUD_CHAT_LINK_WAIT_MS = 30_000;
/** A loaded list without the chat may still be catching up with a chat made
 * on another device; it gets this long before the chat is unavailable. */
export const CLOUD_CHAT_LINK_ABSENT_GRACE_MS = 5_000;

/** A cloud chat link lands on its chat once the opened workspace's chats have
 * loaded. Leaving the workspace ends the wait silently. An archived or
 * terminal chat is unavailable at once; one the loaded list still lacks after
 * the grace period is unavailable too. */
export function selectCloudChatWhenLoaded(folder: string, chatId: string): void {
  let done = false;
  let absent: ReturnType<typeof setTimeout> | undefined;
  const here = () => {
    const state = useWorkspaceStore.getState();
    return state.activePage === "workspace" && selectActiveFolder(state) === folder;
  };
  const unavailable = () => {
    if (done) return;
    end();
    done = true;
    if (here()) toast.error(CHAT_UNAVAILABLE);
  };
  /** True once the link is settled: selected, unavailable, or left behind. */
  const settle = (): boolean => {
    if (done) return true;
    if (!here()) return (done = true);
    const state = useWorkspaceStore.getState();
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (chat && !chat.archived && chat.kind !== "terminal") {
      done = true;
      if (state.activeChatId !== chatId) state.dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
      return true;
    }
    if (chat) {
      done = true;
      toast.error(CHAT_UNAVAILABLE);
      return true;
    }
    if (state.pendingChatHydrationFolder !== folder)
      absent ??= setTimeout(unavailable, CLOUD_CHAT_LINK_ABSENT_GRACE_MS);
    return false;
  };
  if (settle()) return;
  // Store updates and both timers arrive only after this returns, so every
  // binding end() uses exists before it runs.
  const stop = useWorkspaceStore.subscribe(() => {
    if (settle()) end();
  });
  const timer = setTimeout(() => {
    end();
    done = true;
    if (here()) toast.error(CHAT_FAILED);
  }, CLOUD_CHAT_LINK_WAIT_MS);
  function end() {
    stop();
    clearTimeout(timer);
    if (absent !== undefined) clearTimeout(absent);
  }
}
