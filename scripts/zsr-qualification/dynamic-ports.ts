import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { get } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ZsrExecutionBoundary } from "../../apps/desktop/src/engine/agents/containment/zsr-boundary";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function devServerSource(): string {
  return String.raw`
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const http = require("node:http");

const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/plain");
  response.end("zsr-dev-server");
});
server.on("upgrade", (request, socket) => {
  socket.on("error", () => {});
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
  );
  socket.write(Buffer.from([0x81, 0x03, 0x68, 0x6d, 0x72]));
});

function publish() {
  const address = server.address();
  const requestedPort = Number(process.env.ZSR_QUALIFICATION_REQUESTED_PORT || 0);
  process.stdout.write(JSON.stringify({
    type: "listening",
    port: address.port,
    requestedPort,
  }) + "\n");
  const rawPort = requestedPort || address.port;
  const raw = http.get({ host: "127.0.0.1", port: rawPort, path: "/raw" }, (response) => {
    let rawBody = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { rawBody += chunk; });
    response.once("end", () => process.stdout.write(JSON.stringify({
      type: "raw-self-connect",
      ok: response.statusCode === 200 && rawBody === "zsr-dev-server",
    }) + "\n"));
  });
  raw.once("error", () => process.stdout.write(JSON.stringify({
    type: "raw-self-connect",
    ok: false,
  }) + "\n"));

  const admitted = new Set(
    String(process.env.ZEROS_ZSR_MACOS_BIND_PORTS || "")
      .split(",")
      .filter(Boolean)
      .map(Number),
  );
  let unassigned = 32000;
  while (admitted.has(unassigned)) unassigned += 1;
  const bypassEnv = { ...process.env };
  for (const name of Object.keys(bypassEnv)) {
    if (name === "DYLD_INSERT_LIBRARIES" ||
        name === "DYLD_FORCE_FLAT_NAMESPACE" ||
        name.startsWith("ZEROS_ZSR_MACOS_")) delete bypassEnv[name];
  }
  const bypass = spawnSync(process.execPath, ["-e",
    "const n=require('node:net'),s=n.createServer();" +
    "s.once('error',()=>process.exit(0));" +
    "s.listen(" + unassigned + ",'127.0.0.1',()=>process.exit(3));" +
    "setTimeout(()=>process.exit(4),1500);",
  ], { env: bypassEnv, timeout: 3000 });
  process.stdout.write(JSON.stringify({
    type: "unassigned-bind-denied",
    ok: bypass.status === 0,
  }) + "\n");
  const deadline = Date.now() + 15000;
  const probe = () => {
    if (!process.env.HTTP_PROXY) {
      process.stdout.write(JSON.stringify({ type: "self-connect", ok: false }) + "\n");
      return;
    }
    const proxy = new URL(process.env.HTTP_PROXY);
    const authorization = "Basic " + Buffer.from(
      decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password),
    ).toString("base64");
    let body = "";
    let settled = false;
    let request;
    const attemptTimeout = setTimeout(() => {
      request?.destroy();
      complete(false);
    }, 1500);
    const complete = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(attemptTimeout);
      if (ok) {
        process.stdout.write(JSON.stringify({ type: "self-connect", ok: true }) + "\n");
      } else if (Date.now() < deadline) {
        setTimeout(probe, 200);
      } else {
        process.stdout.write(JSON.stringify({ type: "self-connect", ok: false }) + "\n");
      }
    };
    request = http.get({
      host: proxy.hostname,
      port: Number(proxy.port),
      path: "http://localhost:" + address.port + "/self",
      headers: { "proxy-authorization": authorization },
    }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.once("end", () => {
        complete(response.statusCode === 200 && body === "zsr-dev-server");
      });
    });
    process.stdout.write(JSON.stringify({ type: "probe-request" }) + "\n");
    request.setTimeout(1000, () => request.destroy(new Error("timeout")));
    request.once("error", () => complete(false));
  };
  probe();
}

server.once("error", (error) => {
  let map = "";
  let mapStat = null;
  let mapWritable = false;
  const mapOpenModes = {};
  try {
    const metadata = require("node:fs").statSync(
      process.env.ZEROS_ZSR_MACOS_PORT_MAP,
    );
    mapStat = {
      uid: metadata.uid,
      mode: metadata.mode & 0o777,
      links: metadata.nlink,
      self: process.getuid && process.getuid(),
    };
    map = require("node:fs").readFileSync(
      process.env.ZEROS_ZSR_MACOS_PORT_MAP,
      "utf8",
    );
    const fs = require("node:fs");
    for (const [name, flags] of [
      ["readWrite", fs.constants.O_RDWR],
      ["append", fs.constants.O_RDWR | fs.constants.O_APPEND],
      ["closeExec", fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CLOEXEC],
      ["noFollow", fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW],
    ]) {
      try {
        const descriptor = fs.openSync(process.env.ZEROS_ZSR_MACOS_PORT_MAP, flags);
        fs.closeSync(descriptor);
        mapOpenModes[name] = true;
      } catch (failure) {
        mapOpenModes[name] = failure && failure.code || false;
      }
    }
    mapWritable = mapOpenModes.closeExec === true;
  } catch {}
  process.stderr.write(JSON.stringify({
    error: String(error && error.message || error),
    bindPorts: process.env.ZEROS_ZSR_MACOS_BIND_PORTS || "",
    map,
    mapStat,
    mapWritable,
    mapOpenModes,
  }) + "\n");
  process.exit(1);
});
server.listen({
  host: "::",
  port: Number(process.env.ZSR_QUALIFICATION_REQUESTED_PORT || 0),
  ipv6Only: false,
}, publish);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`;
}

async function httpBody(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get({ host, port, path: "/" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.once("end", () => resolve(body));
    });
    request.setTimeout(5_000, () => request.destroy(new Error("HTTP timeout")));
    request.once("error", reject);
  });
}

async function websocketUpgrade(host: string, port: number): Promise<boolean> {
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let response = Buffer.alloc(0);
    const timer = setTimeout(
      () => socket.destroy(new Error("WebSocket timeout")),
      5_000,
    );
    socket.once("connect", () => {
      socket.write(
        `GET /hmr HTTP/1.1\r\nHost: localhost:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (!response.includes(Buffer.from("\r\n\r\n"))) return;
      clearTimeout(timer);
      const text = response.toString("latin1");
      const valid =
        text.startsWith("HTTP/1.1 101") &&
        text.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`);
      socket.end();
      resolve(valid);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitUntil<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out`);
}

async function run(): Promise<void> {
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error("dynamic port qualification requires macOS or Linux");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-ports-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  const boundary = new ZsrExecutionBoundary({
    projectRoot,
    supervisorScript: path.join(projectRoot, "binaries/zsr-supervisor.mjs"),
    networkBridgeScript: path.join(
      projectRoot,
      "binaries/zsr-network-bridge.mjs",
    ),
    macosProcessDomainHelper: path.join(
      projectRoot,
      "binaries/zsr-macos-process-domain",
    ),
  });
  let prepared: Awaited<ReturnType<typeof boundary.prepare>> | null = null;
  try {
    prepared = await boundary.prepare({
      executionId: "dynamic-port-qualification",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const events: Array<Record<string, unknown>> = [];
    const child = await prepared.spawn({
      command: process.execPath,
      args: ["-e", devServerSource()],
      cwd: workspace,
      env: {
        HOME: workspace,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stdio: "pipe",
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let childStderr = "";
    child.stderr?.on("data", (chunk: string) => {
      childStderr = (childStderr + chunk).slice(-2_000);
    });
    let pending = "";
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        events.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const targetPort = await waitUntil(() => {
      const event = events.find((entry) => entry.type === "listening");
      return typeof event?.port === "number" ? event.port : undefined;
    }, "random listener publication");
    const mapping = await waitUntil(
      () => prepared?.activePorts().find((entry) => entry.targetPort === targetPort),
      "automatic browser port mapping",
    );
    const body = await httpBody(mapping.host, mapping.port);
    const websocket = await websocketUpgrade(mapping.host, mapping.port);
    let selfConnect: boolean;
    try {
      selfConnect = await waitUntil(() => {
        const event = events.find((entry) => entry.type === "self-connect");
        return typeof event?.ok === "boolean" ? event.ok : undefined;
      }, "sandbox self-connect");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; event types: ` +
          JSON.stringify(events) +
          (childStderr
            ? `; child diagnostics: ${childStderr.replaceAll(root, "<root>")}`
            : ""),
      );
    }
    const rawSelfConnect = await waitUntil(() => {
      const event = events.find((entry) => entry.type === "raw-self-connect");
      return typeof event?.ok === "boolean" ? event.ok : undefined;
    }, "raw sandbox self-connect");
    const unassignedBindDenied = await waitUntil(() => {
      const event = events.find((entry) => entry.type === "unassigned-bind-denied");
      return typeof event?.ok === "boolean" ? event.ok : undefined;
    }, "unassigned kernel bind denial");

    const virtualEvents: Array<Record<string, unknown>> = [];
    const virtual = await prepared.spawn({
      command: process.execPath,
      args: ["-e", devServerSource()],
      cwd: workspace,
      env: {
        HOME: workspace,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ZSR_QUALIFICATION_REQUESTED_PORT: "5173",
      },
      stdio: "pipe",
    });
    let virtualPending = "";
    let virtualStderr = "";
    virtual.stdout?.setEncoding("utf8");
    virtual.stderr?.setEncoding("utf8");
    virtual.stderr?.on("data", (chunk: string) => {
      virtualStderr = (virtualStderr + chunk).slice(-2_000);
    });
    virtual.stdout?.on("data", (chunk: string) => {
      virtualPending += chunk;
      const lines = virtualPending.split("\n");
      virtualPending = lines.pop() ?? "";
      for (const line of lines) {
        if (line) virtualEvents.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    let virtualTargetPort: number;
    try {
      virtualTargetPort = await waitUntil(() => {
        const event = virtualEvents.find((entry) => entry.type === "listening");
        return typeof event?.port === "number" ? event.port : undefined;
      }, "explicit virtual listener publication");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; events: ` +
          JSON.stringify(virtualEvents) +
          (virtualStderr
            ? `; child diagnostics: ${virtualStderr.replaceAll(root, "<root>")}`
            : ""),
      );
    }
    const virtualMapping = await waitUntil(
      () =>
        prepared?.activePorts().find(
          (entry) => entry.targetPort === virtualTargetPort,
        ),
      "explicit virtual browser port mapping",
    );
    const virtualBody = await httpBody(virtualMapping.host, virtualMapping.port);
    const virtualRawSelfConnect = await waitUntil(() => {
      const event = virtualEvents.find(
        (entry) => entry.type === "raw-self-connect",
      );
      return typeof event?.ok === "boolean" ? event.ok : undefined;
    }, "explicit virtual raw self-connect");
    await prepared.stopAndProve();
    const mappingsRevoked = prepared.activePorts().length === 0;
    let reachableAfterRevoke = false;
    try {
      reachableAfterRevoke =
        (await httpBody(mapping.host, mapping.port)) === "zsr-dev-server";
    } catch {
      reachableAfterRevoke = false;
    }
    prepared = null;
    process.stdout.write(
      `${JSON.stringify({
        randomPort: true,
        mappedPort: mapping.port,
        targetPort,
        http: body === "zsr-dev-server",
        websocket,
        selfConnect,
        rawSelfConnect,
        unassignedBindDenied,
        explicitRequestedPort: 5173,
        explicitTargetPort: virtualTargetPort,
        explicitVirtualized:
          virtualTargetPort !== 5173 &&
          virtualBody === "zsr-dev-server" &&
          virtualRawSelfConnect,
        revoked: mappingsRevoked && !reachableAfterRevoke,
      })}\n`,
    );
  } finally {
    await prepared?.stopAndProve().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
