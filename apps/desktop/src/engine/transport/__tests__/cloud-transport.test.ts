// ──────────────────────────────────────────────────────────
// CloudTransport — the in-sandbox 0.0.0.0 bridge
// ──────────────────────────────────────────────────────────
//
// Unlike LocalTransport (loopback + Origin + Host + token), CloudTransport
// binds 0.0.0.0 behind the sandbox provider's preview proxy: the proxy is the network
// boundary, so the transport-level gate is the connection token. Qualified
// workers add mandatory asymmetric owner binding in ZerosEngine. These tests
// prove the transport contract:
//   • a non-loopback Host and any Origin are accepted (the preview proxy sends
//     its own Host; an Electron client may send file:// or none) — the inverse
//     of LocalTransport's DNS-rebinding gate, which must stay untouched.
//   • credentials are carried by a header or WebSocket subprotocol, never a
//     URL query, and an absent/unsafe configured token is rejected before bind.
//   • a connected peer is surfaced as `kind: "cloud"` and messages round-trip.
//   • /health is served ungated (the proxy + the broker worker probe it).

import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import http from "node:http";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";
import { CloudTransport, parseCloudTransportPort } from "../cloud";
import type { EngineMessage } from "../../types";
import type { TransportClient } from "../types";
import type { CloudRuntimeClientAdmission } from "../../cloud-runtime-registration";

const TOKEN = "worker-minted-conn-token";
const ACCOUNT_USER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION: CloudRuntimeClientAdmission = {
  accountUserId: ACCOUNT_USER_ID,
  authorityEpoch: 7,
};

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

async function startTransport(
  opts: {
    token: string;
    verifyToken?: (
      token: string,
    ) => Promise<CloudRuntimeClientAdmission | null>;
    maxConnections?: number;
    handshakeTimeoutMs?: number;
    maxBufferedBytes?: number;
    maxTotalBufferedBytes?: number;
    internalReadiness?: {
      token: string;
      read: () => {
        version: 1;
        instanceId: string;
        protocolVersion: number;
        health: "ready";
        durableRecordConnected: true;
      } | null;
    };
  } = { token: TOKEN },
): Promise<{
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
    protocols?: string;
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
      if (opts.protocols !== undefined)
        lines.push(`Sec-WebSocket-Protocol: ${opts.protocols}`);
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

function openCloudWebSocket(port: number, token = TOKEN): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, [
    "zeros-v1",
    `zeros-cloud-token.${Buffer.from(token, "utf8").toString("base64url")}`,
  ]);
}

function openRawUpgrade(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error("raw WebSocket upgrade timed out"));
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        [
          "GET /ws HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", // gitleaks:allow
          "Sec-WebSocket-Version: 13",
          `x-zeros-cloud-token: ${TOKEN}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (!response.includes("\r\n\r\n")) return;
      socket.setTimeout(0);
      socket.removeAllListeners("error");
      if (!/^HTTP\/1\.1 101/.test(response)) {
        socket.destroy();
        reject(new Error("raw WebSocket upgrade was rejected"));
        return;
      }
      // Deliberately leave this peer as raw TCP: it will not parse or answer a
      // server close frame, reproducing an uncooperative remote browser.
      resolve(socket);
    });
  });
}

function httpRequest(
  port: number,
  opts: {
    path: string;
    origin?: string;
    host?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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
  it("fails closed on a malformed configured listener port", () => {
    expect(parseCloudTransportPort(undefined)).toBeNull();
    expect(parseCloudTransportPort("  ")).toBeNull();
    expect(parseCloudTransportPort("39393")).toBe(39_393);
    expect(parseCloudTransportPort("65535")).toBe(65_535);
    for (const value of ["0", "-1", "01", "1.5", "1e3", "65536", "NaN"]) {
      expect(() => parseCloudTransportPort(value)).toThrow(/cloud port/i);
    }
  });

  it("refuses to construct without a bounded non-empty token", () => {
    for (const token of [
      undefined,
      "",
      "short",
      "x".repeat(4_097),
      "safe-token-value-with-newline\n",
    ]) {
      expect(
        () =>
          new CloudTransport({
            port: 0,
            token: token as string,
          }),
      ).toThrow(/token/);
    }
    for (const port of [-1, 1.5, 65_536, Number.NaN]) {
      expect(() => new CloudTransport({ port, token: TOKEN })).toThrow(/port/);
    }
    expect(
      () =>
        new CloudTransport({
          port: 0,
          token: TOKEN,
          maxConnections: 129,
        }),
    ).toThrow(/maxConnections/);
    expect(
      () =>
        new CloudTransport({
          port: 0,
          token: TOKEN,
          maxTotalBufferedBytes: 256 * 1024 * 1024 + 1,
        }),
    ).toThrow(/maxTotalBufferedBytes/);
  });

  it("rejects a valid token in the URL query", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: `/ws?token=${TOKEN}` }),
    ).resolves.toBe("rejected");
  });

  it("accepts the right token via the x-zeros-cloud-token header", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: "/ws", cloudTokenHeader: TOKEN }),
    ).resolves.toBe("accepted");
  });

  it("accepts a browser-safe token subprotocol without putting it in the URL", async () => {
    const { port } = await startTransport({ token: TOKEN });
    const encoded = Buffer.from(TOKEN, "utf8").toString("base64url");
    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        protocols: `zeros-v1, zeros-cloud-token.${encoded}`,
      }),
    ).resolves.toBe("accepted");
    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        protocols: `zeros-v1, zeros-cloud-token.${Buffer.from("wrong").toString("base64url")}`,
      }),
    ).resolves.toBe("rejected");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [
      "zeros-v1",
      `zeros-cloud-token.${encoded}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    expect(ws.protocol).toBe("zeros-v1");
    expect(ws.protocol).not.toContain(encoded);
    ws.close();

    // Credential transport must never become the negotiated application
    // protocol, even if an untrusted client puts it first in its offer.
    const reordered = new WebSocket(`ws://127.0.0.1:${port}/ws`, [
      `zeros-cloud-token.${encoded}`,
      "zeros-v1",
    ]);
    await new Promise<void>((resolve, reject) => {
      reordered.once("open", resolve);
      reordered.once("error", reject);
    });
    expect(reordered.protocol).toBe("zeros-v1");
    expect(reordered.protocol).not.toContain(encoded);
    reordered.close();
  });

  it("redeems a one-use desktop token asynchronously without exposing the bootstrap token", async () => {
    const desktopToken = `zws_${"D".repeat(43)}`;
    const verifyToken = vi.fn(async (token: string) =>
      token === desktopToken ? ADMISSION : null,
    );
    const { t, port } = await startTransport({ token: TOKEN, verifyToken });
    let connected: TransportClient | null = null;
    t.onConnect((client) => {
      connected = client;
    });
    const encoded = Buffer.from(desktopToken, "utf8").toString("base64url");

    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        protocols: `zeros-v1, zeros-cloud-token.${encoded}`,
      }),
    ).resolves.toBe("accepted");
    expect(verifyToken).toHaveBeenCalledWith(desktopToken);
    expect(connected).toMatchObject({
      kind: "cloud",
      accountUserId: ACCOUNT_USER_ID,
      authorityEpoch: 7,
    });

    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        protocols: `zeros-v1, zeros-cloud-token.${Buffer.from(`zws_${"E".repeat(43)}`).toString("base64url")}`,
      }),
    ).resolves.toBe("rejected");
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it("bounds pending asynchronous admissions inside the connection limit", async () => {
    let release!: (value: CloudRuntimeClientAdmission | null) => void;
    const held = new Promise<CloudRuntimeClientAdmission | null>((resolve) => {
      release = resolve;
    });
    const desktopToken = `zws_${"F".repeat(43)}`;
    const { port } = await startTransport({
      token: TOKEN,
      maxConnections: 1,
      verifyToken: async () => held,
    });
    const first = attemptUpgrade(port, {
      protocols: `zeros-v1, zeros-cloud-token.${Buffer.from(desktopToken).toString("base64url")}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      attemptUpgrade(port, { cloudTokenHeader: desktopToken }),
    ).resolves.toBe("rejected");
    release(ADMISSION);
    await expect(first).resolves.toBe("accepted");
  });

  it("rejects a non-canonical UTF-8 token subprotocol", async () => {
    const visibleToken = `prefix-token-\uFFFD-suffix-value`;
    const { port } = await startTransport({ token: visibleToken });
    const invalidUtf8 = Buffer.concat([
      Buffer.from("prefix-token-", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("-suffix-value", "utf8"),
    ]).toString("base64url");

    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        protocols: `zeros-v1, zeros-cloud-token.${invalidUtf8}`,
      }),
    ).resolves.toBe("rejected");
  });

  it("requires the safe application protocol with a subprotocol-carried token", async () => {
    const { port } = await startTransport({ token: TOKEN });
    const encoded = Buffer.from(TOKEN, "utf8").toString("base64url");
    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        protocols: `zeros-cloud-token.${encoded}`,
      }),
    ).resolves.toBe("rejected");
  });

  it("rejects ambiguous repeated query credentials", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, {
        path: `/ws?token=${TOKEN}&token=attacker-controlled-token`,
      }),
    ).resolves.toBe("rejected");
  });

  it("rejects ambiguous credentials sent through more than one carrier", async () => {
    const protocolToken = Buffer.from(TOKEN, "utf8").toString("base64url");
    await expect(
      attemptUpgrade((await startTransport({ token: TOKEN })).port, {
        path: `/ws?token=${TOKEN}`,
        cloudTokenHeader: TOKEN,
      }),
    ).resolves.toBe("rejected");
    await expect(
      attemptUpgrade((await startTransport({ token: TOKEN })).port, {
        path: "/ws",
        cloudTokenHeader: TOKEN,
        protocols: `zeros-v1, zeros-cloud-token.${protocolToken}`,
      }),
    ).resolves.toBe("rejected");
  });

  it("accepts a non-loopback Host and a cross-site Origin (NOT gated — unlike LocalTransport)", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, {
        path: "/ws",
        cloudTokenHeader: TOKEN,
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
      attemptUpgrade(port, { path: "/ws", cloudTokenHeader: "nope" }),
    ).resolves.toBe("rejected");
  });

  it("rejects a non-/ws path", async () => {
    const { port } = await startTransport({ token: TOKEN });
    await expect(
      attemptUpgrade(port, { path: "/nope", cloudTokenHeader: TOKEN }),
    ).resolves.toBe("rejected");
  });
});

describe("CloudTransport — connected peer is kind:cloud and messages round-trip", () => {
  it("surfaces the client as kind:cloud, delivers onMessage, and broadcasts back", async () => {
    const { t, port } = await startTransport({ token: TOKEN });

    const connected: TransportClient[] = [];
    const received: Array<{ kind: string; msg: EngineMessage }> = [];
    t.onConnect((c) => connected.push(c));
    t.onMessage((c, msg) => {
      received.push({ kind: c.kind, msg });
    });

    const ws = openCloudWebSocket(port);
    const inbound: EngineMessage[] = [];
    ws.on("message", (d) => inbound.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // Cloud peers must establish the protocol before any other frame. Account
    // verification is performed by ZerosEngine after this transport-level
    // ordering check.
    ws.send(
      JSON.stringify({
        id: "connected-roundtrip",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    await new Promise((r) => setTimeout(r, 25));
    received.length = 0;

    // client → engine
    ws.send(
      JSON.stringify({
        id: "heartbeat-1",
        timestamp: Date.now(),
        type: "HEARTBEAT",
        source: "browser",
      }),
    );
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

  it("drops malformed, engine-forged, and unknown inbound frames", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const received: EngineMessage[] = [];
    t.onMessage((_client, msg) => {
      received.push(msg);
    });
    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.send(
      JSON.stringify({
        id: "connected-validation",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    received.length = 0;

    ws.send("not-json");
    ws.send(
      JSON.stringify({
        id: "forged-1",
        timestamp: Date.now(),
        type: "AGENT_NEW_SESSION",
        source: "engine",
        agentId: "codex",
        workspaceId: "workspace-1",
      }),
    );
    ws.send(
      JSON.stringify({
        id: "unknown-1",
        timestamp: Date.now(),
        type: "UNKNOWN_MUTATION",
        source: "browser",
      }),
    );
    ws.send(
      JSON.stringify({
        id: "bad-env-1",
        timestamp: Date.now(),
        type: "AGENT_NEW_SESSION",
        source: "browser",
        agentId: "codex",
        workspaceId: "workspace-1",
        env: { NODE_ENV: { nested: true } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([]);
    ws.close();
  });

  it("fires onDisconnect when the peer closes", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const disconnected: TransportClient[] = [];
    t.onDisconnect((c) => disconnected.push(c));

    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(disconnected.length).toBe(1);
    expect(disconnected[0].kind).toBe("cloud");
  });

  it("requires CONNECTED first and closes a silent pre-auth peer on deadline", async () => {
    const { port } = await startTransport({
      token: TOKEN,
      handshakeTimeoutMs: 50,
    });

    const wrongFirst = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      wrongFirst.on("open", resolve);
      wrongFirst.on("error", reject);
    });
    const wrongFirstClosed = new Promise<number>((resolve) =>
      wrongFirst.once("close", (code) => resolve(code)),
    );
    wrongFirst.send(JSON.stringify({ type: "HEARTBEAT", source: "browser" }));
    await expect(wrongFirstClosed).resolves.toBe(1008);

    const silent = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      silent.on("open", resolve);
      silent.on("error", reject);
    });
    await expect(
      new Promise<number>((resolve) =>
        silent.once("close", (code) => resolve(code)),
      ),
    ).resolves.toBe(1008);
  });

  it("does not deliver post-CONNECTED frames until async account binding settles", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const delivered: string[] = [];
    let releaseBinding!: () => void;
    const binding = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type === "CONNECTED") {
        delivered.push("CONNECTED:start");
        await binding;
        delivered.push("CONNECTED:end");
        return;
      }
      delivered.push(msg.type);
    });

    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        id: "connected-async-binding",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    ws.send(
      JSON.stringify({
        id: "heartbeat-after-binding",
        timestamp: Date.now(),
        type: "HEARTBEAT",
        source: "browser",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(delivered).toEqual(["CONNECTED:start"]);
    releaseBinding();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(delivered).toEqual([
      "CONNECTED:start",
      "CONNECTED:end",
      "HEARTBEAT",
    ]);
    ws.close();
  });

  it("bounds authenticated async-handler concurrency without serializing control traffic", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const started: string[] = [];
    const finished: string[] = [];
    let releaseHandlers!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type !== "HEARTBEAT") return;
      const id = String((msg as EngineMessage & { id?: string }).id ?? "");
      started.push(id);
      await held;
      finished.push(id);
    });

    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        id: "connected-handler-concurrency",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (let index = 0; index < 33; index++) {
      ws.send(
        JSON.stringify({
          id: `heartbeat-handler-concurrency-${index}`,
          timestamp: Date.now(),
          type: "HEARTBEAT",
          source: "browser",
        }),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(started).toHaveLength(32);
    expect(finished).toHaveLength(0);
    releaseHandlers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toHaveLength(33);
    expect(finished).toHaveLength(33);
    ws.close();
  });

  it("bounds authenticated handler concurrency across all peers, not per socket", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const started: string[] = [];
    let releaseHandlers!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type !== "WORKSPACE_REQUEST") return;
      started.push(String((msg as EngineMessage & { id?: string }).id ?? ""));
      await held;
    });

    const peers = [openCloudWebSocket(port), openCloudWebSocket(port)];
    await Promise.all(
      peers.map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.on("open", resolve);
            ws.on("error", reject);
          }),
      ),
    );
    for (const [index, ws] of peers.entries()) {
      ws.send(
        JSON.stringify({
          id: `connected-global-handler-${index}`,
          timestamp: Date.now(),
          type: "CONNECTED",
          source: "browser",
          capabilities: [],
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const [peerIndex, ws] of peers.entries()) {
      for (let index = 0; index < 20; index++) {
        ws.send(
          JSON.stringify({
            id: `global-handler-${peerIndex}-${index}`,
            timestamp: Date.now(),
            type: "WORKSPACE_REQUEST",
            source: "browser",
            op: "project.list",
            params: {},
          }),
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toHaveLength(32);
    releaseHandlers();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(started).toHaveLength(40);
    for (const ws of peers) ws.close();
  });

  it("reserves bounded control capacity while ordinary handlers are saturated", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    let ordinaryStarted = 0;
    let cancelStarted = false;
    let releaseHandlers!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type === "WORKSPACE_REQUEST") {
        ordinaryStarted += 1;
        await held;
      } else if (msg.type === "AGENT_CANCEL") {
        cancelStarted = true;
      }
    });

    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        id: "connected-control-reserve",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (let index = 0; index < 32; index++) {
      ws.send(
        JSON.stringify({
          id: `ordinary-handler-${index}`,
          timestamp: Date.now(),
          type: "WORKSPACE_REQUEST",
          source: "browser",
          op: "project.list",
          params: {},
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ordinaryStarted).toBe(32);

    ws.send(
      JSON.stringify({
        id: "cancel-handler-control-reserve",
        timestamp: Date.now(),
        type: "AGENT_CANCEL",
        source: "browser",
        agentId: "codex",
        sessionId: "session-control-reserve",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cancelStarted).toBe(true);

    releaseHandlers();
    ws.close();
  });

  it("admits a control frame through its reserved lane when the ordinary queue is full", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    let ordinaryStarted = 0;
    let cancelStarted = false;
    let releaseHandlers!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type === "WORKSPACE_REQUEST") {
        ordinaryStarted += 1;
        await held;
      } else if (msg.type === "AGENT_CANCEL") {
        cancelStarted = true;
      }
    });

    const peers = Array.from({ length: 4 }, () => openCloudWebSocket(port));
    await Promise.all(
      peers.map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.on("open", resolve);
            ws.on("error", reject);
          }),
      ),
    );
    for (const [index, ws] of peers.entries()) {
      ws.send(
        JSON.stringify({
          id: `connected-full-queue-control-${index}`,
          timestamp: Date.now(),
          type: "CONNECTED",
          source: "browser",
          capabilities: [],
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (let index = 0; index < 32; index++) {
      peers[0].send(
        JSON.stringify({
          id: `full-queue-first-peer-${index}`,
          timestamp: Date.now(),
          type: "WORKSPACE_REQUEST",
          source: "browser",
          op: "project.list",
          params: {},
        }),
      );
    }
    await vi.waitFor(() => expect(ordinaryStarted).toBe(32));
    for (let index = 0; index < 32; index++) {
      peers[1].send(
        JSON.stringify({
          id: `full-queue-second-peer-${index}`,
          timestamp: Date.now(),
          type: "WORKSPACE_REQUEST",
          source: "browser",
          op: "project.list",
          params: {},
        }),
      );
      peers[2].send(
        JSON.stringify({
          id: `full-queue-third-peer-${index}`,
          timestamp: Date.now(),
          type: "WORKSPACE_REQUEST",
          source: "browser",
          op: "project.list",
          params: {},
        }),
      );
    }
    await vi.waitFor(() =>
      expect(
        (
          t as unknown as {
            handlerQueue: unknown[];
          }
        ).handlerQueue,
      ).toHaveLength(64),
    );
    expect(ordinaryStarted).toBe(32);

    peers[3].send(
      JSON.stringify({
        id: "full-queue-reserved-cancel",
        timestamp: Date.now(),
        type: "AGENT_CANCEL",
        source: "browser",
        agentId: "codex",
        sessionId: "full-queue-control-session",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cancelStarted).toBe(true);

    releaseHandlers();
    for (const ws of peers) ws.close();
  });

  it("does not let Cancel overtake an earlier queued Prompt for the same execution", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    let ordinaryStarted = 0;
    const routedOrder: string[] = [];
    let releaseHandlers!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type === "WORKSPACE_REQUEST") {
        ordinaryStarted += 1;
        await held;
      } else if (msg.type === "AGENT_PROMPT") {
        routedOrder.push("prompt");
      } else if (msg.type === "AGENT_CANCEL") {
        routedOrder.push("cancel");
      }
    });

    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        id: "connected-same-route-order",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (let index = 0; index < 32; index++) {
      ws.send(
        JSON.stringify({
          id: `route-saturation-${index}`,
          timestamp: Date.now(),
          type: "WORKSPACE_REQUEST",
          source: "browser",
          op: "project.list",
          params: {},
        }),
      );
    }
    await vi.waitFor(() => expect(ordinaryStarted).toBe(32));
    ws.send(
      JSON.stringify({
        id: "queued-prompt-same-route",
        timestamp: Date.now(),
        type: "AGENT_PROMPT",
        source: "browser",
        agentId: "codex",
        executionId: "same-route-execution",
        sessionId: "same-route-execution",
        prompt: [],
      }),
    );
    ws.send(
      JSON.stringify({
        id: "queued-cancel-same-route",
        timestamp: Date.now(),
        type: "AGENT_CANCEL",
        source: "browser",
        agentId: "codex",
        sessionId: "same-route-execution",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(routedOrder).toEqual([]);
    releaseHandlers();
    await vi.waitFor(() => expect(routedOrder).toEqual(["prompt", "cancel"]));
    ws.close();
  });

  it("closes an authenticated peer that overruns the bounded handler queue", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.onMessage(async (_client, msg) => {
      if (msg.type === "HEARTBEAT") await held;
    });
    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        id: "connected-handler-limit",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const closed = new Promise<number>((resolve) =>
      ws.once("close", (code) => resolve(code)),
    );
    for (let index = 0; index < 97; index++) {
      ws.send(
        JSON.stringify({
          id: `heartbeat-handler-limit-${index}`,
          timestamp: Date.now(),
          type: "HEARTBEAT",
          source: "browser",
        }),
      );
    }
    await expect(closed).resolves.toBe(1008);
    release();
  });

  it("caps authenticated peers and releases the slot after disconnect", async () => {
    const { port } = await startTransport({
      token: TOKEN,
      maxConnections: 1,
    });
    const first = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      first.on("open", resolve);
      first.on("error", reject);
    });

    await expect(
      attemptUpgrade(port, { path: "/ws", cloudTokenHeader: TOKEN }),
    ).resolves.toBe("rejected");

    const firstClosed = new Promise<void>((resolve) =>
      first.once("close", () => resolve()),
    );
    first.close();
    await firstClosed;
    await expect(
      attemptUpgrade(port, { path: "/ws", cloudTokenHeader: TOKEN }),
    ).resolves.toBe("accepted");
  });

  it("closes a slow peer before its outbound queue exceeds the high-water mark", async () => {
    const { t, port } = await startTransport({
      token: TOKEN,
      maxBufferedBytes: 256,
    });
    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(
      JSON.stringify({
        id: "connected-slow-peer",
        timestamp: Date.now(),
        type: "CONNECTED",
        source: "browser",
        capabilities: [],
      }),
    );
    const closed = new Promise<number>((resolve) =>
      ws.once("close", (code) => resolve(code)),
    );

    t.broadcast({
      type: "PTY_DATA",
      source: "engine",
      sessionId: "slow-peer",
      data: "x".repeat(1_024),
    } as EngineMessage);

    await expect(closed).resolves.toBe(1009);
  });

  it("enforces an aggregate outbound high-water mark below the per-peer limit", async () => {
    const { t, port } = await startTransport({
      token: TOKEN,
      maxBufferedBytes: 1_024,
      maxTotalBufferedBytes: 512,
    });
    const ws = openCloudWebSocket(port);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const serverSockets = [
      ...(
        t as unknown as {
          clients: Map<WebSocket, TransportClient>;
        }
      ).clients.keys(),
    ];
    expect(serverSockets).toHaveLength(1);
    Object.defineProperty(serverSockets[0], "bufferedAmount", {
      configurable: true,
      get: () => 400,
    });
    const closed = new Promise<number>((resolve) =>
      ws.once("close", (code) => resolve(code)),
    );

    t.broadcast({
      type: "PTY_DATA",
      source: "engine",
      sessionId: "aggregate-slow-peer",
      data: "x".repeat(200),
    } as EngineMessage);

    await expect(closed).resolves.toBe(1009);
  });

  it("bounds shutdown when a raw peer ignores the WebSocket close handshake", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const raw = await openRawUpgrade(port);
    try {
      const verdict = await Promise.race([
        t.stop().then(() => "stopped" as const),
        new Promise<"timed-out">((resolve) =>
          setTimeout(() => resolve("timed-out"), 1_500),
        ),
      ]);
      expect(verdict).toBe("stopped");
    } finally {
      raw.destroy();
    }
  });

  it("bounds shutdown when a raw peer stalls before completing HTTP headers", async () => {
    const { t, port } = await startTransport({ token: TOKEN });
    const raw = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    raw.write("GET /health HTTP/1.1\r\nHost: stalled.example");
    try {
      const verdict = await Promise.race([
        t.stop().then(() => "stopped" as const),
        new Promise<"timed-out">((resolve) =>
          setTimeout(() => resolve("timed-out"), 1_500),
        ),
      ]);
      expect(verdict).toBe("stopped");
    } finally {
      raw.destroy();
    }
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

describe("CloudTransport — image-helper readiness", () => {
  it("serves durable readiness only to a loopback request with the exact probe capability", async () => {
    const readiness = {
      version: 1 as const,
      instanceId: "44444444-4444-4444-8444-444444444444",
      protocolVersion: PROTOCOL_VERSION,
      health: "ready" as const,
      durableRecordConnected: true as const,
    };
    const probeToken = `zwr_${"R".repeat(43)}`;
    const { port } = await startTransport({
      token: TOKEN,
      internalReadiness: { token: probeToken, read: () => readiness },
    });

    const rejectedHeaders: Record<string, string>[] = [
      {},
      { "x-zeros-readiness-token": `zwr_${"X".repeat(43)}` },
    ];
    for (const headers of rejectedHeaders) {
      const rejected = await httpRequest(port, {
        path: "/internal/readiness",
        headers,
      });
      expect(rejected.status).toBe(404);
      expect(rejected.body).not.toContain(readiness.instanceId);
    }
    const publicHost = await httpRequest(port, {
      path: "/internal/readiness",
      host: "39393-provider.example.test",
      headers: { "x-zeros-readiness-token": probeToken },
    });
    expect(publicHost.status).toBe(404);

    const accepted = await httpRequest(port, {
      path: "/internal/readiness",
      headers: { "x-zeros-readiness-token": probeToken },
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({
      version: 1,
      audience: "zeros-cloud-engine-readiness-v1",
      ready: true,
      engine: readiness,
    });
  });

  it("returns unavailable until durable registration is connected", async () => {
    const probeToken = `zwr_${"R".repeat(43)}`;
    const { port } = await startTransport({
      token: TOKEN,
      internalReadiness: { token: probeToken, read: () => null },
    });
    const response = await httpRequest(port, {
      path: "/internal/readiness",
      headers: { "x-zeros-readiness-token": probeToken },
    });
    expect(response.status).toBe(503);
    expect(response.body).toBe("unavailable");
  });
});
