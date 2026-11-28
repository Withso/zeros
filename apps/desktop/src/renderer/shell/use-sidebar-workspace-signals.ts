// One list-level read of every workspace's chat state (awaiting, working,
// unread, draft) for the View menu's filters, counts and Needs you on top.
// Each store is selected as a single string, so the sidebar re-renders only
// when some workspace's state actually flips.
import { useMemo, useSyncExternalStore } from "react";
import { combinedAgentActivity, workingActivity } from "../features/agent/agent-activity";
import { chatUnread, subscribeChatUnread } from "../features/agent/chat-unread";
import { awaitingKindOfSlot, useSessionsStore } from "../features/agent/sessions-store";
import { useComposerDraftPresence } from "../state/composer-draft-presence";
import type { Workspace } from "../platform/git";
import { NO_SIGNAL, type SidebarWorkspaceSignal } from "./sidebar-view-model";
import { findWorkspaceForFolder } from "../state/workspace-resolution";

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
      const { awaiting, working } = agentSignalOfChats(chats, state);
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

type SessionsState = ReturnType<typeof useSessionsStore.getState>;

/** A workspace's agent state across its chats: a blocking question outranks a
 *  plan, and any running chat makes it working. */
export function agentSignalOfChats(
  chats: readonly string[],
  state: Pick<SessionsState, "sessions" | "pendingLocalTurns">,
): { awaiting: "plan" | "input" | null; working: boolean } {
  let awaiting: "plan" | "input" | null = null;
  for (const chat of chats) {
    const slot = state.sessions[chat];
    const kind = slot ? awaitingKindOfSlot(slot) : null;
    if (kind === "input") { awaiting = "input"; break; }
    if (kind) awaiting = kind;
  }
  const working = combinedAgentActivity(chats.map((chat) => workingActivity(state.sessions[chat], state.pendingLocalTurns[chat]))) !== null;
  return { awaiting, working };
}

/** The same signals as useSidebarWorkspaceSignals, read once from the stores,
 *  for code outside React (removal navigation). */
export function readSidebarWorkspaceSignals(
  chatIdsByWorkspace: ChatIds,
  draftIdsByWorkspace: ChatIds,
): (workspaceId: string) => SidebarWorkspaceSignal {
  const sessions = useSessionsStore.getState();
  const drafts = useComposerDraftPresence.getState();
  return (id) => {
    const chats = chatIdsByWorkspace.get(id) ?? EMPTY;
    const { awaiting, working } = agentSignalOfChats(chats, sessions);
    return {
      ...NO_SIGNAL,
      awaiting,
      working,
      unread: chats.some(chatUnread),
      draft: (draftIdsByWorkspace.get(id) ?? EMPTY).some((chat) => drafts.has(chat)),
    };
  };
}

/** Each workspace's live (unarchived) chats, by the folder they belong to. */
export function sidebarChatIdsByWorkspace(
  chats: readonly { id: string; folder: string; archived?: boolean }[],
  workspaces: readonly Workspace[],
): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const workspace of workspaces) ids.set(workspace.id, []);
  for (const chat of chats) {
    if (chat.archived) continue;
    const workspace = findWorkspaceForFolder(chat.folder, workspaces);
    if (workspace) ids.get(workspace.id)?.push(chat.id);
  }
  return ids;
}
