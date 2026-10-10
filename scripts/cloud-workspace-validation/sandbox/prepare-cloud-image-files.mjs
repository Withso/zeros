#!/usr/bin/env node
import * as fs from "node:fs";
import { CloudDelegatedCgroups } from "./cloud-engine-cgroup.mjs";
import {
  chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync,
  realpathSync, renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };

const ENGINE_UID = 10003;
const legacyOwners = new Set([10001, 10002]);
const admittedOwners = new Set([0, ENGINE_UID, ...legacyOwners]);
const sameInode = (left, right) => left.ino === right.ino && left.dev === right.dev &&
  left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
const invalidOwnership = () => new Error("Unsafe cloud engine ownership adoption");
const ownershipMarker = path.join(runtimeLayout.root, ".zeros-engine-ownership-v1.json");
const ownershipCompletion = '{"version":1,"uid":10003,"gid":10003}\n';

/** @typedef {Pick<import("node:fs").Stats, "dev"|"ino"|"uid"|"gid"|"mode"|"nlink"|"isDirectory"|"isFile"|"isSymbolicLink"> & {size?:number}} OwnershipStat */
/** @typedef {{lstatSync(file:string):OwnershipStat, realpathSync(file:string):string,
 * openSync(file:string,flags:number,mode?:number):number, fstatSync(fd:number):OwnershipStat, closeSync(fd:number):void}} OwnershipReadIO */
/** @typedef {OwnershipReadIO & {readdirSync(file:string):string[], fchownSync(fd:number,uid:number,gid:number):void}} OwnershipTreeIO */
/** @typedef {OwnershipTreeIO & {mkdirSync(file:string,options:{mode:number}):unknown,
 * fchmodSync(fd:number,mode:number):void, lchownSync(file:string,uid:number,gid:number):void,
 * renameSync(source:string,target:string):void}} OwnershipHomeIO */
/** @typedef {OwnershipHomeIO & {readFileSync(fd:number,encoding:"utf8"):string,
 * writeFileSync(fd:number,data:string):void, fsyncSync(fd:number):void,
 * readSync(fd:number,buffer:Buffer,offset:number,length:number,position:number):number,
 * unlinkSync(file:string):void}} OwnershipStateIO */

// These are mutable runtime sources. The original physical HOME, staging,
// log and settings identities remain the frozen base's persistence contract.
// Engine namespaces retain their original logical HOME aliases.
export const CLOUD_ENGINE_MUTABLE_LAYOUT = Object.freeze({
  agentHome: path.join(runtimeLayout.root, "home", "engine"),
  captureHome: path.join(runtimeLayout.root, "home", "engine-capture"),
  stagingParent: path.join(runtimeLayout.engineFilesRoot, ".zeros-engine-setup"),
  legacyStagingParent: path.join(runtimeLayout.engineFilesRoot, ".zeros-setup"),
});

function optionalStat(file, io) {
  try { return io.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function pinnedEntry(file, stat, io) {
  const current = io.lstatSync(file);
  if (!sameInode(stat, current) || (!stat.isDirectory() && stat.nlink !== current.nlink) ||
      (!stat.isSymbolicLink() && io.realpathSync(file) !== file)) throw invalidOwnership();
  return current;
}

function rootAncestors(file, io) {
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    const stat = io.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
        (stat.mode & 0o022) || io.realpathSync(parent) !== parent) throw invalidOwnership();
    if (parent === "/") return;
  }
}

function createRuntimeDirectory(file, uid, gid, mode, io) {
  const parent = path.dirname(file);
  const parentFd = io.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const originalParent = io.fstatSync(parentFd);
    if (!originalParent.isDirectory() || !admittedOwners.has(originalParent.uid) ||
        !admittedOwners.has(originalParent.gid)) throw invalidOwnership();
    pinnedEntry(parent, originalParent, io);
    const inheritedGroup = originalParent.mode & 0o2000;
    io.mkdirSync(file, { mode: 0o700 });
    const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = io.fstatSync(fd);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
          stat.gid !== (inheritedGroup ? originalParent.gid : 0) ||
          (stat.mode & 0o7777) !== (0o700 | inheritedGroup)) throw invalidOwnership();
      pinnedEntry(parent, originalParent, io);
      pinnedEntry(file, stat, io);
      io.fchownSync(fd, uid, gid);
      io.fchmodSync(fd, mode);
      const current = io.fstatSync(fd);
      if (current.uid !== uid || current.gid !== gid || (current.mode & 0o7777) !== mode ||
          current.dev !== stat.dev || current.ino !== stat.ino) throw invalidOwnership();
      pinnedEntry(parent, originalParent, io);
      return pinnedEntry(file, current, io);
    } finally { io.closeSync(fd); }
  } finally { io.closeSync(parentFd); }
}

function skippedOwnership(stat) {
  if (!admittedOwners.has(stat.uid) || !admittedOwners.has(stat.gid)) return "foreignEntries";
  if (!stat.isDirectory()) {
    if (!(stat.isFile() || stat.isSymbolicLink())) return "unsupportedEntries";
    if (stat.mode & 0o6000) return "specialModeEntries";
    if (stat.nlink !== 1) return "hardlinkedEntries";
  }
  return null;
}

function adoptEntry(file, stat, io) {
  if (skippedOwnership(stat)) return stat;
  pinnedEntry(file, stat, io);
  if (!legacyOwners.has(stat.uid) && !legacyOwners.has(stat.gid)) return stat;
  const uid = legacyOwners.has(stat.uid) ? ENGINE_UID : stat.uid;
  const gid = legacyOwners.has(stat.gid) ? ENGINE_UID : stat.gid;
  if (stat.isSymbolicLink()) io.lchownSync(file, uid, gid);
  else {
    const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
      (stat.isDirectory() ? fs.constants.O_DIRECTORY : 0));
    try {
      const current = io.fstatSync(fd);
      if (!sameInode(stat, current) || (stat.isFile() && current.nlink !== 1)) throw invalidOwnership();
      pinnedEntry(file, stat, io);
      io.fchownSync(fd, uid, gid);
      const adopted = io.fstatSync(fd);
      if (!sameInode({ ...stat, uid, gid }, adopted) || (stat.isFile() && adopted.nlink !== 1)) throw invalidOwnership();
      pinnedEntry(file, adopted, io);
    } finally { io.closeSync(fd); }
  }
  const current = io.lstatSync(file);
  if (current.dev !== stat.dev || current.ino !== stat.ino || current.mode !== stat.mode ||
      current.uid !== uid || current.gid !== gid || (!stat.isDirectory() && current.nlink !== stat.nlink)) throw invalidOwnership();
  return current;
}

/** Called after the original all-scope retirement and under the root setup
 * lock. Validate eligible inventories and all target collisions before
 * mutation. Leave unrelated/unsafe entries in the old HOME and report counts.
 * Move files and symlinks only: persistence cannot rename HOME directories.
 * A partial move leaves the original roots intact and can be retried without
 * overwriting an existing current file or following a symlink.
 * @param {OwnershipHomeIO} [io] */
export function adoptCloudEngineHomes(io = fs) {
  if (process.geteuid?.() !== 0) throw new Error("Cloud ownership adoption requires root");
  const pairs = [
    { source: runtimeLayout.agentHome, target: CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome, uid: 10001, mode: 0o755 },
    { source: runtimeLayout.captureHome, target: CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome, uid: 10002, mode: 0o700 },
  ];
  const skipped = { unsupportedEntries: 0, specialModeEntries: 0, hardlinkedEntries: 0, foreignEntries: 0, foreignSubtrees: 0 };
  const inventory = (root, owner, mode) => {
    const legacy = owner !== ENGINE_UID;
    const entries = new Map();
    const pending = [{ file: root, depth: 0 }];
    while (pending.length) {
      const next = pending.pop();
      if (!next) break;
      const { file, depth } = next;
      const stat = io.lstatSync(file);
      if (Buffer.byteLength(file) > 4096 ||
          (file === root && (!stat.isDirectory() || stat.uid !== owner || stat.gid !== owner ||
            (stat.mode & 0o7777) !== mode))) throw invalidOwnership();
      const reason = skippedOwnership(stat);
      if (reason) {
        if (legacy) {
          skipped[reason]++;
          if (reason === "foreignEntries" && stat.isDirectory()) skipped.foreignSubtrees++;
        } else entries.set(path.relative(root, file), { file, stat, depth, skipped: true });
        continue;
      }
      if (!stat.isSymbolicLink() && io.realpathSync(file) !== file) throw invalidOwnership();
      entries.set(path.relative(root, file), { file, stat, depth });
      if (stat.isDirectory()) for (const name of io.readdirSync(file)) {
        if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
          throw invalidOwnership();
        pending.push({ file: path.join(file, name), depth: depth + 1 });
      }
    }
    return entries;
  };
  const plans = pairs.map(pair => {
    rootAncestors(pair.source, io);
    rootAncestors(pair.target, io);
    const source = inventory(pair.source, pair.uid, pair.mode);
    const target = optionalStat(pair.target, io) ? inventory(pair.target, ENGINE_UID, pair.mode) : new Map();
    for (const [relative, entry] of source) {
      const destination = target.get(relative);
      if (destination && (destination.skipped || !(entry.stat.isDirectory() && destination.stat.isDirectory()))) throw invalidOwnership();
    }
    return { ...pair, sourceEntries: source, targetEntries: target };
  });
  for (const plan of plans) {
    const { sourceEntries: source, targetEntries: target } = plan;
    const checkParents = (file, root, entries) => {
      for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const original = entries.get(path.relative(root, parent));
        if (!original) throw invalidOwnership();
        pinnedEntry(parent, original.stat, io);
        if (parent === root) return;
      }
    };
    for (const entry of target.values()) if (!entry.skipped) entry.stat = adoptEntry(entry.file, entry.stat, io);
    for (const [relative, entry] of [...source].sort((left, right) => left[1].depth - right[1].depth)) {
      if (!entry.stat.isDirectory()) continue;
      pinnedEntry(entry.file, entry.stat, io);
      if (target.has(relative)) continue;
      const file = path.join(plan.target, relative);
      if (relative) checkParents(file, plan.target, target);
      else rootAncestors(file, io);
      if (optionalStat(file, io)) throw invalidOwnership();
      const stat = createRuntimeDirectory(file, ENGINE_UID, ENGINE_UID, entry.stat.mode & 0o7777, io);
      target.set(relative, { file, stat, depth: entry.depth });
    }
    for (const [relative, entry] of source) {
      if (entry.stat.isDirectory()) continue;
      const file = path.join(plan.target, relative);
      checkParents(entry.file, plan.source, source);
      checkParents(file, plan.target, target);
      pinnedEntry(entry.file, entry.stat, io);
      if (optionalStat(file, io)) throw invalidOwnership();
      io.renameSync(entry.file, file);
      adoptEntry(file, entry.stat, io);
    }
  }
  if (Object.values(skipped).some(count => count > 0))
    console.warn(`Cloud engine HOME adoption left entries unchanged: ${JSON.stringify(skipped)}`);
}

/** @param {OwnershipHomeIO} [io] */
export function prepareCloudEngineRuntimeStaging(io = fs) {
  if (process.geteuid?.() !== 0) throw new Error("Cloud ownership adoption requires root");
  const file = CLOUD_ENGINE_MUTABLE_LAYOUT.stagingParent;
  rootAncestors(file, io);
  const stat = optionalStat(file, io);
  if (!stat) createRuntimeDirectory(file, 0, ENGINE_UID, 0o710, io);
  else if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== ENGINE_UID ||
      (stat.mode & 0o7777) !== 0o710 || io.realpathSync(file) !== file) throw invalidOwnership();
}

/** Root broker only, after its positively drained kernel scope and while the
 * setup/publication lock prevents a replacement engine. Validate and adopt
 * each eligible legacy entry while walking; never follow links or change bytes,
 * modes or inodes. Unrelated artifacts and unsafe legacy files stay untouched.
 * @param {string} root
 * @param {OwnershipTreeIO} [io] */
export function adoptCloudEngineTree(root, io = fs) {
  if (process.geteuid?.() !== 0) throw new Error("Cloud ownership adoption requires root");
  if (!path.isAbsolute(root) || io.realpathSync(root) !== root) throw invalidOwnership();
  const pending = [root];
  while (pending.length) {
    const file = pending.pop();
    if (file === undefined) break;
    let stat = io.lstatSync(file);
    if (Buffer.byteLength(file) > 4096 ||
        (file === root && (!stat.isDirectory() || !admittedOwners.has(stat.uid) || !admittedOwners.has(stat.gid)))) throw invalidOwnership();
    if (stat.isSymbolicLink() || skippedOwnership(stat)) continue;
    if (io.realpathSync(file) !== file) throw invalidOwnership();
    stat = adoptEntry(file, stat, io);
    if (stat.isDirectory()) for (const entry of io.readdirSync(file)) {
      if (typeof entry !== "string" || !entry || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\0"))
        throw invalidOwnership();
      pending.push(path.join(file, entry));
    }
  }
}

/** Preserve the frozen physical traversal identities. Current engine reads
 * use its checked runtime projection; these parents are never re-grouped.
 * @param {OwnershipReadIO} [io] */
export function adoptCloudEngineRuntimeGroups(io = fs) {
  if (process.geteuid?.() !== 0) throw new Error("Cloud ownership adoption requires root");
  /** @type {Array<[string,number,boolean]>} */
  const entries = [
    ["/srv/zeros/files/.zeros-setup", 0o710, true],
    ["/srv/zeros/managed-settings", 0o750, true],
    ["/srv/zeros/managed-settings/settings.managed.toml", 0o640, false],
    ["/srv/zeros/log", 0o750, true],
    ["/srv/zeros/log/engine.log", 0o640, false],
  ];
  for (const [file, mode, directory] of entries) {
    const stat = optionalStat(file, io);
    if (!stat) continue;
    if (io.realpathSync(file) !== file || stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        stat.uid !== 0 || stat.gid !== 10001 || (stat.mode & 0o7777) !== mode)
      throw invalidOwnership();
    const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
      (directory ? fs.constants.O_DIRECTORY : 0));
    try {
      if (!sameInode(stat, io.fstatSync(fd)) || !sameInode(stat, io.lstatSync(file)) ||
          io.realpathSync(file) !== file) throw invalidOwnership();
    } finally { io.closeSync(fd); }
  }
}

function completedOwnership(io) {
  rootAncestors(ownershipMarker, io);
  let fd;
  try { fd = io.openSync(ownershipMarker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error?.code === "ENOENT") return false; throw invalidOwnership(); }
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== 0 ||
        (stat.mode & 0o7777) !== 0o600 || stat.size !== Buffer.byteLength(ownershipCompletion)) throw invalidOwnership();
    pinnedEntry(ownershipMarker, stat, io);
    if (io.readFileSync(fd, "utf8") !== ownershipCompletion) throw invalidOwnership();
    pinnedEntry(ownershipMarker, stat, io);
    return true;
  } finally { io.closeSync(fd); }
}

function removeOwnershipTemporary(file, created, io) {
  const remaining = optionalStat(file, io);
  if (!remaining) return;
  if (!sameInode(created, remaining) || remaining.nlink !== 1) throw invalidOwnership();
  io.unlinkSync(file);
}

function completeOwnership(io) {
  rootAncestors(ownershipMarker, io);
  const temporary = `${ownershipMarker}.${randomUUID()}.tmp`;
  const fd = io.openSync(temporary, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let created;
  try {
    created = io.fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1 || created.uid !== 0 || created.gid !== 0 ||
        (created.mode & 0o7777) !== 0o600) throw invalidOwnership();
    pinnedEntry(temporary, created, io);
    io.writeFileSync(fd, ownershipCompletion);
    const bytes = Buffer.alloc(Buffer.byteLength(ownershipCompletion));
    if (io.fstatSync(fd).size !== bytes.length || io.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
        bytes.toString("utf8") !== ownershipCompletion) throw invalidOwnership();
    io.fsyncSync(fd);
    pinnedEntry(temporary, created, io);
    if (optionalStat(ownershipMarker, io)) throw invalidOwnership();
    // The original root setup lock serializes publication; the parent is
    // root-owned and inaccessible through the engine's files projection.
    io.renameSync(temporary, ownershipMarker);
    pinnedEntry(ownershipMarker, created, io);
    const parent = path.dirname(ownershipMarker);
    const directory = io.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = io.fstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022) throw invalidOwnership();
      pinnedEntry(parent, stat, io);
      io.fsyncSync(directory);
    } finally { io.closeSync(directory); }
    pinnedEntry(ownershipMarker, created, io);
  } finally {
    try {
      if (created) removeOwnershipTemporary(temporary, created, io);
    } finally { io.closeSync(fd); }
  }
}

/** The original root setup lock and positive retirement remain mandatory on
 * every call. A durable root-only completion prevents rescanning live state
 * on future wakes; interruption before publication leaves adoption retryable.
 * @param {OwnershipStateIO} [io] */
export function adoptCloudEngineState(runtime, io = fs) {
  if (process.geteuid?.() !== 0) throw new Error("Cloud ownership adoption requires root");
  // A missing/malformed/busy scope is a refusal, never an ownership guess.
  new CloudDelegatedCgroups({ runtime }).assertRetired();
  adoptCloudEngineRuntimeGroups(io);
  if (completedOwnership(io)) return;
  adoptCloudEngineHomes(io);
  for (const root of [runtimeLayout.repository,
    path.join(CLOUD_ENGINE_MUTABLE_LAYOUT.legacyStagingParent, "seed"),
    path.join(CLOUD_ENGINE_MUTABLE_LAYOUT.stagingParent, "seed")])
    if (optionalStat(root, io)) adoptCloudEngineTree(root, io);
  prepareCloudEngineRuntimeStaging(io);
  completeOwnership(io);
}

function physicalDirectory(directory, owner, mode, mutable = false) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
    stat.uid !== owner || (!mutable && (stat.mode & 0o022)) || (mode !== undefined && (stat.mode & 0o777) !== mode))
    throw new Error("Unsafe cloud image file directory");
}

/** Only an image builder calls this migration, before attestation/snapshotting.
 * Existing workers retain their immutable layout. Logical engine/checkpoint
 * paths remain unchanged. The allowlisted parent exposes no host authority. */
export function prepareCloudImageFileLayout(layout = runtimeLayout, owners = { root: 0, engine: 10003, worker: 10003 }) {
  const parent = layout.engineFilesRoot;
  if (parent !== path.join(layout.root, "files") || layout.repository !== path.join(parent, "workspace") ||
    layout.attachmentTemporaryRoot !== path.join(parent, "attachment-staging"))
    throw new Error("Unsafe cloud image file layout");
  physicalDirectory(layout.root, owners.root);
  const ensure = (directory, owner, mode) => {
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode });
      chownSync(directory, owner, owner);
      chmodSync(directory, mode);
    }
    physicalDirectory(directory, owner, mode);
  };
  ensure(parent, owners.root, 0o755);
  const allowed = ["workspace", "attachment-staging", "state", "home", "managed-settings"];
  if (readdirSync(parent).some(name => !allowed.includes(name)))
    throw new Error("Unexpected cloud image file projection");
  ensure(path.join(parent, "home"), owners.root, 0o755);
  if (readdirSync(path.join(parent, "home")).some(name => !["agent", "capture"].includes(name)))
    throw new Error("Unexpected cloud image home projection");
  for (const name of ["state", "managed-settings", "home/agent", "home/capture"]) {
    const directory = path.join(parent, name);
    ensure(directory, owners.root, 0o755);
    if (readdirSync(directory).length) throw new Error("Unsafe populated cloud image mount point");
  }
  ensure(layout.attachmentTemporaryRoot, owners.engine, 0o700);
  if (readdirSync(layout.attachmentTemporaryRoot).length)
    throw new Error("Unsafe attachment state in cloud image");
  const legacy = path.join(layout.root, "workspace");
  if (existsSync(legacy)) {
    physicalDirectory(legacy, owners.worker, undefined, true);
    if (existsSync(layout.repository)) throw new Error("Ambiguous cloud image repository layout");
    renameSync(legacy, layout.repository);
  }
  physicalDirectory(layout.repository, owners.worker, undefined, true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.getuid?.() !== 0 || existsSync("/run/zeros/cloud-worker-supervisor.sock") ||
    existsSync("/sys/fs/cgroup/zeros-cloud-engine"))
    throw new Error("Cloud image file migration requires an idle root-owned builder");
  prepareCloudImageFileLayout();
}
