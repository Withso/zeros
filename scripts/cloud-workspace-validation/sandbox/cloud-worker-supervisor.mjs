#!/usr/bin/env node

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { ensureCloudHostRuntimeDirectory, readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import { readCloudRootControllerRecord, readCloudRootProcessBirth } from "./publish-cloud-workload-custody.mjs";
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
const FINAL_REASONS = new Set(["before_stop", "before_archive", "before_delete", "before_rebuild"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const isUuid = value => typeof value === "string" && UUID_PATTERN.test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

function immutable(value) {
  const copy = globalThis.structuredClone(value);
  const freeze = item => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

/** The matched engine response is evidence only for the original root-owned
 * scope and this fresh read. Neither process exit nor an upload is a commit. */
export function parseCloudEngineFinalCompletion(value, { challenge, scope }) {
  if (!isUuid(challenge) || !isRecord(value) ||
      !exactKeys(value, ["version", "challenge", "phase", "scope", "mode", "checkpoint", "seal"]) ||
      value.version !== 1 || value.challenge !== challenge || value.phase !== "committed" ||
      !["legacy", "boot-owner-v1"].includes(value.mode) || !isRecord(value.scope) ||
      !exactKeys(value.scope, ["organizationId", "workspaceId", "generation", "engineInstanceId"]) ||
      !["organizationId", "workspaceId", "engineInstanceId"].every(key => isUuid(value.scope[key])) ||
      !positiveInteger(value.scope.generation) ||
      Object.keys(value.scope).some(key => value.scope[key] !== scope?.[key])) return null;
  const checkpoint = value.checkpoint;
  if (!isRecord(checkpoint) || !exactKeys(checkpoint, ["requestId", "checkpointId", "contentRevision", "manifestSha256", "reason"]) ||
      !isUuid(checkpoint.requestId) || !isUuid(checkpoint.checkpointId) || !nonnegative(checkpoint.contentRevision) ||
      typeof checkpoint.manifestSha256 !== "string" || !HASH_PATTERN.test(checkpoint.manifestSha256) ||
      !FINAL_REASONS.has(checkpoint.reason)) return null;
  if (value.mode === "legacy") {
    if (value.seal !== null) return null;
  } else {
    const seal = value.seal;
    if (!isRecord(seal) || !exactKeys(seal, ["writerEpoch", "sealId", "sha256", "inventorySha256", "sequence", "recordSequence", "eventSequence"]) ||
        !isUuid(seal.writerEpoch) || !isUuid(seal.sealId) ||
        !["sha256", "inventorySha256"].every(key => typeof seal[key] === "string" && HASH_PATTERN.test(seal[key])) ||
        !["sequence", "recordSequence", "eventSequence"].every(key => nonnegative(seal[key]))) return null;
  }
  return immutable(value);
}

/** Only the original admitted loopback endpoint and lifecycle token are used.
 * This passive GET does not ask the engine or CP to create a checkpoint. */
export async function requestCloudEngineFinalCompletion(endpoint, challenge) {
  if (!positiveInteger(endpoint?.port, 65535) || !READINESS_TOKEN_PATTERN.test(endpoint?.token ?? "") || !isUuid(challenge))
    throw new Error("Cloud engine final completion unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/internal/final-completion`, {
      method: "GET", redirect: "error", cache: "no-store", signal: globalThis.AbortSignal.timeout(25_000),
      headers: { "x-zeros-readiness-token": endpoint.token, "x-zeros-final-challenge": challenge },
    });
    if (response.status !== 200 || !response.body) throw new Error();
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4096) { await response.body.cancel().catch(() => undefined); throw new Error(); }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("Cloud engine final completion unavailable"); }
}

function readEngineCustody({ runtime, engineId, owner, episode }) {
  const scope = new CloudEngineCgroup({ runtime, instanceId: engineId }).currentIdentity;
  return readCloudRootControllerRecord({ runtime, scope, owner, episode });
}

async function createLegacyResidentControl(options) {
  // The supervisor starts before setup on a cold VM. Use setup's original
  // directory authority so the engine can traverse its private socket view.
  const profile = ensureCloudHostRuntimeDirectory({ version: 4, profile: "zeros-cloud-worker-v4" });
  const directory = profile.runtimeDirectory;
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== profile.engineUid ||
      metadata.gid !== profile.engineGid || (metadata.mode & 0o7777) !== 0o700 || realpathSync(directory) !== directory)
    throw new Error("Cloud legacy control directory is unsafe");
  return new (await import("./cloud-resident-control.mjs")).CloudLegacyResidentControl(options);
}

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

const HANDOFF_KEYS = ["challenge", "engineInstanceId", "expiresAtMs", "fence", "generation", "hostId", "organizationId", "workspaceId"];
function parseHandoff(value) {
  return isRecord(value) && exactKeys(value, HANDOFF_KEYS) &&
    ["challenge", "engineInstanceId", "hostId", "organizationId", "workspaceId"].every(key => UUID_PATTERN.test(value[key] ?? "")) &&
    ["generation", "fence", "expiresAtMs"].every(key => positiveInteger(value[key])) ? { ...value } : null;
}
const sameHandoff = (left, right) => !!parseHandoff(left) && !!parseHandoff(right) && HANDOFF_KEYS.every(key => left[key] === right[key]);

/** The source port and credential come only from root's admitted start frame.
 * Neither a control-plane request nor a user process selects a destination. */
export async function requestCloudEngineHandoff(endpoint, command) {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/internal/runtime-handoff`, {
      method: "POST", redirect: "error", signal: globalThis.AbortSignal.timeout(25_000),
      headers: { "content-type": "application/json", "x-zeros-readiness-token": endpoint.token },
      body: JSON.stringify(command),
    });
    if (response.status !== 200 || !response.body) throw new Error();
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 4096) throw new Error(); chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("Cloud runtime handoff unavailable"); }
}

export function parseCloudWorkerSupervisorRequest(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.audience !== CLOUD_WORKER_SUPERVISOR_AUDIENCE ||
    !["status", "update-status", "resident-status", "runtime-handoff", "prepare", "start", "select-runtime"].includes(value.operation)
  ) {
    return null;
  }
  if (value.operation === "prepare" && Object.hasOwn(value, "resident")) {
    const resident = parseResidentFence(value.resident, true);
    const handoff = Object.hasOwn(value, "handoff") ? parseHandoff(value.handoff) : undefined;
    return resident && handoff !== null && exactKeys(value, ["audience", "operation", "resident", "version", ...(handoff ? ["handoff"] : [])])
      ? { ...value, resident, ...(handoff ? { handoff } : {}) } : null;
  }
  if (value.operation === "runtime-handoff") {
    const handoff = parseHandoff(value.handoff);
    return handoff && ["prepare", "cancel"].includes(value.action) &&
      exactKeys(value, ["version", "audience", "operation", "action", "handoff"]) ? { ...value, handoff } : null;
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

/** @typedef {Pick<import('./cloud-resident-workload.mjs').CloudResidentWorkload,
 * 'identity'|'start'|'enroll'|'stop'> & Partial<Pick<import('./cloud-resident-workload.mjs').CloudResidentWorkload,
 * 'runtime'|'scope'|'witness'|'detach'|'rootCustody'>>} SupervisorResident */

/** The broker always launches one detached root controller with these options;
 * the broader Node spawn overloads are not part of this internal port.
 * @param {string} file @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {import('node:child_process').ChildProcess} */
function spawnCloudRootController(file, args, options) { return spawn(file, args, options); }

/** @param {object} options @returns {Promise<SupervisorResident>} */
async function createResidentWorkload(options) {
  return new (await import("./cloud-resident-workload.mjs")).CloudResidentWorkload(options);
}

export class CloudWorkerSupervisor {
  #handlers;
  #engineHandoff = null;
  #handoffReceipt = null;
  #handoffPrepared = null;
  #engineOwner = null;
  #engineCustody = null;
  #engineRuntime = null;
  #residentAuthority = null;
  #enrolledResident = null;
  #retiredResident = null;
  /** @type {{kind:string, completion:object|null, checkpoint:object|null, retired:boolean}|null} */
  #lastRetirement = null;
  #legacyControl = null;
  #listenerLock = null;
  #stopFlight = null;

  constructor({
    socketPath = CLOUD_WORKER_SUPERVISOR_SOCKET,
    runtime = resolveCloudRuntime(),
    launcher = runtime.startEngine,
    spawnProcess = spawnCloudRootController,
    engineScope = /** @type {{retire:(options?:{preserveWorkload:string})=>Promise<unknown>}|null} */ (null),
    setupScope = /** @type {{retire:()=>Promise<unknown>}|null} */ (null),
    verifySelectedRuntime = verifySelectedCloudRuntime,
    // Legacy images retain their closed helper inventory. This v4-only entry
    // is part of the immutable runtime bundle, loaded only for explicit opt-in.
    createResident = createResidentWorkload,
    requestEngineHandoff = requestCloudEngineHandoff,
    requestEngineFinalCompletion = requestCloudEngineFinalCompletion,
    readBirth = readCloudRootProcessBirth,
    readEngineCustody: readCustody = readEngineCustody,
    createLegacyControl = createLegacyResidentControl,
  } = {}) {
    this.socketPath = socketPath;
    this.runtime = runtime;
    this.launcher = launcher;
    this.spawnProcess = spawnProcess;
    this.engineScope = engineScope;
    this.setupScope = setupScope;
    this.verifySelectedRuntime = verifySelectedRuntime;
    this.createResident = createResident;
    this.requestEngineHandoff = requestEngineHandoff;
    this.requestEngineFinalCompletion = requestEngineFinalCompletion;
    this.readBirth = readBirth;
    this.readEngineCustody = readCustody;
    this.createLegacyControl = createLegacyControl;
    /** @type {SupervisorResident|null} */
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
      ["runtime-handoff", this.#runtimeHandoff.bind(this)],
      ["prepare", this.#prepare.bind(this)],
      ["start", this.#startRuntime.bind(this)],
      ["select-runtime", this.#selectRuntime.bind(this)],
    ]));
  }

  get lastRetirement() { return this.#lastRetirement; }

  async #assertEngine(endpoint = this.#engineHandoff) {
    const child = this.child, owner = this.#engineOwner;
    const refused = () => { throw new Error("Cloud engine original custody or authority changed"); };
    if (!endpoint || endpoint !== this.#engineHandoff || !child || !owner || child.pid !== owner.pid ||
        child.exitCode !== null || child.signalCode !== null || !this.#engineRuntime) refused();
    const check = () => {
      const birth = this.readBirth(owner.pid);
      if (child !== this.child || endpoint !== this.#engineHandoff || child.exitCode !== null || child.signalCode !== null ||
          birth?.pid !== owner.pid || birth.startToken !== owner.startToken) refused();
    };
    check();
    const record = await this.readEngineCustody({ runtime: this.#engineRuntime,
      engineId: endpoint.scope.engineInstanceId, owner: { ...owner }, episode: this.#engineCustody?.episode });
    check();
    if (!record || !isUuid(record.episode) || record.owner?.pid !== owner.pid || record.owner.startToken !== owner.startToken ||
        record.birth?.kind !== "engine" || !positiveInteger(record.birth.pid, 2147483647) ||
        !/^[1-9][0-9]{0,19}$/.test(record.birth.startToken ?? "") ||
        record.scope?.directory !== `${this.#engineRuntime.cgroupRoot}/engine-runtime/engine-${endpoint.scope.engineInstanceId}` ||
        ["runtimeId", "bootId", "supervisorSessionId"].some(key => record.runtime?.[key] !== this.#engineRuntime[key]) ||
        this.#engineCustody && JSON.stringify(record) !== JSON.stringify(this.#engineCustody)) refused();
    this.#engineCustody ??= immutable(record);
  }

  #sameResidentAuthority(authority) {
    const original = this.#residentAuthority;
    if (!isRecord(authority) || !exactKeys(authority, ["organizationId", "workspaceId", "engineId", "generation", "fence", "token"]) || !original ||
        ["organizationId", "workspaceId", "engineId", "generation", "fence"].some(key => authority[key] !== original[key]) ||
        typeof authority.token !== "string") return false;
    const expected = Buffer.from(original.token), supplied = Buffer.from(authority.token);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  #assertListenerLock() {
    const original = this.#listenerLock;
    const refused = () => { throw new Error("Cloud original supervisor listener lock changed"); };
    if (!original || this.lock !== original.fd || process.getuid?.() !== 0 ||
        process.pid !== original.owner.pid || `${this.socketPath}.lock` !== original.path) refused();
    try {
      const descriptor = fstatSync(original.fd, { bigint: true });
      const current = lstatSync(original.path, { bigint: true });
      if (realpathSync(original.path) !== original.path) refused();
      for (const stat of [descriptor, current]) {
        if (!stat.isFile() || stat.isSymbolicLink() || String(stat.uid) !== "0" || String(stat.gid) !== "0" ||
            String(stat.nlink) !== "1" || (BigInt(stat.mode) & 0o7777n) !== 0o600n ||
            String(stat.dev) !== original.dev || String(stat.ino) !== original.ino) refused();
      }
      const birth = this.readBirth(original.owner.pid);
      if (birth?.pid !== original.owner.pid || birth.startToken !== original.owner.startToken) refused();
    } catch { refused(); }
  }

  /** Private callbacks for the fixed authenticated legacy listener. Clearing
   * the pointer retains its receipt and fence floor; it never adopts a new PID. */
  legacyResidentControlOptions() {
    return {
      assertListenerLock: () => this.#assertListenerLock(),
      current: () => this.resident && this.resident === this.#enrolledResident && this.#residentAuthority
        ? { resident: this.resident, authority: { ...this.#residentAuthority } } : null,
      assertEngine: async authority => {
        if (!this.#sameResidentAuthority(authority) || !this.#engineHandoff ||
            ["organizationId", "workspaceId", "generation"].some(key => this.#engineHandoff.scope[key] !== authority[key]) ||
            this.#engineHandoff.scope.engineInstanceId !== authority.engineId)
          throw new Error("Cloud engine original custody or authority changed");
        await this.#assertEngine();
        if (!this.#sameResidentAuthority(authority)) throw new Error("Cloud engine original authority changed");
      },
      clearResident: async (resident, receipt) => {
        const authority = this.#residentAuthority, source = receipt?.source;
        if (!resident || resident !== this.resident || resident !== this.#enrolledResident || !authority ||
            !isRecord(receipt) || !exactKeys(receipt, ["version", "operation", "requestId", "source", "phase", "proof", "replacement"]) ||
            receipt.version !== 1 || receipt.operation !== "retire-legacy-resident" || !isUuid(receipt.requestId) ||
            receipt.phase !== "retired" || receipt.replacement !== "fresh-view-required" ||
            !isRecord(receipt.proof) || !exactKeys(receipt.proof, ["kind", "populated"]) ||
            receipt.proof.kind !== "dedicated-resident-cgroup" || receipt.proof.populated !== 0 ||
            !isRecord(source) || !exactKeys(source, ["hostId", "authority", "runtime", "scope"]) ||
            source.hostId !== resident.identity.hostId || !isRecord(source.authority) ||
            !exactKeys(source.authority, ["organizationId", "workspaceId", "engineId", "generation", "fence"]) ||
            Object.keys(source.authority).some(key => source.authority[key] !== authority[key]) ||
            !isRecord(source.runtime) || !exactKeys(source.runtime, ["runtimeId", "bootId", "supervisorSessionId"]) ||
            Object.keys(source.runtime).some(key => source.runtime[key] !== resident.runtime[key]) ||
            !isRecord(source.scope) || !exactKeys(source.scope, ["directory", "dev", "ino"]) ||
            source.scope.directory !== `${resident.runtime.cgroupRoot}/engine-workload-${source.hostId}` ||
            source.scope.directory !== resident.scope.directory || !/^(0|[1-9][0-9]{0,19})$/.test(source.scope.dev ?? "") ||
            !/^[1-9][0-9]{0,19}$/.test(source.scope.ino ?? ""))
          throw new Error("Cloud legacy resident retirement proof changed");
        await this.#assertEngine();
        if (resident !== this.resident || resident !== this.#enrolledResident || authority !== this.#residentAuthority)
          throw new Error("Cloud legacy resident authority changed");
        this.#retiredResident = immutable(receipt);
        this.resident = null;
        this.preparedResident = null;
      },
      serialize: operation => this.serialize(operation),
    };
  }

  async stopChild({ preserveWorkload, force = false } = {}) {
    if (force !== true && force !== false || force && preserveWorkload !== undefined)
      throw new Error("Invalid cloud engine retirement mode");
    if (preserveWorkload !== undefined) {
      const witness = await this.resident?.witness();
      if (this.runtime.profile !== "v4" || witness?.hostId !== preserveWorkload || witness.engineId !== null)
        throw new Error("Resident workload preservation was not confirmed");
    }
    const child = this.child;
    let completion = null;
    const live = child && child.exitCode === null && child.signalCode === null;
    const kind = preserveWorkload !== undefined ? "preserve" : force ? "force" : live ? "normal" : this.#engineOwner ? "crash" : "empty";
    if (this.runtime.profile === "v4" && this.#engineOwner && typeof this.engineScope?.retire !== "function")
      throw new Error("Cloud engine root scope custody unavailable");
    if (kind === "normal" && this.runtime.profile === "v4") {
      const endpoint = this.#engineHandoff;
      await this.#assertEngine(endpoint);
      const challenge = randomUUID();
      const result = await this.requestEngineFinalCompletion(endpoint, challenge);
      completion = parseCloudEngineFinalCompletion(result, { challenge, scope: endpoint.scope });
      if (!completion) throw new Error("Cloud engine final completion was not confirmed");
      await this.#assertEngine(endpoint);
    }
    // Retain the exact accepted immutable completion before the first signal.
    // Force/crash/empty are explicitly checkpoint-free; preserve is separate.
    this.#lastRetirement = immutable({ kind, completion, checkpoint: completion?.checkpoint ?? null, retired: false });
    let failure;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const signalGroup = (signal) => {
          if (this.#engineOwner) {
            const birth = this.readBirth(child.pid);
            if (birth?.pid !== this.#engineOwner.pid || birth.startToken !== this.#engineOwner.startToken)
              throw new Error("Cloud engine launcher original custody changed");
          }
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
    this.#lastRetirement = immutable({ kind, completion, checkpoint: completion?.checkpoint ?? null, retired: true });
    this.#engineHandoff = null;
    this.#engineOwner = null;
    this.#engineRuntime = null;
    this.#engineCustody = null;
    if (preserveWorkload === undefined && !this.#retiredResident) {
      this.#residentAuthority = null;
      this.#enrolledResident = null;
    }
    if (this.child === child) this.child = null;
  }

  async launch(environment) {
    let rootResident;
    if (environment.residentB64) {
      if (!this.resident || typeof this.resident.rootCustody !== "function")
        throw new Error("Resident original custody unavailable");
      rootResident = Buffer.from(JSON.stringify(this.resident.rootCustody())).toString("base64url");
    }
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
        ...(rootResident ? { ZEROS_ROOT_RESIDENT_CUSTODY_B64: rootResident } : {}),
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
    this.child = child;
    if (this.runtime.profile === "v4") {
      try {
        const birth = this.readBirth(child.pid);
        if (birth?.pid !== child.pid || !/^[1-9][0-9]{0,19}$/.test(birth.startToken ?? ""))
          throw new Error("Cloud engine original custody unavailable");
        this.#engineOwner = immutable({ pid: birth.pid, startToken: birth.startToken });
        this.#engineRuntime = immutable({ ...this.runtime, ...this.selectedRuntime, profile: "v4" });
        this.#engineCustody = null;
      } catch (error) {
        await this.stopChild({ force: true });
        throw error;
      }
    }
    child.unref();
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

  async #handoffSource(request, allowExpired = false) {
    const endpoint = this.#engineHandoff;
    if (!parseHandoff(request) || this.runtime.profile !== "v4" || !endpoint || !this.resident ||
      (!allowExpired && request.expiresAtMs <= Date.now()) || request.expiresAtMs > Date.now() + 900_000 ||
      ["workspaceId", "organizationId", "generation", "engineInstanceId"].some(key => endpoint.scope[key] !== request[key])) return null;
    const witness = await this.resident.witness();
    return witness.hostId === request.hostId && witness.fence === request.fence && witness.engineId === request.engineInstanceId &&
      witness.generation === request.generation && witness.organizationId === request.organizationId && witness.workspaceId === request.workspaceId
      ? endpoint : null;
  }

  async #engineHandoffRequest(action, request) {
    const endpoint = await this.#handoffSource(request, action === "consume");
    if (!endpoint) return null;
    const result = await this.requestEngineHandoff(endpoint, { action, request });
    if (!isRecord(result) || !exactKeys(result, ["version", "action", "request", "accepted", ...(Object.hasOwn(result, "receipt") ? ["receipt"] : [])]) ||
      result.version !== 1 || result.action !== action || result.accepted !== true || !sameHandoff(result.request, request) ||
      await this.#handoffSource(request, action === "consume") !== endpoint) return null;
    if (action === "prepare") {
      const receipt = result.receipt;
      if (!isRecord(receipt) || !exactKeys(receipt, [...HANDOFF_KEYS, "version", "phase", "activityRevision"]) || receipt.version !== 1 ||
        !["draining", "fenced"].includes(receipt.phase) || !Number.isSafeInteger(receipt.activityRevision) || receipt.activityRevision < 0 ||
        HANDOFF_KEYS.some(key => receipt[key] !== request[key])) return null;
    } else if (Object.hasOwn(result, "receipt")) return null;
    return result;
  }

  async #runtimeHandoff(request) {
    if (!["prepare", "cancel"].includes(request.action)) return rejectSupervisorRequest();
    const result = await this.#engineHandoffRequest(request.action, request.handoff);
    if (!result) return rejectSupervisorRequest();
    if (request.action === "cancel") {
      this.#handoffReceipt = null;
      return supervisorResponse("cancelled");
    }
    this.#handoffReceipt = { request: { ...request.handoff }, receipt: result.receipt };
    return supervisorResponse(result.receipt.phase, { handoff: result.receipt });
  }

  async #prepare(request) {
    // A failed target's rollback uses resident prepare without a source
    // handoff receipt. Recover its lost reply with the same unspent session,
    // just as for source consumption; detaching it twice would lose recovery.
    const replay = this.#handoffPrepared;
    if (request.resident && replay && this.#sessionMatches(replay.response.session) &&
        ["hostId", "engineId", "fence"].every(key => request.resident[key] === replay.resident[key]) &&
        (request.handoff ? sameHandoff(request.handoff, replay.request) : replay.request === null)) return replay.response;
    if (request.handoff) {
      if (this.#handoffReceipt?.receipt.phase !== "fenced" || !sameHandoff(request.handoff, this.#handoffReceipt.request) ||
        request.resident?.hostId !== request.handoff.hostId || request.resident?.engineId !== request.handoff.engineInstanceId ||
        request.resident?.fence !== request.handoff.fence || !await this.#engineHandoffRequest("consume", request.handoff)) return rejectSupervisorRequest();
    } else if (request.resident && this.#handoffReceipt) return rejectSupervisorRequest();
    let resident = null;
    if (request.resident) {
      if (this.runtime.profile !== "v4" || !this.resident) return rejectSupervisorRequest();
      await this.resident.witness();
      resident = await this.resident.detach(request.resident);
    }
    this.session = null;
    this.#handoffReceipt = null;
    this.#handoffPrepared = null;
    this.preparedResident = null;
    await this.stopChild(resident ? { preserveWorkload: resident.hostId } : undefined);
    this.preparedResident = resident;
    this.session = `zsp_${randomBytes(32).toString("base64url")}`;
    const response = supervisorResponse("prepared", { session: this.session, ...(resident ? { resident } : {}) });
    if (request.resident) this.#handoffPrepared = { resident: { ...request.resident },
      request: request.handoff ? { ...request.handoff } : null, response };
    return response;
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
    const retired = this.#retiredResident?.source;
    if (retired && (!requested || requested.hostId === retired.hostId || requested.fence <= retired.authority.fence ||
        execution?.organizationId !== retired.authority.organizationId || execution?.workspaceId !== retired.authority.workspaceId))
      return rejectSupervisorRequest();
    this.session = null;
    this.#handoffPrepared = null;
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
      this.#residentAuthority = immutable(authority);
      this.#enrolledResident = this.resident;
      environment = { ...environment, residentB64: Buffer.from(JSON.stringify({
        protocol: "zeros.resident-pty/v1", hostId: requested.hostId, authority,
      })).toString("base64url") };
    }
    const scope = { workspaceId: execution.workspaceId, organizationId: execution.organizationId,
      generation: execution.generation, engineInstanceId: environment.runtime.engine.instanceId };
    const pid = await this.launch(environment);
    this.#engineHandoff = immutable({ scope, port: environment.port, token: environment.runtime.engine.readinessProbeToken });
    return supervisorResponse("started", { pid });
  }

  enqueue(request) {
    return this.serialize(() => this.apply(request));
  }

  serialize(operation) {
    if (this.stopping) return Promise.reject(new Error("Cloud root control is stopping"));
    const current = this.operation.then(operation);
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
      const identity = fstatSync(lock, { bigint: true });
      const owner = this.readBirth(process.pid);
      if (owner?.pid !== process.pid || !/^[1-9][0-9]{0,19}$/.test(owner.startToken ?? ""))
        throw new Error("Cloud original supervisor listener lock changed");
      this.#listenerLock = immutable({ fd: lock, path: `${this.socketPath}.lock`,
        dev: String(identity.dev), ino: String(identity.ino), owner: { pid: owner.pid, startToken: owner.startToken } });
      this.#assertListenerLock();
      // A restarted systemd host begins idle only after the previous kernel
      // workload set is proven empty, including launchers it never observed.
      if (this.runtime.profile === "v4") await this.stopChild();
      if (this.runtime.profile === "v4") {
        const control = await this.createLegacyControl(this.legacyResidentControlOptions());
        this.#legacyControl = control;
        await control.listen({ socketPath: "/run/zeros/engine/resident-control.sock" });
      }
      await this.listen();
    } catch (error) {
      await this.#legacyControl?.close().catch(() => undefined);
      this.#legacyControl = null;
      this.#listenerLock = null;
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

  stop() {
    return this.#stopFlight ??= this.#stop();
  }

  async #stop() {
    this.stopping = true;
    this.session = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await this.#legacyControl?.close();
    this.#legacyControl = null;
    await this.operation.catch(() => undefined);
    await this.stopChild();
    if (this.lock !== null) {
      try {
        if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      } finally {
        this.#listenerLock = null;
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
      async () => {
        // Emergency cleanup never relabels a missing completion as normal.
        // The outside-root owner can still retire the VM tree, checkpoint:null.
        try { await supervisor.stopChild({ force: true }); } catch { /* Exit failed; retirement is not claimed. */ }
        process.exit(1);
      },
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
