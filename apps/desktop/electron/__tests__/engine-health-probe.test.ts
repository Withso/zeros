import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { engineResponsive } from "../engine-health-probe";

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
