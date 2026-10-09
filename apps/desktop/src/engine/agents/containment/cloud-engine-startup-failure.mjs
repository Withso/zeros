import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export const CLOUD_ENGINE_STARTUP_FAILURE_FILE = "cloud-engine-startup-failure.json";
export const CLOUD_ENGINE_STARTUP_PHASES = Object.freeze(["startup", "registration", "history_restore", "boot_owner"]);
export const CLOUD_ENGINE_STARTUP_NAMES = Object.freeze([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ZodError", "SqliteError",
  "CloudCommandRuntimeError", "CloudRuntimeRequestError", "CloudAgentExecutionError", "CloudAgentAdmissionError",
  "CloudRuntimeUpgradeRequiredError", "unknown",
]);
export const CLOUD_ENGINE_STARTUP_CODES = Object.freeze([
  "ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE",
  "EEXIST", "ELOOP", "EBUSY", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET",
  "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_FULL",
  "command_storage_unavailable", "command_conflict", "cloud_command_writer_retired", "engine_authority_rejected",
  "cloud_commands_unavailable", "cloud_actor_authority_rejected", "cloud_runtime_upgrade_required", "unknown",
]);
export const CLOUD_ENGINE_STARTUP_ERRNOS = Object.freeze([-1, -2, -5, -13, -16, -17, -20, -21, -23, -24, -28, -30, -40, -104, -110, -111, -122]);
const MAX_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }

/** Error getters and arbitrary names/codes can carry credentials. Read only
 * data properties, then select from the same closed vocabulary as setup/CP. */
function property(value, key) {
  try {
    for (let depth = 0; record(value) && depth < 4; depth++, value = Object.getPrototypeOf(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) return Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    }
  } catch { /* An untrusted error cannot prevent shutdown or produce text. */ }
  return undefined;
}
export function classifyCloudEngineStartupFailure(error, phase) {
  let selected = error;
  const seen = new Set();
  for (let depth = 0; record(error) && depth < 4 && !seen.has(error); depth++) {
    seen.add(error);
    const code = property(error, "code");
    if (CLOUD_ENGINE_STARTUP_CODES.includes(code) && code !== "unknown") { selected = error; break; }
    selected = error;
    error = property(error, "cause");
  }
  const name = property(selected, "name"), code = property(selected, "code"), errno = property(selected, "errno");
  return { phase: CLOUD_ENGINE_STARTUP_PHASES.includes(phase) ? phase : "startup",
    name: CLOUD_ENGINE_STARTUP_NAMES.includes(name) ? name : "unknown",
    code: CLOUD_ENGINE_STARTUP_CODES.includes(code) ? code : "unknown",
    errno: CLOUD_ENGINE_STARTUP_ERRNOS.includes(errno) ? errno : null };
}
export function parseCloudEngineStartupFailure(value) {
  if (!exact(value, ["phase", "name", "code", "errno"]) || !CLOUD_ENGINE_STARTUP_PHASES.includes(value.phase) ||
      !CLOUD_ENGINE_STARTUP_NAMES.includes(value.name) || !CLOUD_ENGINE_STARTUP_CODES.includes(value.code) ||
      value.errno !== null && !CLOUD_ENGINE_STARTUP_ERRNOS.includes(value.errno)) return null;
  return { phase: value.phase, name: value.name, code: value.code, errno: value.errno };
}

function sameFile(before, after) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.uid === after.uid &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
    after.nlink === 1 && (after.mode & 0o777) === 0o600;
}
async function dataDirectory(dataRoot, uid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) return null;
  const root = path.resolve(dataRoot);
  if (await fs.realpath(root) !== root) return null;
  const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || metadata.uid !== uid || metadata.mode & 0o077) { await handle.close(); return null; }
    // Anchor the leaf to the opened directory on the cloud platform. A later
    // path replacement cannot redirect either writer or reader to another root.
    const directory = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : root;
    return { handle, root, directory, metadata };
  } catch (error) { await handle.close(); throw error; }
}
async function sameDirectory(parent) {
  const metadata = await fs.lstat(parent.root);
  return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.dev === parent.metadata.dev &&
    metadata.ino === parent.metadata.ino && metadata.uid === parent.metadata.uid && !(metadata.mode & 0o077);
}

/** Best-effort evidence only. The exact instance is private and is removed
 * from the setup result; this record never supplies readiness or authority. */
export async function writeCloudEngineStartupFailure({ dataRoot, engineInstanceId, phase, error }) {
  let parent, temporary;
  try {
    if (typeof engineInstanceId !== "string" || !UUID.test(engineInstanceId) || !process.getuid) return false;
    await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
    parent = await dataDirectory(dataRoot, process.getuid());
    if (!parent) return false;
    const document = { version: 1, engineInstanceId, failure: classifyCloudEngineStartupFailure(error, phase) };
    const bytes = Buffer.from(JSON.stringify(document) + "\n");
    if (bytes.length > MAX_BYTES) return false;
    temporary = path.join(parent.directory, `.startup-failure-${randomUUID()}`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (!await sameDirectory(parent)) return false;
    await fs.rename(temporary, path.join(parent.directory, CLOUD_ENGINE_STARTUP_FAILURE_FILE));
    await parent.handle.sync();
    return true;
  } catch { return false; }
  finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
    await parent?.handle.close().catch(() => undefined);
  }
}

/** One no-follow open, fstat and bounded read on that same descriptor. Refuse
 * malformed, foreign, stale or replacement-racy records without changing the
 * original readiness predicate or copying any private text into the result. */
export async function readCloudEngineStartupFailure({ dataRoot, engineInstanceId, expectedUid }) {
  let parent, handle;
  try {
    if (typeof engineInstanceId !== "string" || !UUID.test(engineInstanceId)) return null;
    parent = await dataDirectory(dataRoot, expectedUid);
    if (!parent) return null;
    const file = path.join(parent.directory, CLOUD_ENGINE_STARTUP_FAILURE_FILE);
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== expectedUid || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
        before.size < 2 || before.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(MAX_BYTES + 1); let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    if (total !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await fs.lstat(file)) ||
        !await sameDirectory(parent)) return null;
    const document = JSON.parse(bytes.toString("utf8", 0, total));
    if (!exact(document, ["version", "engineInstanceId", "failure"]) || document.version !== 1 ||
        document.engineInstanceId !== engineInstanceId) return null;
    return parseCloudEngineStartupFailure(document.failure);
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); await parent?.handle.close().catch(() => undefined); }
}
