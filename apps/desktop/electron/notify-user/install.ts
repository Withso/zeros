import { BrowserWindow, Notification, type IpcMainInvokeEvent } from "electron";
import type { NotifyUserEvent } from "@zeros/protocol/notify-user";
import { emitEvent, getMainWindow, openMainWindowForNavigation } from "../ipc/events";
import { setCommand } from "../ipc/router";
import { NotifyUserCenter, type NotifyUserTarget } from "./center";
import { NOTIFY_USER_ATTENTION_EVENT, NOTIFY_USER_OPEN_EVENT, type NotifyUserChat } from "../../shared/notify-user";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN_LIMIT = 20;

/** notify-user-v1 in main: one notification per NotifyUser across the device
 * channel and the bridge, raised only when its chat is not on screen. */
export function installNotifyUser(): { receiveDevice(event: NotifyUserEvent): void; dispose(): void } {
  // Keep each shown notification referenced, or its click handler can be collected.
  const shown: Notification[] = [];
  let pendingOpen: NotifyUserChat | null = null;
  const open = (target: NotifyUserTarget) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) { pendingOpen = target; openMainWindowForNavigation(); return; }
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
    emitEvent(NOTIFY_USER_OPEN_EVENT, target satisfies NotifyUserChat);
  };
  const center = new NotifyUserCenter({
    now: () => Date.now(),
    focused: () => !!BrowserWindow.getFocusedWindow(),
    show: ({ title, body, onClick }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      notification.on("click", onClick);
      shown.push(notification);
      if (shown.length > SHOWN_LIMIT) shown.shift();
      notification.show();
    },
    open,
    attention: arrival => emitEvent(NOTIFY_USER_ATTENTION_EVENT, { workspaceId: arrival.workspaceId, chatId: arrival.chatId } satisfies NotifyUserChat),
  });

  const requireMainFrame = (event: IpcMainInvokeEvent) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Notifications require the app window.");
  };
  const text = (value: unknown, max: number, allowEmpty = false) => {
    if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) throw new Error("Invalid notification.");
    return value;
  };
  /** The bridge path: an attached app saw the worker's `attention` update. */
  setCommand("notify_user_attention", (args, event) => {
    requireMainFrame(event);
    if (typeof args.notificationId !== "string" || !UUID.test(args.notificationId) || typeof args.workspaceId !== "string" || !UUID.test(args.workspaceId))
      throw new Error("Invalid notification.");
    return center.receive("app", { notificationId: args.notificationId, workspaceId: args.workspaceId, chatId: text(args.chatId, 256),
      chatTitle: text(args.chatTitle, 4096, true).slice(0, 200), title: text(args.title, 80) });
  });
  /** Worker chat keys on screen in the window; replaced whole on every change. */
  setCommand("notify_user_view", (args, event) => {
    requireMainFrame(event);
    if (!Array.isArray(args.chats) || args.chats.length > 64) throw new Error("Invalid chats in view.");
    center.setChatsInView(args.chats.map(chat => text(chat, 600)));
    return true;
  });
  /** A click while no window existed opens its chat once the window is back. */
  setCommand("notify_user_take_open", (_args, event) => {
    requireMainFrame(event);
    const target = pendingOpen; pendingOpen = null;
    return target;
  });
  return {
    receiveDevice: event => {
      // Ids and the kind only: never the title or the message.
      console.info(`[notify-user] received id=${event.notificationId.slice(0, 8)} workspace=${event.workspace.id.slice(0, 8)} kind=${event.kind}`);
      const createdAt = Date.parse(event.createdAt);
      center.receive("device", { notificationId: event.notificationId, workspaceId: event.workspace.id, chatId: event.chat.id,
        chatTitle: event.chat.title, title: event.title, ...(Number.isFinite(createdAt) ? { createdAt } : {}) });
    },
    dispose: () => { for (const notification of shown.splice(0)) notification.close(); },
  };
}
