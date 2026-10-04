import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer as tcpServer, connect } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CloudRuntimeServiceTransport } from "../cloud-runtime-service-transport";
import type { CloudRuntimeServiceAccess } from "../cloud-runtime-service-client";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function sshIntro() {
  const key = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  const raw = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.from(key.x!, "base64url"),
  ]);
  return {
    version: 1,
    kind: "ssh",
    publicKey: `ssh-ed25519 ${raw.toString("base64")}`,
    hostKeySha256: createHash("sha256")
      .update(raw)
      .digest("base64")
      .replace(/=+$/, ""),
  };
}
async function fixture(
  intro: unknown = { version: 1, kind: "tunnel" },
  binary = false,
) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: () => "zeros.service.v1",
  });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new CloudRuntimeServiceTransport({
    baseUrl: origin,
    allowInsecureLoopback: true,
  });
  cleanups.push(() => transport.dispose());
  const kind = (intro as { kind?: string })?.kind === "ssh" ? "ssh" : "tunnel";
  const access: CloudRuntimeServiceAccess = {
    grant: {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 7,
      kind,
      deviceId: "44444444-4444-4444-8444-444444444444",
      remotePort: kind === "ssh" ? null : 4173,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    deviceKeyVersion: 1,
    transport: {
      version: 1,
      url: `${origin.replace("http:", "ws:")}/v1/cloud-workspaces/services/${kind}/33333333-3333-4333-8333-333333333333`,
      capability: `zsh_${"a".repeat(43)}`,
      headerName: "x-zeros-runtime-service",
      protocol: "zeros.service.v1",
    },
    ...(kind === "ssh"
      ? { ssh: { username: "zeros", hostKey: "stream-introduction" } }
      : {}),
  };
  server.on("connection", (socket) => {
    if (intro !== null) socket.send(JSON.stringify(intro), { binary });
    socket.on("message", (bytes, isBinary) => {
      if (isBinary) socket.send(bytes, { binary: true });
    });
  });
  return { server, origin, transport, access };
}

describe("native service streams", () => {
  it("consumes the introduction, carries the grant only in a header, and relays binary TCP bytes", async () => {
    const { server, transport, access } = await fixture();
    const upgrade = once(server, "connection");
    const connection = await transport.open(access);
    const [, request] = await upgrade;
    expect(
      request.headers["x-zeros-runtime-service"] ===
        access.transport.capability,
    ).toBe(true);
    expect(request.url.includes(access.transport.capability)).toBe(false);
    expect(connection.intro).toEqual({ version: 1, kind: "tunnel" });
    const data = once(connection.stream, "data");
    connection.stream.write(Buffer.from([0, 255, 10, 2]));
    expect((await data)[0]).toEqual(Buffer.from([0, 255, 10, 2]));
    await connection.stop();
    await connection.closed;
  });

  it("validates the Ed25519 wire encoding and its authenticated fingerprint", async () => {
    const intro = sshIntro();
    const { transport, access } = await fixture(intro);
    const connection = await transport.open(access);
    expect(connection.intro).toEqual(intro);
    await connection.stop();
  });

  it.each(["hash", "key", "extra", "version", "binary", "kind"])(
    "rejects a wrong %s introduction before exposing bytes",
    async (variant) => {
      const intro = sshIntro();
      if (variant === "hash") intro.hostKeySha256 = "x".repeat(43);
      if (variant === "key") intro.publicKey = "ssh-ed25519 invalid";
      if (variant === "extra") Object.assign(intro, { unknown: true });
      if (variant === "version") intro.version = 2;
      const { transport, access } = await fixture(intro, variant === "binary");
      if (variant === "kind") {
        access.grant.kind = "tunnel";
        access.transport.url = access.transport.url.replace(
          "/ssh/",
          "/tunnel/",
        );
      }
      await expect(transport.open(access)).rejects.toThrow(/introduction/i);
    },
  );

  it("rejects text after introduction and bounds binary frame size", async () => {
    for (const large of [false, true]) {
      const { transport, access, server } = await fixture();
      const stream = await transport.open(access);
      for (const socket of server.clients)
        socket.send(large ? Buffer.alloc(65537) : "unexpected", {
          binary: large,
        });
      await stream.closed;
      expect(stream.stream.destroyed).toBe(true);
    }
  });

  it("splits writes into frames the engine can accept", async () => {
    const { transport, access, server } = await fixture();
    const sizes: number[] = [];
    server.on("connection", (socket) =>
      socket.on("message", (bytes) => sizes.push((bytes as Buffer).length)),
    );
    const connection = await transport.open(access);
    let received = 0;
    const done = new Promise<void>((resolve) =>
      connection.stream.on("data", (chunk) => {
        received += chunk.length;
        if (received === 200_000) resolve();
      }),
    );
    connection.stream.write(Buffer.alloc(200_000, 7));
    await done;
    expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(200_000);
  });

  it("fails closed at expiry and refuses an old grant or another origin", async () => {
    const { transport, access } = await fixture();
    access.grant.expiresAt = new Date(Date.now() + 150).toISOString();
    const connection = await transport.open(access);
    await connection.closed;
    await expect(transport.open(access)).rejects.toThrow(/expired/i);
    access.grant.expiresAt = new Date(Date.now() + 60_000).toISOString();
    access.transport.url = "wss://attacker.test/services";
    await expect(transport.open(access)).rejects.toThrow(/transport/i);
  });

  it("cancels an admission that has not introduced itself", async () => {
    const { transport, access } = await fixture(null);
    const controller = new AbortController();
    const opening = transport.open(access, controller.signal);
    const rejected = expect(opening).rejects.toThrow(/closed|unavailable/i);
    controller.abort();
    await rejected;
  });

  it("owns a loopback listener, reports collisions, and stops pending/active clients", async () => {
    const { transport, access } = await fixture();
    const handle = await transport.startTunnel(access, 0);
    expect(handle.localPort).toBeGreaterThan(1023);
    const socket = connect({ host: "127.0.0.1", port: handle.localPort });
    const data = once(socket, "data");
    socket.write("tcp-roundtrip");
    expect((await data)[0].toString()).toBe("tcp-roundtrip");
    expect(socket.remoteAddress).toBe("127.0.0.1");
    await expect(
      transport.startTunnel(access, handle.localPort),
    ).rejects.toMatchObject({ code: "local_port_in_use" });
    const closed = once(socket, "close");
    await handle.stop();
    await closed;
    await handle.closed;
    const replacement = tcpServer();
    replacement.listen(handle.localPort, "127.0.0.1");
    await once(replacement, "listening");
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });

  it("retires a listener on rejected admission so wake needs explicit reopening", async () => {
    const { transport, access, server } = await fixture();
    server.removeAllListeners("connection");
    server.on("connection", (socket) => socket.close(1008));
    const handle = await transport.startTunnel(access, 0);
    const socket = connect({ host: "127.0.0.1", port: handle.localPort });
    socket.on("error", () => {});
    await handle.closed;
  });

  it("drains final TCP bytes to a slow local reader before closing", async () => {
    const { transport, access, server } = await fixture();
    const payload = Buffer.alloc(8 * 1024 * 1024, 7);
    server.on("connection", (socket) => {
      for (let offset = 0; offset < payload.length; offset += 65536)
        socket.send(payload.subarray(offset, offset + 65536));
      socket.close();
    });
    const handle = await transport.startTunnel(access, 0);
    const socket = connect({ host: "127.0.0.1", port: handle.localPort });
    socket.pause();
    const received: Buffer[] = [];
    socket.on("data", (data) => received.push(data));
    const ended = once(socket, "end");
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.resume();
    await ended;
    expect(Buffer.concat(received).equals(payload)).toBe(true);
    await handle.stop();
  });
});
