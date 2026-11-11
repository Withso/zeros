import { NOTIFY_USER_LIMITS } from "@zeros/protocol/notify-user";

/** One NotifyUser, from the device channel or an attached app's bridge. */
export interface NotifyUserArrival {
  notificationId: string;
  workspaceId: string;
  /** The worker's chat id (not the renderer's scoped id). */
  chatId: string;
  chatTitle: string;
  /** The agent's title: the only agent text a notification shows. */
  title: string;
  /** Device events carry it; a stale one is dropped. */
  createdAt?: number;
}
export type NotifyUserTarget = Pick<NotifyUserArrival, "workspaceId" | "chatId">;

const SEEN_LIMIT = 256;

/** Main owns de-duplication and the OS notification: both delivery paths
 * name the same notification id, and only one notification may show. */
export class NotifyUserCenter {
  private readonly seen = new Map<string, number>();
  private inView = new Set<string>();
  constructor(private readonly deps: {
    now(): number;
    /** A focused app window; a chat on screen there needs no notification. */
    focused(): boolean;
    show(notification: { title: string; body: string; onClick(): void }): void;
    open(target: NotifyUserTarget): void;
    /** Device arrivals only: the renderer marks the chat unread. */
    attention(arrival: NotifyUserArrival): void;
  }) {}

  /** Worker chat keys (`<workspaceId>/<chatId>`) on screen in the app window. */
  setChatsInView(keys: readonly string[]): void { this.inView = new Set(keys); }

  receive(source: "device" | "app", arrival: NotifyUserArrival): boolean {
    const now = this.deps.now();
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    if (arrival.createdAt !== undefined && now - arrival.createdAt > NOTIFY_USER_LIMITS.lifetimeMs) return false;
    if (this.seen.has(arrival.notificationId)) return false;
    this.seen.set(arrival.notificationId, now + NOTIFY_USER_LIMITS.lifetimeMs);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value!);
    if (source === "device") this.deps.attention(arrival);
    if (this.deps.focused() && this.inView.has(`${arrival.workspaceId}/${arrival.chatId}`)) return true;
    // A lock screen can show this: the chat's title and the agent's title only.
    this.deps.show({ title: `${arrival.chatTitle.trim() || "A chat"} · needs you`.slice(0, 200), body: arrival.title,
      onClick: () => this.deps.open({ workspaceId: arrival.workspaceId, chatId: arrival.chatId }) });
    return true;
  }
}
