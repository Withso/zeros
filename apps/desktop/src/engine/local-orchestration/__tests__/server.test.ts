// The loopback endpoint the CLI calls: exact loopback Host, no browser
// Origin, one POST path, an execution-scoped bearer and bounded bodies.

import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { LOCAL_MAX_REQUEST_BYTES, LOCAL_ORCHESTRATION_CALL_PATH, localOk, type LocalEnvelope } from "@zeros/protocol/local-orchestration";
import { LocalCapabilityRegistry, LocalOrchestrationServer } from "../server";
import type { LocalCallerScope } from "../types";

const scope: LocalCallerScope = { executionId: "exec-1", chatId: "chat-1", agentId: "claude", surface: "cli" };
let server: LocalOrchestrationServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

function request(
  url: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: { ok: boolean; error?: { code: string } } }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: options.method ?? "POST",
        path: options.path ?? LOCAL_ORCHESTRATION_CALL_PATH,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function start(handler: (s: LocalCallerScope, body: unknown) => Promise<LocalEnvelope> = async (s, body) => localOk({ scope: s, body }, { engine: "e" })) {
  const registry = new LocalCapabilityRegistry();
  server = new LocalOrchestrationServer(registry, handler, () => "engine");
  await server.start();
  return { registry, url: server.url };
}

describe("Local CLI endpoint", () => {
  it("serves a valid bearer on 127.0.0.1 and resolves it to its execution", async () => {
    const seen: LocalCallerScope[] = [];
    const { registry, url } = await start(async (s) => {
      seen.push(s);
      return localOk({}, { engine: "e" });
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const token = registry.mint(scope);
    const res = await request(url, { headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ command: "whoami" }) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(seen).toEqual([scope]);
  });

  it("refuses missing, revoked and foreign bearers", async () => {
    const { registry, url } = await start();
    const token = registry.mint(scope);
    expect((await request(url, { body: "{}" })).status).toBe(401);
    expect((await request(url, { headers: { authorization: "Bearer nope" }, body: "{}" })).body.error?.code).toBe("NO_CAPABILITY");
    registry.revokeExecution("exec-1");
    expect((await request(url, { headers: { authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(401);
    expect(registry.size).toBe(0);
  });

  it("rechecks a bearer revoked while its request body was arriving", async () => {
    const handler = vi.fn(async () => localOk({}, { engine: "e" }));
    const { registry, url } = await start(handler);
    const token = registry.mint(scope);
    let headersAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => { headersAccepted = resolve; });
    const original = registry.resolve.bind(registry);
    vi.spyOn(registry, "resolve").mockImplementation((value) => {
      const resolved = original(value);
      headersAccepted();
      return resolved;
    });
    let req!: http.ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      req = http.request(url + LOCAL_ORCHESTRATION_CALL_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
    });
    req.write('{"protocol":1,');
    await accepted;
    registry.revokeExecution(scope.executionId);
    req.end('"command":"whoami","args":{}}');

    expect(await response).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses browsers, other hosts and other paths", async () => {
    const { registry, url } = await start();
    const auth = { authorization: `Bearer ${registry.mint(scope)}` };
    expect((await request(url, { headers: { ...auth, origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    expect((await request(url, { headers: { ...auth, host: "attacker.test" }, body: "{}" })).status).toBe(421);
    expect((await request(url, { headers: auth, path: "/other", body: "{}" })).status).toBe(404);
    expect((await request(url, { headers: auth, method: "GET" })).status).toBe(404);
  });

  it("bounds request bodies", async () => {
    const { registry, url } = await start();
    const auth = { authorization: `Bearer ${registry.mint(scope)}` };
    const huge = JSON.stringify({ command: "whoami", args: { pad: "x".repeat(LOCAL_MAX_REQUEST_BYTES) } });
    expect((await request(url, { headers: auth, body: huge })).status).toBe(413);
    expect((await request(url, { headers: auth, body: "not json" })).status).toBe(413);
  });

  it("never returns a thrown handler error to the caller", async () => {
    const { registry, url } = await start(async () => {
      throw new Error("secret detail");
    });
    const res = await request(url, { headers: { authorization: `Bearer ${registry.mint(scope)}` }, body: "{}" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });

  it("starts one listener for concurrent first admissions", async () => {
    const registry = new LocalCapabilityRegistry();
    server = new LocalOrchestrationServer(registry, async () => localOk({}, { engine: "e" }), () => "engine");
    const listen = vi.spyOn(http.Server.prototype, "listen");
    await Promise.all([server.start(), server.start(), server.start()]);
    expect(listen).toHaveBeenCalledTimes(1);
    listen.mockRestore();
    expect(server.running).toBe(true);
  });

  it("keeps a long call's connection alive with whitespace the JSON reader ignores", async () => {
    const registry = new LocalCapabilityRegistry();
    server = new LocalOrchestrationServer(
      registry,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return localOk({ waited: true }, { engine: "e" });
      },
      () => "engine",
      { keepaliveMs: 20 },
    );
    await server.start();
    const target = new URL(server.url);
    const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { host: target.hostname, port: target.port, method: "POST", path: LOCAL_ORCHESTRATION_CALL_PATH, headers: { authorization: `Bearer ${registry.mint(scope)}` } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ command: "chat.wait" }));
    });
    expect(raw.status).toBe(200);
    expect(raw.text.startsWith(" ")).toBe(true);
    expect(JSON.parse(raw.text)).toMatchObject({ ok: true, result: { waited: true } });
  });

  it("stores only token hashes", () => {
    const registry = new LocalCapabilityRegistry();
    const token = registry.mint(scope);
    expect(JSON.stringify([...((registry as unknown as { byHash: Map<string, unknown> }).byHash.keys())])).not.toContain(token);
    expect(registry.resolve(token)).toEqual(scope);
    registry.revoke(token);
    expect(registry.resolve(token)).toBeNull();
  });
});
