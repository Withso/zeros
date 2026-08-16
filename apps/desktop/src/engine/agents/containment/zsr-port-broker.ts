import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import type { PortLease, PortRequest, TerritoryGeneration } from "./types";

const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;
const BRIDGE_RETRY_MS = 20;
const MAX_BRIDGE_RESPONSE_BYTES = 64;
const MAX_LISTENER_RESPONSE_BYTES = 4 * 1024;
const MAX_DISCOVERED_LISTENERS = 256;
const MAX_ACTIVE_CONNECTIONS = 256;
const MAX_SERVICE_FRAME_BYTES = 4 * 1024;

interface ReversePortBrokerOptions {
  readonly generation: TerritoryGeneration;
  readonly socketPath: string;
  readonly token: Buffer;
}

interface PortPolicyClientOptions {
  readonly generation: TerritoryGeneration;
  readonly socketPath: string;
  readonly token: Buffer;
}

function validPort(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function exactToken(candidate: unknown, expected: Buffer): boolean {
  if (typeof candidate !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) {
    return false;
  }
  const decoded = Buffer.from(candidate, "base64url");
  return (
    decoded.length === expected.length && timingSafeEqual(decoded, expected)
  );
}

async function connectLoopback(port: number): Promise<Socket> {
  let firstError: unknown;
  for (const host of ["127.0.0.1", "::1"] as const) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host, port });
        const timeout = setTimeout(
          () => fail(new Error("local service connection timed out")),
          BRIDGE_CONNECT_TIMEOUT_MS,
        );
        const fail = (error: Error) => {
          clearTimeout(timeout);
          socket.destroy();
          reject(error);
        };
        socket.once("error", fail);
        socket.once("connect", () => {
          clearTimeout(timeout);
          socket.off("error", fail);
          resolve(socket);
        });
      });
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError instanceof Error
    ? firstError
    : new Error("local service is unavailable");
}

interface LocalTcpBrokerOptions {
  readonly generation: TerritoryGeneration;
  readonly socketPath: string;
  readonly token: Buffer;
  readonly allowedPorts: readonly number[];
}

/** Host-side endpoint for direct localhost clients inside Linux's isolated
 * network namespace. The hidden in-namespace bridge authenticates here and
 * may reach only the exact ports admitted with the boundary generation. */
export class ZsrLocalTcpBroker {
  private readonly sockets = new Set<Socket>();
  private closed = false;

  private constructor(
    private readonly options: LocalTcpBrokerOptions,
    private readonly server: Server,
  ) {}

  static async start(
    options: LocalTcpBrokerOptions,
  ): Promise<ZsrLocalTcpBroker> {
    const allowed = new Set(options.allowedPorts);
    if (
      allowed.size !== options.allowedPorts.length ||
      [...allowed].some((port) => !validPort(port))
    ) {
      throw new Error("local TCP broker ports must be unique and valid");
    }
    const brokerRef: { current: ZsrLocalTcpBroker | null } = { current: null };
    const server = createServer((socket) => {
      const current = brokerRef.current;
      if (!current) {
        socket.destroy();
        return;
      }
      current.accept(socket);
    });
    const broker = new ZsrLocalTcpBroker(options, server);
    brokerRef.current = broker;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.socketPath, resolve);
      });
      await chmod(options.socketPath, 0o600);
      server.unref();
      return broker;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= MAX_ACTIVE_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(BRIDGE_CONNECT_TIMEOUT_MS, () => socket.destroy());
    let frame = Buffer.alloc(0);
    let handled = false;
    socket.once("close", () => this.sockets.delete(socket));
    socket.once("error", () => this.sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      frame = Buffer.concat([frame, chunk]);
      if (frame.length > MAX_SERVICE_FRAME_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      const newline = frame.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      if (newline !== frame.length - 1) {
        socket.destroy();
        return;
      }
      void this.authorizeAndForward(
        socket,
        frame.subarray(0, newline).toString("utf8"),
      );
    });
  }

  private async authorizeAndForward(
    socket: Socket,
    raw: string,
  ): Promise<void> {
    try {
      const request = JSON.parse(raw) as Record<string, unknown>;
      const port = request.port;
      if (
        request.version !== 1 ||
        request.operation !== "connect-local-tcp" ||
        request.generation !== this.options.generation ||
        !exactToken(request.token, this.options.token) ||
        !validPort(port) ||
        !this.options.allowedPorts.includes(port)
      ) {
        socket.destroy();
        return;
      }
      socket.pause();
      socket.removeAllListeners("data");
      const target = await connectLoopback(port);
      this.sockets.add(target);
      target.once("close", () => this.sockets.delete(target));
      target.once("error", () => socket.destroy());
      socket.once("close", () => target.destroy());
      socket.setTimeout(0);
      socket.write("OK\n");
      socket.pipe(target);
      target.pipe(socket);
      socket.resume();
    } catch {
      socket.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await closeServer(this.server).catch(() => undefined);
  }
}

/** Authenticated engine-to-supervisor channel for the part of local-port
 * policy SRT can update live: its HTTP/SOCKS proxy allowlist. The macOS
 * Seatbelt profile itself remains immutable; discovered listeners are reached
 * by proxy-aware clients through SRT's already-admitted proxy port. */
export class ZsrPortPolicyClient {
  private closed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: PortPolicyClientOptions) {}

  private async send(ports: readonly number[]): Promise<void> {
    const socket = await (async () => {
      const deadline = Date.now() + BRIDGE_CONNECT_TIMEOUT_MS;
      while (!this.closed && Date.now() < deadline) {
        try {
          return await new Promise<Socket>((resolve, reject) => {
            const candidate = createConnection(this.options.socketPath);
            const fail = (error: Error) => {
              candidate.destroy();
              reject(error);
            };
            candidate.once("error", fail);
            candidate.once("connect", () => {
              candidate.off("error", fail);
              resolve(candidate);
            });
          });
        } catch {
          await wait(BRIDGE_RETRY_MS);
        }
      }
      throw new Error("session port-policy control is unavailable");
    })();
    await new Promise<void>((resolve, reject) => {
      let response = Buffer.alloc(0);
      let settled = false;
      const timeout = setTimeout(
        () => fail(new Error("session port-policy update timed out")),
        BRIDGE_CONNECT_TIMEOUT_MS,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new Error("session port-policy control closed"));
      });
      socket.on("data", (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > MAX_BRIDGE_RESPONSE_BYTES) {
          fail(new Error("invalid session port-policy response"));
          return;
        }
        const newline = response.indexOf(0x0a);
        if (newline < 0) return;
        if (
          newline !== response.length - 1 ||
          response.subarray(0, newline).toString("utf8") !== "OK"
        ) {
          fail(new Error("session port-policy update was rejected"));
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
      socket.write(
        `${JSON.stringify({
          version: 1,
          operation: "set-local-ports",
          generation: this.options.generation,
          token: this.options.token.toString("base64url"),
          ports,
        })}\n`,
      );
    });
  }

  setLocalPorts(ports: readonly number[]): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("execution boundary is revoked"));
    const normalized = [...new Set(ports)].sort((left, right) => left - right);
    if (
      normalized.length > MAX_DISCOVERED_LISTENERS ||
      normalized.some((port) => !validPort(port))
    ) {
      return Promise.reject(new Error("invalid dynamic local-port policy"));
    }
    const update = this.tail
      .catch(() => undefined)
      .then(() => this.send(normalized));
    this.tail = update;
    return update;
  }

  close(): void {
    this.closed = true;
  }
}

/** Host-side half of the Linux network-namespace reverse bridge. The browser
 * sees a normal loopback TCP listener; each connection is authenticated to a
 * hidden bridge inside the session namespace, then byte-for-byte piped to the
 * exact leased target port. No engine/control listener is ever forwarded. */
export class ZsrReversePortBroker {
  private readonly leases = new Set<PortLease>();
  private closed = false;

  constructor(private readonly options: ReversePortBrokerOptions) {}

  private async connectBridge(): Promise<Socket> {
    const deadline = Date.now() + BRIDGE_CONNECT_TIMEOUT_MS;
    let lastError: unknown;
    while (!this.closed && Date.now() < deadline) {
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const socket = createConnection(this.options.socketPath);
          const fail = (error: Error) => {
            socket.destroy();
            reject(error);
          };
          socket.once("error", fail);
          socket.once("connect", () => {
            socket.off("error", fail);
            resolve(socket);
          });
        });
      } catch (error) {
        lastError = error;
        await wait(BRIDGE_RETRY_MS);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("session network bridge is unavailable");
  }

  private async forward(client: Socket, targetPort: number): Promise<void> {
    client.pause();
    const bridge = await this.connectBridge();
    let response = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () => fail(new Error("session network bridge timed out")),
        BRIDGE_CONNECT_TIMEOUT_MS,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        bridge.off("error", fail);
        bridge.removeAllListeners("data");
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        bridge.destroy();
        reject(error);
      };
      bridge.once("error", fail);
      bridge.on("data", (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > MAX_BRIDGE_RESPONSE_BYTES) {
          fail(new Error("invalid session network bridge response"));
          return;
        }
        const newline = response.indexOf(0x0a);
        if (newline < 0) return;
        cleanup();
        if (response.subarray(0, newline).toString("utf8") !== "OK") {
          fail(new Error("session target port is unavailable"));
          return;
        }
        if (newline !== response.length - 1) {
          fail(new Error("invalid session network bridge framing"));
          return;
        }
        settled = true;
        resolve();
      });
      bridge.write(
        `${JSON.stringify({
          version: 1,
          operation: "connect-tcp",
          generation: this.options.generation,
          token: this.options.token.toString("base64url"),
          port: targetPort,
        })}\n`,
      );
    });
    const destroyBoth = () => {
      client.destroy();
      bridge.destroy();
    };
    client.once("error", destroyBoth);
    bridge.once("error", destroyBoth);
    client.once("close", () => bridge.destroy());
    bridge.once("close", () => client.destroy());
    client.pipe(bridge);
    bridge.pipe(client);
    client.resume();
  }

  async listTcpListeners(): Promise<readonly number[]> {
    if (this.closed) throw new Error("execution boundary is revoked");
    const bridge = await this.connectBridge();
    return new Promise<readonly number[]>((resolve, reject) => {
      let response = Buffer.alloc(0);
      let settled = false;
      const timeout = setTimeout(
        () => fail(new Error("session listener discovery timed out")),
        BRIDGE_CONNECT_TIMEOUT_MS,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        bridge.removeAllListeners();
        bridge.destroy();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      bridge.once("error", fail);
      bridge.on("data", (chunk: Buffer) => {
        if (settled) return;
        response = Buffer.concat([response, chunk]);
        if (response.length > MAX_LISTENER_RESPONSE_BYTES) {
          fail(new Error("oversized session listener response"));
          return;
        }
        const newline = response.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== response.length - 1) {
          fail(new Error("invalid session listener framing"));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(response.subarray(0, newline).toString("utf8"));
        } catch {
          fail(new Error("invalid session listener response"));
          return;
        }
        const record = value as { version?: unknown; listeners?: unknown };
        if (
          !record ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          record.version !== 1 ||
          !Array.isArray(record.listeners) ||
          record.listeners.length > MAX_DISCOVERED_LISTENERS ||
          record.listeners.some((port) => !validPort(port)) ||
          new Set(record.listeners).size !== record.listeners.length
        ) {
          fail(new Error("invalid session listener response"));
          return;
        }
        const listeners = [...record.listeners].sort((a, b) => a - b);
        settled = true;
        cleanup();
        resolve(listeners);
      });
      bridge.once("close", () => {
        if (!settled) fail(new Error("session listener bridge closed"));
      });
      bridge.write(
        `${JSON.stringify({
          version: 1,
          operation: "list-tcp-listeners",
          generation: this.options.generation,
          token: this.options.token.toString("base64url"),
        })}\n`,
      );
    });
  }

  async lease(request: PortRequest): Promise<PortLease> {
    if (this.closed) throw new Error("execution boundary is revoked");
    if (request.protocol !== "tcp") {
      throw new Error("UDP port leases require the datagram bridge");
    }
    if (
      request.preferredPort !== undefined &&
      !validPort(request.preferredPort)
    ) {
      throw new Error("preferred port must be a valid TCP port");
    }
    if (request.targetPort !== undefined && !validPort(request.targetPort)) {
      throw new Error("target port must be a valid TCP port");
    }

    const connections = new Set<Socket>();
    let targetPort = request.targetPort ?? request.preferredPort ?? 0;
    const server = createServer({ pauseOnConnect: true }, (client) => {
      if (connections.size >= MAX_ACTIVE_CONNECTIONS) {
        client.destroy();
        return;
      }
      connections.add(client);
      client.once("close", () => connections.delete(client));
      void this.forward(client, targetPort).catch(() => client.destroy());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(request.preferredPort ?? 0, "127.0.0.1", resolve);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("reverse port broker did not receive a TCP address");
    }
    if (targetPort === 0) targetPort = address.port;
    server.unref();

    let active = true;
    const lease: PortLease = {
      leaseId: `port:${this.options.generation}:${randomUUID()}`,
      generation: this.options.generation,
      host: "127.0.0.1",
      port: address.port,
      targetPort,
      revoke: async () => {
        if (!active) return;
        active = false;
        this.leases.delete(lease);
        for (const connection of connections) connection.destroy();
        await closeServer(server).catch(() => undefined);
      },
    };
    this.leases.add(lease);
    return lease;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.leases].map((lease) => lease.revoke()));
  }
}
