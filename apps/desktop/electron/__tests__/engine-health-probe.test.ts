import { createServer, type Server, type ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import { afterEach, expect, it } from "vitest";
import {
  engineResponsive,
  ownedEngineResponsive,
} from "../engine-health-probe";

const servers: Server[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  for (const server of servers.splice(0)) {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }
});

async function listen(respond: (response: ServerResponse) => void) {
  const server = createServer((_req, res) => respond(res));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

it("accepts only an exact healthy generation", async () => {
  const port = await listen((res) =>
    res.end(JSON.stringify({ status: "ok", instance: "current" })),
  );
  expect(await engineResponsive(port, "current")).toBe(true);
  expect(await engineResponsive(port, "old")).toBe(false);
});

it("bounds a health response that keeps sending data without ending", async () => {
  const port = await listen((res) => {
    res.write("{");
    timers.push(setInterval(() => res.write(" "), 100));
  });
  const start = Date.now();
  const result = engineResponsive(port, "current");
  const outcome = await Promise.race([
    result,
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("deadline missed"), 2300),
    ),
  ]);
  expect(outcome).toBe(false);
  expect(Date.now() - start).toBeLessThan(2200);
});

it("rejects an oversized health response immediately", async () => {
  const port = await listen((res) => {
    res.write("x".repeat(9000));
  });
  const start = Date.now();
  expect(await engineResponsive(port, "current")).toBe(false);
  expect(Date.now() - start).toBeLessThan(1000);
});

it("allows a bounded confirmation to receive a health response after the short deadline", async () => {
  const port = await listen((res) => {
    timers.push(
      setTimeout(() => {
        res.end(JSON.stringify({ status: "ok", instance: "current" }));
      }, 1800),
    );
  });
  expect(await engineResponsive(port, "current", { timeoutMs: 3000 })).toBe(
    true,
  );
});

it("honors the caller's absolute deadline even with no response", async () => {
  const port = await listen(() => {});
  const start = Date.now();
  expect(await engineResponsive(port, "current", { timeoutMs: 50 })).toBe(
    false,
  );
  expect(Date.now() - start).toBeLessThan(1000);
});

it("cancels a pending confirmation when its owned child exits", async () => {
  const port = await listen(() => {});
  const controller = new AbortController();
  const start = Date.now();
  const pending = engineResponsive(port, "current", {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  controller.abort();
  expect(await pending).toBe(false);
  expect(Date.now() - start).toBeLessThan(1000);
});

it("does not accept a healthy response for an already cancelled child", async () => {
  const port = await listen((res) =>
    res.end(JSON.stringify({ status: "ok", instance: "current" })),
  );
  const controller = new AbortController();
  controller.abort();
  expect(
    await engineResponsive(port, "current", { signal: controller.signal }),
  ).toBe(false);
});

it("cancels an owned probe on child exit and releases child listeners", async () => {
  const port = await listen(() => {});
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
  });
  const start = Date.now();
  const pending = ownedEngineResponsive(child, port, "current", 60_000);
  child.exitCode = 1;
  child.emit("exit", 1, null);
  expect(await pending).toBe(false);
  expect(Date.now() - start).toBeLessThan(1000);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
});

it("does not mistake an answering sibling for an exited owned child", async () => {
  const port = await listen((res) =>
    res.end(JSON.stringify({ status: "ok", instance: "current" })),
  );
  const child = Object.assign(new EventEmitter(), {
    exitCode: 1,
    signalCode: null,
  });
  expect(await ownedEngineResponsive(child, port, "current")).toBe(false);
  expect(await ownedEngineResponsive(null, port, "current")).toBe(false);
});
