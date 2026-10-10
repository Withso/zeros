import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

// Exercise the installed shell blocks with explicit metadata IO. All ownership
// operations are intercepted; the launcher and privileged paths never execute.
const source = readFileSync(path.resolve("scripts/cloud-workspace-validation/sandbox/start-engine.sh"), "utf8");
const identities = source.split("\n").filter(line => /^[A-Z_]*(?:UID|GID)="?[0-9]+"?$/.test(line)).join("\n");
const settingsStart = source.indexOf('  if [[ ! -d "$SETTINGS_DIRECTORY"');
const settingsEnd = source.indexOf('  export ZEROS_USER_SETTINGS_DIR=', settingsStart);
const logStart = source.indexOf('if [[ ! -e "$LOG" ]]');
const logEnd = source.indexOf('\necho "[start-engine] runtime=', logStart);
if ([settingsStart, settingsEnd, logStart, logEnd].some(index => index < 0)) {
  throw new Error("Installed startup guard extraction changed");
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runSettings(directoryIdentity = "0:10001:750", fileIdentity = "0:10001:640:1") {
  const root = mkdtempSync(path.join(os.tmpdir(), "zeros-start-settings-"));
  roots.push(root);
  const directory = path.join(root, "settings");
  mkdirSync(directory, { mode: 0o750 });
  writeFileSync(path.join(directory, "settings.managed.toml"), "# fixture settings\n");
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail
${identities}
SETTINGS_DIRECTORY="$START_SETTINGS_DIRECTORY"
stat() {
  case "$2" in
    '%u:%g:%a') printf '%s' "$START_DIRECTORY_IDENTITY";;
    '%u:%g:%a:%h') printf '%s' "$START_FILE_IDENTITY";;
    *) return 97;;
  esac
}
${source.slice(settingsStart, settingsEnd)}
printf '%s:%s' "$ENGINE_UID" "$ENGINE_GID"
`], {
    env: {
      PATH: "/usr/bin:/bin",
      START_SETTINGS_DIRECTORY: directory,
      START_DIRECTORY_IDENTITY: directoryIdentity,
      START_FILE_IDENTITY: fileIdentity,
    },
    encoding: "utf8",
  });
}

function runLog(kind: "existing" | "missing" | "symlink") {
  const root = mkdtempSync(path.join(os.tmpdir(), "zeros-start-log-"));
  roots.push(root);
  const file = path.join(root, "engine.log");
  const target = path.join(root, "other.log");
  if (kind === "symlink") {
    writeFileSync(target, "original\n");
    symlinkSync("other.log", file);
  } else if (kind === "existing") writeFileSync(file, "original\n", { mode: 0o640 });
  const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail
${identities}
LOG="$START_ENGINE_LOG"
chown() { printf 'chown %s\\n' "$1"; }
chmod() { printf 'chmod %s\\n' "$1"; }
install() { printf 'install'; printf ' %s' "$@"; printf '\\n'; }
${source.slice(logStart, logEnd)}
`], { env: { PATH: "/usr/bin:/bin", START_ENGINE_LOG: file }, encoding: "utf8" });
  if (kind !== "missing") expect(readFileSync(kind === "symlink" ? target : file, "utf8")).toBe("original\n");
  return result;
}

it("admits frozen root:10001 settings while retaining engine 10003:10003", () => {
  const result = runSettings();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("10003:10003");
});

it.each([
  ["current engine group on the host parent", "0:10003:750", "0:10001:640:1"],
  ["current engine group on the host file", "0:10001:750", "0:10003:640:1"],
  ["foreign owner", "10003:10001:750", "0:10001:640:1"],
  ["writable parent", "0:10001:770", "0:10001:640:1"],
  ["writable file", "0:10001:750", "0:10001:660:1"],
  ["hardlinked file", "0:10001:750", "0:10001:640:2"],
])("refuses %s without changing the settings", (_label, directoryIdentity, fileIdentity) => {
  expect(runSettings(directoryIdentity, fileIdentity).status).not.toBe(0);
});

it("keeps an existing physical log root:10001 for subsequent adoption", () => {
  const result = runLog("existing");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("chown root:10001\nchmod 0640\n");
});

it("creates a missing physical log root:10001 with the frozen mode", () => {
  const result = runLog("missing");
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^install -o root -g 10001 -m 0640 \/dev\/null /);
});

it("refuses a symbolic log without changing its target", () => {
  const result = runLog("symlink");
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
});
