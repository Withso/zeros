// ──────────────────────────────────────────────────────────
// Free-port probing for the per-worktree dev launcher
// ──────────────────────────────────────────────────────────
//
// Split out of scripts/dev-instance.mjs purely so the probe can be unit-tested
// against a REAL listener: that file spawns the whole dev stack at import time,
// so nothing can import a function out of it. See scripts/__tests__/dev-ports.test.ts.
// ──────────────────────────────────────────────────────────

import net from "node:net";

/** Probe ONE address: "free" (bound + released), "busy" (EADDRINUSE), or "skip"
 *  (address unavailable, e.g. IPv6 disabled — EADDRNOTAVAIL/EAFNOSUPPORT).
 *
 *  A null/undefined `host` probes the WILDCARD, the way a server that listens on
 *  every interface does. Node turns that into a `::` bind and — importantly —
 *  silently retries on `0.0.0.0` when the `::` bind fails for ANY reason,
 *  EADDRINUSE included (net.js `setupListenHandle`). Going through the same
 *  no-host call rather than naming an address ourselves means the probe mirrors
 *  the real server's bind sequence instead of second-guessing it: "busy" here
 *  means a wildcard server would genuinely have failed too. */
export function probeBind(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e.code === "EADDRINUSE" ? "busy" : "skip"));
    srv.once("listening", () => srv.close(() => resolve("free")));
    if (host) srv.listen(port, host);
    else srv.listen(port);
  });
}

/** Every address a port can already be taken on, in probe order. */
const PROBE_HOSTS = ["127.0.0.1", "::1", null /* wildcard */];

/** A port is free only when ALL of those come back non-busy. Two distinct blind
 *  spots are closed here, and both used to end the same way: the launcher
 *  announces a port in good faith, Vite's `strictPort: true` makes the losing
 *  bind fatal, and `concurrently -k` tears the whole instance down.
 *
 *   1. IPv4-only. Vite binds `localhost`, which macOS resolves to ::1 — so a
 *      naive 127.0.0.1 check reads a SIBLING worktree's IPv6 listener as "free"
 *      and hands Vite an already-taken port.
 *   2. Specific-address vs WILDCARD. Our Vite runs `host: true` (vite.config.ts),
 *      which binds the wildcard; on the BSD stack, SO_REUSEADDR — which
 *      Node/libuv sets by default — lets a bind on a SPECIFIC address succeed
 *      over an existing wildcard bind. Both loopback probes then report "free"
 *      while the port is very much taken. Verified on macOS 26 against a `::`
 *      holder: `127.0.0.1` -> FREE, `::1` -> FREE, wildcard -> EADDRINUSE. This
 *      is what handed a nested `pnpm electron:dev` its parent's Vite port. (Node's
 *      `exclusive: true` is NOT an alternative — that flag governs cluster handle
 *      sharing, not SO_REUSEADDR.)
 *
 *  An address that is merely UNAVAILABLE ("skip" — never bound, e.g. IPv6 off)
 *  doesn't count against the port. Being conservative costs nothing here: the
 *  engine binds 127.0.0.1 specifically and could in principle share a port with a
 *  wildcard neighbour, but it has 256 slots to pick from, so skipping a
 *  technically-shareable port beats handing out a contended one. Covers the engine
 *  ports as well as Vite's — both run through this one probe. */
export async function portFree(port) {
  for (const host of PROBE_HOSTS) {
    if ((await probeBind(port, host)) === "busy") return false;
  }
  return true;
}
