import { isAttentionUpdate } from "@zeros/protocol/agent-events";
import { formatCloudWorkspaceLink } from "@zeros/protocol/cloud-workspace-link";
import { formatWorkspaceLink } from "@zeros/protocol/local-orchestration";
import { NOTIFY_USER_ATTENTION_EVENT, NOTIFY_USER_OPEN_EVENT, type NotifyUserChat } from "../../../shared/notify-user";
import { noteChatsFinished, subscribeChatsInView } from "../features/agent/chat-unread";
import { getTeamStoreState } from "../features/team/team-store";
import { toast } from "../shared/ui/primitives/elements";
import { cloudWorkspaceDocumentById, refreshCloudWorkspaceCatalog } from "../state/cloud-workspace-catalog";
import { useWorkspaceStore } from "../state/workspace-store";
import { cloudScopedId, parseCloudScopedId } from "./bridge/cloud-workspace-key";
import { openLocalLink, resolveLocalLinkScheme } from "./local-links";
import { isElectron, nativeInvoke, nativeListen } from "./runtime";

/** notify-user-v1, bridge path: an attached app saw the worker's `attention`
 * update for one of its cloud chats (the renderer's scoped id). Marks it
 * unread unless on screen, and lets main decide the OS notification. */
export function noteAttention(scopedChatId: string, update: unknown): boolean {
  if (!isAttentionUpdate(update)) return false;
  const chat = parseCloudScopedId(scopedChatId);
  if (!chat) return true;
  noteChatsFinished([scopedChatId]);
  if (isElectron()) {
    const chatTitle = useWorkspaceStore.getState().chats.find(thread => thread.id === scopedChatId)?.title ?? "";
    void nativeInvoke("notify_user_attention", { notificationId: update.notificationId, workspaceId: chat.workspaceId, chatId: chat.id,
      chatTitle, title: update.title }).catch(() => {});
  }
  return true;
}

/** The loaded catalog spans organizations; a miss reads it once. */
async function documentFor(workspaceId: string) {
  const loaded = cloudWorkspaceDocumentById(workspaceId);
  if (loaded) return loaded;
  await refreshCloudWorkspaceCatalog().catch(() => {});
  return cloudWorkspaceDocumentById(workspaceId);
}

/** A clicked notification opens its chat through the app's own link route,
 * with that route's access checks and organization switch. */
export async function openNotifiedChat(target: NotifyUserChat, open: (href: string) => void = openLocalLink): Promise<void> {
  const doc = await documentFor(target.workspaceId);
  if (!doc) { toast.error("You don't have access to that chat."); return; }
  const scheme = await resolveLocalLinkScheme();
  const organizations = getTeamStoreState().me?.organizations ?? [];
  const slug = organizations.find(organization => organization.id === doc.organizationId)?.slug?.toLowerCase();
  try {
    if (slug && doc.number) { open(formatWorkspaceLink(scheme, { owner: slug, number: doc.number }, target.chatId)); return; }
  } catch { /* A chat id a link cannot carry opens its workspace. */ }
  open(formatCloudWorkspaceLink(scheme, { organizationId: doc.organizationId, workspaceId: doc.id }));
}

/** Main's half: device-channel arrivals, clicks, and which chats are on screen. */
export function startNotifyUser(): () => void {
  if (!isElectron()) return () => {};
  let stopped = false, lastView = "";
  const stops: Array<() => void> = [];
  const markUnread = async ({ workspaceId, chatId }: NotifyUserChat) => {
    const doc = await documentFor(workspaceId);
    if (doc && !stopped) noteChatsFinished([cloudScopedId({ organizationId: doc.organizationId, workspaceId }, chatId)]);
  };
  stops.push(subscribeChatsInView(chats => {
    const keys = [...chats].flatMap(id => { const chat = parseCloudScopedId(id); return chat ? [`${chat.workspaceId}/${chat.id}`] : []; }).slice(0, 64);
    const view = JSON.stringify(keys);
    if (view === lastView) return;
    lastView = view;
    void nativeInvoke("notify_user_view", { chats: keys }).catch(() => {});
  }));
  void Promise.all([
    nativeListen<NotifyUserChat>(NOTIFY_USER_ATTENTION_EVENT, target => { void markUnread(target); }),
    nativeListen<NotifyUserChat>(NOTIFY_USER_OPEN_EVENT, target => { void openNotifiedChat(target); }),
  ]).then(offs => {
    if (stopped) { for (const off of offs) off(); return; }
    stops.push(...offs);
    void nativeInvoke<NotifyUserChat | null>("notify_user_take_open").then(target => { if (target && !stopped) void openNotifiedChat(target); }, () => {});
  }, () => {});
  return () => { stopped = true; for (const stop of stops.splice(0)) stop(); };
}
