// Deletion helpers for development-storage cleanup (prune, ephemeral
// identities, storage:sweep). Containment comes from the engine's shared
// contained-removal.cjs with $HOME as the anchor: every target sits directly
// inside an expected container and nothing follows a link. Node built-ins only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const contained = createRequire(import.meta.url)("../apps/desktop/src/engine/db/contained-removal.cjs");

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Why `target` may not be removed, or null when it may; `home` is the anchor. */
export function refusal(target, { container, home, kind = "directory" }) {
  return contained.refusal(target, { container, root: home, kind });
}

/** Remove one contained target. Returns "removed", "missing" or a refusal. */
export function removeContained(target, { container, home, kind = "directory" }) {
  return contained.removeContained(target, { container, root: home, kind });
}

/** Allocated bytes under `target` (what `du` reports), counting links as
 * themselves and each inode once across every call sharing `seen`: development
 * bundles are hardlink clones, so apparent sizes would overstate what a removal
 * frees. */
export function sizeOf(target, { deadline = Infinity, seen = new Set() } = {}) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    if (Date.now() > deadline) return { bytes: total, complete: false };
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    const inode = `${stat.dev}:${stat.ino}`;
    if (!seen.has(inode)) {
      seen.add(inode);
      total += typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
    }
    if (!stat.isDirectory()) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) stack.push(path.join(current, entry));
  }
  return { bytes: total, complete: true };
}

const EMPTY_WORK_FOLDERS = new Set(["workspaces", "design workspaces", "cloud-sync"]);
const IGNORABLE = new Set([".DS_Store"]);

/** Whether a visible root holds anything a person may need. Only missing, or
 * empty `workspaces` / `design workspaces` / `cloud-sync` folders, prove it
 * holds nothing; anything unreadable or unexpected counts as work. */
export function hasWorkspaceEntries(visibleRoot) {
  let stat;
  try {
    stat = lstatOrNull(visibleRoot);
  } catch {
    return true;
  }
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  let entries;
  try {
    entries = fs.readdirSync(visibleRoot, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (IGNORABLE.has(entry.name)) continue;
    if (!EMPTY_WORK_FOLDERS.has(entry.name) || !entry.isDirectory()) return true;
    try {
      if (fs.readdirSync(path.join(visibleRoot, entry.name)).some((name) => !IGNORABLE.has(name))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Whether the shared Local provider store may point into `dataDir`. A
 * provider profile (`provider-accounts/<provider>/<uuid>`) inside an
 * instance's data dir is referenced by the shared store only after
 * migrateLocalProviderSecrets() copied that instance's records, which writes
 * the plaintext `local-provider-migration:<sha256(<dataDir>/secrets.json)>`
 * key in the same locked write. The records themselves are encrypted, so a
 * missing store is the only proof of no reference; anything unreadable counts
 * as referenced. */
export function providerStoreReferences({ dataDir, sharedDataDir }) {
  const store = path.join(sharedDataDir, "secrets.json");
  let fd;
  try {
    fd = fs.openSync(store, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return error.code !== "ENOENT";
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return true;
    const doc = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return true;
    const marker = `local-provider-migration:${createHash("sha256").update(path.join(dataDir, "secrets.json")).digest("hex")}`;
    return Object.hasOwn(doc, marker);
  } catch {
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
