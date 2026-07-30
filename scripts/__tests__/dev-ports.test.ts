// Free-port probing for the per-worktree dev launcher (scripts/dev-ports.mjs).
//
// These run against REAL listeners, because the bug being guarded is entirely
// about OS bind semantics: the launcher used to probe only 127.0.0.1 and ::1, and
// on the BSD stack SO_REUSEADDR (set by libuv on every socket) lets a bind on a
// SPECIFIC address succeed over an existing WILDCARD bind. Our Vite runs
// `host: true` → wildcard, so the launcher declared a port free that Vite then
// died on (strictPort → EADDRINUSE → `concurrently -k` kills the instance).
//
// PLATFORM NOTE, so a green run isn't over-read: only macOS/BSD has the
// permissive specific-over-wildcard behaviour. Verified on macOS 26 against a
// `::` holder — `127.0.0.1` FREE, `::1` FREE, wildcard EADDRINUSE. On Linux (CI)
// the loopback probes already report EADDRINUSE for the same holder, so the
// "wildcard holder ⇒ not free" assertion passed there even before the fix. What
// pins the fix on EVERY platform is the direct wildcard-probe assertion below.

import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
// @ts-expect-error — .mjs has no type declarations; it exports two plain functions.
import { portFree, probeBind } from "../dev-ports.mjs";

const holders: net.Server[] = [];

/** Bind a real listener on an ephemeral port and return that port. `host`
 *  undefined = the wildcard bind Vite does with `host: true`. */
function hold(host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    holders.push(srv);
    srv.once("error", reject);
    srv.once("listening", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
    if (host) srv.listen(0, host);
    else srv.listen(0);
  });
}

/** An ephemeral port nobody holds: take one, then give it straight back. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.once("listening", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
    srv.listen(0, "127.0.0.1");
  });
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(
    holders.splice(0).map((srv) => new Promise<void>((r) => srv.close(() => r()))),
  );
});

describe("probeBind", () => {
  it("reports a WILDCARD holder busy — the probe the launcher was missing", async () => {
    const port = await hold();
    expect(await probeBind(port, null)).toBe("busy");
  });

  it("reports an unheld port free, and the released socket is not left listening", async () => {
    const port = await freePort();
    expect(await probeBind(port, null)).toBe("free");
    // Probing must not itself take the port — pickVitePort()/pickEngineBasePort()
    // hand the number to Vite/the engine, which bind it for real moments later.
    expect(await probeBind(port, null)).toBe("free");
  });
});

describe("portFree", () => {
  it("is FALSE for a wildcard holder (a `host: true` server, i.e. our Vite)", async () => {
    const port = await hold();
    expect(await portFree(port)).toBe(false);
  });

  it("is FALSE for a 127.0.0.1-only holder (the engine binds specifically)", async () => {
    const port = await hold("127.0.0.1");
    expect(await portFree(port)).toBe(false);
  });

  it("is TRUE for a port nobody holds — the added probe must not fail everything", async () => {
    expect(await portFree(await freePort())).toBe(true);
  });
});
