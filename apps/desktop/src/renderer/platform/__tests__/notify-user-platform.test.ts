import { beforeEach, describe, expect, it, vi } from "vitest";

const ws = "11111111-1111-4111-8111-111111111111", org = "22222222-2222-4222-8222-222222222222";
const state = vi.hoisted(() => ({ invokes: [] as Array<{ cmd: string; args?: unknown }>, listeners: new Map<string, (value: unknown) => void>(),
  docs: [] as Array<{ id: string; organizationId: string; number?: number }>, refreshed: 0, toasts: [] as string[], pendingOpen: null as unknown }));
vi.mock("../runtime", async original => ({ ...await original<typeof import("../runtime")>(), isElectron: () => true,
  nativeInvoke: async (cmd: string, args?: unknown) => { state.invokes.push({ cmd, args }); return cmd === "notify_user_take_open" ? state.pendingOpen : true; },
  nativeListen: async (name: string, listener: (value: unknown) => void) => { state.listeners.set(name, listener); return () => { state.listeners.delete(name); }; } }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocumentById: (id: string) => state.docs.find(doc => doc.id === id),
  refreshCloudWorkspaceCatalog: async () => { state.refreshed++; },
}));
vi.mock("../../features/team/team-store", () => ({ getTeamStoreState: () => ({ me: { organizations: [{ id: org, slug: "Acme" }] } }) }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: (text: string) => { state.toasts.push(text); } } }));
vi.mock("../local-links", () => ({ openLocalLink: () => {}, resolveLocalLinkScheme: async () => "zeros" }));
import { chatUnread, resetChatUnreadForTests, setChatsInView } from "../../features/agent/chat-unread";
import { cloudScopedId } from "../bridge/cloud-workspace-key";
import { noteAttention, openNotifiedChat, startNotifyUser } from "../notify-user";

const update = { sessionUpdate: "attention", notificationId: "0f0e0d0c-0b0a-4908-8706-050403020100", kind: "review", title: "Ready for review", message: "Done." };
const scoped = (chatId: string) => cloudScopedId({ organizationId: org, workspaceId: ws }, chatId);
beforeEach(() => { state.invokes = []; state.listeners.clear(); state.docs = []; state.refreshed = 0; state.toasts = []; state.pendingOpen = null; resetChatUnreadForTests(); });

describe("NotifyUser in the renderer", () => {
  it("marks an attention chat unread unless on screen, and hands main the worker's ids and the agent's title only", () => {
    expect(noteAttention(scoped("chat-1"), { sessionUpdate: "turn_state" })).toBe(false);
    expect(noteAttention(scoped("chat-1"), update)).toBe(true);
    expect(chatUnread(scoped("chat-1"))).toBe(true);
    expect(state.invokes).toEqual([{ cmd: "notify_user_attention", args: { notificationId: update.notificationId, workspaceId: ws, chatId: "chat-1", chatTitle: "", title: "Ready for review" } }]);
    setChatsInView([scoped("chat-2")]);
    noteAttention(scoped("chat-2"), { ...update, notificationId: "1f0e0d0c-0b0a-4908-8706-050403020100" });
    expect(chatUnread(scoped("chat-2"))).toBe(false);
  });

  it("opens a clicked chat through the app's link route, by organization slug and number, else its workspace", async () => {
    const opened: string[] = [];
    state.docs = [{ id: ws, organizationId: org, number: 7 }];
    await openNotifiedChat({ workspaceId: ws, chatId: "chat-1" }, href => { opened.push(href); });
    state.docs = [{ id: ws, organizationId: org }];
    await openNotifiedChat({ workspaceId: ws, chatId: "chat-1" }, href => { opened.push(href); });
    expect(opened).toEqual(["zeros://acme/w/7?session=chat-1", `zeros://cloud-workspace/${org}/${ws}`]);
    state.docs = [];
    await openNotifiedChat({ workspaceId: ws, chatId: "chat-1" }, href => { opened.push(href); });
    expect(state.refreshed).toBe(1);
    expect(state.toasts).toEqual(["You don't have access to that chat."]);
    expect(opened).toHaveLength(2);
  });

  it("tells main which cloud chats are on screen, marks device arrivals unread, and takes a click made while the window was closed", async () => {
    state.docs = [{ id: ws, organizationId: org, number: 7 }];
    state.pendingOpen = { workspaceId: ws, chatId: "chat-9" };
    setChatsInView([scoped("chat-1"), "/local/chat"]);
    const stop = startNotifyUser();
    expect(state.invokes[0]).toEqual({ cmd: "notify_user_view", args: { chats: [`${ws}/chat-1`] } });
    await vi.waitFor(() => expect(state.invokes.map(call => call.cmd)).toContain("notify_user_take_open"));
    state.listeners.get("notify-user:attention")!({ workspaceId: ws, chatId: "chat-3" });
    await vi.waitFor(() => expect(chatUnread(scoped("chat-3"))).toBe(true));
    setChatsInView([]);
    expect(state.invokes.at(-1)).toEqual({ cmd: "notify_user_view", args: { chats: [] } });
    stop();
    expect(state.listeners.size).toBe(0);
  });
});
