// ──────────────────────────────────────────────────────────
// LocalTransport — loopback authentication gate
// ──────────────────────────────────────────────────────────
//
// Loopback is NOT a trust boundary: any website can open a cross-origin
// ws:// to 127.0.0.1, and a DNS-rebinding page reaches it with an attacker
// Host header. The /ws upgrade and HTTP routes use a three-part gate:
// an allowed Origin, a loopback Host, AND the per-launch token. These tests
// prove a forbidden Origin / wrong Host / missing-or-wrong token is rejected
// while a legitimate renderer client is accepted.
//
// We drive the upgrade with a RAW TCP socket rather than the `ws` client so
// we get byte-level control over the exact inputs the gate keys on (Origin,
// Host, ?token) — the `ws` client manages those headers itself.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import http from "node:http";
import { confirmLoopbackOwnership, LocalTransport } from "../local";

const TOKEN = "launch-secret-token";
const DEV_ORIGIN = "http://localhost:5193";

let transports: LocalTransport[] = [];
let nextBasePort = 38700;

afterEach(async () => {
  for (const t of transports) {
    try {
      await t.stop();
    } catch {
      /* already stopped */
    }
  }
  transports = [];
});

async function startTransport(opts: {
  token?: string;
  allowedOrigins?: string[];
  handleHttp?: ConstructorParameters<typeof LocalTransport>[0]["handleHttp"];
}): Promise<LocalTransport> {
  const t = new LocalTransport({ port: nextBasePort, ...opts });
  nextBasePort += 10; // disjoint base per transport so the port walk never collides
  transports.push(t);
  await t.start();
  return t;
}

/** Send a WebSocket upgrade with explicit headers and report whether the
 *  server completed the handshake (HTTP 101) or rejected it (socket destroyed
 *  before any 101). */
function attemptUpgrade(
  port: number,
  opts: { path?: string; origin?: string; host?: string } = {},
): Promise<"accepted" | "rejected"> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    let settled = false;
    const done = (r: "accepted" | "rejected") => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    sock.setTimeout(2000, () => done("rejected"));
    sock.on("connect", () => {
      const reqPath = opts.path ?? "/ws";
      const host = opts.host ?? `127.0.0.1:${port}`;
      const lines = [
        `GET ${reqPath} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        // The RFC 6455 §1.3 example nonce, not a credential.
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", // gitleaks:allow
        "Sec-WebSocket-Version: 13",
      ];
      if (opts.origin !== undefined) lines.push(`Origin: ${opts.origin}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n");
    });
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n"))
        done(/^HTTP\/1\.1 101/.test(buf) ? "accepted" : "rejected");
    });
    sock.on("close", () => done("rejected"));
    sock.on("error", () => done("rejected"));
  });
}

/** Raw HTTP request with explicit Origin / Host / ?token. */
function httpRequest(
  port: number,
  opts: {
    path: string;
    method?: string;
    origin?: string;
    host?: string;
    token?: string;
    engineToken?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.origin !== undefined) headers["Origin"] = opts.origin;
    if (opts.host !== undefined) headers["Host"] = opts.host;
    if (opts.engineToken !== undefined) {
      headers["X-Zeros-Engine-Token"] = opts.engineToken;
    }
    const reqPath = opts.token ? `${opts.path}?token=${opts.token}` : opts.path;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: opts.method ?? "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("LocalTransport — C1 /ws upgrade auth gate", () => {
  it("accepts a legitimate renderer (allowed origin + loopback host + token)", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    await expect(
      attemptUpgrade(t.actualPort, {
        path: `/ws?token=${TOKEN}`,
        origin: DEV_ORIGIN,
      }),
    ).resolves.toBe("accepted");
  });

  it("accepts the packaged renderer (file:// origin) and a no-Origin Node client", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    await expect(
      attemptUpgrade(t.actualPort, {
        path: `/ws?token=${TOKEN}`,
        origin: "file://",
      }),
    ).resolves.toBe("accepted");
    // Absent Origin (some Node clients) is allowed — the server binds loopback.
    await expect(
      attemptUpgrade(t.actualPort, { path: `/ws?token=${TOKEN}` }),
    ).resolves.toBe("accepted");
  });

  it("rejects a missing token", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    await expect(
      attemptUpgrade(t.actualPort, { path: "/ws", origin: DEV_ORIGIN }),
    ).resolves.toBe("rejected");
  });

  it("rejects a wrong token", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    await expect(
      attemptUpgrade(t.actualPort, {
        path: "/ws?token=not-the-token",
        origin: DEV_ORIGIN,
      }),
    ).resolves.toBe("rejected");
  });

  it("rejects a cross-site Origin even with the right token", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    await expect(
      attemptUpgrade(t.actualPort, {
        path: `/ws?token=${TOKEN}`,
        origin: "https://evil.example",
      }),
    ).resolves.toBe("rejected");
  });

  it("rejects a non-loopback Host (DNS rebinding) even with the right token", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    await expect(
      attemptUpgrade(t.actualPort, {
        path: `/ws?token=${TOKEN}`,
        origin: DEV_ORIGIN,
        host: "attacker.example",
      }),
    ).resolves.toBe("rejected");
  });

  it("with no token configured (standalone), accepts an allowed origin without a token param", async () => {
    const t = await startTransport({ allowedOrigins: [DEV_ORIGIN] });
    await expect(
      attemptUpgrade(t.actualPort, { path: "/ws", origin: DEV_ORIGIN }),
    ).resolves.toBe("accepted");
    // …but a cross-site origin is still rejected (origin gate is independent of the token).
    await expect(
      attemptUpgrade(t.actualPort, {
        path: "/ws",
        origin: "https://evil.example",
      }),
    ).resolves.toBe("rejected");
  });
});

describe("LocalTransport — C1 HTTP route gate", () => {
  it("serves /health to a no-Origin client but 403s a cross-site Origin", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    const ok = await httpRequest(t.actualPort, { path: "/health" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).status).toBe("ok");

    const forbidden = await httpRequest(t.actualPort, {
      path: "/health",
      origin: "https://evil.example",
    });
    expect(forbidden.status).toBe(403);
  });

  it("403s /health for a non-loopback Host", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
    });
    const res = await httpRequest(t.actualPort, {
      path: "/health",
      host: "attacker.example",
    });
    expect(res.status).toBe(403);
  });

  it("keeps design resources behind the host-only launch token", async () => {
    const t = await startTransport({
      token: TOKEN,
      allowedOrigins: [DEV_ORIGIN],
      handleHttp: async ({ url }) =>
        url.pathname === "/design/ws-a/home.html"
          ? {
              status: 200,
              headers: { "Content-Type": "text/html" },
              body: Buffer.from("<h1>Design</h1>"),
            }
          : null,
    });
    expect(
      (
        await httpRequest(t.actualPort, {
          path: "/design/ws-a/home.html",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await httpRequest(t.actualPort, {
          path: "/design/ws-a/home.html",
          engineToken: "wrong",
        })
      ).status,
    ).toBe(403);
    const ok = await httpRequest(t.actualPort, {
      path: "/design/ws-a/home.html",
      engineToken: TOKEN,
    });
    expect(ok).toEqual({ status: 200, body: "<h1>Design</h1>" });
    expect(
      (
        await httpRequest(t.actualPort, {
          path: "/design/ws-a/home.html",
          engineToken: TOKEN,
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
  });
});

// ── Early ownership + bounded port walk ───────────────────────────────────
//
// The in-process probe protects standalone engines and catches inherited
// black-hole sockets before later startup. Electron independently verifies the
// nonce again after the whole engine reports ready; the early check cannot
// detect a later subsystem deadlocking the event loop.

describe("LocalTransport — early ownership and bounded walk", () => {
  it("serves a per-boot instance nonce in /health, distinct across instances", async () => {
    const a = await startTransport({});
    const b = await startTransport({});
    const [ra, rb] = await Promise.all([
      httpRequest(a.actualPort, { path: "/health" }),
      httpRequest(b.actualPort, { path: "/health" }),
    ]);
    expect(JSON.parse(ra.body).instance).toBe(a.instanceNonce);
    expect(JSON.parse(rb.body).instance).toBe(b.instanceNonce);
    expect(a.instanceNonce).not.toBe(b.instanceNonce);
  });

  it("confirms ownership against itself and rejects a foreign nonce", async () => {
    const t = await startTransport({});
    await expect(
      confirmLoopbackOwnership(t.actualPort, t.instanceNonce),
    ).resolves.toBe(true);
    await expect(
      confirmLoopbackOwnership(t.actualPort, "some-other-boot"),
    ).resolves.toBe(false);
  });

  it("rejects a black-hole listener that accepts connections but never responds", async () => {
    const accepted: net.Socket[] = [];
    const blackHole = net.createServer((sock) => {
      accepted.push(sock);
    });
    const port = await new Promise<number>((resolve) => {
      blackHole.listen(0, "127.0.0.1", () => {
        resolve((blackHole.address() as net.AddressInfo).port);
      });
    });
    try {
      await expect(
        confirmLoopbackOwnership(port, "any-nonce", { timeoutMs: 300 }),
      ).resolves.toBe(false);
    } finally {
      for (const sock of accepted) sock.destroy();
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
    }
  });

  it("walks past a port that is EADDRINUSE instead of failing the boot", async () => {
    const squatter = net.createServer(() => {
      /* hold the base port */
    });
    const base = nextBasePort;
    nextBasePort += 10;
    await new Promise<void>((resolve) =>
      squatter.listen(base, "127.0.0.1", resolve),
    );
    try {
      const t = new LocalTransport({ port: base });
      transports.push(t);
      await t.start();
      expect(t.actualPort).toBeGreaterThan(base);
      const res = await httpRequest(t.actualPort, { path: "/health" });
      expect(JSON.parse(res.body).instance).toBe(t.instanceNonce);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("does not walk beyond the span supplied by its host", async () => {
    const squatter = net.createServer(() => {
      /* hold the sole allowed port */
    });
    const base = nextBasePort;
    nextBasePort += 10;
    await new Promise<void>((resolve) =>
      squatter.listen(base, "127.0.0.1", resolve),
    );
    try {
      const t = new LocalTransport({ port: base, portSpan: 1 });
      transports.push(t);
      await expect(t.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});
