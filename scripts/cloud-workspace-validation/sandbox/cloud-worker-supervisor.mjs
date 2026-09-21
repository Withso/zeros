#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { CloudEngineCgroup } from "./cloud-engine-cgroup.mjs";
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUD_WORKER_SUPERVISOR_SOCKET =
  "/run/zeros/cloud-worker-supervisor.sock";
export const CLOUD_WORKER_SUPERVISOR_AUDIENCE =
  "zeros-cloud-worker-supervisor-v1";

const LAUNCHER = "/opt/zeros-runtime/bin/start-engine.sh";
const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 10_000;
const SESSION_PATTERN = /^zsp_[A-Za-z0-9_-]{43}$/;
const BRIDGE_TOKEN_PATTERN = /^zwb_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const READINESS_TOKEN_PATTERN = /^zwr_[A-Za-z0-9_-]{43}$/;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function safeString(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\0\r\n]/.test(value)
  );
}

function exactHttpsUrl(value, maximumBytes = 4_096) {
  if (!safeString(value, maximumBytes)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseRuntimeB64(encoded) {
  if (
    typeof encoded !== "string" ||
    encoded.length < 2 ||
    Buffer.byteLength(encoded, "utf8") > 96 * 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64url");
  try {
    if (
      decoded.length > 64 * 1024 ||
      decoded.toString("base64url") !== encoded
    ) {
      return null;
    }
    const value = JSON.parse(decoded.toString("utf8"));
    if (
      !isRecord(value) ||
      !exactKeys(value, [
        "audience",
        "engine",
        "execution",
        "registration",
        "version",
      ]) ||
      value.version !== 1 ||
      value.audience !== "zeros-cloud-engine-runtime-v1" ||
      !isRecord(value.execution) ||
      !exactKeys(value.execution, [
        "executionFence",
        "generation",
        "organizationId",
        "setupRunId",
        "workspaceId",
      ]) ||
      !UUID_PATTERN.test(value.execution.workspaceId ?? "") ||
      !UUID_PATTERN.test(value.execution.organizationId ?? "") ||
      !UUID_PATTERN.test(value.execution.setupRunId ?? "") ||
      !positiveInteger(value.execution.generation) ||
      !positiveInteger(value.execution.executionFence) ||
      !isRecord(value.engine) ||
      !exactKeys(value.engine, [
        "instanceId",
        "protocolVersion",
        "readinessProbeToken",
      ]) ||
      !UUID_PATTERN.test(value.engine.instanceId ?? "") ||
      !positiveInteger(value.engine.protocolVersion, 65_535) ||
      !READINESS_TOKEN_PATTERN.test(value.engine.readinessProbeToken ?? "") ||
      !isRecord(value.registration) ||
      !exactKeys(value.registration, ["endpoint", "expiresAtMs", "token"]) ||
      exactHttpsUrl(value.registration.endpoint) === null ||
      !SETUP_TOKEN_PATTERN.test(value.registration.token ?? "") ||
      !Number.isSafeInteger(value.registration.expiresAtMs)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  } finally {
    decoded.fill(0);
  }
}

function parseStartEnvironment(value) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "accountAudience",
      "accountClientId",
      "accountContract",
      "accountIssuers",
      "accountJwksUrl",
      "bridgeToken",
      "ownerSubject",
      "port",
      "runtimeB64",
    ]) ||
    !safeString(value.accountAudience, 512) ||
    !Array.isArray(value.accountIssuers) ||
    value.accountIssuers.length < 1 ||
    value.accountIssuers.length > 8 ||
    value.accountIssuers.some(
      (issuer) =>
        exactHttpsUrl(issuer) === null || String(issuer).includes(","),
    ) ||
    !(
      (value.accountContract === null && value.accountClientId === null) ||
      (value.accountContract === "zeros-access-v1" &&
        safeString(value.accountClientId, 512) &&
        value.accountIssuers.length === 1)
    ) ||
    exactHttpsUrl(value.accountJwksUrl) === null ||
    !BRIDGE_TOKEN_PATTERN.test(value.bridgeToken ?? "") ||
    !safeString(value.ownerSubject, 512) ||
    !positiveInteger(value.port, 65_535) ||
    value.port === 22_222
  ) {
    return null;
  }
  const runtime = parseRuntimeB64(value.runtimeB64);
  if (!runtime) return null;
  return {
    accountAudience: value.accountAudience,
    accountClientId: value.accountClientId,
    accountContract: value.accountContract,
    accountIssuers: [...value.accountIssuers],
    accountJwksUrl: exactHttpsUrl(value.accountJwksUrl),
    bridgeToken: value.bridgeToken,
    ownerSubject: value.ownerSubject,
    port: value.port,
    runtimeB64: value.runtimeB64,
    runtime,
  };
}

export function parseCloudWorkerSupervisorRequest(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.audience !== CLOUD_WORKER_SUPERVISOR_AUDIENCE ||
    !["status", "prepare", "start"].includes(value.operation)
  ) {
    return null;
  }
  if (value.operation === "prepare" || value.operation === "status") {
    return exactKeys(value, ["audience", "operation", "version"])
      ? {
          version: 1,
          audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
          operation: value.operation,
        }
      : null;
  }
  if (
    !exactKeys(value, [
      "audience",
      "environment",
      "operation",
      "session",
      "version",
    ]) ||
    !SESSION_PATTERN.test(value.session ?? "")
  ) {
    return null;
  }
  const environment = parseStartEnvironment(value.environment);
  return environment
    ? {
        version: 1,
        audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
        operation: "start",
        session: value.session,
        environment,
      }
    : null;
}

function supervisorResponse(outcome, extra = {}) {
  return {
    version: 1,
    audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
    outcome,
    ...extra,
  };
}

function childExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

export class CloudWorkerSupervisor {
  constructor({
    socketPath = CLOUD_WORKER_SUPERVISOR_SOCKET,
    launcher = LAUNCHER,
    spawnProcess = spawn,
    engineScope = null,
    setupScope = null,
  } = {}) {
    this.socketPath = socketPath;
    this.launcher = launcher;
    this.spawnProcess = spawnProcess;
    this.engineScope = engineScope;
    this.setupScope = setupScope;
    this.server = null;
    this.child = null;
    this.session = null;
    this.operation = Promise.resolve();
    this.stopping = false;
    this.lock = null;
  }

  async stopChild() {
    const child = this.child;
    let failure;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const signalGroup = (signal) => {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (error?.code !== "ESRCH") throw error;
          }
        };
        signalGroup("SIGTERM");
        if (!(await childExit(child, STOP_GRACE_MS))) {
          signalGroup("SIGKILL");
          if (!(await childExit(child, 5000)))
            throw new Error("Cloud engine launcher retirement is unconfirmed");
        }
      }
    } catch (error) {
      failure = error;
    }
    // A launcher exit is not evidence that a double-forked workload exited.
    // Version-2 images retain and drain the kernel scope even after a broker
    // restart loses its ChildProcess object. Failure cannot mint a new session.
    try {
      await this.engineScope?.retire();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.setupScope?.retire();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    if (this.child === child) this.child = null;
  }

  async launch(environment) {
    const child = this.spawnProcess(this.launcher, [], {
      cwd: "/",
      detached: true,
      stdio: "ignore",
      env: {
        HOME: "/root",
        LANG: "C.UTF-8",
        PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        ZEROS_ACCOUNT_JWT_AUD: environment.accountAudience,
        ...(environment.accountContract
          ? {
              ZEROS_ACCOUNT_JWT_CLIENT_ID: environment.accountClientId,
              ZEROS_ACCOUNT_JWT_CONTRACT: environment.accountContract,
            }
          : {}),
        ZEROS_ACCOUNT_JWT_ISS: environment.accountIssuers.join(","),
        ZEROS_ACCOUNT_JWT_JWKS_URL: environment.accountJwksUrl,
        ZEROS_CLOUD_OWNER_SUB: environment.ownerSubject,
        ZEROS_CLOUD_PORT: String(environment.port),
        ZEROS_CLOUD_RUNTIME_B64: environment.runtimeB64,
        ZEROS_CLOUD_SETUP_BOOT: "1",
        ZEROS_CLOUD_TOKEN: environment.bridgeToken,
        ZEROS_REQUIRE_ACCOUNT: "1",
      },
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    child.unref();
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    return child.pid;
  }

  async apply(request) {
    if (this.stopping) return supervisorResponse("rejected");
    if (request.operation === "status") return supervisorResponse("ready");
    if (request.operation === "prepare") {
      this.session = null;
      await this.stopChild();
      this.session = `zsp_${randomBytes(32).toString("base64url")}`;
      return supervisorResponse("prepared", { session: this.session });
    }
    if (!this.session || request.session !== this.session) {
      return supervisorResponse("rejected");
    }
    this.session = null;
    await this.stopChild();
    const pid = await this.launch(request.environment);
    return supervisorResponse("started", { pid });
  }

  enqueue(request) {
    const current = this.operation.then(() => this.apply(request));
    this.operation = current.catch(() => undefined);
    return current;
  }

  handle(socket) {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let source = "";
    let complete = false;
    const reject = () => {
      if (complete) return;
      complete = true;
      socket.end(`${JSON.stringify(supervisorResponse("rejected"))}\n`);
    };
    socket.on("timeout", reject);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (complete) return;
      source += chunk;
      if (Buffer.byteLength(source, "utf8") > MAX_REQUEST_BYTES) {
        reject();
        return;
      }
      const newline = source.indexOf("\n");
      if (newline === -1) return;
      if (
        newline !== source.length - 1 ||
        source.indexOf("\n", newline + 1) !== -1
      ) {
        reject();
        return;
      }
      let request;
      try {
        request = parseCloudWorkerSupervisorRequest(
          JSON.parse(source.slice(0, newline)),
        );
      } catch {
        request = null;
      }
      if (!request) {
        reject();
        return;
      }
      complete = true;
      this.enqueue(request).then(
        (response) => socket.end(`${JSON.stringify(response)}\n`),
        () => socket.end(`${JSON.stringify(supervisorResponse("failed"))}\n`),
      );
    });
    socket.on("end", () => {
      if (!complete) reject();
    });
  }

  async start() {
    if (this.server) throw new Error("cloud worker supervisor already started");
    const directory = path.dirname(this.socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryStat.uid !== 0 ||
      (directoryStat.mode & 0o077) !== 0 ||
      realpathSync(directory) !== directory
    ) {
      throw new Error("cloud worker supervisor directory is unsafe");
    }
    chmodSync(directory, 0o700);
    // Keep ownership for the complete broker lifetime. A competing resume
    // helper must never unlink a live socket, retire its engine, or take over
    // its one-use launch session. flock is released automatically on crash.
    const lock = openSync(
      `${this.socketPath}.lock`,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const metadata = fstatSync(lock);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== 0 ||
        metadata.mode & 0o077
      )
        throw new Error("cloud worker supervisor lock is unsafe");
      const acquired = spawnSync(
        "/usr/bin/flock",
        ["--exclusive", "--nonblock", "3"],
        {
          stdio: ["ignore", "ignore", "pipe", lock],
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          timeout: 5000,
          maxBuffer: 4096,
        },
      );
      if (acquired.status !== 0 || acquired.signal || acquired.error)
        throw new Error("cloud worker supervisor is already owned");
      this.lock = lock;
      await this.listen();
    } catch (error) {
      this.lock = null;
      closeSync(lock);
      throw error;
    }
  }

  async listen() {
    if (existsSync(this.socketPath)) {
      const existing = lstatSync(this.socketPath);
      if (
        !existing.isSocket() ||
        existing.isSymbolicLink() ||
        existing.uid !== 0
      ) {
        throw new Error("cloud worker supervisor socket is unsafe");
      }
      unlinkSync(this.socketPath);
    }
    const server = net.createServer((socket) => this.handle(socket));
    server.maxConnections = 8;
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
        this.server = server;
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.session = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await this.operation.catch(() => undefined);
    await this.stopChild();
    if (this.lock !== null) {
      try {
        if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      } finally {
        closeSync(this.lock);
        this.lock = null;
      }
    }
  }
}

async function main() {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) {
    throw new Error("cloud worker supervisor requires a root Linux runtime");
  }
  process.umask(0o077);
  const profile = readCloudHostRuntimeProfile();
  const supervisor = new CloudWorkerSupervisor({
    engineScope: profile.version >= 2 ? new CloudEngineCgroup() : null,
    setupScope:
      profile.version >= 2
        ? new CloudEngineCgroup({
            directory: "/sys/fs/cgroup/zeros-cloud-setup",
          })
        : null,
  });
  await supervisor.start();
  const shutdown = () => {
    supervisor.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch(() => {
    process.stderr.write("cloud worker supervisor failed\n");
    process.exitCode = 1;
  });
}
