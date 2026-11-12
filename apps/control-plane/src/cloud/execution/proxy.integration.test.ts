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
});
