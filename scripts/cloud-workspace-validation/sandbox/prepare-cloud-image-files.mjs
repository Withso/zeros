#!/usr/bin/env node
import {
  chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync,
  realpathSync, renameSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };

function physicalDirectory(directory, owner, mode, mutable = false) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
    stat.uid !== owner || (!mutable && (stat.mode & 0o022)) || (mode !== undefined && (stat.mode & 0o777) !== mode))
    throw new Error("Unsafe cloud image file directory");
}

/** Only an image builder calls this migration, before attestation/snapshotting.
 * Existing workers retain their immutable layout. Logical engine/checkpoint
 * paths remain unchanged. The allowlisted parent exposes no host authority. */
export function prepareCloudImageFileLayout(layout = runtimeLayout, owners = { root: 0, engine: 10003, worker: 10001 }) {
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
  if (process.getuid() !== 0 || existsSync("/run/zeros/cloud-worker-supervisor.sock") ||
    existsSync("/sys/fs/cgroup/zeros-cloud-engine"))
    throw new Error("Cloud image file migration requires an idle root-owned builder");
  prepareCloudImageFileLayout();
}
