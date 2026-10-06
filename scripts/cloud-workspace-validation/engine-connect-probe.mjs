// Operator payload. No provider credentials or original engine authority enter
// this program. A serve probe is allowed only on the recorded disposable fork.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const CLOSE_REASONS = new Set([
  "CONNECTED required", "CONNECTED handler failed", "client authority expired",
  "client authority revoked", "client authority unavailable", "account binding required",
  "workspace operation denied", "protocol version mismatch", "message handler failed",
  "message queue limit", "pre-auth queue limit", "outbound buffer limit", "Engine shutting down",
]);
const ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE_ESM", "SQLITE_READONLY", "SQLITE_CANTOPEN"]);
const REJECTIONS = new Set(["auth-required", "auth-invalid", "auth-wrong-account", "desktop-unbound",
  "protocol-too-old", "protocol-too-new"]);
const LOG_PATTERNS = {
  browser_connected: /\[Zeros\] Browser connected/,
  cloud_listening: /\[Zeros cloud\] CloudTransport listening/,
  idle_observation: /\[Zeros cloud\].*idle.*quiet/i,
  idle_blocked: /idle_stop_blocked/,
  authority_lost: /cloud.*authority.*(?:lost|unavailable|rejected)/i,
  account_binding_failed: /relay account binding failed/,
  account_binding_required: /account binding required/,
  protocol_mismatch: /protocol version mismatch/,
  engine_error: /\[Zeros.*(?:error|failed)|Error:|TypeError:|ReferenceError:/i,
  permission_denied: /EACCES|EPERM|permission denied/i,
  database_readonly: /SQLITE_READONLY/,
  missing_file: /ENOENT/,
};
export function closeIdentity(code, reason) {
  const text = String(reason ?? "");
  return { code: Number.isInteger(code) && code >= 0 && code <= 4999 ? code : null,
    reason: CLOSE_REASONS.has(text) ? text : !text || text === "empty" ? "empty" : "other" };
}
export function summarizeEngineLog(input) {
  const lines = String(input).slice(-2 * 1024 * 1024).split("\n");
  const counts = Object.fromEntries(Object.keys(LOG_PATTERNS).map(key => [key, 0]));
  const events = [];
  for (let index = 0; index < lines.length; index++) {
    const kinds = Object.entries(LOG_PATTERNS).filter(([, pattern]) => pattern.test(lines[index])).map(([key]) => key);
    for (const kind of kinds) counts[kind]++;
    if (kinds.length) events.push({ line: index + 1, kinds });
  }
  return { lines: lines.length, counts, events: events.slice(-64) };
}
export function sanitizeEngineConnectProbe(value) {
  if (value?.schema !== "zeros.engine-connect-probe/v1") throw new Error("probe_invalid");
  const number = (value, maximum = 2 * 1024 * 1024) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  const log = value => ({ lines: number(value?.lines),
    counts: Object.fromEntries(Object.keys(LOG_PATTERNS).map(key => [key, number(value?.counts?.[key]) ?? 0])),
    events: Array.isArray(value?.events) ? value.events.slice(-64).map(event => ({ line: number(event?.line),
      kinds: Array.isArray(event?.kinds) ? Object.keys(LOG_PATTERNS).filter(kind => event.kinds.includes(kind)) : [] })) : [] });
  const socket = value => value ? {
    ...Object.fromEntries(["opened", "engineReady", "connectedSent", "workspaceResponse", "workspaceError"].map(key => [key, value[key] === true])),
    rejection: value.rejection === null ? null : REJECTIONS.has(value.rejection) ? value.rejection : "other",
    close: value.close ? closeIdentity(value.close.code, value.close.reason) : null,
    error: value.error === null ? null : ERROR_CODES.has(value.error) ? value.error : "socket_error",
    durationMs: number(value.durationMs, 180000),
  } : null;
  return { schema: value.schema, mode: value.mode === "isolated_serve" ? "isolated_serve" : "read_only",
    previousLog: { state: ["read", "absent", "unavailable"].includes(value.previousLog?.state) ? value.previousLog.state : "unavailable",
      truncated: value.previousLog?.truncated === true, ...log(value.previousLog) },
    serve: value.serve ? { ready: value.serve.ready === true, socket: socket(value.serve.socket),
      outOfOrderSocket: socket(value.serve.outOfOrderSocket),
      exitCode: number(value.serve.exitCode, 255), log: log(value.serve.log), authority: "synthetic_asymmetric_account" } : null,
    retired: value.retired === true,
    error: value.error ? { phase: ["runtime", "admission", "launch", "socket"].includes(value.error.phase) ? value.error.phase : "other",
      code: ERROR_CODES.has(value.error.code) ? value.error.code : "probe_failed" } : null,
    preconditions: ["production_actor_admission", "control_plane_relay", "provider_preview_transport"] };
}
function previousLog() {
  let fd;
  try {
    fd = fs.openSync("/srv/zeros/log/engine.log", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { state: "unavailable" };
    const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
    const length = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return { state: "read", truncated: stat.size > buffer.length, ...summarizeEngineLog(buffer.subarray(0, length)) };
  } catch (error) { return { state: error?.code === "ENOENT" ? "absent" : "unavailable" }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function probeEngineSocket(WebSocket, port, token, authToken, protocolVersion, timeoutMs = 15000, requestFirst = false) {
  const started = performance.now(), requestId = randomUUID();
  const result = { opened: false, engineReady: false, connectedSent: false, workspaceResponse: false,
    workspaceError: false, rejection: null, close: null, error: null, durationMs: 0 };
  await new Promise(resolve => {
    let finished = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { "x-zeros-cloud-token": token }, handshakeTimeout: timeoutMs,
      perMessageDeflate: false, maxPayload: 1024 * 1024,
    });
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      result.durationMs = Math.round(performance.now() - started);
      ws.terminate(); resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.on("open", () => {
      result.opened = true;
      const request = JSON.stringify({ id: requestId, type: "WORKSPACE_REQUEST", source: "browser", timestamp: Date.now(),
        op: "workspace.list", params: {} });
      if (requestFirst) ws.send(request);
      ws.send(JSON.stringify({ id: randomUUID(), type: "CONNECTED", source: "browser", timestamp: Date.now(),
        capabilities: [], protocolVersion, authToken }));
      result.connectedSent = true;
      if (!requestFirst) ws.send(request);
    });
    ws.on("message", data => {
      let value;
      try { value = JSON.parse(data.toString()); } catch { return; }
      if (value.type === "ENGINE_READY") result.engineReady = true;
      if (value.type === "CONNECTION_REJECTED") result.rejection = REJECTIONS.has(value.reason) ? value.reason : "other";
      if (value.requestId === requestId && ["WORKSPACE_RESPONSE", "WORKSPACE_ERROR"].includes(value.type)) {
        result.workspaceResponse = value.type === "WORKSPACE_RESPONSE";
        result.workspaceError = value.type === "WORKSPACE_ERROR";
        finish();
      }
    });
    ws.on("close", (code, reason) => { if (!finished) result.close = closeIdentity(code, reason); finish(); });
    ws.on("error", error => { if (finished) return; result.error = ERROR_CODES.has(error?.code) ? error.code : "socket_error"; finish(); });
  });
  return result;
}

export async function engineConnectProbe(material) {
  const report = { schema: "zeros.engine-connect-probe/v1", previousLog: previousLog(),
    mode: material.fork ? "isolated_serve" : "read_only", serve: null,
    preconditions: ["production_actor_admission", "control_plane_relay", "provider_preview_transport"] };
  if (!material.fork) return report;
  try { return await isolatedEngineProbe(material, report); }
  catch (error) {
    report.error = { phase: report.phase, code: ERROR_CODES.has(error?.code) ? error.code : "probe_failed" };
    return report;
  }
}

async function isolatedEngineProbe(material, report) {
  report.phase = "runtime";
  const node = fs.realpathSync("/opt/zeros/current/bin/node");
  if (!/^\/opt\/zeros-infra\/r1-[a-f0-9]{64}\/bin\/node$/.test(node)) throw new Error("runtime_invalid");
  const lib = node.slice(0, -9) + "/lib/zeros";
  const { resolveCloudRuntime } = await import(pathToFileURL(`${lib}/cloud-runtime-root.mjs`));
  const runtime = resolveCloudRuntime();
  if (runtime.runtimeId !== material.runtimeId) throw new Error("runtime_invalid");
  const execution = { workspaceId: material.workspaceId, organizationId: material.organizationId,
    generation: material.generation, setupRunId: randomUUID(), executionFence: 1 };
  const engine = { instanceId: randomUUID() };
  report.phase = "admission";
  if (material.computer) {
    const { createCloudComputerWorkspaceAdmission } = await import(pathToFileURL(`${lib}/cloud-computer-checkout.mjs`));
    const admission = createCloudComputerWorkspaceAdmission({ execution, engine, computer: material.computer, repository: material.repository }, runtime);
    const file = "/run/zeros/computer-workspace.json";
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, JSON.stringify(admission), { flag: "wx", mode: 0o600 });
  }
  const { launchCloudEngine } = await import(pathToFileURL(`${lib}/cloud-engine-launcher.mjs`));
  report.phase = "launch";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = randomBytes(32).toString("base64url"), owner = randomUUID(), port = 41419;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: owner, aud: "zeros-v2-test-engine-connect",
    iss: "zeros-v2-test-engine-connect", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
  const authToken = `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url")}`;
  const signals = new EventEmitter();
  let child, output = "", exit = null, launchFailed = false;
  const source = { ZEROS_CLOUD_RUNTIME_B64: Buffer.from(JSON.stringify({ execution, engine })).toString("base64url"),
    ZEROS_CLOUD_PORT: String(port), ZEROS_CLOUD_TOKEN: token, ZEROS_CLOUD_OWNER_SUB: owner,
    ZEROS_REQUIRE_ACCOUNT: "1", ZEROS_ACCOUNT_JWT_AUD: "zeros-v2-test-engine-connect",
    ZEROS_ACCOUNT_JWT_ISS: "zeros-v2-test-engine-connect" };
  const launched = launchCloudEngine({ runtime, source, signals, spawnProcess(file, args, options) {
    // The fork has no control-plane authority. Keep the real view, cgroup and
    // asymmetric account gate; use a fresh in-memory test key, never a live JWT.
    const env = { ...options.env, ZEROS_ACCOUNT_JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }) };
    delete env.ZEROS_CLOUD_RUNTIME_B64;
    child = spawn(file, args, { ...options, env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes.toString()).slice(-2 * 1024 * 1024); });
    return child;
  } }).then(code => { exit = code; }, () => { exit = 125; launchFailed = true; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120 && exit === null; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        ready = response.ok && (await response.json()).transport === "cloud";
        if (ready) break;
      } catch { /* The private engine may still be starting. */ }
      await pause(500);
    }
    const WebSocket = createRequire(`${runtime.workerRoot}/package.json`)("ws");
    report.phase = "socket";
    report.serve = { ready, socket: ready ? await probeEngineSocket(WebSocket, port, token, authToken, material.protocolVersion) : null,
      outOfOrderSocket: ready ? await probeEngineSocket(WebSocket, port, token, authToken, material.protocolVersion, 15000, true) : null,
      exitCode: exit, log: summarizeEngineLog(output), authority: "synthetic_asymmetric_account" };
  } finally {
    signals.emit("SIGTERM");
    await launched;
    report.retired = !launchFailed;
  }
  return report;
}
