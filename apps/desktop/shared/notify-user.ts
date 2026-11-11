/** Main -> renderer: a device-channel NotifyUser; mark the chat unread. */
export const NOTIFY_USER_ATTENTION_EVENT = "notify-user:attention";
/** Main -> renderer: a NotifyUser notification was clicked; open its chat. */
export const NOTIFY_USER_OPEN_EVENT = "notify-user:open";

export interface NotifyUserChat {
  workspaceId: string;
  /** The worker's chat id; the renderer scopes it to its workspace. */
  chatId: string;
}
