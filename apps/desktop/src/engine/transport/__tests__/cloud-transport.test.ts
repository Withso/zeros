// ──────────────────────────────────────────────────────────
// CloudTransport — the in-sandbox 0.0.0.0 bridge
// ──────────────────────────────────────────────────────────
//
// Unlike LocalTransport (loopback + Origin + Host + token), CloudTransport
// binds 0.0.0.0 behind the sandbox provider's preview proxy: the proxy is the network
// boundary, so the ONLY app-level gate is the connection token. These tests
// prove that contract:
//   • a non-loopback Host and any Origin are accepted (the preview proxy sends
//     its own Host; an Electron client may send file:// or none) — the inverse
//     of LocalTransport's DNS-rebinding gate, which must stay untouched.
//   • the header gates the /ws upgrade, the legacy query form remains
//     compatible, and an empty configured token disables the gate.
//   • a connected peer is surfaced as `kind: "cloud"` and messages round-trip.
//   • /health is served ungated (the proxy + the broker worker probe it).

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import http from "node:http";
import { WebSocket } from "ws";
import { CloudTransport } from "../cloud";
import type { EngineMessage } from "../../types";
import type { TransportClient } from "../types";

const TOKEN = "worker-minted-conn-token";

let transports: CloudTransport[] = [];

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

async function startTransport(opts: { token?: string } = {}): Promise<{
  t: CloudTransport;
  port: number;
}> {
  // port 0 → the OS assigns a free ephemeral port, read back via boundPort.
  // Hardcoded ports raced other listeners on CI and flaked with EADDRINUSE.
  const t = new CloudTransport({ port: 0, ...opts });
  transports.push(t);
  await t.start();
  return { t, port: t.boundPort };
}

/** Send a WebSocket upgrade with explicit headers and report whether the server
 *  completed the handshake (HTTP 101) or rejected it (socket destroyed). */
function attemptUpgrade(
  port: number,
  opts: {
    path?: string;
    origin?: string;
    host?: string;
    cloudTokenHeader?: string;
  } = {},
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
      if (opts.cloudTokenHeader !== undefined)
        lines.push(`x-zeros-cloud-token: ${opts.cloudTokenHeader}`);
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

function httpRequest(
  port: number,
  opts: { path: string; origin?: string; host?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.origin !== undefined) headers["Origin"] = opts.origin;
    if (opts.host !== undefined) headers["Host"] = opts.host;
    const req = http.request(
      { host: "127.0.0.1", port, path: opts.path, method: "GET", headers },
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

describe("CloudTransport — /ws token gate (preview proxy is the boundary)", () => {
  it("accepts the right token via ?token=", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: `/ws?token=${TOKEN}` }),
    ).resolves.toBe("accepted");
  });

  it("accepts the right token via the x-zeros-cloud-token header", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: "/ws", cloudTokenHeader: TOKEN }),
    ).resolves.toBe("accepted");
  });

  it("accepts a non-loopback Host and a cross-site Origin (NOT gated — unlike LocalTransport)", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, {
        path: `/ws?token=${TOKEN}`,
        host: "9000-abc123.proxy.example.dev",
        origin: "https://app.zeros.build",
      }),
    ).resolves.toBe("accepted");
  });

  it("rejects a missing token", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(attemptUpgrade(port, { path: "/ws" })).resolves.toBe(
      "rejected",
    );
  });

  it("rejects a wrong token", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: "/ws?token=nope" }),
    ).resolves.toBe("rejected");
  });

  it("with no token configured, accepts without a token param", async () => {
    const { port } = await startTransport({});
    await expect(attemptUpgrade(port, { path: "/ws" })).resolves.toBe(
      "accepted",
    );
  });

  it("rejects a non-/ws path", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: `/nope?token=${TOKEN}` }),
    ).resolves.toBe("rejected");
  });
});

describe("CloudTransport — connected peer is kind:cloud and messages round-trip", () => {
  it("surfaces the client as kind:cloud, delivers onMessage, and broadcasts back", async () => {
    const { t, port } = await startTransport({ token: TOKEN });

    const connected: TransportClient[] = [];
    const received: Array<{ kind: string; msg: EngineMessage }> = [];
    t.onConnect((c) => connected.push(c));
    t.onMessage((c, msg) => received.push({ kind: c.kind, msg }));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const inbound: EngineMessage[] = [];
    ws.on("message", (d) => inbound.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // client → engine
    ws.send(JSON.stringify({ type: "HEARTBEAT", source: "client" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("cloud");
    expect(received[0].msg.type).toBe("HEARTBEAT");
    expect(connected.length).toBe(1);
    expect(connected[0].kind).toBe("cloud");

    // engine → client (broadcast)
    t.broadcast({
      type: "PTY_DATA",
      source: "engine",
      sessionId: "s1",
      data: "hi",
    } as EngineMessage);
    await new Promise((r) => setTimeout(r, 50));
    expect(inbound.length).toBe(1);
    expect(inbound[0].type).toBe("PTY_DATA");

    ws.close();
  });

  it("fires onDisconnect when the peer closes", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const disconnected: TransportClient[] = [];
    t.onDisconnect((c) => disconnected.push(c));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(disconnected.length).toBe(1);
    expect(disconnected[0].kind).toBe("cloud");
  });
});

describe("CloudTransport — /health is ungated", () => {
  it("serves /health with a 200 regardless of Origin/Host (proxy + worker probe it)", async () => {
    const { port } = await startTransport({ token: TOKEN });
    const ok = await httpRequest(port, { path: "/health" });
    expect(ok.status).toBe(200);
    const parsed = JSON.parse(ok.body);
    expect(parsed.status).toBe("ok");
    expect(parsed.transport).toBe("cloud");

    // A cross-site Origin + non-loopback Host still gets 200 (no gate here).
    const cross = await httpRequest(port, {
      path: "/health",
      origin: "https://app.zeros.build",
      host: "9000-abc123.proxy.example.dev",
    });
    expect(cross.status).toBe(200);
  });
});
