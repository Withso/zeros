// One list-level read of every workspace's chat state (awaiting, working,
// unread, draft) for the View menu's filters, counts and Needs you on top.
// Each store is selected as a single string, so the sidebar re-renders only
// when some workspace's state actually flips.
import { useMemo, useSyncExternalStore } from "react";
import { combinedAgentActivity, workingActivity } from "../features/agent/agent-activity";
import { chatUnread, subscribeChatUnread } from "../features/agent/chat-unread";
import { awaitingKindOfSlot, useSessionsStore } from "../features/agent/sessions-store";
import { useComposerDraftPresence } from "../state/composer-draft-presence";
import { NO_SIGNAL, type SidebarWorkspaceSignal } from "./sidebar-view-model";

type ChatIds = ReadonlyMap<string, readonly string[]>;
const EMPTY: readonly string[] = [];

export function useSidebarWorkspaceSignals(
  chatIdsByWorkspace: ChatIds,
  draftIdsByWorkspace: ChatIds,
  enabled: boolean,
): (workspaceId: string) => SidebarWorkspaceSignal {
  const agents = useSessionsStore((state) => {
    if (!enabled) return "";
    let out = "";
    for (const [id, chats] of chatIdsByWorkspace) {
      let awaiting: "plan" | "input" | null = null;
      for (const chat of chats) {
        const slot = state.sessions[chat];
        const kind = slot ? awaitingKindOfSlot(slot) : null;
        if (kind === "input") { awaiting = "input"; break; }
        if (kind) awaiting = kind;
      }
      const working = combinedAgentActivity(chats.map((chat) => workingActivity(state.sessions[chat], state.pendingLocalTurns[chat]))) !== null;
      if (awaiting || working) out += `${id}\u0000${awaiting ?? ""}\u0000${working ? 1 : 0}\u0001`;
    }
    return out;
  });
  const unread = useSyncExternalStore(subscribeChatUnread, () => {
    if (!enabled) return "";
    let out = "";
    for (const [id, chats] of chatIdsByWorkspace) if (chats.some(chatUnread)) out += `${id}\u0001`;
    return out;
  }, () => "");
  const drafts = useComposerDraftPresence((ids) => {
    if (!enabled) return "";
    let out = "";
    for (const [id, chats] of draftIdsByWorkspace) if (chats.some((chat) => ids.has(chat))) out += `${id}\u0001`;
    return out;
  });
  return useMemo(() => {
    const signals = new Map<string, SidebarWorkspaceSignal>();
    const get = (id: string) => signals.get(id) ?? { ...NO_SIGNAL };
    for (const entry of agents.split("\u0001")) {
      if (!entry) continue;
      const [id, awaiting, working] = entry.split("\u0000");
      signals.set(id!, { ...get(id!), awaiting: awaiting === "plan" || awaiting === "input" ? awaiting : null, working: working === "1" });
    }
    for (const id of unread.split("\u0001")) if (id) signals.set(id, { ...get(id), unread: true });
    for (const id of drafts.split("\u0001")) if (id) signals.set(id, { ...get(id), draft: true });
    return (id: string) => signals.get(id) ?? NO_SIGNAL;
  }, [agents, unread, drafts]);
}

export const NO_CHAT_IDS = EMPTY;
