import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { Duplex } from "node:stream";
import WebSocket, { type RawData } from "ws";
import {
  CloudWorkspaceAccessClientError,
  boundedJson,
  safeBaseUrl,
} from "./cloud-workspace-access-client";
import type { CloudRuntimeServiceAccess } from "./cloud-runtime-service-client";

const FRAME_BYTES = 64 * 1024;
const TRANSFER_BYTES = 256 * 1024 * 1024;
// Match the control-plane relay's per-grant stream limit. Authority checks
// use HTTP and do not reserve a stream or connect to the forwarded application.
const MAX_CONNECTIONS = 4;
const AUTHORITY_MS = 10_000;
export type CloudSshIntroduction = {
  version: 1;
  kind: "ssh";
  publicKey: string;
  hostKeySha256: string;
};
export type CloudServiceIntroduction =
  | CloudSshIntroduction
  | { version: 1; kind: "tunnel" };
export type CloudServiceHandle = {
  closed: Promise<void>;
  stop(): Promise<void>;
};
export type CloudServiceConnection = CloudServiceHandle & {
  stream: Duplex;
  intro: CloudServiceIntroduction;
};
export type CloudServiceTunnel = CloudServiceHandle & { localPort: number };

/** The introduction is authenticated by the exact control-plane WSS channel.
 * Its public key is a per-stream pin, never a trust-on-first-use database. */
export function parseCloudServiceIntroduction(
  source: Buffer,
  kind: "ssh" | "tunnel",
): CloudServiceIntroduction {
  const invalid = () => new Error("Cloud service introduction is invalid.");
  if (source.length > 1024) throw invalid();
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
  } catch {
    throw invalid();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.kind !== kind
  )
    throw invalid();
  if (kind === "tunnel") {
    if (Object.keys(value).sort().join(",") !== "kind,version") throw invalid();
    return { version: 1, kind };
  }
  if (
    Object.keys(value).sort().join(",") !==
      "hostKeySha256,kind,publicKey,version" ||
    typeof value.publicKey !== "string" ||
    typeof value.hostKeySha256 !== "string"
  )
    throw invalid();
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/.exec(value.publicKey);
  if (!match) throw invalid();
  const key = Buffer.from(match[1]!, "base64");
  if (
    key.length !== 51 ||
    key.toString("base64") !== match[1] ||
    key.readUInt32BE(0) !== 11 ||
    key.subarray(4, 15).toString() !== "ssh-ed25519" ||
    key.readUInt32BE(15) !== 32 ||
    createHash("sha256").update(key).digest("base64").replace(/=+$/, "") !==
      value.hostKeySha256
  )
    throw invalid();
  return {
    version: 1,
    kind,
    publicKey: value.publicKey,
    hostKeySha256: value.hostKeySha256,
  };
}

function buffer(data: RawData): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}
function unavailable(): Error {
  return new Error("Cloud service connection is unavailable or closed.");
}
class CapacityError extends Error {}

/** Main-process byte relay. All authentication stays in HTTP headers, and both
 * backpressure and size/deadline limits apply independently of remote behavior. */
export class CloudRuntimeServiceTransport {
  private readonly baseUrl: string;
  private readonly handles = new Set<CloudServiceHandle>();
  private disposed = false;
  constructor(options: { baseUrl: string; allowInsecureLoopback?: boolean }) {
    this.baseUrl = safeBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
  }

  private endpoint(access: CloudRuntimeServiceAccess): URL {
    const expected = new URL(
      `/v1/cloud-workspaces/services/${access.grant.kind}/${access.grant.id}`,
      this.baseUrl,
    );
    expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
    if (
      access.transport.url !== expected.toString() ||
      access.transport.version !== 1 ||
      access.transport.headerName !== "x-zeros-runtime-service" ||
      access.transport.protocol !== "zeros.service.v1" ||
      !/^zsh_[A-Za-z0-9_-]{43}$/.test(access.transport.capability)
    )
      throw new Error("Cloud service transport is invalid.");
    return expected;
  }

  private async checkAuthority(access: CloudRuntimeServiceAccess, signal: AbortSignal): Promise<number> {
    const url = this.endpoint(access);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const started = Date.now();
    const response = await fetch(url, {
      signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "x-zeros-runtime-service": access.transport.capability, "cache-control": "no-store" },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw unavailable();
    }
    const value = await boundedJson(response) as { expiresAtMs?: unknown } | null;
    if (!value || Object.keys(value).join(",") !== "expiresAtMs" ||
        typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs)) throw unavailable();
    return Math.min(value.expiresAtMs, started + AUTHORITY_MS, Date.parse(access.grant.expiresAt));
  }

  async open(
    access: CloudRuntimeServiceAccess,
    signal?: AbortSignal,
  ): Promise<CloudServiceConnection> {
    if (this.disposed || signal?.aborted) throw unavailable();
    const expected = this.endpoint(access);
    const remaining = Date.parse(access.grant.expiresAt) - Date.now();
    if (
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > 32 * 60_000
    )
      throw new Error("Cloud service access is invalid or expired.");
    return new Promise<CloudServiceConnection>((resolve, reject) => {
      const socket = new WebSocket(expected, "zeros.service.v1", {
        headers: { "x-zeros-runtime-service": access.transport.capability },
        followRedirects: false,
        handshakeTimeout: 10_000,
        maxPayload: FRAME_BYTES,
        perMessageDeflate: false,
      });
      let introduced = false,
        ended = false,
        received = 0,
        sent = 0;
      let finishClosed!: () => void;
      const closed = new Promise<void>((done) => {
        finishClosed = done;
      });
      const stream = new Duplex({
        highWaterMark: FRAME_BYTES,
        read() {
          socket.resume();
        },
        write(chunk: Buffer, _encoding, callback) {
          sent += chunk.length;
          if (
            sent > TRANSFER_BYTES ||
            ended ||
            socket.readyState !== WebSocket.OPEN
          ) {
            callback(unavailable());
            return;
          }
          // A local socket write can exceed one runtime frame. Send bounded
          // frames serially; callbacks retain the stream's backpressure.
          let offset = 0;
          const next = (error?: Error) => {
            if (error) {
              callback(unavailable());
              return;
            }
            if (offset >= chunk.length) {
              callback();
              return;
            }
            if (ended || socket.readyState !== WebSocket.OPEN) {
              callback(unavailable());
              return;
            }
            const part = chunk.subarray(offset, offset + FRAME_BYTES);
            offset += part.length;
            socket.send(part, { binary: true, compress: false }, next);
          };
          next();
        },
        final(callback) {
          if (!ended) socket.close();
          callback();
        },
        destroy(_error, callback) {
          socket.terminate();
          callback();
        },
      });
      const fail = (error = unavailable()) => {
        if (!introduced) reject(error);
        stream.destroy();
        socket.terminate();
      };
      const handle: CloudServiceHandle = {
        closed,
        stop: async () => {
          fail();
          await closed;
        },
      };
      this.handles.add(handle);
      const deadline = setTimeout(
        () => fail(new Error("Cloud service access expired.")),
        remaining,
      );
      deadline.unref();
      const handshake = setTimeout(() => fail(), 10_000);
      handshake.unref();
      const abort = () => fail();
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("error", abort);
      socket.on("error", abort);
      socket.once("unexpected-response", (_request, response) => {
        const error = response.statusCode === 429
          ? new CapacityError("Cloud service connection capacity is full.")
          : unavailable();
        response.destroy();
        fail(error);
      });
      socket.once("open", () => {
        if (socket.protocol !== "zeros.service.v1") fail();
      });
      socket.on("message", (data, binary) => {
        if (ended || stream.destroyed) return;
        const bytes = buffer(data);
        if (!introduced) {
          try {
            if (binary)
              throw new Error("Cloud service introduction must be text.");
            const intro = parseCloudServiceIntroduction(
              bytes,
              access.grant.kind,
            );
            introduced = true;
            clearTimeout(handshake);
            resolve({ ...handle, stream, intro });
          } catch {
            fail(new Error("Cloud service introduction is invalid."));
          }
          return;
        }
        received += bytes.length;
        if (
          !binary ||
          bytes.length > FRAME_BYTES ||
          received > TRANSFER_BYTES
        ) {
          fail();
          return;
        }
        if (!stream.push(bytes)) socket.pause();
      });
      socket.once("close", () => {
        ended = true;
        clearTimeout(deadline);
        clearTimeout(handshake);
        signal?.removeEventListener("abort", abort);
        this.handles.delete(handle);
        if (!introduced) reject(unavailable());
        // Preserve already received exit status/stderr and final TCP bytes.
        // The readable side drains before normal stream auto-destruction.
        stream.push(null);
        stream.end();
        finishClosed();
      });
    });
  }

  async startTunnel(
    access: CloudRuntimeServiceAccess,
    localPort: number,
  ): Promise<CloudServiceTunnel> {
    if (
      this.disposed ||
      access.grant.kind !== "tunnel" ||
      !Number.isSafeInteger(localPort) ||
      (localPort !== 0 && (localPort < 1024 || localPort > 65535)) ||
      Date.parse(access.grant.expiresAt) <= Date.now()
    )
      throw unavailable();
    const clients = new Map<
      Socket,
      { abort: AbortController; connection?: CloudServiceConnection }
    >();
    let stopped = false,
      finishClosed!: () => void,
      stopping: Promise<void> | undefined;
    const authorityAbort = new AbortController();
    let authorityExpiresAt = Date.now() + AUTHORITY_MS, checking = false;
    let authorityTimer: ReturnType<typeof setTimeout> | undefined;
    let authorityDeadline: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve) => {
      finishClosed = resolve;
    });
    const server = createServer({ pauseOnConnect: true }, (socket) => {
      if (stopped || clients.size >= MAX_CONNECTIONS) {
        socket.destroy();
        return;
      }
      const client = {
        abort: new AbortController(),
        connection: undefined as CloudServiceConnection | undefined,
      };
      clients.set(socket, client);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => {
        clients.delete(socket);
        client.abort.abort();
        void client.connection?.stop();
      });
      void this.open(access, client.abort.signal).then(
        (connection) => {
          client.connection = connection;
          if (stopped || socket.destroyed) {
            void connection.stop();
            return;
          }
          connection.stream.once("error", () => socket.destroy());
          connection.stream.once("close", () => socket.destroy());
          socket.pipe(connection.stream).pipe(socket);
          socket.resume();
        },
        (error: unknown) => {
          // A stale grant is never renewed implicitly after wake/revocation.
          // Capacity rejection affects this connection only, including when
          // another client or the relay's global limit consumed the slot.
          if (!stopped && !client.abort.signal.aborted && !(error instanceof CapacityError)) void stop();
          socket.destroy();
        },
      );
    });
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      stopped = true;
      clearTimeout(deadline);
      clearTimeout(authorityTimer);
      clearTimeout(authorityDeadline);
      authorityAbort.abort();
      for (const [socket, client] of clients) {
        client.abort.abort();
        socket.destroy();
      }
      stopping = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      ).then(() => {
        this.handles.delete(handle);
        finishClosed();
      });
      return stopping;
    };
    const handle: CloudServiceHandle = { closed, stop };
    this.handles.add(handle);
    const deadline = setTimeout(
      () => void stop(),
      Math.max(0, Date.parse(access.grant.expiresAt) - Date.now()),
    );
    deadline.unref();
    const checkAuthority = async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        const expires = await this.checkAuthority(access, authorityAbort.signal);
        if (stopped) return;
        if (Date.now() >= authorityExpiresAt || !Number.isFinite(expires) || expires <= Date.now()) {
          await stop();
          return;
        }
        authorityExpiresAt = expires;
        clearTimeout(authorityDeadline);
        authorityDeadline = setTimeout(() => void stop(), expires - Date.now());
        authorityDeadline.unref();
        authorityTimer = setTimeout(() => void checkAuthority(), Math.max(1, Math.min(5_000, (expires - Date.now()) / 2)));
        authorityTimer.unref();
      } catch {
        await stop();
      } finally {
        checking = false;
      }
    };
    // Retire even if an idle listener's check hangs. Application EOF does not
    // signal authority retirement; this independent lease governs the listener.
    authorityDeadline = setTimeout(() => void stop(), AUTHORITY_MS);
    authorityDeadline.unref();
    server.on("error", () => {
      if (server.listening) void stop();
    });
    try {
      await checkAuthority();
      if (stopped || this.disposed) throw unavailable();
      const observedPort = await new Promise<number>((resolve, reject) => {
        const failed = (error: NodeJS.ErrnoException) =>
          reject(
            new CloudWorkspaceAccessClientError(
              0,
              error.code === "EADDRINUSE"
                ? "local_port_in_use"
                : "local_listener_unavailable",
              error.code === "EADDRINUSE"
                ? "That local port is already in use. Choose another port."
                : "The local port could not be opened.",
            ),
          );
        server.once("error", failed);
        server.listen(
          { host: "127.0.0.1", port: localPort, exclusive: true },
          () => {
            server.off("error", failed);
            const address = server.address();
            if (
              !address ||
              typeof address === "string" ||
              address.address !== "127.0.0.1"
            ) {
              reject(unavailable());
              return;
            }
            resolve(address.port);
          },
        );
      });
      if (stopped || this.disposed) throw unavailable();
      return { ...handle, localPort: observedPort };
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.handles].map((handle) => handle.stop()));
  }
}
