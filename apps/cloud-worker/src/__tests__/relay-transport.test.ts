import { once } from "node:events";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { RelayTransport } from "../relay-transport";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "worker-relay-"));
  const tokenFile = join(directory, "worker-token");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("No fixture address.");
  const status: string[] = [];
  const transport = new RelayTransport({ url: `ws://127.0.0.1:${address.port}/v2/cloud/worker`, tokenFile, retryBaseMs: 10, retryMaxMs: 30, onStatus: (value) => { status.push(value); } });
  cleanups.push(async () => { await transport.dispose(); for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return { tokenFile, server, transport, status };
}

it("waits for the credential file, rereads it after disconnect, and sends hello first", async () => {
  const { tokenFile, server, transport, status } = await fixture();
  let expected = "fixture-first-worker-token", connections = 0;
  const matched: boolean[] = [], messages: unknown[] = [], incoming: unknown[] = [];
  server.on("connection", (socket, request) => {
    connections++; matched.push(request.headers.authorization === `Bearer ${expected}`);
    socket.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); socket.send(JSON.stringify({ t: "close", clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })); });
  });
  transport.start({ open: async () => { await transport.send({ t: "hello", protocol: 1, workerVersion: "fixture", capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] } }); }, frame: async (frame) => { incoming.push(frame); }, close: () => {} });
  await expect.poll(() => status.includes("credential-unavailable")).toBe(true);
  expect(connections).toBe(0);
  await writeFile(tokenFile, expected, { mode: 0o600 });
  await expect.poll(() => incoming.length).toBe(1);
  expect(messages).toMatchObject([{ t: "hello" }]);
  expected = "fixture-rotated-worker-token";
  await writeFile(tokenFile, expected, { mode: 0o600 });
  for (const client of server.clients) client.terminate();
  await expect.poll(() => incoming.length).toBe(2);
  expect(matched).toEqual([true, true]);
});

it("refuses broad credential permissions and never includes authentication in status messages", async () => {
  const { tokenFile, server, transport, status } = await fixture();
  let connected = false;
  server.on("connection", () => { connected = true; });
  await writeFile(tokenFile, "fixture-worker-token", { mode: 0o644 });
  transport.start({ open: () => {}, frame: async () => {}, close: () => {} });
  await expect.poll(() => status.includes("credential-unavailable")).toBe(true);
  expect(connected).toBe(false);
  await chmod(tokenFile, 0o600);
  await expect.poll(() => connected).toBe(true);
  expect(status.every((value) => ["credential-unavailable", "connected"].includes(value))).toBe(true);
});

it.each([4000, 4001, 4003])("stops reconnecting after terminal relay close %s", async (code) => {
  const { tokenFile, server, transport, status } = await fixture();
  await writeFile(tokenFile, "fixture-worker-token", { mode: 0o600 });
  server.on("connection", (socket) => socket.close(code));
  transport.start({ open: () => {}, frame: async () => {}, close: () => {} });
  await expect.poll(() => status.at(-1)).toBe(code === 4000 ? "superseded" : code === 4001 ? "stopped" : "protocol-error");
  expect(await transport.send({ t: "idle", idle: true })).toBe(false);
});

it("requires TLS outside literal loopback and keeps credentials out of URLs", () => {
  for (const url of ["ws://example.invalid/v2/cloud/worker", "wss://user:pass@example.invalid/v2/cloud/worker", "wss://example.invalid/v2/cloud/worker?token=fixture"])
    expect(() => new RelayTransport({ url, tokenFile: "/unused" })).toThrow("Invalid worker relay URL.");
});
