// The development family's instance registry:
// <com.zeros.local>/instances.json, owner-only, rewritten atomically under an
// exclusive lock. It is a record `pnpm storage:inventory` reads; nothing decides
// to delete from it. Unknown fields and instances survive every rewrite; a
// corrupt file is renamed aside and rebuilt empty. Reads never block on, follow
// or replace anything but a regular file. Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { LockBusyError, acquireExclusiveLock, heldByThisProcess, pidAlive, readRegularFile } from "./exclusive-file-lock.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

export const REGISTRY_VERSION = 1;
export const INSTANCE_KINDS = Object.freeze(["checkout"]);
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

/** The registry records account-free Local checkouts, whose id is always 16
 * hex characters: any other pairing was not written by a launcher and proves
 * nothing about its owner. */
export function possibleEntry(instance, kind) {
  return kind === "checkout" && paths.isCheckoutInstanceId(instance);
}

/** Read-only view. A missing file is empty; a corrupt one reads as empty and is
 * repaired by the next update. Entries with an impossible kind/id pair are left
 * out of `instances` and named in `inconsistent`. Throws for anything that is
 * not a regular file. */
export function readRegistry(file) {
  const raw = readRegularFile(file);
  if (raw === null) return { ...emptyRegistry(), corrupt: false, inconsistent: [] };
  let doc;
  try {
    doc = parseRegistry(raw);
  } catch {
    return { ...emptyRegistry(), corrupt: true, inconsistent: [] };
  }
  const instances = {}, inconsistent = [];
  for (const [instance, entry] of Object.entries(doc.instances)) {
    if (possibleEntry(instance, entry.kind)) instances[instance] = entry;
    else if (INSTANCE_KINDS.includes(entry.kind) || paths.isCheckoutInstanceId(instance)) inconsistent.push(instance);
  }
  return { ...doc, instances, corrupt: false, inconsistent };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `timeoutMs: 0` makes one attempt and never sleeps (launch registration). */
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
  // Removed only by this invocation, and only while it is still its own file.
  let owned = false;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    owned = true;
    fs.renameSync(temporary, file);
    owned = false;
    fs.chmodSync(file, 0o600);
  } finally {
    if (owned) fs.rmSync(temporary, { force: true });
  }
}

/** Keep a corrupt registry beside it under a name no other file has: link(2)
 * never replaces an existing name. */
function setAside(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 16; attempt++) {
    const aside = `${file}.corrupt-${stamp}${attempt ? `-${attempt}` : ""}`;
    try {
      fs.linkSync(file, aside);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not set aside the corrupt Zeros Local instance registry.");
}

/** Apply `mutate(doc)` under the lock and persist the result. */
export function updateRegistry(file, mutate, { timeoutMs = 5_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = registryLock(file, timeoutMs);
  try {
    let doc = emptyRegistry();
    const raw = readRegularFile(file);
    if (raw !== null) {
      try {
        doc = parseRegistry(raw);
      } catch {
        setAside(file);
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
  if (!possibleEntry(instance, fields.kind)) throw new Error(`Invalid Zeros Local instance id for kind ${fields.kind}`);
  const stamp = now.toISOString();
  return updateRegistry(file, (doc) => {
    const previous = doc.instances[instance] ?? {};
    const next = { ...previous, ...fields, createdAt: previous.createdAt ?? stamp, lastUsedAt: stamp };
    delete next.ownerPid;
    doc.instances[instance] = next;
    return next;
  }, { timeoutMs });
}
