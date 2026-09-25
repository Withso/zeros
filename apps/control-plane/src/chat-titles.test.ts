import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createChatTitleRoutes, sanitizeChatTitle } from "./chat-titles.js";
import { HttpError } from "./authz.js";

const payload = {
  chatId: "chat-1",
  messageId: "message-1",
  prompt: "Fix the login redirect bug",
};
const completed = (text = "Fix login redirect bug") => ({
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});
let userId = "title-user";
function app(key: string | null = "synthetic-title-key") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId } as never);
    await next();
  });
  app.route("/", createChatTitleRoutes(key));
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : error instanceof HttpError
        ? c.json({ error: { code: error.code } }, error.status)
        : c.json({ error: "unexpected" }, 500),
  );
  return app;
}
const post = (server: Hono, body: unknown = payload) =>
  server.request("/v1/chat-titles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  userId = crypto.randomUUID();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(completed())),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("chat title endpoint", () => {
  it("reads assistant text after response metadata without assuming output order", async () => {
    const body = completed();
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        ...body,
        output: [
          { type: "reasoning", id: "reasoning-item", summary: [] },
          ...body.output,
        ],
      }),
    );
    expect(await (await post(app())).json()).toEqual({
      title: "Fix login redirect bug",
    });
  });

  it("accepts a completed response whose message omits the optional status", async () => {
    const body = completed();
    const { status: _status, ...message } = body.output[0]!;
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...body, output: [message] }),
    );
    expect(await (await post(app())).json()).toEqual({
      title: "Fix login redirect bug",
    });
  });

  it("bounds in-flight calls and releases capacity on completion", async () => {
    const releases: Array<() => void> = [];
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(Response.json(completed())));
        }),
    );
    const server = app();
    const pending = Array.from({ length: 8 }, (_, i) =>
      post(server, { ...payload, chatId: String(i) }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(8));
    expect(
      (await post(server, { ...payload, chatId: "overflow" })).status,
    ).toBe(429);
    // A duplicate still shares existing work when all slots are occupied.
    const duplicate = post(server, { ...payload, chatId: "0" });
    for (const release of releases) release();
    await Promise.all([...pending, duplicate]);
    expect(fetch).toHaveBeenCalledTimes(8);
    vi.mocked(fetch).mockResolvedValue(Response.json(completed()));
    expect((await post(server, { ...payload, chatId: "after" })).status).toBe(
      200,
    );
  });

  it("times out the upstream call without retrying or leaking its error", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(10_000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () =>
            reject(new Error("private timeout")),
          );
        }),
    );
    const response = post(app());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await (await response).json()).toEqual({ title: null });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("expires duplicate results after a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = app();
    await post(server);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 + 1);
    await post(server);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("enforces the daily ceiling across minute windows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = app();
    for (let i = 0; i < 500; i++) {
      if (i % 20 === 0) vi.setSystemTime(Date.now() + 60_001);
      expect(
        (await post(server, { ...payload, chatId: String(i) })).status,
      ).toBe(200);
    }
    vi.setSystemTime(Date.now() + 60_001);
    expect(
      (await post(server, { ...payload, chatId: "daily-overflow" })).status,
    ).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(500);
  });

  it("uses a tiny fixed Luna request without tools, history, or stored responses", async () => {
    expect(await (await post(app())).json()).toEqual({
      title: "Fix login redirect bug",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer synthetic-title-key",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      max_output_tokens: 32,
      store: false,
      instructions: expect.any(String),
      input: payload.prompt,
    });
    expect((init?.signal as AbortSignal).aborted).toBe(false);
  });
  it("stays disabled without a server key", async () => {
    expect((await post(app(null))).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { ...payload, prompt: " " },
    { ...payload, prompt: "x".repeat(501) },
    { ...payload, prompt: "😀".repeat(501) },
    { ...payload, prompt: 12 },
    { ...payload, chatId: "" },
    { ...payload, messageId: "" },
    { ...payload, model: "expensive-model" },
    { ...payload, systemPrompt: "override" },
    { ...payload, env: { OPENAI_API_KEY: "caller-key" } },
  ])("rejects malformed or client-configurable requests %#", async (body) => {
    expect((await post(app(), body)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts 500 Unicode characters", async () => {
    expect(
      (await post(app(), { ...payload, prompt: "😀".repeat(500) })).status,
    ).toBe(200);
  });
  it("rejects oversized bodies and malformed JSON", async () => {
    expect(
      (await post(app(), { ...payload, prompt: "x".repeat(9000) })).status,
    ).toBe(413);
    const response = await app().request("/v1/chat-titles", {
      method: "POST",
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shares concurrent duplicates and caches the result", async () => {
    const server = app();
    const responses = await Promise.all([
      post(server),
      post(server),
      post(server),
    ]);
    for (const response of responses)
      expect(await response.json()).toEqual({
        title: "Fix login redirect bug",
      });
    await post(server);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("isolates account identities and rejects changed input for one request identity", async () => {
    const server = app();
    await post(server);
    expect(
      (await post(server, { ...payload, prompt: "Different topic" })).status,
    ).toBe(409);
    userId = crypto.randomUUID();
    await post(server);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([401, 429, 500])(
    "keeps upstream errors private and does not retry (%s)",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("private prompt or key", { status }),
      );
      const server = app();
      expect(await (await post(server)).json()).toEqual({ title: null });
      expect(await (await post(server)).json()).toEqual({ title: null });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { ...completed(), status: "incomplete" },
    { ...completed(), error: { message: "private" } },
    {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "no" }] },
      ],
    },
    completed(""),
    completed("Two words"),
    null,
  ])("discards incomplete, refused, and invalid replies %#", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    expect(await (await post(app())).json()).toEqual({ title: null });
  });
  it("contains network and JSON errors", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error("private transport detail"),
    );
    expect(await (await post(app())).json()).toEqual({ title: null });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not JSON"));
    expect(await (await post(app())).json()).toEqual({ title: null });
  });
  it("caps paid requests per user", async () => {
    const server = app();
    for (let i = 0; i < 20; i++)
      expect(
        (await post(server, { ...payload, chatId: String(i) })).status,
      ).toBe(200);
    expect(
      (await post(server, { ...payload, chatId: "overflow" })).status,
    ).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(20);
  });
});

describe("title output contract", () => {
  it.each([
    ['"Fix login redirect bug."', "Fix login redirect bug"],
    ["**Fix login redirect bug**", "Fix login redirect bug"],
    ["Fix login redirect bug\nExplanation", "Fix login redirect bug"],
    ["Fix the login redirect bug now", "Fix the login redirect bug"],
    ["🔧 Fix login redirect bug", "Fix login redirect bug"],
    ["修复 登录 跳转 问题", "修复 登录 跳转 问题"],
    ["Error: authentication failed", null],
    ["I cannot help with that", null],
    ["...", null],
    ["Two words", null],
    ["a".repeat(90) + " two three", null],
  ])("sanitizes %s", (input, expected) => {
    expect(sanitizeChatTitle(input)).toBe(expected);
  });
});
