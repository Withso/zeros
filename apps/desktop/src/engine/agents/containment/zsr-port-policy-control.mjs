import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const VERSION = 1;
const MAX_FRAME_BYTES = 4 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_PORTS = 256;
const AUTH_TIMEOUT_MS = 5_000;
const REQUEST_KEYS = [
  "generation",
  "operation",
  "ports",
  "token",
  "version",
];

function validToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function equalToken(candidate, expected) {
  if (!validToken(candidate)) return false;
  const decoded = Buffer.from(candidate, "base64url");
  return (
    decoded.length === expected.length && timingSafeEqual(decoded, expected)
  );
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function validPortList(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PORTS &&
    value.every(validPort) &&
    new Set(value).size === value.length &&
    value.every((port, index) => index === 0 || value[index - 1] < port)
  );
}

function assertPrivateParent(socketPath) {
  if (!path.isAbsolute(socketPath) || socketPath.includes("\0")) {
    throw new Error("port-policy socket path must be absolute");
  }
  const maximumBytes = process.platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(socketPath) > maximumBytes) {
    throw new Error("port-policy socket path exceeds the platform limit");
  }
  const parent = path.dirname(socketPath);
  const metadata = lstatSync(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(parent) !== parent ||
    (metadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("port-policy socket parent is not private");
  }
}

function removeStaleSocket(socketPath) {
  try {
    const metadata = lstatSync(socketPath);
    if (
      !metadata.isSocket() ||
      metadata.isSymbolicLink() ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new Error("port-policy socket path is occupied");
    }
    unlinkSync(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

export async function startZsrPortPolicyControl(options) {
  if (
    !options ||
    typeof options.generation !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(options.generation) ||
    !Buffer.isBuffer(options.token) ||
    options.token.length !== 32 ||
    !validPortList(options.staticPorts) ||
    !validPortList(options.deniedPorts) ||
    typeof options.onPorts !== "function"
  ) {
    throw new Error("invalid port-policy control options");
  }
  if (options.staticPorts.some((port) => options.deniedPorts.includes(port))) {
    throw new Error("static and denied port policies overlap");
  }
  assertPrivateParent(options.socketPath);
  removeStaleSocket(options.socketPath);
  const token = Buffer.from(options.token);
  const staticPorts = new Set(options.staticPorts);
  const deniedPorts = new Set(options.deniedPorts);
  const peers = new Set();
  let closed = false;
  let activeConnections = 0;
  const server = createServer((peer) => {
    if (closed || activeConnections >= MAX_CONNECTIONS) {
      peer.destroy();
      return;
    }
    activeConnections += 1;
    peers.add(peer);
    let frame = Buffer.alloc(0);
    let handled = false;
    peer.setTimeout(AUTH_TIMEOUT_MS, () => peer.destroy());
    peer.once("close", () => {
      peers.delete(peer);
      activeConnections = Math.max(0, activeConnections - 1);
    });
    peer.on("error", () => undefined);
    peer.on("data", (chunk) => {
      if (handled) return;
      frame = Buffer.concat([frame, chunk]);
      if (frame.length > MAX_FRAME_BYTES) {
        handled = true;
        peer.destroy();
        return;
      }
      const newline = frame.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      if (newline !== frame.length - 1) {
        peer.destroy();
        return;
      }
      let request;
      try {
        request = JSON.parse(frame.subarray(0, newline).toString("utf8"));
      } catch {
        peer.destroy();
        return;
      }
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join("\0") !== REQUEST_KEYS.join("\0") ||
        request.version !== VERSION ||
        request.operation !== "set-local-ports" ||
        request.generation !== options.generation ||
        !equalToken(request.token, token) ||
        !validPortList(request.ports) ||
        request.ports.some((port) => deniedPorts.has(port))
      ) {
        peer.destroy();
        return;
      }
      const effective = [...new Set([...staticPorts, ...request.ports])].sort(
        (left, right) => left - right,
      );
      try {
        options.onPorts(effective);
        peer.end("OK\n");
      } catch {
        peer.destroy();
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, resolve);
    });
    chmodSync(options.socketPath, 0o600);
    server.unref();
  } catch (error) {
    server.close();
    token.fill(0);
    throw error;
  }
  return {
    async close() {
      if (closed) return;
      closed = true;
      token.fill(0);
      for (const peer of peers) peer.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(options.socketPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}
