#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { CloudEngineCgroup, CloudDelegatedCgroups } from "./cloud-engine-cgroup.mjs";
import { cloudActiveRuntimeDescriptor, parseCloudActiveRuntime, resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUD_WORKER_SUPERVISOR_SOCKET =
  "/run/zeros/cloud-worker-supervisor.sock";
export const CLOUD_WORKER_SUPERVISOR_AUDIENCE =
  "zeros-cloud-worker-supervisor-v1";

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

function parseResidentFence(value, source = false) {
  return isRecord(value) && exactKeys(value, source ? ["hostId", "engineId", "fence"] : ["hostId", "fence"]) &&
    UUID_PATTERN.test(value.hostId ?? "") && (!source || UUID_PATTERN.test(value.engineId ?? "")) &&
    positiveInteger(value.fence) ? { ...value } : null;
}

export function parseCloudWorkerSupervisorRequest(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.audience !== CLOUD_WORKER_SUPERVISOR_AUDIENCE ||
    !["status", "update-status", "resident-status", "prepare", "start", "select-runtime"].includes(value.operation)
  ) {
    return null;
  }
  if (value.operation === "prepare" && Object.hasOwn(value, "resident")) {
    const resident = parseResidentFence(value.resident, true);
    return resident && exactKeys(value, ["audience", "operation", "resident", "version"]) ? { ...value, resident } : null;
  }
  if (["prepare", "status", "update-status", "resident-status"].includes(value.operation)) {
    return exactKeys(value, ["audience", "operation", "version"])
      ? {
          version: 1,
          audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
          operation: value.operation,
        }
      : null;
  }
  if (value.operation === "select-runtime") {
    if (!exactKeys(value, ["audience", "active", "operation", "session", "version"]) ||
      !SESSION_PATTERN.test(value.session ?? "")) return null;
    try { return { ...value, active: parseCloudActiveRuntime(value.active) }; }
    catch { return null; }
  }
  if (
    !exactKeys(value, [
      "audience",
      "environment",
      "operation",
      "session",
      "version",
      ...(Object.hasOwn(value, "resident") ? ["resident"] : []),
    ]) ||
    !SESSION_PATTERN.test(value.session ?? "")
  ) {
    return null;
  }
  const environment = parseStartEnvironment(value.environment);
  const resident = Object.hasOwn(value, "resident") ? parseResidentFence(value.resident) : undefined;
  return environment && resident !== null
    ? {
        version: 1,
        audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
        operation: "start",
        session: value.session,
        environment,
        ...(resident ? { resident } : {}),
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

function rejectSupervisorRequest() {
  return supervisorResponse("rejected");
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

// Reuse the protected installer on the physical host. Do not override the
// ordinary runtime resolver's pinned-executable check: this supervisor remains
// controller H while it launches engine T. The adapter already hashed T; this
// independent check also prevents a root caller selecting an unverified tree.
const VERIFY_SELECTED_RUNTIME = `
import importlib.util,json,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('bootstrap','/opt/zeros-bootstrap/bootstrap.py')
b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
try:
 a=b.Bootstrap();a.base();a.require_persistence()
 expected=b.strict_json(sys.stdin.buffer.read(4097),'input_schema')
 active=b.strict_json(a.read(b.ACTIVE,4096,0o600),'input_schema')
 _,receipt=a.verify_runtime(a.current(),full=True)
 installed=b.strict_json(receipt,'cache_conflict')
 b.text_match(active['supervisorSessionId'],b.UUID,'input_schema')
 verified={'schema':'zeros.active-runtime/v1','runtimeId':installed['runtimeId'],
  'manifestSha256':installed['manifestSha256'],'root':b.INFRA+'/'+installed['runtimeId'],
  'baseCompatibilityId':a.compat_id,'installerReceiptSha256':b.sha(receipt),
  'bootId':a.boot_id(),'cgroupRoot':b.CGROUP,'supervisorSessionId':active['supervisorSessionId']}
 b.require(active==verified and expected==verified,'input_schema')
 print(json.dumps(verified,separators=(',',':')))
except Exception:
 sys.exit(1)
`;

export function verifySelectedCloudRuntime(expected) {
  if (process.platform !== "linux" || process.geteuid?.() !== 0)
    throw new Error("Cloud runtime selection requires the root host");
  const active = parseCloudActiveRuntime(expected);
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", VERIFY_SELECTED_RUNTIME], {
    input: JSON.stringify(active), encoding: "utf8", timeout: 90_000, maxBuffer: 8192,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || result.signal)
    throw new Error("Cloud runtime selection verification failed");
  const verified = parseCloudActiveRuntime(JSON.parse(result.stdout));
  if (Object.keys(active).some(key => active[key] !== verified[key]))
    throw new Error("Cloud runtime selection changed");
  return verified;
}

export class CloudWorkerSupervisor {
  #handlers;

  constructor({
    socketPath = CLOUD_WORKER_SUPERVISOR_SOCKET,
    runtime = resolveCloudRuntime(),
    launcher = runtime.startEngine,
    spawnProcess = spawn,
    engineScope = null,
    setupScope = null,
    verifySelectedRuntime = verifySelectedCloudRuntime,
    // Legacy images retain their closed helper inventory. This v4-only entry
    // is part of the immutable runtime bundle, loaded only for explicit opt-in.
    createResident = async options => new (await import("./cloud-resident-workload.mjs")).CloudResidentWorkload(options),
  } = {}) {
    this.socketPath = socketPath;
    this.runtime = runtime;
    this.launcher = launcher;
    this.spawnProcess = spawnProcess;
    this.engineScope = engineScope;
    this.setupScope = setupScope;
    this.verifySelectedRuntime = verifySelectedRuntime;
    this.createResident = createResident;
    this.resident = null;
    this.preparedResident = null;
    this.selectedRuntime = runtime.profile === "v4" ? cloudActiveRuntimeDescriptor(runtime) : null;
    this.binRoot = runtime.binRoot;
    this.server = null;
    this.child = null;
    this.session = null;
    this.operation = Promise.resolve();
    this.stopping = false;
    this.lock = null;
    this.#handlers = Object.freeze(new Map([
      ["status", this.#status.bind(this)],
      ["update-status", this.#updateStatus.bind(this)],
      ["resident-status", this.#residentStatus.bind(this)],
      ["prepare", this.#prepare.bind(this)],
      ["start", this.#startRuntime.bind(this)],
      ["select-runtime", this.#selectRuntime.bind(this)],
    ]));
  }

  async stopChild({ preserveWorkload } = {}) {
    if (preserveWorkload !== undefined) {
      const witness = await this.resident?.witness();
      if (this.runtime.profile !== "v4" || witness?.hostId !== preserveWorkload || witness.engineId !== null)
        throw new Error("Resident workload preservation was not confirmed");
    }
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
      if (preserveWorkload === undefined) {
        await this.resident?.stop();
        this.resident = null;
      }
    } catch (error) {
      failure ??= error;
    }
    try {
      if (preserveWorkload === undefined) await this.engineScope?.retire();
      else await this.engineScope?.retire({ preserveWorkload });
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
        PATH: `${this.binRoot}:/usr/bin:/bin:/usr/sbin:/sbin`,
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
        ...(environment.residentB64 ? { ZEROS_RESIDENT_PTY_B64: environment.residentB64 } : {}),
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
    if (this.stopping) return rejectSupervisorRequest();
    return (this.#handlers.get(request?.operation) ?? rejectSupervisorRequest)(request);
  }

  #sessionMatches(candidate) {
    if (!this.session || typeof candidate !== "string") return false;
    const expected = Buffer.from(this.session, "utf8");
    const supplied = Buffer.from(candidate, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  #status() {
    return supervisorResponse("ready");
  }

  #updateStatus() {
    return this.runtime.profile === "v4"
      ? supervisorResponse("ready", { controller: cloudActiveRuntimeDescriptor(this.runtime), selected: this.selectedRuntime })
      : supervisorResponse("rejected");
  }

  async #residentStatus() {
    if (this.runtime.profile !== "v4") return rejectSupervisorRequest();
    return supervisorResponse("ready", { resident: this.resident ? await this.resident.witness() : null });
  }

  async #prepare(request) {
    let resident = null;
    if (request.resident) {
      if (this.runtime.profile !== "v4" || !this.resident) return rejectSupervisorRequest();
      await this.resident.witness();
      resident = await this.resident.detach(request.resident);
    }
    this.session = null;
    this.preparedResident = null;
    await this.stopChild(resident ? { preserveWorkload: resident.hostId } : undefined);
    this.preparedResident = resident;
    this.session = `zsp_${randomBytes(32).toString("base64url")}`;
    return supervisorResponse("prepared", { session: this.session, ...(resident ? { resident } : {}) });
  }

  #selectRuntime(request) {
    if (!this.#sessionMatches(request.session)) return rejectSupervisorRequest();
    if (this.runtime.profile !== "v4" || this.child) return rejectSupervisorRequest();
    const active = this.verifySelectedRuntime(request.active);
    if (["baseCompatibilityId", "bootId", "cgroupRoot"].some(key => active[key] !== this.runtime[key]))
      return rejectSupervisorRequest();
    this.selectedRuntime = active;
    this.binRoot = `${active.root}/bin`;
    this.launcher = `${this.binRoot}/start-engine.sh`;
    return supervisorResponse("selected");
  }

  async #startRuntime(request) {
    if (!this.#sessionMatches(request.session)) return rejectSupervisorRequest();
    const retained = this.preparedResident;
    const requested = request.resident;
    const execution = request.environment?.runtime?.execution;
    if (retained && (!requested || requested.hostId !== retained.hostId || requested.fence <= retained.fence ||
      execution?.workspaceId !== retained.workspaceId || execution?.organizationId !== retained.organizationId))
      return rejectSupervisorRequest();
    if (requested && this.runtime.profile !== "v4") return rejectSupervisorRequest();
    this.session = null;
    this.preparedResident = null;
    await this.stopChild(retained ? { preserveWorkload: retained.hostId } : undefined);
    let environment = request.environment;
    if (requested) {
      if (!this.resident) {
        const active = this.verifySelectedRuntime(this.selectedRuntime);
        if (Object.keys(this.selectedRuntime).some(key => active[key] !== this.selectedRuntime[key]))
          throw new Error("Resident runtime selection changed");
        this.resident = await this.createResident({ runtime: { ...active, profile: "v4",
          node: `${active.root}/bin/node`, libRoot: `${active.root}/lib/zeros` },
          hostId: requested.hostId, organizationId: execution.organizationId, workspaceId: execution.workspaceId });
        await this.resident.start(environment.runtimeB64);
      }
      const authority = { organizationId: execution.organizationId, workspaceId: execution.workspaceId,
        engineId: environment.runtime.engine.instanceId, generation: execution.generation,
        fence: requested.fence, token: randomBytes(32).toString("base64url") };
      await this.resident.enroll(authority);
      environment = { ...environment, residentB64: Buffer.from(JSON.stringify({
        protocol: "zeros.resident-pty/v1", hostId: requested.hostId, authority,
      })).toString("base64url") };
    }
    const pid = await this.launch(environment);
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
      if (request.operation === "select-runtime") socket.setTimeout(100_000);
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
      // A restarted systemd host begins idle only after the previous kernel
      // workload set is proven empty, including launchers it never observed.
      if (this.runtime.profile === "v4") await this.stopChild();
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
  const runtime = resolveCloudRuntime();
  const delegated = runtime.profile === "v4" ? new CloudDelegatedCgroups({runtime}) : null;
  if (delegated) {
    if (process.argv.length !== 2) throw new Error("Cloud systemd host takes no arguments");
    delegated.prepareHost();
  }
  const supervisor = new CloudWorkerSupervisor({
    runtime,
    engineScope: delegated ?? (profile.version >= 2 ? new CloudEngineCgroup({runtime}) : null),
    setupScope:
      profile.version >= 2 && !delegated
        ? new CloudEngineCgroup({runtime, kind:"setup"})
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
