#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  lchownSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { runScopedCloudSetup } from "./cloud-setup-process.mjs";
import {
  validCloudResourceContract,
  cloudResourcesMeetContract,
  cloudImageReferenceMatchesBuild,
} from "./cloud-resource-admission.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import {
  ensureCloudHostRuntimeDirectory,
  readCloudHostRuntimeProfile,
} from "./cloud-runtime-profile.mjs";

import {
  cloudOwnerSubjectSha256,
  installCloudGithubCredentialPayload,
} from "./install-cloud-github-credential.mjs";
import {
  CLOUD_WORKER_SUPERVISOR_AUDIENCE,
  CLOUD_WORKER_SUPERVISOR_SOCKET,
} from "./cloud-worker-supervisor.mjs";

export const CLOUD_WORKSPACE_SETUP_ENV = "ZEROS_CLOUD_WORKSPACE_SETUP_B64";
export const CLOUD_WORKSPACE_SETUP_AUDIENCE = "zeros-cloud-workspace-setup-v1";
export const CLOUD_WORKSPACE_SETUP_MATERIALS_AUDIENCE =
  "zeros-cloud-workspace-setup-materials-v1";
export const CLOUD_WORKSPACE_SETUP_RESULT_AUDIENCE =
  "zeros-cloud-workspace-setup-result-v1";

const SETUP_ADMISSION_PATH = "/internal/v1/cloud-workspaces/setup/admission";
const ENGINE_REGISTRATION_PATH =
  "/internal/v1/cloud-workspaces/engine/register";
const SETUP_RECOVERY_PATH = "/internal/v1/cloud-workspaces/setup/recovery";
const TARGET_REPOSITORY = runtimeLayout.repository;
const SEEDED_REPOSITORY_BACKUP = runtimeLayout.seedBackup;
const ATTESTER = "/opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs";
const ASKPASS = "/opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs";
const GITHUB_REVOKE_URL = "https://api.github.com/installation/token";
const WORKER_UID = 10_001;
const WORKER_GID = 10_001;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_MATERIAL_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SUPERVISOR_RESPONSE_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 30_000;
const SETUP_REQUEST_MAX_AGE_MS = 15 * 60_000;
const READINESS_DEADLINE_MS = 90_000;
const HTTP_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SETUP_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const BRIDGE_TOKEN_PATTERN = /^zwb_[A-Za-z0-9_-]{43}$/;
const READINESS_TOKEN_PATTERN = /^zwr_[A-Za-z0-9_-]{43}$/;
const RECOVERY_TOKEN_PATTERN = /^zrc_[A-Za-z0-9_-]{43}$/;
const SESSION_PATTERN = /^zsp_[A-Za-z0-9_-]{43}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

// Both deployed setup and the bundled engine use the same immutable native
// checkpoint parser. Its path is deployment-owned, never selected by a grant.
const CHECKPOINT_HELPER_URL = fileURLToPath(import.meta.url) === "/opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs"
  ? pathToFileURL(path.join(runtimeLayout.engine, "apps/desktop/src/engine/agents/containment/cloud-checkpoint-artifacts.mjs"))
  : new URL("../../../apps/desktop/src/engine/agents/containment/cloud-checkpoint-artifacts.mjs", import.meta.url);

export const CLOUD_WORKSPACE_UNPRIVILEGED_SET_PRIV_ARGS = Object.freeze([
  "--no-new-privs",
  "--bounding-set=-all",
  "--inh-caps=-all",
  "--ambient-caps=-all",
  "--pdeathsig=SIGKILL",
  `--reuid=${WORKER_UID}`,
  `--regid=${WORKER_GID}`,
  "--clear-groups",
]);

class SetupFailure extends Error {
  constructor(code) {
    super("cloud workspace setup did not complete");
    this.name = "SetupFailure";
    this.code = code;
  }
}

function failure(code) {
  return new SetupFailure(code);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
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

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function exactHttpsUrl(value, expectedPath) {
  if (!safeString(value, 4_096)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (expectedPath && parsed.pathname !== expectedPath)
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function canonicalDecode(encoded, maximumBytes, message) {
  if (
    typeof encoded !== "string" ||
    encoded.length < 2 ||
    Buffer.byteLength(encoded, "utf8") > maximumBytes * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new Error(message);
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== encoded
  ) {
    decoded.fill(0);
    throw new Error(message);
  }
  return decoded;
}

function validateJsonValue(value, state, depth = 0) {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 20_000) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => validateJsonValue(entry, state, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !["__proto__", "constructor", "prototype"].includes(key) &&
      validateJsonValue(entry, state, depth + 1),
  );
}

function safeEnvironmentName(name) {
  return (
    ENV_NAME_PATTERN.test(name) &&
    !name.startsWith("ZEROS_") &&
    !name.startsWith("CONDUCTOR_") &&
    !name.startsWith("LD_") &&
    !name.startsWith("DYLD_") &&
    !name.startsWith("GIT_") &&
    ![
      "ALL_PROXY",
      "BASH_ENV",
      "ENV",
      "HOME",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "NODE_OPTIONS",
      "NODE_PATH",
      "PATH",
      "PERL5OPT",
      "PYTHONSTARTUP",
      "RUBYOPT",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
    ].includes(name)
  );
}

export function parseCloudWorkspaceSetupRequest(encoded, now = Date.now()) {
  const decoded = canonicalDecode(
    encoded,
    MAX_REQUEST_BYTES,
    "cloud workspace setup request is invalid",
  );
  let raw;
  try {
    raw = JSON.parse(decoded.toString("utf8"));
  } finally {
    decoded.fill(0);
  }
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "admission",
      "audience",
      "execution",
      "expected",
      "issuedAtMs",
      "version",
    ]) ||
    raw.version !== 1 ||
    raw.audience !== CLOUD_WORKSPACE_SETUP_AUDIENCE ||
    !Number.isSafeInteger(raw.issuedAtMs) ||
    raw.issuedAtMs > now + CLOCK_SKEW_MS ||
    now - raw.issuedAtMs > SETUP_REQUEST_MAX_AGE_MS ||
    !isRecord(raw.admission) ||
    !exactKeys(raw.admission, ["endpoint", "expiresAtMs", "id", "token"]) ||
    !UUID_PATTERN.test(raw.admission.id ?? "") ||
    !SETUP_TOKEN_PATTERN.test(raw.admission.token ?? "") ||
    exactHttpsUrl(raw.admission.endpoint, SETUP_ADMISSION_PATH) === null ||
    !Number.isSafeInteger(raw.admission.expiresAtMs) ||
    raw.admission.expiresAtMs - now < 5_000 ||
    raw.admission.expiresAtMs - raw.issuedAtMs > SETUP_REQUEST_MAX_AGE_MS ||
    !isRecord(raw.execution) ||
    !exactKeys(raw.execution, [
      "executionFence",
      "generation",
      "organizationId",
      "setupRunId",
      "workspaceId",
    ]) ||
    !UUID_PATTERN.test(raw.execution.workspaceId ?? "") ||
    !UUID_PATTERN.test(raw.execution.organizationId ?? "") ||
    !UUID_PATTERN.test(raw.execution.setupRunId ?? "") ||
    !positiveInteger(raw.execution.generation) ||
    !positiveInteger(raw.execution.executionFence) ||
    !isRecord(raw.expected) ||
    !exactKeys(raw.expected, [
      "imageRef",
      "imageSourceCommit",
      "repositoryRevision",
      "settingsSha256",
      "settingsVersion",
    ]) ||
    !safeString(raw.expected.imageRef, 1_024) ||
    !COMMIT_PATTERN.test(raw.expected.imageSourceCommit ?? "") ||
    !safeString(raw.expected.repositoryRevision, 512) ||
    !SHA256_PATTERN.test(raw.expected.settingsSha256 ?? "") ||
    !positiveInteger(raw.expected.settingsVersion)
  ) {
    throw new Error("cloud workspace setup request is invalid");
  }
  return {
    version: 1,
    audience: CLOUD_WORKSPACE_SETUP_AUDIENCE,
    issuedAtMs: raw.issuedAtMs,
    admission: {
      id: raw.admission.id,
      token: raw.admission.token,
      endpoint: exactHttpsUrl(raw.admission.endpoint, SETUP_ADMISSION_PATH),
      expiresAtMs: raw.admission.expiresAtMs,
    },
    execution: { ...raw.execution },
    expected: { ...raw.expected },
  };
}

function parseSetupDocument(encoded, expectedSha256) {
  const decoded = canonicalDecode(
    encoded,
    512 * 1024,
    "cloud workspace settings are invalid",
  );
  try {
    if (createHash("sha256").update(decoded).digest("hex") !== expectedSha256) {
      throw new Error("cloud workspace settings are invalid");
    }
    const document = JSON.parse(decoded.toString("utf8"));
    const keys = [
      "schemaVersion",
      "values",
      ...(document?.secretRefs === undefined ? [] : ["secretRefs"]),
      ...(document?.setupCommands === undefined ? [] : ["setupCommands"]),
    ];
    if (
      !isRecord(document) ||
      !exactKeys(document, keys) ||
      document.schemaVersion !== 1 ||
      !isRecord(document.values) ||
      !validateJsonValue(document.values, { nodes: 0 })
    ) {
      throw new Error("cloud workspace settings are invalid");
    }
    return document;
  } finally {
    decoded.fill(0);
  }
}

export function parseCloudWorkspaceSetupMaterials(
  raw,
  request,
  now = Date.now(),
) {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "audience",
      "engine",
      "execution",
      "image",
      ...(raw.recovery === undefined ? [] : ["recovery"]),
      "repository",
      "settings",
      "version",
    ]) ||
    ![1, 2].includes(raw.version) ||
    raw.audience !== CLOUD_WORKSPACE_SETUP_MATERIALS_AUDIENCE ||
    !isRecord(raw.execution) ||
    !exactKeys(raw.execution, [
      "executionFence",
      "generation",
      "organizationId",
      "setupRunId",
      "workspaceId",
    ]) ||
    Object.keys(request.execution).some(
      (key) => raw.execution[key] !== request.execution[key],
    ) ||
    !isRecord(raw.image) ||
    !exactKeys(raw.image, [
      "ref",
      "sourceCommit",
      ...(raw.version === 2 ? ["resources"] : []),
    ]) ||
    (raw.version === 2 && !validCloudResourceContract(raw.image.resources)) ||
    raw.image.ref !== request.expected.imageRef ||
    raw.image.sourceCommit !== request.expected.imageSourceCommit ||
    !isRecord(raw.repository) ||
    !exactKeys(raw.repository, [
      "cloneUrl",
      "credential",
      "forge",
      "name",
      "owner",
      "revision",
    ]) ||
    raw.repository.forge !== "github.com" ||
    !GITHUB_NAME_PATTERN.test(raw.repository.owner ?? "") ||
    !GITHUB_NAME_PATTERN.test(raw.repository.name ?? "") ||
    raw.repository.revision !== request.expected.repositoryRevision ||
    raw.repository.cloneUrl !==
      `https://github.com/${raw.repository.owner}/${raw.repository.name}.git` ||
    !isRecord(raw.repository.credential) ||
    !exactKeys(raw.repository.credential, [
      "expiresAtMs",
      "token",
      "username",
    ]) ||
    raw.repository.credential.username !== "x-access-token" ||
    !safeString(raw.repository.credential.token, 4_096) ||
    !Number.isSafeInteger(raw.repository.credential.expiresAtMs) ||
    raw.repository.credential.expiresAtMs - now < 5 * 60_000 ||
    raw.repository.credential.expiresAtMs - now > 70 * 60_000 ||
    !(
      raw.recovery === undefined ||
      raw.recovery === null ||
      (isRecord(raw.recovery) &&
        exactKeys(raw.recovery, [
          "audience",
          "checkpointId",
          "contentRevision",
          "endpoint",
          "expiresAtMs",
          "recordRevision",
          "token",
          "version",
        ]) &&
        raw.recovery.version === 1 &&
        raw.recovery.audience === "zeros-cloud-workspace-recovery-v1" &&
        UUID_PATTERN.test(raw.recovery.checkpointId ?? "") &&
        positiveInteger(raw.recovery.contentRevision) &&
        Number.isSafeInteger(raw.recovery.recordRevision) &&
        raw.recovery.recordRevision >= 0 &&
        exactHttpsUrl(raw.recovery.endpoint, SETUP_RECOVERY_PATH) !== null &&
        new URL(raw.recovery.endpoint).origin ===
          new URL(request.admission.endpoint).origin &&
        RECOVERY_TOKEN_PATTERN.test(raw.recovery.token ?? "") &&
        Number.isSafeInteger(raw.recovery.expiresAtMs) &&
        raw.recovery.expiresAtMs - now >= 60_000 &&
        raw.recovery.expiresAtMs - now <= 2 * 60 * 60_000)
    ) ||
    !isRecord(raw.settings) ||
    !exactKeys(raw.settings, [
      "documentB64",
      "documentSha256",
      "setupCommands",
      "setupEnvironment",
      "snapshotSha256",
      "version",
    ]) ||
    raw.settings.version !== request.expected.settingsVersion ||
    raw.settings.snapshotSha256 !== request.expected.settingsSha256 ||
    !SHA256_PATTERN.test(raw.settings.documentSha256 ?? "") ||
    !Array.isArray(raw.settings.setupEnvironment) ||
    raw.settings.setupEnvironment.length > 128 ||
    !Array.isArray(raw.settings.setupCommands) ||
    raw.settings.setupCommands.length > 32 ||
    !isRecord(raw.engine) ||
    !exactKeys(raw.engine, [
      "accountAuth",
      "bridgeToken",
      "instanceId",
      "ownerSubject",
      "port",
      "protocolVersion",
      "readinessProbeToken",
      "registration",
    ]) ||
    !UUID_PATTERN.test(raw.engine.instanceId ?? "") ||
    !positiveInteger(raw.engine.protocolVersion, 65_535) ||
    !positiveInteger(raw.engine.port, 65_535) ||
    raw.engine.port === 22_222 ||
    !BRIDGE_TOKEN_PATTERN.test(raw.engine.bridgeToken ?? "") ||
    !READINESS_TOKEN_PATTERN.test(raw.engine.readinessProbeToken ?? "") ||
    !safeString(raw.engine.ownerSubject, 512) ||
    !isRecord(raw.engine.accountAuth) ||
    !exactKeys(raw.engine.accountAuth, [
      "audience",
      "clientId",
      "contract",
      "issuers",
      "jwksUrl",
    ]) ||
    !safeString(raw.engine.accountAuth.audience, 512) ||
    exactHttpsUrl(raw.engine.accountAuth.jwksUrl) === null ||
    !Array.isArray(raw.engine.accountAuth.issuers) ||
    raw.engine.accountAuth.issuers.length < 1 ||
    raw.engine.accountAuth.issuers.length > 8 ||
    raw.engine.accountAuth.issuers.some(
      (issuer) => exactHttpsUrl(issuer) === null || issuer.includes(","),
    ) ||
    !(
      (raw.engine.accountAuth.contract === null &&
        raw.engine.accountAuth.clientId === null) ||
      (raw.engine.accountAuth.contract === "zeros-access-v1" &&
        safeString(raw.engine.accountAuth.clientId, 512) &&
        raw.engine.accountAuth.issuers.length === 1)
    ) ||
    !isRecord(raw.engine.registration) ||
    !exactKeys(raw.engine.registration, ["endpoint", "expiresAtMs", "token"]) ||
    exactHttpsUrl(
      raw.engine.registration.endpoint,
      ENGINE_REGISTRATION_PATH,
    ) === null ||
    new URL(raw.engine.registration.endpoint).origin !==
      new URL(request.admission.endpoint).origin ||
    !SETUP_TOKEN_PATTERN.test(raw.engine.registration.token ?? "") ||
    !Number.isSafeInteger(raw.engine.registration.expiresAtMs) ||
    raw.engine.registration.expiresAtMs - now < 60_000 ||
    raw.engine.registration.expiresAtMs - now > 2 * 60 * 60_000
  ) {
    throw new Error("cloud workspace setup materials are invalid");
  }

  const document = parseSetupDocument(
    raw.settings.documentB64,
    raw.settings.documentSha256,
  );
  const environment = raw.settings.setupEnvironment.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["name", "value"]) ||
      !safeEnvironmentName(entry.name ?? "") ||
      typeof entry.value !== "string" ||
      entry.value.includes("\0") ||
      Buffer.byteLength(entry.value, "utf8") > 64 * 1024
    ) {
      throw new Error("cloud workspace setup environment is invalid");
    }
    return { name: entry.name, value: entry.value };
  });
  if (
    new Set(environment.map((entry) => entry.name)).size !==
      environment.length ||
    environment.reduce(
      (total, entry) => total + Buffer.byteLength(entry.value, "utf8"),
      0,
    ) >
      512 * 1024
  ) {
    throw new Error("cloud workspace setup environment is invalid");
  }
  const secretRefs = document.secretRefs ?? [];
  if (
    !Array.isArray(secretRefs) ||
    secretRefs.length !== environment.length ||
    secretRefs.some(
      (entry, index) =>
        !isRecord(entry) ||
        !exactKeys(entry, ["id", "name"]) ||
        !UUID_PATTERN.test(entry.id ?? "") ||
        entry.name !== environment[index].name,
    )
  ) {
    throw new Error("cloud workspace setup environment is invalid");
  }
  const commands = raw.settings.setupCommands.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["command", "timeoutSeconds"]) ||
      typeof entry.command !== "string" ||
      entry.command.trim().length < 1 ||
      entry.command.includes("\0") ||
      Buffer.byteLength(entry.command, "utf8") > 16 * 1024 ||
      !positiveInteger(entry.timeoutSeconds, 900)
    ) {
      throw new Error("cloud workspace setup commands are invalid");
    }
    return { command: entry.command, timeoutSeconds: entry.timeoutSeconds };
  });
  const documentCommands = document.setupCommands ?? [];
  if (
    !Array.isArray(documentCommands) ||
    documentCommands.length !== commands.length ||
    documentCommands.some(
      (entry, index) =>
        !isRecord(entry) ||
        !exactKeys(entry, ["command", "timeoutSeconds"]) ||
        entry.command !== commands[index].command ||
        entry.timeoutSeconds !== commands[index].timeoutSeconds,
    )
  ) {
    throw new Error("cloud workspace setup commands are invalid");
  }
  return {
    ...raw,
    settings: {
      ...raw.settings,
      document,
      setupEnvironment: environment,
      setupCommands: commands,
    },
  };
}

async function boundedResponseJson(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && (declared < 0 || declared > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cloud workspace response is too large");
  }
  if (!response.body) throw new Error("cloud workspace response is empty");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("cloud workspace response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } finally {
    joined.fill(0);
  }
}

function normalizedRecoveryPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component.length < 1 ||
        component === "." ||
        component === ".." ||
        component.toLocaleLowerCase("en-US") === ".git",
    )
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  return value;
}

/** PostgreSQL recovery pages use COLLATE "C", which orders UTF-8 bytes. Do
 * not substitute locale collation or JavaScript UTF-16 relational ordering:
 * either can reject a valid cursor (or accept a regressing one) for Unicode
 * paths. */
export function compareCloudWorkspaceRecoveryPath(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function parseRecoveryManifestPage(raw, recovery, afterPath) {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "audience",
      "checkpointId",
      "contentRevision",
      "entries",
      "fileCount",
      "gitBaseCommit",
      "gitHeadRef",
      "nextAfterPath",
      "totalBytes",
      "version",
      ...(raw.version === 2 ? ["manifest", "artifacts"] : []),
    ]) ||
    ![1, 2].includes(raw.version) ||
    raw.audience !== `zeros-cloud-workspace-recovery-manifest-v${raw.version}` ||
    raw.checkpointId !== recovery.checkpointId ||
    raw.contentRevision !== recovery.contentRevision ||
    !(raw.gitBaseCommit === null || COMMIT_PATTERN.test(raw.gitBaseCommit)) ||
    !(raw.gitHeadRef === null || safeString(raw.gitHeadRef, 512)) ||
    !Number.isSafeInteger(raw.fileCount) ||
    raw.fileCount < 0 ||
    raw.fileCount > 1_000_000 ||
    !Number.isSafeInteger(raw.totalBytes) ||
    raw.totalBytes < 0 ||
    raw.totalBytes > 10 * 1024 * 1024 * 1024 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > 500 ||
    !(raw.nextAfterPath === null || typeof raw.nextAfterPath === "string")
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  if (raw.version === 2) {
    if (!Array.isArray(raw.artifacts) || raw.artifacts.length > 1_024 || !validRecoveryBlob(raw.manifest) ||
      raw.artifacts.some(blob => !validRecoveryBlob(blob) || blob.sizeBytes > 16 * 1024 * 1024) ||
      new Set(raw.artifacts.map(blob => blob.blobId)).size !== raw.artifacts.length) throw failure("checkpoint_restore_invalid");
  }
  const entries = raw.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.operation !== "string" ||
      !["upsert", "delete"].includes(entry.operation)
    ) {
      throw failure("checkpoint_restore_invalid");
    }
    const entryPath = normalizedRecoveryPath(entry.path);
    if (
      afterPath !== null &&
      compareCloudWorkspaceRecoveryPath(entryPath, afterPath) <= 0
    ) {
      throw failure("checkpoint_restore_invalid");
    }
    if (entry.operation === "delete") {
      if (!exactKeys(entry, ["operation", "path"])) {
        throw failure("checkpoint_restore_invalid");
      }
      return { operation: "delete", path: entryPath };
    }
    if (
      !exactKeys(entry, [
        "blobId",
        "contentSha256",
        "entryType",
        "mode",
        "operation",
        "path",
        "sizeBytes",
      ]) ||
      !["file", "symlink"].includes(entry.entryType) ||
      ![33188, 33261, 40960].includes(entry.mode) ||
      (entry.entryType === "symlink" && entry.mode !== 40960) ||
      (entry.entryType === "file" && entry.mode === 40960) ||
      !UUID_PATTERN.test(entry.blobId ?? "") ||
      !SHA256_PATTERN.test(entry.contentSha256 ?? "") ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > 1024 * 1024 * 1024 ||
      (entry.entryType === "symlink" && entry.sizeBytes > 4_096)
    ) {
      throw failure("checkpoint_restore_invalid");
    }
    return { ...entry, path: entryPath };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (
      compareCloudWorkspaceRecoveryPath(
        entries[index - 1].path,
        entries[index].path,
      ) >= 0
    ) {
      throw failure("checkpoint_restore_invalid");
    }
  }
  const nextAfterPath =
    raw.nextAfterPath === null
      ? null
      : normalizedRecoveryPath(raw.nextAfterPath);
  if (
    nextAfterPath !== null &&
    (entries.length < 1 || nextAfterPath !== entries.at(-1).path)
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  return {
    ...raw,
    entries,
    nextAfterPath,
  };
}

function validRecoveryBlob(blob) {
  return isRecord(blob) && exactKeys(blob, ["blobId", "contentSha256", "sizeBytes"]) &&
    UUID_PATTERN.test(blob.blobId ?? "") && SHA256_PATTERN.test(blob.contentSha256 ?? "") &&
    Number.isSafeInteger(blob.sizeBytes) && blob.sizeBytes >= 0 && blob.sizeBytes <= 64 * 1024 * 1024;
}

async function recoveryFetch(url, token, signal) {
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]) : AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        Accept: "application/json, application/octet-stream",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw failure("checkpoint_restore_unavailable");
  }
}

async function loadRecoveryManifest(recovery, signal) {
  const entries = [];
  const collisionKeys = new Set();
  let afterPath = null;
  let metadata = null;
  for (;;) {
    signal.throwIfAborted();
    const endpoint = new URL(`${recovery.endpoint}/manifest`);
    endpoint.searchParams.set("limit", "500");
    endpoint.searchParams.set("version", "2");
    if (afterPath !== null) {
      endpoint.searchParams.set(
        "after",
        Buffer.from(afterPath, "utf8").toString("base64url"),
      );
    }
    const response = await recoveryFetch(endpoint.toString(), recovery.token, signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(
        response.status >= 500
          ? "checkpoint_restore_unavailable"
          : "checkpoint_restore_invalid",
      );
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw failure("checkpoint_restore_invalid");
    }
    const page = parseRecoveryManifestPage(
      await boundedResponseJson(response, 2 * 1024 * 1024),
      recovery,
      afterPath,
    );
    signal.throwIfAborted();
    const pageMetadata = JSON.stringify({
      version: page.version,
      ...(page.version === 2 ? { manifest: page.manifest, artifacts: page.artifacts } : {}),
      checkpointId: page.checkpointId,
      contentRevision: page.contentRevision,
      gitBaseCommit: page.gitBaseCommit,
      gitHeadRef: page.gitHeadRef,
      fileCount: page.fileCount,
      totalBytes: page.totalBytes,
    });
    if (metadata === null) metadata = pageMetadata;
    else if (metadata !== pageMetadata)
      throw failure("checkpoint_restore_invalid");
    for (const entry of page.entries) {
      const collision = entry.path.normalize("NFKC").toLocaleLowerCase("en-US");
      if (collisionKeys.has(collision)) {
        throw failure("checkpoint_restore_invalid");
      }
      collisionKeys.add(collision);
      entries.push(entry);
      if (entries.length > 1_000_000) {
        throw failure("checkpoint_restore_invalid");
      }
    }
    if (page.nextAfterPath === null) {
      const parsedMetadata = JSON.parse(metadata);
      const upserts = entries.filter((entry) => entry.operation === "upsert");
      if (
        upserts.length !== parsedMetadata.fileCount ||
        upserts.reduce((total, entry) => total + entry.sizeBytes, 0) !==
          parsedMetadata.totalBytes
      ) {
        throw failure("checkpoint_restore_invalid");
      }
      const upsertPaths = new Set(upserts.map((entry) => entry.path));
      for (const entry of upserts) {
        const components = entry.path.split("/");
        for (let index = 1; index < components.length; index += 1) {
          if (upsertPaths.has(components.slice(0, index).join("/"))) {
            throw failure("checkpoint_restore_invalid");
          }
        }
      }
      return { ...parsedMetadata, entries };
    }
    if (page.entries.length < 1 || page.nextAfterPath === afterPath) {
      throw failure("checkpoint_restore_invalid");
    }
    afterPath = page.nextAfterPath;
  }
}

function safeRepositoryTarget(repositoryDirectory, relativePath) {
  const target = path.join(repositoryDirectory, ...relativePath.split("/"));
  const relative = path.relative(repositoryDirectory, target);
  if (
    relative.length < 1 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  return target;
}

function ensureRecoveryParents(repositoryDirectory, relativePath) {
  const components = relativePath.split("/").slice(0, -1);
  let current = repositoryDirectory;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw failure("checkpoint_restore_invalid");
      }
    } catch (error) {
      if (error instanceof SetupFailure) throw error;
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o755 });
      chownSync(current, WORKER_UID, WORKER_GID);
    }
    const resolved = realpathSync(current);
    if (
      resolved !== repositoryDirectory &&
      !resolved.startsWith(`${repositoryDirectory}${path.sep}`)
    ) {
      throw failure("checkpoint_restore_invalid");
    }
  }
}

function recoveryParentsExistSafely(repositoryDirectory, relativePath) {
  const components = relativePath.split("/").slice(0, -1);
  let current = repositoryDirectory;
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw failure("checkpoint_restore_invalid");
    }
  }
  return true;
}

export function writeAllSync(descriptor, value, write = writeSync) {
  let offset = 0;
  while (offset < value.byteLength) {
    const remaining = value.byteLength - offset;
    const written = write(descriptor, value, offset, remaining, null);
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw failure("checkpoint_restore_invalid");
    }
    offset += written;
  }
}

async function downloadRecoveryBlob(recovery, entry, destination, signal) {
  signal.throwIfAborted();
  const response = await recoveryFetch(`${recovery.endpoint}/blobs/${entry.blobId}`, recovery.token, signal);
  let descriptor, reader, complete = false, cancelled = Promise.resolve();
  const abort = () => { cancelled = reader?.cancel().catch(() => undefined) ?? Promise.resolve(); };
  try {
    signal.throwIfAborted();
    if (!response.ok) throw failure(response.status >= 500 ? "checkpoint_restore_unavailable" : "checkpoint_restore_invalid");
    const declared = response.headers.get("content-length");
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/octet-stream" ||
        !response.body || declared === null || !/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) !== entry.sizeBytes)
      throw failure("checkpoint_restore_invalid");
    descriptor = openSync(destination, "wx", 0o600);
    const digest = createHash("sha256");
    reader = response.body.getReader();
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > entry.sizeBytes - size)
        throw failure("checkpoint_restore_invalid");
      size += value.byteLength;
      digest.update(value);
      writeAllSync(descriptor, value);
    }
    if (size !== entry.sizeBytes || digest.digest("hex") !== entry.contentSha256)
      throw failure("checkpoint_restore_invalid");
    fsyncSync(descriptor);
    complete = true;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await (reader ? reader.cancel() : response.body?.cancel())?.catch(() => undefined);
    await cancelled;
    reader?.releaseLock();
    if (descriptor !== undefined) {
      closeSync(descriptor);
      if (!complete) rmSync(destination, { force: true });
    }
  }
}

function safeSymlinkTarget(repositoryDirectory, entryPath, bytes) {
  let target;
  try {
    target = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure("checkpoint_restore_invalid");
  }
  if (
    target.length < 1 ||
    target !== target.normalize("NFC") ||
    path.posix.isAbsolute(target) ||
    target.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(target)
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  const resolved = path.resolve(
    path.dirname(safeRepositoryTarget(repositoryDirectory, entryPath)),
    target,
  );
  if (
    resolved === repositoryDirectory ||
    !resolved.startsWith(`${repositoryDirectory}${path.sep}`) ||
    path
      .relative(repositoryDirectory, resolved)
      .split(path.sep)
      .some((component) => component.toLocaleLowerCase("en-US") === ".git")
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  return target;
}

function recoveryDeadline(recovery) {
  const deadline = Math.min(recovery.expiresAtMs, Date.now() + 15 * 60_000);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw failure("checkpoint_restore_unavailable");
  return deadline;
}

function assertRecoveryActive(signal, deadlineAtMs) {
  // Synchronous publication can outlive a deadline before timers are dispatched.
  if (signal.aborted || Date.now() >= deadlineAtMs) throw failure("checkpoint_restore_unavailable");
}

function normalizeRecoveryFailure(error, signal, deadlineAtMs) {
  if (error instanceof SetupFailure) return error;
  if (signal.aborted || Date.now() >= deadlineAtMs ||
      error?.name === "AbortError" || error?.name === "TimeoutError")
    return failure("checkpoint_restore_unavailable");
  return error;
}

/** Stage verified unique ciphertext-derived payloads before any checkout mutation.
 * The declared-byte budget also bounds concurrent buffering in the API server. */
export async function stageCloudRecoveryBlobs(recovery, entries, payloadDirectory, signal) {
  const deadlineAtMs = recoveryDeadline(recovery);
  signal = signal ?? AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now()));
  const descriptors = new Map();
  for (const entry of entries) {
    assertRecoveryActive(signal, deadlineAtMs);
    const descriptor = { blobId: entry.blobId, contentSha256: entry.contentSha256, sizeBytes: entry.sizeBytes };
    if (!validRecoveryBlob(descriptor)) throw failure("checkpoint_restore_invalid");
    const previous = descriptors.get(entry.blobId);
    if (previous && (previous.contentSha256 !== entry.contentSha256 || previous.sizeBytes !== entry.sizeBytes))
      throw failure("checkpoint_restore_invalid");
    descriptors.set(entry.blobId, descriptor);
  }
  const cached = new Map(), pending = new Set(), queue = [...descriptors.values()];
  const controller = new AbortController(), lifetime = AbortSignal.any([signal, controller.signal]);
  let next = 0, activeBytes = 0, failed = null;
  try {
    while (next < queue.length || pending.size) {
      assertRecoveryActive(lifetime, deadlineAtMs);
      while (next < queue.length && pending.size < 16 && activeBytes + Math.max(1, queue[next].sizeBytes) <= 64 * 1024 * 1024) {
        assertRecoveryActive(lifetime, deadlineAtMs);
        const entry = queue[next++], size = Math.max(1, entry.sizeBytes), destination = path.join(payloadDirectory, entry.blobId);
        activeBytes += size;
        const task = downloadRecoveryBlob(recovery, entry, destination, lifetime)
          .then(() => { cached.set(entry.blobId, destination); })
          .catch(error => { failed ??= error; controller.abort(); })
          .finally(() => { activeBytes -= size; pending.delete(task); });
        pending.add(task);
      }
      if (pending.size) await Promise.race(pending);
    }
    assertRecoveryActive(lifetime, deadlineAtMs);
    return cached;
  } catch (error) {
    failed ??= error;
    throw normalizeRecoveryFailure(failed, signal, deadlineAtMs);
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    if (failed || signal.aborted) for (const destination of cached.values()) rmSync(destination, { force: true });
  }
}

export async function restoreCloudWorkspaceCheckpoint(
  material,
  repositoryDirectory,
  privateIdentity,
) {
  if (!material.recovery) return false;
  const deadlineAtMs = recoveryDeadline(material.recovery);
  const signal = AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now()));
  try {
    return await restoreCloudWorkspaceCheckpointContents(material, repositoryDirectory, privateIdentity, deadlineAtMs, signal);
  } catch (error) {
    // Include manifest/body cancellation and the native helper's deadline errors
    // in setup's retry contract. Integrity/shape errors remain terminal recovery
    // failures and never masquerade as an invalid installed image.
    const normalized = normalizeRecoveryFailure(error, signal, deadlineAtMs);
    throw normalized instanceof SetupFailure ? normalized : failure("checkpoint_restore_invalid");
  }
}

async function restoreCloudWorkspaceCheckpointContents(material, repositoryDirectory, privateIdentity, deadlineAtMs, signal) {
  if (
    !path.isAbsolute(repositoryDirectory) ||
    realpathSync(repositoryDirectory) !== repositoryDirectory
  ) {
    throw failure("checkpoint_restore_invalid");
  }
  const manifest = await loadRecoveryManifest(material.recovery, signal);
  const payloadDirectory = mkdtempSync(
    path.join(path.dirname(repositoryDirectory), ".zeros-recovery-"),
  );
  try {
    let native = null;
    let selection = null;
    if (manifest.version === 2) {
      const destination = path.join(payloadDirectory, "manifest");
      await downloadRecoveryBlob(material.recovery, manifest.manifest, destination, signal);
      let document;
      try { document = JSON.parse(readFileSync(destination, "utf8")); }
      catch { throw failure("checkpoint_restore_invalid"); }
      if (document?.version === 2) {
        if (!exactKeys(document, ["version", "audience", "gitBaseCommit", "gitHeadRef", "entries", "deletions", "native", "designSelection"]) ||
          document.audience !== "zeros-cloud-workspace-checkpoint-manifest-v2" ||
          document.gitBaseCommit !== manifest.gitBaseCommit || document.gitHeadRef !== manifest.gitHeadRef ||
          !Array.isArray(document.entries) || !Array.isArray(document.deletions)) throw failure("checkpoint_restore_invalid");
        const { validateCloudNativeCheckpoint } = await import(CHECKPOINT_HELPER_URL.href);
        native = validateCloudNativeCheckpoint(document.native);
        const approved = new Map(manifest.artifacts.map(blob => [blob.blobId, blob]));
        if (approved.size !== new Set(native.chunks.map(blob => blob.blobId)).size || native.chunks.some(blob => {
          const expected = approved.get(blob.blobId);
          return !expected || blob.contentSha256 !== expected.contentSha256 || blob.sizeBytes !== expected.sizeBytes;
        })) throw failure("checkpoint_restore_invalid");
        const entries = new Map(manifest.entries.filter(entry => entry.operation === "upsert").map(entry => [entry.path, entry]));
        if (entries.size !== document.entries.length || new Set(document.entries.map(entry => entry.path)).size !== entries.size ||
          document.entries.some(entry => {
            const expected = entries.get(entry.path);
            return !expected || !exactKeys(entry, ["path", "entryType", "mode", "contentSha256", "sizeBytes"]) ||
              entry.entryType !== expected.entryType || entry.mode !== expected.mode || entry.contentSha256 !== expected.contentSha256 || entry.sizeBytes !== expected.sizeBytes;
          })) throw failure("checkpoint_restore_invalid");
        selection = parseRecoveryDesignSelection(document.designSelection);
      } else if (document?.version !== 1 || manifest.artifacts.length) throw failure("checkpoint_restore_invalid");
    }
    if (!native && manifest.gitBaseCommit !== null && manifest.gitBaseCommit !== (await repositoryIdentity(
      repositoryDirectory, path.join(path.dirname(repositoryDirectory), "home"), material.repository.cloneUrl,
    ))) throw failure("checkpoint_restore_invalid");
    const cached = await stageCloudRecoveryBlobs(material.recovery,
      [...manifest.entries.filter(entry => entry.operation === "upsert"), ...(native?.chunks ?? [])], payloadDirectory, signal);
    assertRecoveryActive(signal, deadlineAtMs);
    if (native) {
      // V2 is a complete working tree. The source HEAD may contain unpublished
      // commits, and files removed in those commits must not survive from the
      // newly cloned remote baseline.
      for (const name of readdirSync(repositoryDirectory)) {
        assertRecoveryActive(signal, deadlineAtMs);
        if (name !== ".git") rmSync(path.join(repositoryDirectory, name), { recursive: true, force: true });
      }
      const { restoreCloudNativeCheckpoint } = await import(CHECKPOINT_HELPER_URL.href);
      await restoreCloudNativeCheckpoint({
        archive: native,
        roots: { repository: repositoryDirectory, logicalRepository: TARGET_REPOSITORY, agentHome: runtimeLayout.agentHome, data: runtimeLayout.data },
        identity: { uid: WORKER_UID, gid: WORKER_GID },
        privateIdentity,
        deadlineAtMs,
        getChunk: async blobId => {
          assertRecoveryActive(signal, deadlineAtMs);
          const destination = cached.get(blobId);
          if (!destination) throw failure("checkpoint_restore_invalid");
          // Repeated native chunks and working-tree entries may share a blob.
          // Retain staged bytes until the complete restore finishes.
          return readFileSync(destination);
        },
      });
      const recoveredHead = await repositoryIdentity(repositoryDirectory, runtimeLayout.agentHome, material.repository.cloneUrl);
      if (recoveredHead !== manifest.gitBaseCommit) throw failure("checkpoint_restore_invalid");
    }
    for (const entry of [...manifest.entries]
      .filter((candidate) => candidate.operation === "delete")
      .sort((left, right) => right.path.length - left.path.length)) {
      assertRecoveryActive(signal, deadlineAtMs);
      const target = safeRepositoryTarget(repositoryDirectory, entry.path);
      if (recoveryParentsExistSafely(repositoryDirectory, entry.path)) {
        rmSync(target, { recursive: true, force: true });
      }
    }
    for (const entry of manifest.entries.filter(
      (candidate) => candidate.operation === "upsert",
    )) {
      assertRecoveryActive(signal, deadlineAtMs);
      const target = safeRepositoryTarget(repositoryDirectory, entry.path);
      ensureRecoveryParents(repositoryDirectory, entry.path);
      rmSync(target, { recursive: true, force: true });
      const source = cached.get(entry.blobId);
      if (!source) throw failure("checkpoint_restore_invalid");
      if (entry.entryType === "symlink") {
        const bytes = readFileSync(source);
        try {
          symlinkSync(
            safeSymlinkTarget(repositoryDirectory, entry.path, bytes),
            target,
          );
          lchownSync(target, WORKER_UID, WORKER_GID);
        } finally {
          bytes.fill(0);
        }
      } else {
        copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
        chownSync(target, WORKER_UID, WORKER_GID);
        chmodSync(target, entry.mode === 33261 ? 0o755 : 0o644);
      }
    }
    assertRecoveryActive(signal, deadlineAtMs);
    if (selection) {
      const entry = ".zeros/settings.local.toml";
      ensureRecoveryParents(repositoryDirectory, entry);
      const target = safeRepositoryTarget(repositoryDirectory, entry);
      const text = `[design]\n${Object.entries(selection).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join("")}`;
      // Only this normalized selection is restored, never private environment,
      // credentials or the rest of settings.local.toml.
      rmSync(target, { force: true });
      writeFileSync(target, text, { flag: "wx", mode: 0o600 });
      chownSync(target, WORKER_UID, WORKER_GID);
    }
    assertRecoveryActive(signal, deadlineAtMs);
    return true;
  } finally {
    rmSync(payloadDirectory, { recursive: true, force: true });
  }
}

export function parseRecoveryDesignSelection(value) {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).length < 1 || Object.keys(value).length > 2 ||
    Object.keys(value).some(key => !["directory_id", "directory"].includes(key)) ||
    (value.directory_id !== undefined && (typeof value.directory_id !== "string" || !/^design_[a-zA-Z0-9_-]{1,64}$/.test(value.directory_id)))) throw failure("checkpoint_restore_invalid");
  if (value.directory !== undefined) {
    const name = normalizedRecoveryPath(value.directory);
    if (/^[A-Za-z]:/.test(name) || name.split("/").some(part => part.toLowerCase() === ".zeros" || /[. ]$/.test(part))) throw failure("checkpoint_restore_invalid");
  }
  return value;
}

async function redeemMaterials(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetch(request.admission.endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${request.admission.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        materialVersion: 2,
        workspaceId: request.execution.workspaceId,
        organizationId: request.execution.organizationId,
        generation: request.execution.generation,
        setupRunId: request.execution.setupRunId,
        executionFence: request.execution.executionFence,
        expected: request.expected,
      }),
    });
  } catch {
    throw failure("admission_temporarily_unavailable");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 422) throw failure("settings_invalid");
    if (response.status === 429 || response.status >= 500) {
      throw failure("admission_temporarily_unavailable");
    }
    throw failure("request_invalid");
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw failure("admission_temporarily_unavailable");
  }
  let raw;
  try {
    raw = await boundedResponseJson(response, MAX_MATERIAL_BYTES);
    if (raw?.version !== 2) throw failure("image_contract_invalid");
    return parseCloudWorkspaceSetupMaterials(raw, request);
  } catch (error) {
    if (error instanceof SetupFailure) throw error;
    throw failure("settings_invalid");
  }
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function runProcess(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd ?? "/",
      detached: true,
      env: options.env ?? {
        HOME: "/root",
        PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const collect = (chunks, chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_PROCESS_OUTPUT_BYTES) {
        overflow = true;
        killProcessGroup(child, "SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => collect(stderrChunks, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        overflow,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function assertRootDirectory(directory, mode, gid = 0) {
  mkdirSync(directory, { recursive: true, mode });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    realpathSync(directory) !== directory
  ) {
    throw new Error("cloud workspace directory is unsafe");
  }
  chownSync(directory, 0, gid);
  chmodSync(directory, mode);
}

function assertReplaceableFile(file, expectedUid = 0) {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.nlink !== 1 ||
    realpathSync(file) !== file
  ) {
    throw new Error("cloud workspace state file is unsafe");
  }
}

function removeRootRuntimeFile(file, expectedUid = 0) {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(file) !== file
  ) {
    throw new Error("cloud workspace runtime file is unsafe");
  }
  rmSync(file);
}

function atomicWrite(file, source, { mode, uid = 0, gid = 0 }) {
  assertReplaceableFile(file, uid);
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.zeros-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, source, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chownSync(temporary, uid, gid);
    chmodSync(temporary, mode);
    renameSync(temporary, file);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readPhysicalJson(file, maximumBytes) {
  const descriptor = openSync(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    const current = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 2 ||
      stat.size > maximumBytes ||
      realpathSync(file) !== file
    ) {
      throw new Error("cloud workspace setup journal is unsafe");
    }
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

function journalIdentity(material, commit, managedTomlSha256) {
  return {
    version: 1,
    workspaceId: material.execution.workspaceId,
    organizationId: material.execution.organizationId,
    generation: material.execution.generation,
    repository: {
      cloneUrl: material.repository.cloneUrl,
      revision: material.repository.revision,
      commit,
    },
    settings: {
      version: material.settings.version,
      sha256: material.settings.snapshotSha256,
      managedTomlSha256,
    },
  };
}

function parseJournal(raw) {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "commandsCompleted",
      "executionFence",
      "generation",
      "organizationId",
      "repository",
      "settings",
      "setupRunId",
      "version",
      "workspaceId",
    ]) ||
    raw.version !== 1 ||
    !UUID_PATTERN.test(raw.workspaceId ?? "") ||
    !UUID_PATTERN.test(raw.organizationId ?? "") ||
    !UUID_PATTERN.test(raw.setupRunId ?? "") ||
    !positiveInteger(raw.generation) ||
    !positiveInteger(raw.executionFence) ||
    !Number.isSafeInteger(raw.commandsCompleted) ||
    raw.commandsCompleted < 0 ||
    raw.commandsCompleted > 32 ||
    !isRecord(raw.repository) ||
    !exactKeys(raw.repository, ["cloneUrl", "commit", "revision"]) ||
    !safeString(raw.repository.cloneUrl, 4_096) ||
    !safeString(raw.repository.revision, 512) ||
    !COMMIT_PATTERN.test(raw.repository.commit ?? "") ||
    !isRecord(raw.settings) ||
    !exactKeys(raw.settings, ["managedTomlSha256", "sha256", "version"]) ||
    !positiveInteger(raw.settings.version) ||
    !SHA256_PATTERN.test(raw.settings.sha256 ?? "") ||
    !SHA256_PATTERN.test(raw.settings.managedTomlSha256 ?? "")
  ) {
    throw new Error("cloud workspace setup journal is invalid");
  }
  return raw;
}

function saveJournal(file, identity, material, commandsCompleted) {
  atomicWrite(
    file,
    `${JSON.stringify({
      ...identity,
      setupRunId: material.execution.setupRunId,
      executionFence: material.execution.executionFence,
      commandsCompleted,
    })}\n`,
    { mode: 0o600 },
  );
}

function journalMatches(journal, identity, commandCount, completedSetup) {
  return (
    journal.workspaceId === identity.workspaceId &&
    journal.organizationId === identity.organizationId &&
    journal.generation === identity.generation &&
    journal.repository.cloneUrl === identity.repository.cloneUrl &&
    journal.repository.revision === identity.repository.revision &&
    (completedSetup || journal.repository.commit === identity.repository.commit) &&
    journal.settings.version === identity.settings.version &&
    journal.settings.sha256 === identity.settings.sha256 &&
    journal.settings.managedTomlSha256 ===
      identity.settings.managedTomlSha256 &&
    journal.commandsCompleted <= commandCount
  );
}

async function gitCommand(repositoryDirectory, homeDirectory, args, token) {
  const env = {
    GIT_ASKPASS: ASKPASS,
    GIT_ASKPASS_REQUIRE: "force",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: homeDirectory,
    LANG: "C.UTF-8",
    PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin",
    ...(token
      ? {
          ZEROS_GIT_ASKPASS_HOST: "github.com",
          ZEROS_GIT_ASKPASS_PASSWORD: token,
          ZEROS_GIT_ASKPASS_USERNAME: "x-access-token",
        }
      : {}),
  };
  return runProcess(
    "/usr/bin/setpriv",
    [
      ...CLOUD_WORKSPACE_UNPRIVILEGED_SET_PRIV_ARGS,
      "/usr/bin/git",
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "http.followRedirects=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      ...args,
    ],
    { cwd: repositoryDirectory, env, timeoutMs: 5 * 60_000 },
  );
}

async function repositoryIdentity(directory, homeDirectory, cloneUrl) {
  if (!existsSync(directory)) return null;
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== WORKER_UID ||
    realpathSync(directory) !== directory
  ) {
    return null;
  }
  const gitDirectory = path.join(directory, ".git");
  try {
    const gitStat = lstatSync(gitDirectory);
    if (
      !gitStat.isDirectory() ||
      gitStat.isSymbolicLink() ||
      gitStat.uid !== WORKER_UID ||
      realpathSync(gitDirectory) !== gitDirectory
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const commit = await gitCommand(directory, homeDirectory, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const topLevel = await gitCommand(directory, homeDirectory, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const resolvedGitDirectory = await gitCommand(directory, homeDirectory, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const remote = await gitCommand(directory, homeDirectory, [
    "remote",
    "get-url",
    "origin",
  ]);
  if (
    commit.code !== 0 ||
    commit.timedOut ||
    commit.overflow ||
    topLevel.code !== 0 ||
    topLevel.timedOut ||
    topLevel.overflow ||
    resolvedGitDirectory.code !== 0 ||
    resolvedGitDirectory.timedOut ||
    resolvedGitDirectory.overflow ||
    remote.code !== 0 ||
    remote.timedOut ||
    remote.overflow ||
    topLevel.stdout.trim() !== directory ||
    resolvedGitDirectory.stdout.trim() !== gitDirectory ||
    remote.stdout.trim() !== cloneUrl ||
    !COMMIT_PATTERN.test(commit.stdout.trim())
  ) {
    return null;
  }
  return commit.stdout.trim();
}

export function repositoryIdentityMatchesSetup(expectedCommit, observedCommit) {
  return (
    typeof expectedCommit === "string" &&
    COMMIT_PATTERN.test(expectedCommit) &&
    observedCommit === expectedCommit
  );
}

export function recoverInterruptedCloudWorkspaceClone({
  targetDirectory = TARGET_REPOSITORY,
  seededRepositoryBackup = SEEDED_REPOSITORY_BACKUP,
  expectedUid = WORKER_UID,
} = {}) {
  if (
    !path.isAbsolute(targetDirectory) ||
    !path.isAbsolute(seededRepositoryBackup) ||
    targetDirectory === seededRepositoryBackup ||
    !Number.isSafeInteger(expectedUid) ||
    expectedUid < 0
  ) {
    throw new Error("cloud workspace clone recovery is invalid");
  }
  try {
    lstatSync(targetDirectory);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let backup;
  try {
    backup = lstatSync(seededRepositoryBackup);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (
    !backup.isDirectory() ||
    backup.isSymbolicLink() ||
    backup.uid !== expectedUid ||
    realpathSync(seededRepositoryBackup) !== seededRepositoryBackup
  ) {
    throw failure("image_contract_invalid");
  }
  renameSync(seededRepositoryBackup, targetDirectory);
  return true;
}

async function cloneRepository(material,profile) {
  const workspace = runtimeLayout.root;
  const workspaceStat = lstatSync(workspace);
  if (
    !workspaceStat.isDirectory() ||
    workspaceStat.isSymbolicLink() ||
    workspaceStat.uid !== 0 ||
    (workspaceStat.mode & 0o022) !== 0 ||
    realpathSync(workspace) !== workspace ||
    existsSync(SEEDED_REPOSITORY_BACKUP)
  ) {
    throw failure("image_contract_invalid");
  }
  const stagingRoot = mkdtempSync(path.join(workspace, ".zeros-setup-"));
  const repositoryDirectory = path.join(stagingRoot, "repository");
  const homeDirectory = path.join(stagingRoot, "home");
  try {
    mkdirSync(repositoryDirectory, { mode: 0o700 });
    mkdirSync(homeDirectory, { mode: 0o700 });
    chownSync(stagingRoot, WORKER_UID, WORKER_GID);
    chownSync(repositoryDirectory, WORKER_UID, WORKER_GID);
    chownSync(homeDirectory, WORKER_UID, WORKER_GID);
    chmodSync(stagingRoot, 0o700);
    const revisionCheck = COMMIT_PATTERN.test(material.repository.revision)
      ? { code: 0, timedOut: false, overflow: false }
      : await gitCommand(repositoryDirectory, homeDirectory, [
          "check-ref-format",
          "--branch",
          material.repository.revision,
        ]);
    if (
      revisionCheck.code !== 0 ||
      revisionCheck.timedOut ||
      revisionCheck.overflow
    ) {
      throw failure("repository_revision_invalid");
    }
    for (const args of [
      ["init", "--quiet", "."],
      ["remote", "add", "origin", material.repository.cloneUrl],
    ]) {
      const result = await gitCommand(repositoryDirectory, homeDirectory, args);
      if (result.code !== 0 || result.timedOut || result.overflow) {
        throw failure("repository_temporarily_unavailable");
      }
    }
    const fetched = await gitCommand(
      repositoryDirectory,
      homeDirectory,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "origin",
        material.repository.revision,
      ],
      material.repository.credential.token,
    );
    if (fetched.code !== 0 || fetched.timedOut || fetched.overflow) {
      throw failure("repository_temporarily_unavailable");
    }
    const checkedOut = await gitCommand(repositoryDirectory, homeDirectory, [
      "checkout",
      "--quiet",
      "--detach",
      "FETCH_HEAD",
    ]);
    if (checkedOut.code !== 0 || checkedOut.timedOut || checkedOut.overflow) {
      throw failure("repository_revision_invalid");
    }
    const recovered = await restoreCloudWorkspaceCheckpoint(material, repositoryDirectory,{uid:profile.engineUid,gid:profile.engineGid});
    const commit = await repositoryIdentity(
      repositoryDirectory,
      homeDirectory,
      material.repository.cloneUrl,
    );
    if (
      !commit ||
      (!recovered && COMMIT_PATTERN.test(material.repository.revision) &&
        commit !== material.repository.revision)
    ) {
      throw failure("repository_revision_invalid");
    }
    if (existsSync(TARGET_REPOSITORY)) {
      const target = lstatSync(TARGET_REPOSITORY);
      if (
        !target.isDirectory() ||
        target.isSymbolicLink() ||
        target.uid !== WORKER_UID ||
        realpathSync(TARGET_REPOSITORY) !== TARGET_REPOSITORY
      ) {
        throw failure("image_contract_invalid");
      }
      renameSync(TARGET_REPOSITORY, SEEDED_REPOSITORY_BACKUP);
    }
    try {
      renameSync(repositoryDirectory, TARGET_REPOSITORY);
    } catch (error) {
      if (
        existsSync(SEEDED_REPOSITORY_BACKUP) &&
        !existsSync(TARGET_REPOSITORY)
      ) {
        renameSync(SEEDED_REPOSITORY_BACKUP, TARGET_REPOSITORY);
      }
      throw error;
    }
    return commit;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function stringifyManagedSettings(values) {
  try {
    const requireFromEngine = createRequire("/opt/zeros/package.json");
    const modulePath = requireFromEngine.resolve("smol-toml");
    const module = await import(pathToFileURL(modulePath).href);
    const source = module.stringify(values);
    if (
      typeof source !== "string" ||
      Buffer.byteLength(source, "utf8") > 512 * 1024
    ) {
      throw new Error("managed settings are too large");
    }
    return source.endsWith("\n") ? source : `${source}\n`;
  } catch {
    throw failure("settings_invalid");
  }
}

export async function prepareRepositoryAndSettings(material, profile, stringify = stringifyManagedSettings) {
  const journalFile = path.join(profile.setupDirectory, "repository.json");
  const managedSettings = path.join(
    profile.managedSettingsDirectory,
    "settings.managed.toml",
  );
  assertRootDirectory(profile.setupDirectory, 0o700);
  assertRootDirectory(profile.managedSettingsDirectory, 0o750, WORKER_GID);
  const managedToml = await stringify(
    material.settings.document.values,
  );
  const managedTomlSha256 = createHash("sha256")
    .update(managedToml)
    .digest("hex");
  atomicWrite(managedSettings, managedToml, {
    mode: 0o640,
    uid: 0,
    gid: WORKER_GID,
  });

  let journal = existsSync(journalFile)
    ? parseJournal(readPhysicalJson(journalFile, 64 * 1024))
    : null;
  // A completed root-owned journal binds the repository and settings, while
  // the workspace owner may create commits afterward. An interrupted setup
  // still requires its original HEAD; never rerun a partial hook against a
  // different checkout. Fresh clones validate their pin before recovery.
  const completedSetup = journal !== null &&
    journal.commandsCompleted === material.settings.setupCommands.length;
  if (!journal) recoverInterruptedCloudWorkspaceClone();
  let commit = await repositoryIdentity(
    TARGET_REPOSITORY,
    runtimeLayout.agentHome,
    material.repository.cloneUrl,
  );
  if (!journal) {
    if (existsSync(SEEDED_REPOSITORY_BACKUP)) {
      if (!commit) throw failure("image_contract_invalid");
    } else {
      commit = await cloneRepository(material,profile);
    }
    const identity = journalIdentity(material, commit, managedTomlSha256);
    saveJournal(journalFile, identity, material, 0);
    journal = parseJournal(readPhysicalJson(journalFile, 64 * 1024));
  }
  if (!commit) throw failure("image_contract_invalid");
  const identity = journalIdentity(material, commit, managedTomlSha256);
  if (
    !journalMatches(journal, identity, material.settings.setupCommands.length, completedSetup)
  ) {
    throw failure("repository_revision_invalid");
  }
  if (
    !completedSetup && !material.recovery &&
    COMMIT_PATTERN.test(material.repository.revision) &&
    commit !== material.repository.revision
  ) {
    throw failure("repository_revision_invalid");
  }
  for (
    let index = journal.commandsCompleted;
    index < material.settings.setupCommands.length;
    index += 1
  ) {
    const command = material.settings.setupCommands[index];
    const commandEnvironment = Object.fromEntries(
      material.settings.setupEnvironment.map((entry) => [
        entry.name,
        entry.value,
      ]),
    );
    const result =
      profile.version >= 2
        ? await runScopedCloudSetup({
            version: 1,
            command: command.command,
            timeoutMs: command.timeoutSeconds * 1000,
            environment: commandEnvironment,
          })
        : await runProcess(
            "/usr/bin/setpriv",
            [
              ...CLOUD_WORKSPACE_UNPRIVILEGED_SET_PRIV_ARGS,
              "/bin/bash",
              "--noprofile",
              "--norc",
              "-lc",
              command.command,
            ],
            {
              cwd: TARGET_REPOSITORY,
              timeoutMs: command.timeoutSeconds * 1_000,
              env: {
                ...commandEnvironment,
                HOME: runtimeLayout.agentHome,
                LANG: "C.UTF-8",
                LOGNAME: "zeros-agent",
                PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin",
                SHELL: "/bin/bash",
                USER: "zeros-agent",
              },
            },
          );
    for (const name of Object.keys(commandEnvironment)) {
      commandEnvironment[name] = "";
    }
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.overflow ||
      result.signal
    ) {
      throw failure("setup_command_failed");
    }
    saveJournal(journalFile, identity, material, index + 1);
  }
  const verifiedCommit = await repositoryIdentity(
    TARGET_REPOSITORY,
    runtimeLayout.agentHome,
    material.repository.cloneUrl,
  );
  if (!repositoryIdentityMatchesSetup(commit, verifiedCommit)) {
    throw failure("repository_revision_invalid");
  }
  saveJournal(
    journalFile,
    identity,
    material,
    material.settings.setupCommands.length,
  );
  return commit;
}

function supervisorRequest(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CLOUD_WORKER_SUPERVISOR_SOCKET);
    socket.setEncoding("utf8");
    socket.setTimeout(15_000);
    let source = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      source += chunk;
      if (Buffer.byteLength(source, "utf8") > MAX_SUPERVISOR_RESPONSE_BYTES) {
        finish(() =>
          reject(new Error("cloud supervisor response is too large")),
        );
      }
    });
    socket.once("timeout", () =>
      finish(() => reject(new Error("cloud supervisor request timed out"))),
    );
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (settled) return;
      try {
        if (
          !source.endsWith("\n") ||
          source.indexOf("\n") !== source.length - 1
        ) {
          throw new Error("cloud supervisor response is invalid");
        }
        finish(() => resolve(JSON.parse(source)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
  });
}

async function prepareSupervisor() {
  let response;
  try {
    response = await supervisorRequest({
      version: 1,
      audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
      operation: "prepare",
    });
  } catch {
    throw failure("image_contract_invalid");
  }
  if (
    !isRecord(response) ||
    !exactKeys(response, ["audience", "outcome", "session", "version"]) ||
    response.version !== 1 ||
    response.audience !== CLOUD_WORKER_SUPERVISOR_AUDIENCE ||
    response.outcome !== "prepared" ||
    !SESSION_PATTERN.test(response.session ?? "")
  ) {
    throw failure("image_contract_invalid");
  }
  return response.session;
}

function engineRuntimeB64(material) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      audience: "zeros-cloud-engine-runtime-v1",
      execution: material.execution,
      engine: {
        instanceId: material.engine.instanceId,
        protocolVersion: material.engine.protocolVersion,
        readinessProbeToken: material.engine.readinessProbeToken,
      },
      registration: material.engine.registration,
    }),
    "utf8",
  ).toString("base64url");
}

async function startEngine(material, session) {
  let response;
  try {
    response = await supervisorRequest({
      version: 1,
      audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
      operation: "start",
      session,
      environment: {
        accountAudience: material.engine.accountAuth.audience,
        accountClientId: material.engine.accountAuth.clientId,
        accountContract: material.engine.accountAuth.contract,
        accountIssuers: material.engine.accountAuth.issuers,
        accountJwksUrl: material.engine.accountAuth.jwksUrl,
        bridgeToken: material.engine.bridgeToken,
        ownerSubject: material.engine.ownerSubject,
        port: material.engine.port,
        runtimeB64: engineRuntimeB64(material),
      },
    });
  } catch {
    throw failure("engine_readiness_failed");
  }
  if (
    !isRecord(response) ||
    !exactKeys(response, ["audience", "outcome", "pid", "version"]) ||
    response.version !== 1 ||
    response.audience !== CLOUD_WORKER_SUPERVISOR_AUDIENCE ||
    response.outcome !== "started" ||
    !positiveInteger(response.pid)
  ) {
    throw failure("engine_readiness_failed");
  }
}

function installGithubProjection(material, profile, now = Date.now()) {
  const ownerSubjectSha256 = cloudOwnerSubjectSha256(
    material.engine.ownerSubject,
  );
  const projection = {
    version: 1,
    audience: "zeros-cloud-github-credential-v1",
    generation: randomBytes(24).toString("base64url"),
    issuedAt: now,
    expiresAt: material.repository.credential.expiresAtMs,
    ownerSubjectSha256,
    method: "github-app",
    credential: {
      method: "github-app",
      accessToken: material.repository.credential.token,
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      expiresAtMs: material.repository.credential.expiresAtMs,
    },
  };
  const encoded = Buffer.from(JSON.stringify(projection), "utf8").toString(
    "base64url",
  );
  installCloudGithubCredentialPayload(encoded, {
    output: path.join(profile.runtimeDirectory, "github-credential.json"),
    expectedUid: profile.engineUid,
    expectedGid: profile.engineGid,
    expectedOwnerSubjectSha256: ownerSubjectSha256,
    now,
  });
}

/** Bounded operator diagnostics contain only fixed gate names and booleans.
 * Attestation stdout/stderr can contain workload output and stays private. */
export function cloudWorkspaceImageAdmissionChecks(
  material,
  profile,
  result,
  report,
) {
  return {
    execution: result.code === 0 && !result.timedOut && !result.overflow,
    report: isRecord(report) && report.version === 1,
    profile: report?.profile === profile.profile,
    qualified: report?.qualified === true,
    source:
      report?.metadata?.build?.source?.commit === material.image.sourceCommit,
    build: cloudImageReferenceMatchesBuild(
      material.image.ref,
      report?.metadata?.buildSha256,
    ),
    helpers:
      report?.helpers?.deploymentTrusted?.setupHelper === true &&
      report?.helpers?.deploymentTrusted?.workerSupervisor === true,
    resources:
      report?.resources?.finite === true &&
      (profile.version < 2 ||
        cloudResourcesMeetContract(material.image.resources, report.resources)),
    runtime: report?.qualification?.secure === true,
  };
}

/** Closed vocabulary: untrusted output and unknown names never become diagnostics. */
const IMAGE_ADMISSION_PROBES = new Set([
  "engine-no-new-privileges-and-seccomp",
  "fixed-engine-user-namespace",
  "readonly-image-authority",
  "host-authority-absent",
  "host-process-secrets-denied",
  "global-kernel-control-writes-denied",
  "host-user-namespace-entry-denied",
  "readonly-mounts-locked",
  "inherited-unmount-denied",
  "worker-nested-user-namespace",
  "worker-file-ownership-preserved",
  "worker-cannot-read-engine-or-become-engine",
  "finite-engine-and-descendant-resources",
  "exact-pin",
  "license",
  "actor-boundary-routing",
  "host-machine-read",
  "code-workspace-write",
  "cloud-code-design-write-denial",
  "native-git-all-subcommands",
  "native-git-stderr",
  "pre-push-hook",
  "real-home",
  "provider-home",
  "gh-token",
  "github-token",
  "ssh-agent",
  "gh-cli",
  "keychain",
  "ambient-container-authority-denial",
  "cloud-private-container-service",
  "cloud-private-container-execution",
  "direct-local-service",
  "direct-agent-port",
  "direct-requested-port",
  "host-network-environment",
  "host-tls-trust-environment",
  "design-marker-boundary-posture",
  "repo-settings-host-parity-write",
  "code-engine-authority-posture",
  "cloud-worker-identity",
  "design-engine-authority-read-denial",
  "design-engine-authority-durable-write-denial",
  "design-engine-authority-hardlink-denial",
  "design-git-restore-denial",
  "design-code-read",
  "design-context-read",
  "design-code-write-denial",
  "design-directory-write-denial",
  "design-outside-write-denial",
  "design-git-metadata-write-denial",
  "design-canonical-git-write-denial",
  "design-scratch-write",
  "design-provider-state-write",
  "design-preserves-code",
  "local-admission-fast-path",
  "macos-detached-process-domain"
]);
export function cloudWorkspaceImageAdmissionDiagnostic(report) {
  const qualification = report?.qualification;
  const failedProbes = new Set();
  for (const lane of [qualification?.identity, qualification?.workload]) {
    for (const check of Array.isArray(lane?.checks) ? lane.checks.slice(0, 256) : []) {
      if (IMAGE_ADMISSION_PROBES.has(check?.name) && check.status === "fail")
        failedProbes.add(check.name);
    }
  }
  return {
    identity: qualification?.identity?.secure === true,
    workload: qualification?.workload?.secure === true,
    capture: qualification?.capture?.secure === true,
    humanServices: qualification?.humanServices?.secure === true,
    humanServicePhase: ["configuration", "worker-launch", "handshake", "identity", "exec-pty", "pty", "sftp", "namespace-retirement"].includes(qualification?.humanServices?.phase)
      ? qualification.humanServices.phase : null,
    setup: {
      secure: report?.setupQualification?.secure === true,
      unprivileged: report?.setupQualification?.unprivileged === true,
      detachedDescendantsRetired: report?.setupQualification?.detachedDescendantsRetired === true,
      timeoutRetired: report?.setupQualification?.timeoutRetired === true,
    },
    failedHelpers: [
      "node", "bwrap", "setpriv", "supervisor", "runtimeProfile", "engineLauncher",
      "engineView", "engineCgroup", "engineNamespace", "engineAppArmor", "runtimeTree",
      "engineQualification", "supervisorRecovery", "runtimeLayout", "resourceInspector",
      "resourceAdmission", "imageContract", "setupProcess", "sourceIntegrity", "marker",
      "build", "engine", "engineTree", "launcher", "admissionConsumer", "previewLinkInstaller",
      "githubCredentialInstaller", "githubRefreshRequestHelper", "gitAskpass",
      "workerSupervisor", "setupHelper", "attester", "admissionDirectory",
    ].filter(name => report?.helpers?.trusted?.[name] === false ||
      report?.helpers?.deploymentTrusted?.[name] === false).sort(),
    failedProbes: [...failedProbes].sort(),
  };
}

async function attestImage(material, profile, recordChecks) {
  if (
    material.repository.credential.expiresAtMs - Date.now() < 5 * 60_000 ||
    material.engine.registration.expiresAtMs - Date.now() < 5 * 60_000
  ) {
    throw failure("engine_readiness_failed");
  }
  const result = await runProcess(
    profile.version >= 2
      ? "/opt/zeros-runtime/bin/node"
      : "/usr/local/bin/node",
    [ATTESTER],
    {
      timeoutMs: 4 * 60_000,
    },
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  const checks = cloudWorkspaceImageAdmissionChecks(
    material,
    profile,
    result,
    report,
  );
  recordChecks(checks, cloudWorkspaceImageAdmissionDiagnostic(report));
  if (!Object.values(checks).every((value) => value === true)) {
    throw failure("image_contract_invalid");
  }
}

export function parseCloudWorkspaceEngineReadiness(raw, material) {
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["audience", "engine", "ready", "version"]) ||
    raw.version !== 1 ||
    raw.audience !== "zeros-cloud-engine-readiness-v1" ||
    raw.ready !== true ||
    !isRecord(raw.engine) ||
    !exactKeys(raw.engine, [
      "durableRecordConnected",
      "health",
      "instanceId",
      "protocolVersion",
      "version",
    ]) ||
    raw.engine.version !== 1 ||
    raw.engine.instanceId !== material.engine.instanceId ||
    raw.engine.protocolVersion !== material.engine.protocolVersion ||
    raw.engine.health !== "ready" ||
    raw.engine.durableRecordConnected !== true
  ) {
    return null;
  }
  return raw.engine;
}

async function waitForReadiness(material) {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  const endpoint = `http://127.0.0.1:${material.engine.port}/internal/readiness`;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    timer.unref?.();
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "x-zeros-readiness-token": material.engine.readinessProbeToken,
        },
      });
      if (response.ok) {
        if (
          response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
          "application/json"
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("cloud engine readiness is invalid");
        }
        const raw = await boundedResponseJson(response, 64 * 1024);
        const readiness = parseCloudWorkspaceEngineReadiness(raw, material);
        if (readiness) return readiness;
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Engine startup and its durable registration can take several probes.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw failure("engine_readiness_failed");
}

async function revokeGithubToken(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(GITHUB_REVOKE_URL, {
      method: "DELETE",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "zeros-cloud-workspace-setup",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // The installation token is short-lived; failure is safe to retry later.
  } finally {
    clearTimeout(timer);
  }
}

function readyResult(material, commit, engine) {
  return {
    version: 1,
    audience: CLOUD_WORKSPACE_SETUP_RESULT_AUDIENCE,
    outcome: "ready",
    readiness: {
      version: 1,
      setupRunId: material.execution.setupRunId,
      workspaceId: material.execution.workspaceId,
      organizationId: material.execution.organizationId,
      generation: material.execution.generation,
      executionFence: material.execution.executionFence,
      image: {
        ref: material.image.ref,
        sourceCommit: material.image.sourceCommit,
      },
      repository: {
        revision: material.repository.revision,
        commit,
      },
      settings: {
        version: material.settings.version,
        sha256: material.settings.snapshotSha256,
      },
      engine: {
        instanceId: engine.instanceId,
        protocolVersion: engine.protocolVersion,
        health: "ready",
        durableRecordConnected: true,
      },
    },
  };
}

async function executeSetup(encoded) {
  let request;
  try {
    request = parseCloudWorkspaceSetupRequest(encoded);
  } catch {
    throw failure("request_invalid");
  }
  const material = await redeemMaterials(request);
  let supervisorPrepared = false;
  let successful = false;
  let profile;
  let diagnostic = { version: 1, stage: "runtime", outcome: "running" };
  const record = (stage, checks, runtime) => {
    diagnostic = {
      version: 1,
      stage,
      outcome: "running",
      ...(checks ? { checks } : {}),
      ...(runtime ? { runtime } : {}),
    };
    atomicWrite(
      path.join(profile.setupDirectory, "last-diagnostic.json"),
      JSON.stringify({ ...diagnostic, updatedAt: new Date().toISOString() }) +
        "\n",
      { mode: 0o600 },
    );
  };
  try {
    profile = ensureCloudHostRuntimeDirectory(readCloudHostRuntimeProfile());
    assertRootDirectory(profile.setupDirectory, 0o700);
    record("supervisor");
    const session = await prepareSupervisor();
    supervisorPrepared = true;
    // Reject an unqualified image or undersized allocation before running any
    // repository setup hook. Reattest below to mint a fresh launch proof after
    // potentially long hooks; that proof is intentionally short-lived.
    record("image-preflight");
    await attestImage(material, profile, (checks, runtime) =>
      record("image-preflight", checks, runtime),
    );
    record("repository");
    const commit = await prepareRepositoryAndSettings(material, profile);
    record("credential-projection");
    installGithubProjection(material, profile);
    removeRootRuntimeFile(
      path.join(profile.runtimeDirectory, "github-credential-refresh.json"),
      profile.engineUid,
    );
    record("image-launch");
    await attestImage(material, profile, (checks, runtime) =>
      record("image-launch", checks, runtime),
    );
    record("engine-launch");
    await startEngine(material, session);
    record("engine-readiness");
    const engine = await waitForReadiness(material);
    record("complete");
    successful = true;
    return readyResult(material, commit, engine);
  } finally {
    if (profile) {
      try {
        atomicWrite(
          path.join(profile.setupDirectory, "last-diagnostic.json"),
          JSON.stringify({
            ...diagnostic,
            outcome: successful ? "ready" : "failed",
            updatedAt: new Date().toISOString(),
          }) + "\n",
          { mode: 0o600 },
        );
      } catch {
        // Diagnostics never turn a failed authority check into a successful setup.
      }
    }
    if (!successful) {
      if (supervisorPrepared) await prepareSupervisor().catch(() => undefined);
      await revokeGithubToken(material.repository.credential.token);
      try {
        if (profile)
          removeRootRuntimeFile(
            path.join(profile.runtimeDirectory, "github-credential.json"),
            profile.engineUid,
          );
      } catch {
        // Best-effort removal; the token is also revoked/short-lived.
      }
    }
  }
}

/** SSH bootstrap carries the same admission document over the encrypted stdin
 * channel. Keep the original provider environment transport readable, while
 * refusing ambiguous sources and bounding a peer that never closes stdin. */
export async function readCloudWorkspaceSetupInput({
  args = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  timeoutMs = 10_000,
} = {}) {
  const environment = env[CLOUD_WORKSPACE_SETUP_ENV];
  delete env[CLOUD_WORKSPACE_SETUP_ENV];
  if (args.length === 0) return environment ?? "";
  if (
    args.length !== 1 ||
    args[0] !== "--stdin" ||
    environment !== undefined ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw failure("request_invalid");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      if (error) {
        input.destroy();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > 48 * 1024) finish(failure("request_invalid"));
      else chunks.push(value);
    };
    const onEnd = () => finish(bytes === 0 ? failure("request_invalid") : null);
    const onError = () => finish(failure("request_invalid"));
    const onClose = () => {
      if (!settled) onError();
    };
    const timer = setTimeout(onError, timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
    if (input.destroyed || input.readableEnded) onError();
  });
}

async function main() {
  let response;
  let exitCode = 0;
  try {
    if (process.platform !== "linux" || process.geteuid?.() !== 0) {
      throw failure("image_contract_invalid");
    }
    process.umask(0o077);
    const encoded = await readCloudWorkspaceSetupInput();
    response = await executeSetup(encoded);
  } catch (error) {
    exitCode = 1;
    response = {
      version: 1,
      audience: CLOUD_WORKSPACE_SETUP_RESULT_AUDIENCE,
      outcome: "error",
      code:
        error instanceof SetupFailure ? error.code : "image_contract_invalid",
    };
  }
  process.stdout.write(JSON.stringify(response));
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch(() => {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        audience: CLOUD_WORKSPACE_SETUP_RESULT_AUDIENCE,
        outcome: "error",
        code: "image_contract_invalid",
      }),
    );
    process.exitCode = 1;
  });
}
