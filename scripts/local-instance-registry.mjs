// The development family's instance registry:
// <com.zeros.local>/instances.json, owner-only, rewritten atomically under an
// exclusive lock. Unknown fields and instances survive every rewrite; a corrupt
// file is renamed aside and rebuilt empty. Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { LockBusyError, acquireExclusiveLock, heldByThisProcess, pidAlive } from "./exclusive-file-lock.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

export const REGISTRY_VERSION = 1;
export const INSTANCE_KINDS = Object.freeze(["checkout", "alpha", "ephemeral"]);
const LOCK_STALE_MS = 30_000;

export function registryPath({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  return path.join(paths.developmentContainers({ home, platform, env }).sharedDataDir, "instances.json");
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, instances: {} };
}

function parseRegistry(raw) {
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
  if (doc.version !== REGISTRY_VERSION) throw new Error("unknown version");
  const { instances } = doc;
  if (!instances || typeof instances !== "object" || Array.isArray(instances)) throw new Error("no instances");
  for (const entry of Object.values(instances))
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("bad entry");
  return doc;
}

/** Read-only view. A missing file is empty; a corrupt one reads as empty and is
 * repaired by the next update. */
export function readRegistry(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ...emptyRegistry(), corrupt: false };
    throw error;
  }
  try {
    return { ...parseRegistry(raw), corrupt: false };
  } catch {
    return { ...emptyRegistry(), corrupt: true };
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function registryLock(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return acquireExclusiveLock({
        file: `${file}.lock`,
        busyMessage: "The Zeros Local instance registry is busy.",
        // Only positive evidence retires a holder: a dead pid. A live one, even
        // a suspended one, keeps the lock however old it is; an owner that
        // cannot be read is retired only after it has been old for a while.
        classify: ({ owner, stat }) => {
          const age = stat ? Date.now() - stat.mtimeMs : Infinity;
          if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
            return age > LOCK_STALE_MS ? "stale" : "live";
          if (heldByThisProcess(owner)) return "live";
          return pidAlive(owner.pid) ? "live" : "stale";
        },
      });
    } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
      sleep(25);
    }
  }
}

function writeAtomic(file, doc) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Apply `mutate(doc)` under the lock and persist the result. */
export function updateRegistry(file, mutate, { timeoutMs = 5_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = registryLock(file, timeoutMs);
  try {
    let doc = emptyRegistry();
    let raw = null;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (raw !== null) {
      try {
        doc = parseRegistry(raw);
      } catch {
        fs.renameSync(file, `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        doc = emptyRegistry();
      }
    }
    const result = mutate(doc);
    writeAtomic(file, doc);
    return result;
  } finally {
    release();
  }
}

/** Create or refresh one entry, keeping every field this version does not own. */
export function upsertInstance(file, instance, fields, { now = new Date(), timeoutMs } = {}) {
  if (!INSTANCE_KINDS.includes(fields.kind)) throw new Error("Invalid Zeros Local instance kind");
  const stamp = now.toISOString();
  return updateRegistry(file, (doc) => {
    const previous = doc.instances[instance] ?? {};
    const next = { ...previous, ...fields, createdAt: previous.createdAt ?? stamp, lastUsedAt: stamp };
    if (fields.kind !== "ephemeral") delete next.ownerPid;
    doc.instances[instance] = next;
    return next;
  }, { timeoutMs });
}

/** Remove an entry only if it is still the one the caller inspected. */
export function removeInstance(file, instance, expected, { timeoutMs } = {}) {
  return updateRegistry(file, (doc) => {
    const current = doc.instances[instance];
    if (!current) return false;
    if (expected && current.lastUsedAt !== expected.lastUsedAt) return false;
    delete doc.instances[instance];
    return true;
  }, { timeoutMs });
}
