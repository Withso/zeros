import { cpSync, chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stageDependencyClosure } from "../runtime-bundle/closure";
import { assertPrivateNamespace } from "./runtime-contract";

// Source sandboxes can have a usable N-API prebuild but no source-build slot.
// Shipping's closure expects that slot. Project it only in this private
// staging namespace; neither pnpm's store nor publication code is changed.
const [source, stage, outer, uid] = process.argv.slice(2);
assertPrivateNamespace({ outer, current: readlinkSync("/proc/self/ns/mnt"), uid: process.getuid!() });
const require = createRequire(path.join(source, "package.json"));
const pkg = path.dirname(require.resolve("better-sqlite3/package.json"));
const shadow = path.join(path.dirname(stage), "sqlite-source-fixture");
cpSync(pkg, shadow, { recursive: true, dereference: false });
execFileSync("/usr/bin/mount", ["--bind", shadow, pkg], { stdio: "pipe" });
mkdirSync(`${pkg}/build/Release`, { recursive: true });
cpSync(`${pkg}/prebuilds/linux-x64.node`, `${pkg}/build/Release/better_sqlite3.node`);
const packages = await stageDependencyClosure(source, stage);
function restore(directory: string) {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink()) return;
  chownSync(directory, Number(uid), Number(uid));
  if (metadata.isDirectory()) for (const name of readdirSync(directory)) restore(path.join(directory, name));
}
restore(stage);
process.stdout.write(JSON.stringify({ packageCount: packages.length, sqliteSource: "sandbox_napi_prebuild_fixture" }));
