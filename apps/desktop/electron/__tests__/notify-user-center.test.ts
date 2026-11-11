import { describe, expect, it } from "vitest";
import { NotifyUserCenter, type NotifyUserArrival, type NotifyUserTarget } from "../notify-user/center";

const arrival: NotifyUserArrival = { notificationId: "0f0e0d0c-0b0a-4908-8706-050403020100", workspaceId: "11111111-1111-4111-8111-111111111111",
  chatId: "chat-1", chatTitle: "Simulator", title: "Ready for review" };
function fixture(focused = false) {
  let now = 1_000_000;
  const shown: Array<{ title: string; body: string; onClick(): void }> = [], opened: NotifyUserTarget[] = [], marked: string[] = [];
  const center = new NotifyUserCenter({ now: () => now, focused: () => focused, show: n => { shown.push(n); }, open: t => { opened.push(t); },
    attention: a => { marked.push(a.notificationId); } });
  return { center, shown, opened, marked, advance: (ms: number) => { now += ms; }, setFocused: (value: boolean) => { focused = value; }, now: () => now };
}

describe("NotifyUserCenter", () => {
  it("shows one notification for both paths: the chat's title and the agent's title, never the message; click opens the chat", () => {
    const f = fixture();
    expect(f.center.receive("app", arrival)).toBe(true);
    expect(f.center.receive("device", { ...arrival, createdAt: f.now() })).toBe(false);
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0]).toMatchObject({ title: "Simulator · needs you", body: "Ready for review" });
    expect(f.marked).toEqual([]); // the app path already marked it
    f.shown[0]!.onClick();
    expect(f.opened).toEqual([{ workspaceId: arrival.workspaceId, chatId: "chat-1" }]);
  });

  it("marks the chat unread for a device arrival, and shows nothing while that chat is on screen in a focused window", () => {
    const f = fixture(true);
    f.center.setChatsInView([`${arrival.workspaceId}/chat-1`]);
    expect(f.center.receive("device", { ...arrival, createdAt: f.now() })).toBe(true);
    expect(f.marked).toEqual([arrival.notificationId]);
    expect(f.shown).toHaveLength(0);
    // The same chat behind an unfocused window, or another chat, notifies.
    f.setFocused(false);
    f.center.receive("device", { ...arrival, notificationId: "1f0e0d0c-0b0a-4908-8706-050403020100", createdAt: f.now() });
    f.setFocused(true);
    f.center.receive("app", { ...arrival, notificationId: "2f0e0d0c-0b0a-4908-8706-050403020100", chatId: "chat-2" });
    expect(f.shown).toHaveLength(2);
  });

  it("drops a device event older than ten minutes, and forgets ids after their lifetime", () => {
    const f = fixture();
    expect(f.center.receive("device", { ...arrival, createdAt: f.now() - 600_001 })).toBe(false);
    expect(f.shown).toHaveLength(0);
    f.center.receive("app", arrival);
    f.advance(600_000);
    expect(f.center.receive("app", arrival)).toBe(true);
    expect(f.shown).toHaveLength(2);
  });

  it("names an untitled chat plainly", () => {
    const f = fixture();
    f.center.receive("app", { ...arrival, chatTitle: "  " });
    expect(f.shown[0]!.title).toBe("A chat · needs you");
  });
});
