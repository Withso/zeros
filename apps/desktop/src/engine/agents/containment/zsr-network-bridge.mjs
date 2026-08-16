#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";

const CONFIG_VERSION = 1;
const MAX_FRAME_BYTES = 4 * 1024;
const MAX_CONNECTIONS = 256;
const MAX_DISCOVERED_LISTENERS = 256;
const AUTH_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;

function fail(message) {
  process.stderr.write(`[zsr-network-bridge] ${message}\n`);
  process.exitCode = 125;
}

function ownedPrivateRegularFile(file, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} path must be absolute`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be one regular, unlinked file`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad`);
  }
  if (realpathSync(file) !== file) {
    throw new Error(`${label} path is not canonical`);
  }
}

function ownedPrivateDirectory(directory, label) {
  if (!path.isAbsolute(directory)) {
    throw new Error(`${label} path must be absolute`);
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad`);
  }
  if (realpathSync(directory) !== directory) {
    throw new Error(`${label} path is not canonical`);
  }
}

function validToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function validPortList(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DISCOVERED_LISTENERS &&
    value.every(validPort) &&
    new Set(value).size === value.length
  );
}

function equalToken(left, right) {
  if (!validToken(left) || !validToken(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function readConfig(configPath) {
  ownedPrivateRegularFile(configPath, "bridge descriptor");
  const value = JSON.parse(readFileSync(configPath, "utf8"));
  if (!value || value.version !== CONFIG_VERSION) {
    throw new Error("unsupported bridge descriptor version");
  }
  if (!validToken(value.token)) throw new Error("invalid bridge token");
  if (
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.generation)
  ) {
    throw new Error("invalid bridge generation");
  }
  if (
    !path.isAbsolute(value.reverseSocketPath) ||
    value.reverseSocketPath.includes("\0")
  ) {
    throw new Error("invalid reverse bridge socket path");
  }
  const parent = path.dirname(value.reverseSocketPath);
  ownedPrivateDirectory(parent, "reverse bridge parent");
  if (path.dirname(value.reverseSocketPath) !== parent) {
    throw new Error("invalid reverse bridge socket parent");
  }
  if (!validPortList(value.localTcpPorts)) {
    throw new Error("invalid local TCP bridge ports");
  }
  if (
    value.ignoredTcpPorts !== undefined &&
    !validPortList(value.ignoredTcpPorts)
  ) {
    throw new Error("invalid ignored TCP listener ports");
  }
  value.ignoredTcpPorts ??= [];
  if (value.localTcpPorts.length > 0) {
    if (
      !path.isAbsolute(value.serviceSocketPath) ||
      value.serviceSocketPath.includes("\0")
    ) {
      throw new Error("invalid local TCP service socket path");
    }
    const serviceParent = path.dirname(value.serviceSocketPath);
    ownedPrivateDirectory(serviceParent, "local TCP service parent");
    const serviceStat = lstatSync(value.serviceSocketPath);
    if (!serviceStat.isSocket() || serviceStat.isSymbolicLink()) {
      throw new Error("local TCP service endpoint is not a socket");
    }
    if (
      typeof process.getuid === "function" &&
      serviceStat.uid !== process.getuid()
    ) {
      throw new Error("local TCP service endpoint has the wrong owner");
    }
  }
  return value;
}

function removeStaleSocket(socketPath) {
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink()) {
      throw new Error("reverse bridge path is occupied by a non-socket");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("stale reverse bridge socket has the wrong owner");
    }
    unlinkSync(socketPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function validAuthenticatedRequest(value, config) {
  return (
    value &&
    value.version === CONFIG_VERSION &&
    value.generation === config.generation &&
    equalToken(value.token, config.token)
  );
}

function tcpListeners(config) {
  const ignored = new Set([
    ...config.localTcpPorts,
    ...config.ignoredTcpPorts,
  ]);
  const listeners = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch (error) {
      if (file.endsWith("tcp6") && error?.code === "ENOENT") continue;
      throw error;
    }
    for (const line of contents.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== "0A") continue;
      const separator = fields[1]?.lastIndexOf(":") ?? -1;
      if (separator < 0) continue;
      const encoded = fields[1].slice(separator + 1);
      if (!/^[0-9A-Fa-f]{4}$/.test(encoded)) continue;
      const port = Number.parseInt(encoded, 16);
      if (!validPort(port) || ignored.has(port)) continue;
      listeners.add(port);
      if (listeners.size > MAX_DISCOVERED_LISTENERS) {
        throw new Error("too many TCP listeners in session namespace");
      }
    }
  }
  return [...listeners].sort((left, right) => left - right);
}

async function connectLoopback(port) {
  let firstError;
  for (const host of ["127.0.0.1", "::1"]) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const fail = (error) => {
          clearTimeout(timeout);
          socket.destroy();
          reject(error);
        };
        const timeout = setTimeout(
          () => fail(new Error("TCP target connection timed out")),
          CONNECT_TIMEOUT_MS,
        );
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
  throw firstError ?? new Error("TCP target is unavailable");
}

async function run() {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : null;
  if (!configPath) throw new Error("missing --config descriptor");
  const config = readConfig(configPath);
  // The token is consumed into this hidden bridge process before untrusted
  // code starts. Removing the file also prevents replay by a later launch.
  unlinkSync(configPath);
  removeStaleSocket(config.reverseSocketPath);

  let activeConnections = 0;
  const peers = new Set();
  const localServers = new Set();

  const listenLocalTcp = async (local, port) => {
    try {
      await new Promise((resolve, reject) => {
        local.once("error", reject);
        local.listen({ host: "::", port, ipv6Only: false }, resolve);
      });
    } catch (error) {
      if (
        !error ||
        !["EAFNOSUPPORT", "EADDRNOTAVAIL", "EINVAL"].includes(error.code)
      ) {
        throw error;
      }
      local.removeAllListeners("error");
      await new Promise((resolve, reject) => {
        local.once("error", reject);
        local.listen({ host: "127.0.0.1", port }, resolve);
      });
    }
  };

  const forwardLocalTcp = (client, port) => {
    if (activeConnections >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    activeConnections += 1;
    peers.add(client);
    client.pause();
    client.once("close", () => {
      peers.delete(client);
      activeConnections = Math.max(0, activeConnections - 1);
    });
    client.on("error", () => undefined);
    const service = connect(config.serviceSocketPath);
    peers.add(service);
    let response = Buffer.alloc(0);
    let authenticated = false;
    const destroyBoth = () => {
      client.destroy();
      service.destroy();
    };
    service.setTimeout(CONNECT_TIMEOUT_MS, destroyBoth);
    service.once("error", destroyBoth);
    service.once("close", () => {
      peers.delete(service);
      client.destroy();
    });
    client.once("close", () => service.destroy());
    service.once("connect", () => {
      service.write(
        `${JSON.stringify({
          version: CONFIG_VERSION,
          operation: "connect-local-tcp",
          generation: config.generation,
          token: config.token,
          port,
        })}\n`,
      );
    });
    service.on("data", (chunk) => {
      if (authenticated) return;
      response = Buffer.concat([response, chunk]);
      if (response.length > 64) {
        destroyBoth();
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      if (
        newline !== response.length - 1 ||
        response.subarray(0, newline).toString("utf8") !== "OK"
      ) {
        destroyBoth();
        return;
      }
      authenticated = true;
      service.removeAllListeners("data");
      service.setTimeout(0);
      client.pipe(service);
      service.pipe(client);
      client.resume();
    });
  };

  for (const port of config.localTcpPorts) {
    const local = createServer({ pauseOnConnect: true }, (client) =>
      forwardLocalTcp(client, port),
    );
    await listenLocalTcp(local, port);
    localServers.add(local);
  }
  const server = createServer({ pauseOnConnect: true }, (client) => {
    if (activeConnections >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    activeConnections += 1;
    peers.add(client);
    let frame = Buffer.alloc(0);
    let authenticated = false;
    const finish = () => {
      peers.delete(client);
      activeConnections = Math.max(0, activeConnections - 1);
    };
    client.once("close", finish);
    client.setTimeout(AUTH_TIMEOUT_MS, () => client.destroy());
    client.on("error", () => undefined);
    client.on("data", (chunk) => {
      if (authenticated) return;
      frame = Buffer.concat([frame, chunk]);
      if (frame.length > MAX_FRAME_BYTES) {
        client.destroy();
        return;
      }
      const newline = frame.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== frame.length - 1) {
        client.destroy();
        return;
      }
      let request;
      try {
        request = JSON.parse(frame.subarray(0, newline).toString("utf8"));
      } catch {
        client.destroy();
        return;
      }
      if (!validAuthenticatedRequest(request, config)) {
        client.destroy();
        return;
      }
      authenticated = true;
      client.pause();
      client.removeAllListeners("data");
      client.setTimeout(0);
      if (request.operation === "list-tcp-listeners") {
        try {
          client.end(
            `${JSON.stringify({
              version: CONFIG_VERSION,
              listeners: tcpListeners(config),
            })}\n`,
          );
        } catch {
          client.destroy();
        }
        return;
      }
      if (request.operation !== "connect-tcp" || !validPort(request.port)) {
        client.destroy();
        return;
      }
      void connectLoopback(request.port)
        .then((target) => {
          if (client.destroyed) {
            target.destroy();
            return;
          }
          peers.add(target);
          target.once("close", () => peers.delete(target));
          target.once("error", () => client.destroy());
          client.once("close", () => target.destroy());
          client.write("OK\n");
          client.pipe(target);
          target.pipe(client);
          client.resume();
        })
        .catch(() => client.destroy());
    });
    client.resume();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.reverseSocketPath, resolve);
  });
  chmodSync(config.reverseSocketPath, 0o600);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    for (const peer of peers) peer.destroy();
    for (const local of localServers) local.close();
    server.close(() => {
      try {
        unlinkSync(config.reverseSocketPath);
      } catch {
        // The mount namespace is already disappearing or the socket vanished.
      }
      process.exit(0);
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  process.once("SIGHUP", close);
}

await run().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
