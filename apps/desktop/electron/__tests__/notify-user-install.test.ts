import { beforeEach, expect, it, vi } from "vitest";
import { NOTIFY_USER_KINDS, type NotifyUserEvent } from "@zeros/protocol/notify-user";

const h = vi.hoisted(() => ({
  account: "account-a" as string | null,
  listeners: new Set<() => void>(),
  commands: new Map<string, (args: Record<string, unknown>, event: unknown) => unknown>(),
  open: [] as Array<{ title: string; click?: () => void; closed: boolean }>,
  window: null as null | { isDestroyed(): boolean; webContents: { mainFrame: object } },
}));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  Notification: class {
    static isSupported() { return true; }
    private readonly row: { title: string; click?: () => void; closed: boolean };
    constructor(options: { title: string }) { this.row = { title: options.title, closed: false }; h.open.push(this.row); }
    on(_event: "click", listener: () => void) { this.row.click = listener; }
    show() {}
    close() { this.row.closed = true; }
  },
}));
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn(), getMainWindow: () => h.window, openMainWindowForNavigation: vi.fn() }));
vi.mock("../ipc/router", () => ({ setCommand: (name: string, run: (args: Record<string, unknown>, event: unknown) => unknown) => { h.commands.set(name, run); } }));
vi.mock("../ipc/commands/auth-session", () => ({
  getSessionUserForMain: () => h.account ? { accountId: h.account, sessionId: `${h.account}-session` } : null,
  onMainAuthSessionChanged: (listener: () => void) => { h.listeners.add(listener); return () => h.listeners.delete(listener); },
}));

import { installNotifyUser } from "../notify-user/install";

const event = (notificationId: string): NotifyUserEvent => ({
  notificationId, kind: NOTIFY_USER_KINDS[0], createdAt: new Date().toISOString(), title: "Ready for review",
  message: "Done", workspace: { id: "11111111-1111-4111-8111-111111111111", name: "w-1", title: null }, chat: { id: "chat-a", title: "A's private chat" },
});
const sessionChanged = (account: string | null) => { h.account = account; for (const listener of h.listeners) listener(); };
/** The window comes back after the click, as when one was clicked with none open. */
function takeOpen() {
  const webContents = { mainFrame: {} };
  h.window = { isDestroyed: () => false, webContents };
  return h.commands.get("notify_user_take_open")!({}, { sender: webContents, senderFrame: webContents.mainFrame });
}

beforeEach(() => { h.account = "account-a"; h.window = null; h.listeners.clear(); h.commands.clear(); h.open.length = 0; });

it("keeps a same-account click for the window that comes back", () => {
  const notify = installNotifyUser();
  notify.receiveDevice(event("0f0e0d0c-0b0a-4908-8706-050403020101"));
  h.open[0]!.click!();
  sessionChanged("account-a");
  expect(takeOpen()).toEqual({ workspaceId: "11111111-1111-4111-8111-111111111111", chatId: "chat-a" });
  notify.dispose();
});

it("retires one account's notifications and pending open before the next account signs in", () => {
  const notify = installNotifyUser();
  notify.receiveDevice(event("0f0e0d0c-0b0a-4908-8706-050403020100"));
  expect(h.open.map(row => row.title)).toEqual(["A's private chat · needs you"]);
  h.open[0]!.click!();

  sessionChanged("account-a"); // A token refresh is not an account change.
  expect(h.open[0]!.closed).toBe(false);

  sessionChanged(null);
  sessionChanged("account-b");
  expect(h.open[0]!.closed).toBe(true);
  expect(takeOpen()).toBeNull();
  notify.dispose();
});
