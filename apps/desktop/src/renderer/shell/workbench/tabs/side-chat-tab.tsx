import { useEffect, useRef } from "react";
import { ChatView } from "../../conversation/chat-view";
import { useWorkspaceDispatch, useWorkspaceStore } from "../../../state/store";
import type { WorkbenchTab } from "../tab-model";

/** A side chat in the Workbench. Interacting with it makes it the focused chat,
 *  as a split pane does, so its composer, sends and shortcuts own the keyboard;
 *  the chat column takes focus back on its own pointer or focus entry. */
export function SideChatTab({ tab, active }: { tab: WorkbenchTab; active: boolean; scope?: string }) {
  const chatId = tab.chatId ?? "";
  const exists = useWorkspaceStore((state) => state.chats.some((chat) => chat.id === chatId && !chat.archived));
  const dispatch = useWorkspaceDispatch();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !active || !exists) return;
    const activate = () => {
      if (useWorkspaceStore.getState().activeChatId !== chatId) dispatch({ type: "SET_ACTIVE_CHAT", id: chatId });
    };
    el.addEventListener("pointerdown", activate, true);
    el.addEventListener("focusin", activate, true);
    return () => {
      el.removeEventListener("pointerdown", activate, true);
      el.removeEventListener("focusin", activate, true);
    };
  }, [active, chatId, dispatch, exists]);

  if (!exists) {
    return <div className="text-fg3 flex h-full items-center justify-center text-xs" data-side-chat-missing="">This side chat is closed</div>;
  }
  return (
    <div ref={rootRef} data-zeros-root="" data-side-chat-tab={chatId} className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ChatView chatId={chatId} surfaceActive={active} />
    </div>
  );
}
