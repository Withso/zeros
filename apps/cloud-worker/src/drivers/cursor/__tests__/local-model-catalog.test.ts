// Regression: opening a cloud Cursor session read the account's catalog, then
// Agent.create/resume read it again (@cursor/sdk 1.2.0 validates the model
// against a fresh GET /v1/models on every call), doubling that wait before the
// first turn. The host now gives the SDK the record it just read, through the
// SDK's CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON, for that call only. Builds the
// shipped host entry against the REAL SDK and a loopback backend.

import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { MODEL_VALIDATION_WINDOW_MS, withLocalModelCatalog } from "../local-model-catalog";

const ENV = "CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function realHost(): Promise<string> {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const directory = await mkdtemp(join(root, ".worker-build-cursor-real-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cursor-host.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../host-entry.ts", import.meta.url))], outfile: path,
    external: ["@cursor/sdk"], platform: "node", target: "node24", format: "esm", bundle: true, logLevel: "silent" });
  return path;
}

async function backend(): Promise<{ url: string; catalogReads: () => number }> {
  let reads = 0;
  const server: Server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/models") {
      reads++;
      response.end(JSON.stringify({ items: [{ id: "composer-2.5", displayName: "Composer 2.5" }] }));
      return;
    }
    response.writeHead(401);
    response.end(JSON.stringify({ error: "loopback backend" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, catalogReads: () => reads };
}

function request(child: ChildProcess, method: string, params: unknown): Promise<{ value?: unknown; error?: string }> {
  return new Promise(resolve => {
    child.on("message", (raw: { t?: string; id?: number; value?: unknown; error?: string }) => {
      if (raw.t === "reply" && raw.id === 1) resolve(raw);
    });
    child.send({ id: 1, method, params });
  });
}

it("opens a session with one catalog read", async () => {
  const [path, server, home] = await Promise.all([realHost(), backend(), mkdtemp(join(tmpdir(), "zeros-cursor-real-host-"))]);
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const child = fork(path, [], { cwd: home, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {
    PATH: process.env.PATH, HOME: home, CURSOR_API_KEY: "key_cursor_cloud_fixture", CURSOR_BACKEND_URL: server.url,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  } });
  cleanup.push(() => { child.kill("SIGKILL"); });
  const reply = await request(child, "open", { cwd: home, model: "composer-2.5" });
  expect(reply.error).toBeUndefined();
  expect(reply.value).toMatchObject({ nativeSessionId: expect.any(String) });
  expect(server.catalogReads()).toBe(1);
}, 30_000);

// Regression (Mac, 2026-11-07): a session's first send read the catalog again,
// because send() validates its model too, on the agent's own platform.
it("sends the first prompt without reading the catalog again", async () => {
  const [path, server, home] = await Promise.all([realHost(), backend(), mkdtemp(join(tmpdir(), "zeros-cursor-real-host-"))]);
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const child = fork(path, [], { cwd: home, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {
    PATH: process.env.PATH, HOME: home, CURSOR_API_KEY: "key_cursor_cloud_fixture", CURSOR_BACKEND_URL: server.url,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  } });
  cleanup.push(() => { child.kill("SIGKILL"); });
  const replies = new Map<number, (reply: { value?: unknown; error?: string }) => void>();
  child.on("message", (raw: { t?: string; id?: number; value?: unknown; error?: string }) => {
    if (raw.t === "reply" && raw.id !== undefined) replies.get(raw.id)?.(raw);
  });
  const call = (id: number, method: string, params: unknown) =>
    new Promise<{ value?: unknown; error?: string }>(resolve => { replies.set(id, resolve); child.send({ id, method, params }); });
  const opened = await call(1, "open", { cwd: home, model: "composer-2.5" });
  expect(opened.error).toBeUndefined();
  expect(server.catalogReads()).toBe(1);
  // The loopback backend refuses the run itself; only the catalog read matters.
  await call(2, "prompt", { turnId: "turn-1", content: { text: "hi" }, model: "composer-2.5" });
  expect(server.catalogReads()).toBe(1);
}, 30_000);

it("exposes a valid record only for its call and serializes callers", async () => {
  const previous = process.env[ENV];
  delete process.env[ENV];
  try {
    const record = { id: "composer-2.5", displayName: "Composer 2.5" };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen: Array<string | undefined> = [];
    const first = withLocalModelCatalog([record], async () => { seen.push(process.env[ENV]); await held; });
    const second = withLocalModelCatalog(undefined, async () => { seen.push(process.env[ENV]); });
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).toEqual([JSON.stringify([record])]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([JSON.stringify([record]), undefined]);
    await withLocalModelCatalog([{ displayName: "No id" }], async () => { seen.push(process.env[ENV]); });
    expect(seen.at(-1)).toBeUndefined();
    expect(process.env[ENV]).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env[ENV]; else process.env[ENV] = previous;
  }
});

it("lets the next call proceed when a call hangs past the window", async () => {
  vi.useFakeTimers();
  const previous = process.env[ENV];
  delete process.env[ENV];
  try {
    const hung = withLocalModelCatalog([{ id: "composer-2.5" }], () => new Promise<never>(() => {}));
    void hung;
    let ran: string | undefined | null = null;
    const next = withLocalModelCatalog(undefined, async () => { ran = process.env[ENV]; });
    await vi.advanceTimersByTimeAsync(MODEL_VALIDATION_WINDOW_MS - 1);
    expect(ran).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(ran).toBeUndefined();
  } finally {
    vi.useRealTimers();
    if (previous === undefined) delete process.env[ENV]; else process.env[ENV] = previous;
  }
});
