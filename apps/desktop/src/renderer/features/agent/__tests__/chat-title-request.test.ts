import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  url: "https://api.example.test",
  chats: [{ id: "chat-1", title: "Untitled", folder: "/repo", createdAt: 1 }],
  session: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../../auth/auth-store", () => ({
  getSession: state.session,
  onAuthStateChange: state.subscribe,
}));
vi.mock("../../team/control-plane", () => ({
  get CONTROL_PLANE_URL() {
    return state.url;
  },
}));
vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceStore: { getState: () => ({ chats: state.chats }) },
}));
const session = {
  access_token: "synthetic-session-token",
  user: { sub: "account-1", provider: "workos" },
};
const args = () => ({
  chatId: "chat-1",
  messageId: "message-1",
  prompt: "Fix the login redirect bug",
  expectedTitle: "Untitled",
  dispatch: vi.fn(),
});
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  state.url = "https://api.example.test";
  state.chats = [
    { id: "chat-1", title: "Untitled", folder: "/repo", createdAt: 1 },
  ];
  state.session.mockReset().mockResolvedValue(session);
  state.subscribe.mockReset().mockImplementation(() => vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ title: "Fix login redirect bug" })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background chat title requests", () => {
  it("sends only the compact first message with app auth and renames with CAS", async () => {
    const { requestAiChatTitle } = await import("../chat-title");
    const input = {
      ...args(),
      prompt: "a".repeat(400) + "private-middle" + "z".repeat(100),
    };
    expect(requestAiChatTitle(input)).toBe(true);
    expect(input.dispatch).not.toHaveBeenCalled();
    await settled();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/chat-titles");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer synthetic-session-token",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      chatId: "chat-1",
      messageId: "message-1",
      prompt: "a".repeat(400) + "z".repeat(100),
    });
    expect(input.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "UPDATE_CHAT_TITLE_IF",
      id: "chat-1",
      title: "Fix login redirect bug",
      expectedTitle: "Untitled",
    });
  });
  it("deduplicates concurrent renders and later remounts", async () => {
    const { requestAiChatTitle } = await import("../chat-title");
    const input = args();
    requestAiChatTitle(input);
    requestAiChatTitle(input);
    await settled();
    requestAiChatTitle(input);
    await settled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(input.dispatch).toHaveBeenCalledOnce();
  });
  it("does not consume the title attempt before an auth session is available", async () => {
    const { requestAiChatTitle } = await import("../chat-title");
    const input = args();
    state.session.mockResolvedValue(null);
    requestAiChatTitle(input);
    await settled();
    expect(fetch).not.toHaveBeenCalled();

    state.session.mockResolvedValue(session);
    requestAiChatTitle(input);
    await settled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(input.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix login redirect bug" }),
    );
  });
  it("starts naming when sign-in becomes available without remounting the chat", async () => {
    const { startChatTitleRequest } = await import("../chat-title");
    const input = args();
    state.session.mockResolvedValue(null);
    const stop = startChatTitleRequest(input);
    await settled();
    expect(fetch).not.toHaveBeenCalled();

    state.session.mockResolvedValue(session);
    const onSignIn = state.subscribe.mock.calls[0]![0];
    onSignIn(session);
    onSignIn(session);
    await settled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(input.dispatch).toHaveBeenCalledOnce();
    stop();
    expect(state.subscribe.mock.results[0]!.value).toHaveBeenCalledOnce();
  });
  it("stops waiting for sign-in when the chat effect becomes inactive", async () => {
    const { startChatTitleRequest } = await import("../chat-title");
    state.session.mockResolvedValue(null);
    const stop = startChatTitleRequest(args());
    await settled();
    stop();
    state.session.mockResolvedValue(session);
    state.subscribe.mock.calls[0]![0](session);
    await settled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, session])(
    "handles sign-in while the initial session lookup is pending (%#)",
    async (staleSession) => {
      let release!: (value: typeof session | null) => void;
      state.session.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const { startChatTitleRequest } = await import("../chat-title");
      const input = args();
      const stop = startChatTitleRequest(input);
      state.subscribe.mock.calls[0]![0](session);
      await settled();
      expect(fetch).toHaveBeenCalledOnce();
      release(staleSession);
      await settled();
      expect(fetch).toHaveBeenCalledOnce();
      expect(input.dispatch).toHaveBeenCalledOnce();
      stop();
    },
  );
  it.each([
    "renamed",
    "deleted",
    "replaced",
    "moved",
    "signed-out",
    "account-changed",
  ])("ignores a stale response when %s", async (change) => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    const { requestAiChatTitle } = await import("../chat-title");
    const input = args();
    requestAiChatTitle(input);
    await settled();
    if (change === "renamed") state.chats[0]!.title = "My custom title";
    if (change === "deleted") state.chats = [];
    if (change === "replaced") state.chats[0]!.createdAt = 2;
    if (change === "moved") state.chats[0]!.folder = "/different-owner";
    if (change === "signed-out") state.session.mockResolvedValue(null);
    if (change === "account-changed")
      state.session.mockResolvedValue({
        ...session,
        user: { ...session.user, sub: "account-2" },
      });
    resolve(Response.json({ title: "Fix login redirect bug" }));
    await settled();
    expect(input.dispatch).not.toHaveBeenCalled();
  });
  it("keeps different chats independent", async () => {
    state.chats.push({ ...state.chats[0]!, id: "chat-2" });
    const { requestAiChatTitle } = await import("../chat-title");
    const first = args(),
      second = { ...args(), chatId: "chat-2" };
    requestAiChatTitle(first);
    requestAiChatTitle(second);
    await settled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-1" }),
    );
    expect(second.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-2" }),
    );
  });
  it.each([401, 429, 503])(
    "leaves the seed on HTTP %s without retries",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("private error", { status }),
      );
      const { requestAiChatTitle } = await import("../chat-title");
      const input = args();
      requestAiChatTitle(input);
      await settled();
      requestAiChatTitle(input);
      await settled();
      expect(fetch).toHaveBeenCalledOnce();
      expect(input.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { title: null },
    { title: 12 },
    { title: "Two words" },
    { title: "Error: authentication failed" },
  ])("ignores unusable response %#", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    const { requestAiChatTitle } = await import("../chat-title");
    const input = args();
    requestAiChatTitle(input);
    await settled();
    expect(input.dispatch).not.toHaveBeenCalled();
  });
  it("contains network errors", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("private network detail"));
    const { requestAiChatTitle } = await import("../chat-title");
    const input = args();
    requestAiChatTitle(input);
    await settled();
    expect(input.dispatch).not.toHaveBeenCalled();
  });
  it("makes no request while signed out, unconfigured, blank, or already renamed", async () => {
    const { requestAiChatTitle } = await import("../chat-title");
    const input = args();
    expect(requestAiChatTitle({ ...input, prompt: "  " })).toBe(false);
    state.url = "";
    expect(requestAiChatTitle(input)).toBe(false);
    state.url = "https://api.example.test";
    state.chats[0]!.title = "Manual title";
    expect(requestAiChatTitle(input)).toBe(false);
    state.chats[0]!.title = "Untitled";
    state.session.mockResolvedValue(null);
    requestAiChatTitle(input);
    await settled();
    expect(fetch).not.toHaveBeenCalled();
    expect(input.dispatch).not.toHaveBeenCalled();
  });
});
