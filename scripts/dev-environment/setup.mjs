#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { developmentProfilePath } from "./profile-path.mjs";
import { importDevelopmentProfile, inspectDevelopmentProfile } from "./setup-profile.mjs";
import { developmentHome, privateDirectory, systemEnvironment, writePrivateFile } from "./state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const check = args.includes("--check"), profileOnly = args.includes("--profile-only");
const profileIndex = args.indexOf("--profile");
const source = profileIndex < 0 ? developmentProfilePath(root) : path.resolve(args[profileIndex + 1]);
const packageManager = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).packageManager;
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) throw new Error("Expected an exact pnpm packageManager version");
const pnpmVersion = packageManager.slice("pnpm@".length);
const env = systemEnvironment();
const nodeBin = process.env.ZEROS_DEV_SETUP_NODE_BIN ?? path.dirname(process.execPath);

function version(command) {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8", stdio: "pipe" });
  return result.status === 0 ? result.stdout.trim() : null;
}
function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed; fix the reported tool/dependency error and rerun setup`);
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function installShellPath(directory, toolsBin) {
  const file = path.join(directory, "shell-env.sh");
  writePrivateFile(file, `# Installed by Zeros Dev setup. No credentials belong here.\nexport PATH=${quote(toolsBin)}:${quote(nodeBin)}:"$PATH"\n`);
  const line = `[ -r ${quote(file)} ] && . ${quote(file)}`;
  for (const name of [".zprofile", ".bash_profile"]) {
    const target = path.join(os.homedir(), name);
    // Preserve the existing shell profile; reject links and other owners.
    const fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0 || stat.size > 128 * 1024) {
        throw new Error("Shell profile must be a user-owned regular file without group/other write access");
      }
      if (!fs.readFileSync(fd, "utf8").split("\n").includes(line)) {
        fs.writeSync(fd, `\n# Zeros Dev tools\n${line}\n`); fs.fsyncSync(fd);
      }
    } finally { fs.closeSync(fd); }
  }
}

function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const issues = inspectDevelopmentProfile(source).issues;
  if (major < 22 || (major === 22 && minor < 18) || (!profileOnly && major !== 22)) {
    issues.push("Use Node 22.18 or newer in the 22.x release line, matching CI/backend. Run bash scripts/setup-zeros-dev.sh to install it.");
  }
  if (check) {
    if (version("pnpm") !== pnpmVersion) issues.push(`Install ${packageManager}`);
    if (!version("bun")) issues.push("Install Bun");
    if (!version("python3")) issues.push("Install Python 3 for native module builds");
    for (const [command, arguments_] of [["xcode-select", ["-p"]], ["xcrun", ["--find", "clang"]]]) {
      if (spawnSync(command, arguments_, { env, stdio: "pipe" }).status !== 0) issues.push("Install Xcode Command Line Tools");
    }
    if (issues.length) throw new Error([...new Set(issues)].join("\n"));
    console.log("[zeros-dev] Tools and profile format are ready. Provider access and launch/archive still require live qualification.");
    return;
  }
  if (issues.length) throw new Error(issues.join("\n"));
  importDevelopmentProfile({ root, source });
  console.log("[zeros-dev] Profile imported with mode 0600 into ~/.zeros-dev, the main clone and this checkout. Registry key preserved.");
  if (profileOnly) return;

  const directory = developmentHome(), prefix = privateDirectory(directory, "tools"), toolsBin = path.join(prefix, "bin");
  env.PATH = `${toolsBin}:${nodeBin}:${env.PATH ?? ""}`;
  const packages = [];
  if (version("pnpm") !== pnpmVersion) packages.push(packageManager);
  if (!version("bun")) packages.push("bun");
  if (packages.length) run("npm", ["install", "--global", "--prefix", prefix, ...packages], directory);
  if (version("pnpm") !== pnpmVersion || !version("bun")) throw new Error("Installed tools could not be verified; rerun setup after checking PATH");
  installShellPath(directory, toolsBin);
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["--dir", "apps/control-plane", "install", "--frozen-lockfile"]);
  run("npm", ["--prefix", "apps/web", "ci"]);
  run(process.execPath, ["--import", "tsx", "scripts/dev-environment/setup-native.ts"]);
  console.log("[zeros-dev] Setup complete. Open a new terminal, then run pnpm electron:dev in this checkout. No hosted resources were provisioned by setup.");
}

try { main(); }
catch (error) {
  // Never print raw filesystem/JSON error objects, argv, environment or profile.
  const message = error instanceof Error && !error.code ? error.message : "Local setup could not complete; check file ownership, permissions and available tools";
  console.error(`[zeros-dev] ${message}`); process.exitCode = 1;
}
