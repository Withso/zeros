#!/usr/bin/env node
// One background launch per key, with a recoverable marker. A transport
// timeout never authorizes a second launch; inspect the existing marker/log.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectNativeSourceManifest, nativeProcessAlive, writeNativeJson } from "./design-native-run.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [key, ...args] = process.argv.slice(2);
assert.equal(process.platform, "darwin", "Native qualification requires macOS.");
assert(/^[a-z0-9-]{1,80}$/.test(key ?? ""), "Supply a unique launch key.");
const digestIndex = args.indexOf("--source-digest");
const digest = digestIndex >= 0 ? args[digestIndex + 1] : undefined;
assert(/^[a-f0-9]{64}$/.test(digest ?? ""), "A recorded source digest is required.");
const root = path.join(repo, ".context/design-native");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const marker = path.join(root, `${key}-launch.json`);
if (fs.existsSync(marker)) {
  const stat = fs.lstatSync(marker);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, "Inspect the invalid launch marker.");
  const previous = JSON.parse(fs.readFileSync(marker, "utf8"));
  console.log(JSON.stringify({ ...previous, alive: nativeProcessAlive(previous.pid), existing: true }));
  process.exit(0);
}
assert.equal(collectNativeSourceManifest(repo).digest, digest, "Wait for the verified source files to sync.");
const launch = { stage: "launching", pid: process.pid, startedAt: new Date().toISOString(), sourceDigest: digest };
fs.writeFileSync(marker, JSON.stringify(launch), { flag: "wx", mode: 0o600 });
let log;
try {
  log = fs.openSync(path.join(root, `${key}-launch.log`), "wx", 0o600);
  const child = spawn(process.execPath, [path.join(repo, "scripts/design-native-run.mjs"), ...args],
    { cwd: repo, detached: true, stdio: ["ignore", log, log] });
  child.once("error", error => {
    launch.stage = "failed"; launch.error = error.message; writeNativeJson(marker, launch);
    fs.closeSync(log); console.error(error.message); process.exitCode = 1;
  });
  child.once("spawn", () => {
    launch.stage = "launched"; launch.pid = child.pid; writeNativeJson(marker, launch);
    fs.closeSync(log); child.unref(); console.log(JSON.stringify(launch));
  });
} catch (error) {
  launch.stage = "failed"; launch.error = error.message; writeNativeJson(marker, launch);
  if (log !== undefined) fs.closeSync(log);
  throw error;
}
