import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { brokerRequest } from "../client";
import { GithubBroker } from "../github";

const execute = promisify(execFile), cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "broker-lifecycle-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "github.sock");
}
function close(server: Server): Promise<void> { return new Promise(resolve => server.close(() => resolve())); }
async function staleSocket(path: string): Promise<void> {
  await execute(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:net';
    createServer().listen(process.argv[1], () => process.exit(0));
  `, path], { env: { PATH: process.env.PATH }, timeout: 10_000 });
}

it("leaves a foreign replacement socket reachable when the original broker is disposed", async () => {
  const path = await fixture(), token = { token: "fixture-own", expiresAt: Date.now() + 120_000 };
  const broker = new GithubBroker(path, async () => token); cleanups.push(() => broker.dispose());
  await broker.start();
  expect(await brokerRequest(path, "token")).toMatchObject(token);
  await unlink(path);
  const foreign = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ token: "fixture-foreign", expiresAt: Date.now() + 120_000 }) + "\n")));
  cleanups.push(() => close(foreign));
  await new Promise<void>(resolve => foreign.listen(path, resolve));
  const inode = (await stat(path)).ino;
  await broker.dispose();
  expect(await stat(path).then(value => value.ino, () => undefined)).toBe(inode);
  expect(await brokerRequest(path, "token")).toMatchObject({ token: "fixture-foreign" });
});

it("does not claim an existing socket just because its listener is unreachable", async () => {
  const path = await fixture(); await staleSocket(path);
  const inode = (await stat(path)).ino;
  const broker = new GithubBroker(path, async () => ({ token: "fixture-own", expiresAt: Date.now() + 120_000 }));
  cleanups.push(() => broker.dispose());
  await expect(broker.start()).rejects.toThrow();
  expect((await stat(path)).ino).toBe(inode);
});

it("shares a single listener across concurrent starts", async () => {
  const path = await fixture();
  const broker = new GithubBroker(path, async () => ({ token: "fixture-own", expiresAt: Date.now() + 120_000 }));
  cleanups.push(() => broker.dispose());
  await Promise.all([broker.start(), broker.start(), broker.start()]);
  expect(await brokerRequest(path, "token")).toMatchObject({ token: "fixture-own" });
});

it("joins disposal with an in-progress start and retires its private directory", async () => {
  const path = join(dirname(await fixture()), "owned", "github.sock");
  const broker = new GithubBroker(path, async () => ({ token: "fixture-own", expiresAt: Date.now() + 120_000 }));
  cleanups.push(() => broker.dispose());
  const starting = broker.start(), stopping = broker.dispose();
  await Promise.all([starting, stopping, broker.dispose()]);
  await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(broker.start()).rejects.toThrow("disposed");
});

it("preserves foreign contents in an owned directory during disposal", async () => {
  const path = join(dirname(await fixture()), "owned", "github.sock");
  const broker = new GithubBroker(path, async () => ({ token: "fixture-own", expiresAt: Date.now() + 120_000 }));
  cleanups.push(() => broker.dispose());
  await broker.start();
  const foreign = join(dirname(path), "keep.txt"); await writeFile(foreign, "keep");
  await broker.dispose();
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(foreign, "utf8")).toBe("keep");
});

function observeDials() {
  const native = Socket.prototype.connect, dials: Socket[] = [];
  let refused!: (code: string | undefined) => void;
  const firstError = new Promise<string | undefined>(resolve => { refused = resolve; });
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: Parameters<Socket["connect"]>) {
    dials.push(this);
    this.once("error", (error: NodeJS.ErrnoException) => { refused(error.code); });
    return native.apply(this, args);
  });
  return { dials, firstError };
}

it.each(["ENOENT", "ECONNREFUSED"])("retries one %s dial after the socket becomes reachable", async reason => {
  const path = await fixture();
  if (reason === "ECONNREFUSED") await staleSocket(path);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const observed = observeDials();
  const pending = brokerRequest(path, "token").then(value => ({ value }), error => ({ error }));
  expect(await observed.firstError).toBe(reason);
  if (reason === "ECONNREFUSED") await unlink(path);
  const server = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ token: "fixture-recovered", expiresAt: Date.now() + 120_000 }) + "\n")));
  cleanups.push(() => close(server));
  await new Promise<void>(resolve => server.listen(path, resolve));
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toMatchObject({ value: { token: "fixture-recovered" } });
  expect(observed.dials).toHaveLength(2);
});

it("ends a persistently refused connection after exactly one delayed retry", async () => {
  const path = await fixture(); await staleSocket(path);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const observed = observeDials();
  const pending = brokerRequest(path, "token").catch(error => error);
  expect(await observed.firstError).toBe("ECONNREFUSED");
  await vi.advanceTimersByTimeAsync(249);
  expect(observed.dials).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ reason: "unavailable" });
  expect(observed.dials).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the response deadline measured from the first dial", async () => {
  const path = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const observed = observeDials();
  const pending = brokerRequest(path, "token").then(value => ({ value }), error => ({ error }));
  expect(await observed.firstError).toBe("ENOENT");
  let accepted!: () => void; const connected = new Promise<void>(resolve => { accepted = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); accepted(); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await close(server); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  await vi.advanceTimersByTimeAsync(250);
  expect(observed.dials).toHaveLength(2);
  await connected;
  await vi.advanceTimersByTimeAsync(21_000 - 250);
  expect(await pending).toMatchObject({ error: { reason: "unavailable" } });
  expect(observed.dials).toHaveLength(2);
});

it("does not retry a connection that already delivered the request", async () => {
  const path = await fixture(); let requests = 0;
  const server = createServer(socket => socket.once("data", () => { requests++; socket.end(); }));
  cleanups.push(() => close(server));
  await new Promise<void>(resolve => server.listen(path, resolve));
  await expect(brokerRequest(path, "changed")).rejects.toMatchObject({ reason: "unavailable" });
  expect(requests).toBe(1);
});

it.each([
  ['{"error":"connection-expired"}\n', "connection-expired"],
  ["invalid reply\n", "unavailable"],
  ['{"token":', "unavailable"],
])("does not redial after a refusal or malformed reply: %s", async (reply, reason) => {
  const path = await fixture();
  const server = createServer(socket => socket.once("data", () => socket.end(reply)));
  cleanups.push(() => close(server));
  await new Promise<void>(resolve => server.listen(path, resolve));
  const observed = observeDials();
  await expect(brokerRequest(path, "token")).rejects.toMatchObject({ reason });
  expect(observed.dials).toHaveLength(1);
});
