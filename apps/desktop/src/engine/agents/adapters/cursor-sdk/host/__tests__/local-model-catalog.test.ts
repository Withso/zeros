// Regression (Alpha log, 2026-11-05): a reopened Cursor chat waited 31 s before
// its first turn. Zeros had already read the account's catalog, but
// @cursor/sdk 1.2.0 validates `model` inside Agent.create/resume against a
// fresh GET /v1/models (each call builds a new platform with an empty cache),
// and that second read took 25 s. The engine now hands the host the confirmed
// record for the selected model; the host exposes it through the SDK's own
// CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON for that call only.
//
// Drives the REAL cursor-host.cjs and the REAL @cursor/sdk against a loopback
// backend, so an SDK upgrade that drops or renames the hook fails here.

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cursor-host.cjs");
const MODEL = { id: "composer-2.5", displayName: "Composer 2.5" };

interface Reply { ok: boolean; result?: { agentId?: string; handleId?: string }; error?: { message?: string } }

/** A loopback Cursor backend that holds every catalog read until released. */
class Backend {
  readonly catalogReads: Array<() => void> = [];
  private arrived: Array<() => void> = [];
  private server: Server;
  url = "";

  constructor() {
    this.server = createServer((request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/models") {
        this.catalogReads.push(() => response.end(JSON.stringify({ items: [MODEL] })));
        for (const notify of this.arrived.splice(0)) notify();
        return;
      }
      response.writeHead(401);
      response.end(JSON.stringify({ error: "loopback backend" }));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  nextCatalogRead(): Promise<void> {
    return new Promise((resolve) => this.arrived.push(resolve));
  }

  releaseAll(): void {
    for (const release of this.catalogReads.splice(0)) release();
  }

  async stop(): Promise<void> {
    this.releaseAll();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

class Host {
  private child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  readonly ready: Promise<void>;

  constructor(backend: string, cwd: string) {
    this.child = spawn(process.execPath, [HOST], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CURSOR_BACKEND_URL: backend,
        CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: "",
        ZEROS_CURSOR_SDK_ENTRY: "",
        ZEROS_CURSOR_STATE_ROOT: path.join(cwd, "state"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    });
    let markReady!: () => void;
    this.ready = new Promise((resolve) => (markReady = resolve));
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { k: string; id?: number } & Reply;
        if (message.k === "ready") markReady();
        if (message.k === "res" && message.id !== undefined) this.pending.get(message.id)?.(message);
      }
    });
    this.child.stderr!.resume();
  }

  call(op: string, args: unknown): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin!.write(`${JSON.stringify({ k: "req", id, op, args })}\n`);
    });
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function start(): Promise<{ backend: Backend; host: Host; cwd: string }> {
  const backend = new Backend();
  await backend.start();
  cleanup.push(() => backend.stop());
  const cwd = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-catalog-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const host = new Host(backend.url, cwd);
  cleanup.push(() => host.stop());
  await host.ready;
  return { backend, host, cwd };
}

function createOptions(cwd: string) {
  return { apiKey: "key_cursor_catalog_fixture", model: { id: MODEL.id }, cwd, local: { cwd, settingSources: [] } };
}

describe("Cursor host model validation", () => {
  it("creates and resumes with the engine's confirmed record while the catalog endpoint is held", async () => {
    const { backend, host, cwd } = await start();
    const catalogRead = backend.nextCatalogRead().then(() => "catalog read" as const);

    const created = await Promise.race([
      host.call("agent.create", { ...createOptions(cwd), zerosLocalModelCatalog: [MODEL] }),
      catalogRead,
    ]);
    if (created === "catalog read") throw new Error("Agent.create refetched the model catalog");
    expect(created.ok, created.error?.message).toBe(true);
    const resumed = await Promise.race([
      host.call("agent.resume", {
        agentId: created.result!.agentId,
        opts: createOptions(cwd),
        zerosLocalModelCatalog: [MODEL],
      }),
      catalogRead,
    ]);
    if (resumed === "catalog read") throw new Error("Agent.resume refetched the model catalog");
    expect(resumed.ok, resumed.error?.message).toBe(true);
    expect(backend.catalogReads).toHaveLength(0);

    // The record was exposed for those calls only: a call without one still
    // validates against Cursor and waits for that read.
    const read = backend.nextCatalogRead();
    let settled = false;
    const live = host.call("agent.create", createOptions(cwd)).finally(() => { settled = true; });
    await read;
    expect(settled).toBe(false);
    backend.releaseAll();
    const reply = await live;
    expect(reply.ok, reply.error?.message).toBe(true);
  }, 30_000);

  // Regression (Mac, 2026-11-07): the first send of every new Cursor chat read
  // GET /v1/models for 1.6 s. send() validates its model on the agent's own
  // platform, whose catalog cache create() left empty.
  it("sends with the engine's confirmed record while the catalog endpoint is held", async () => {
    const { backend, host, cwd } = await start();
    const send = (agent: Reply, record: boolean) =>
      host.call("agent.send", {
        agentId: agent.result!.agentId,
        handleId: agent.result!.handleId,
        message: "hello",
        options: { model: { id: MODEL.id }, local: { force: true } },
        ...(record ? { zerosLocalModelCatalog: [MODEL] } : {}),
      });
    const created = await host.call("agent.create", { ...createOptions(cwd), zerosLocalModelCatalog: [MODEL] });
    expect(created.ok, created.error?.message).toBe(true);
    const catalogRead = backend.nextCatalogRead().then(() => "catalog read" as const);
    const sent = await Promise.race([send(created, true), catalogRead]);
    if (sent === "catalog read") throw new Error("agent.send refetched the model catalog");
    expect(backend.catalogReads).toHaveLength(0);

    // Without the record, a new agent's send waits for Cursor's catalog.
    const other = await host.call("agent.create", { ...createOptions(cwd), zerosLocalModelCatalog: [MODEL] });
    expect(other.ok, other.error?.message).toBe(true);
    const read = backend.nextCatalogRead();
    let settled = false;
    const live = send(other, false).finally(() => { settled = true; });
    await read;
    expect(settled).toBe(false);
    backend.releaseAll();
    await live;
  }, 30_000);

  it("ignores a malformed record and keeps Cursor's own validation", async () => {
    const { backend, host, cwd } = await start();
    const read = backend.nextCatalogRead();
    const pending = host.call("agent.create", {
      ...createOptions(cwd),
      zerosLocalModelCatalog: [{ displayName: "No id" }],
    });
    await read;
    backend.releaseAll();
    const reply = await pending;
    expect(reply.ok, reply.error?.message).toBe(true);
  }, 30_000);
});
