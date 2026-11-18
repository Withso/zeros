import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudV2ProxyRoutes } from "../proxy.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("acting-user Codex proxy", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(f.creator, "codex"); await f.login(f.viewer, "codex"); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const setup = async (fetcher: typeof fetch) => {
    const turn = await f.dispatch(f.prompt(randomUUID(), { agentId: "codex" }), f.viewer);
    const response = await f.worker("turn-lease", turn.lease); expect(response.status).toBe(200);
    const lease = await response.json(), token = lease.agents.codex.token;
    const app = createCloudV2ProxyRoutes({ ...f.cp.proxy, fetch: fetcher });
    const request = () => app.request("/v2/cloud/proxy/openai/responses", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "chatgpt-account-id": "forged" }, body: "{}" });
    return { ...turn, token, request };
  };

  it("uses the pinned Creator login and rejects the token after its context ends", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer synthetic-codex-${f.creator.id}`);
      expect(new Headers(options?.headers).has("chatgpt-account-id")).toBe(false);
      return Response.json({ ok: true });
    });
    const turn = await setup(fetcher);
    const response = await turn.request(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await f.worker("prompts/outcome", { userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" });
    expect((await turn.request()).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not release an upstream reply after Stop wins during the fetch", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>(async () => { entered.resolve(); return release.promise; });
    const turn = await setup(fetcher), pending = turn.request();
    await Promise.race([entered.promise, pending.then(response => { throw new Error(`upstream was not called: ${response.status}`); })]);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", { chatId: "chat", throughEpoch: "0" }, f.viewer, { "X-Zeros-Team-Sharing": "1" })).status).toBe(200);
    release.resolve(Response.json({ mustNotEscape: true }));
    const response = await pending; expect(response.status).toBe(401); expect(await response.text()).not.toContain("mustNotEscape");
  });

  it("fences each streamed chunk after a context has been revoked", async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
    const turn = await setup(async () => new Response(source));
    const response = await turn.request(); expect(response.status).toBe(200);
    const reader = response.body!.getReader(); output.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await f.worker("prompts/outcome", { userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" });
    const next = reader.read(); output.enqueue(new TextEncoder().encode("mustNotEscape"));
    await expect(next).rejects.toThrow();
  });

  // statements-2: a token check is one transaction (was about 6); each chunk still waits for its own check.
  const transactions = async (run: () => Promise<void>) => {
    const scope = new AsyncLocalStorage<boolean>(), query = pg.Client.prototype.query;
    let count = 0;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (scope.getStore() && typeof args[0] === "string" && /^BEGIN\b/.test(args[0])) count += 1;
      return (query as (...values: unknown[]) => unknown).apply(this, args);
    } as never);
    try { await scope.run(true, run); } finally { spy.mockRestore(); }
    return count;
  };
  const waiting = (chunks: string[], close = true) => new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    if (close) controller.close();
  } });

  it("checks a token in one transaction", async () => {
    const turn = await setup(async () => Response.json({}));
    let check!: () => Promise<number>;
    // Token check, login read, token check.
    expect(await transactions(async () => { ({ check } = await f.cp.execution.proxyAccess(turn.token)); })).toBe(3);
    expect(await transactions(async () => { await check(); })).toBe(1);
  });

  it("streams twenty chunks with 27 transactions (157 before statements-2)", async () => {
    const chunks = Array.from({ length: 20 }, (_, index) => `chunk-${index};`);
    const turn = await setup(async () => new Response(waiting(chunks)));
    let text = "";
    // proxyAccess 3, a check before and after the upstream request and at stream start, then one per chunk and one for the end.
    expect(await transactions(async () => {
      const response = await turn.request(); expect(response.status).toBe(200);
      text = await response.text();
    })).toBe(27);
    expect(text).toBe(chunks.join(""));
  });

  it("releases no waiting chunk whose check starts after the turn has ended", async () => {
    const turn = await setup(async () => new Response(waiting(["first", "second", "third"], false)));
    const response = await turn.request(); expect(response.status).toBe(200);
    const reader = response.body!.getReader(), received: string[] = [];
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await f.worker("prompts/outcome", { userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" });
    // The stream reads one chunk ahead, so "second" may already have passed its check before the turn ended.
    await expect((async () => { for (;;) { const value = await reader.read(); if (value.done) return; received.push(new TextDecoder().decode(value.value)); } })())
      .rejects.toThrow();
    expect(received).not.toContain("third");
  });

  it("never releases a chunk that arrived after the check covering the earlier chunks started", async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
    const turn = await setup(async () => new Response(source));
    const response = await turn.request(); expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const tokenContext = f.cp.execution.tokenContext.bind(f.cp.execution);
    let raced = false;
    vi.spyOn(f.cp.execution, "tokenContext").mockImplementation(async (...args) => {
      const result = await tokenContext(...args);
      if (!raced) {
        // This check has passed for "first"; "late" arrives and the turn ends before it reports back.
        raced = true;
        output.enqueue(new TextEncoder().encode("late"));
        await f.worker("prompts/outcome", { userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" });
      }
      return result;
    });
    output.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await expect(reader.read()).rejects.toThrow();
    expect(raced).toBe(true);
  });
});
