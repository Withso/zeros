import { editCloudV2Chat } from "../platform/cloud-v2";
import { parseCloudScopedId } from "../platform/bridge/cloud-workspace-key";
import { toast } from "../shared/ui/primitives/elements";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { cloudWorkspaceDocument } from "./cloud-workspace-catalog";
import { useWorkspaceStore, type Action } from "./workspace-store";

export type ChatEdit = { title: string } | { archived: boolean };

/** Exact chat key → the edit request that owns it. A newer edit of the same
 * chat supersedes an older one, so its late reply can neither revert nor
 * release anything. */
const pending = new Map<string, number>();
let sequence = 0;

/** The chat mirror must not hand a held edit to the worker before the control
 * plane accepts it (it may refuse, for example a busy archive). */
export function hasPendingCloudChatEdit(chatId: string): boolean { return pending.has(chatId); }

/** A close the control plane refused as busy keeps today's behavior: the chat
 * stays closed and the chat mirror carries it to the worker, as before. */
const fallbacks = new Set<(chatId: string) => void>();
export function onCloudChatEditFallback(listener: (chatId: string) => void): () => void {
  fallbacks.add(listener);
  return () => { fallbacks.delete(listener); };
}

const actionFor = (chatId: string, change: ChatEdit): Action => "title" in change
  ? { type: "UPDATE_CHAT_TITLE", id: chatId, title: change.title }
  : { type: change.archived ? "ARCHIVE_CHAT" : "UNARCHIVE_CHAT", id: chatId };

/** A user's rename, close (archive) or reopen of a chat. It shows at once.
 * For a cloud workspace whose document advertises chatEdits, the control plane
 * carries it, also while the VM sleeps, and a refusal reverts it. Local
 * workspaces and older control planes keep the existing chat mirror path. */
export function editChat(dispatch: (action: Action) => void, chatId: string, change: ChatEdit,
  /** The chat's turn was running when it was closed. Closing a working chat
   * stops it in the background and archives at once through the chat mirror,
   * exactly as before; the route would refuse it as session_busy. */
  options: { busy?: boolean } = {}): void {
  const before = useWorkspaceStore.getState().chats.find(chat => chat.id === chatId);
  dispatch(actionFor(chatId, change));
  const scoped = parseCloudScopedId(chatId);
  if (!before || !scoped || cloudWorkspaceDocument(scoped)?.capabilities.chatEdits !== 1) return;
  if (options.busy && "archived" in change && change.archived) return;
  const request = ++sequence, generation = getOrganizationStoreGeneration();
  pending.set(chatId, request);
  const owns = () => pending.get(chatId) === request;
  void editCloudV2Chat(scoped, scoped.id, change).catch((error: unknown) => {
    if (!owns() || generation !== getOrganizationStoreGeneration()) return;
    if ((error as { code?: unknown } | null)?.code === "session_busy" && "archived" in change && change.archived) {
      pending.delete(chatId);
      for (const listener of fallbacks) listener(chatId);
      return;
    }
    const current = useWorkspaceStore.getState().chats.find(chat => chat.id === chatId);
    // Revert only what this edit still shows; a value changed again since stays.
    if ("title" in change) {
      if (current?.title === change.title) dispatch({ type: "UPDATE_CHAT_TITLE", id: chatId, title: before.title });
    } else if (current?.archived === change.archived) dispatch(actionFor(chatId, { archived: !change.archived }));
    toast.error("title" in change ? "Couldn't rename the chat" : change.archived ? "Couldn't close the chat" : "Couldn't reopen the chat",
      { description: error instanceof Error && error.message ? error.message : "Try again." });
  }).finally(() => { if (owns()) pending.delete(chatId); });
}
