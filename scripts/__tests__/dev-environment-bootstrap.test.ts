import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { systemEnvironment } from "../dev-environment/state.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts/setup-zeros-dev.sh");
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function invoke(args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-bootstrap-")); homes.push(home);
  return { home, result: spawnSync("bash", [script, ...args], { cwd: root, env: { ...systemEnvironment(), HOME: home }, encoding: "utf8" }) };
}

describe("new-machine Dev entrypoint", () => {
  it("forwards no options safely under nounset, including macOS Bash 3.2", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-bootstrap-shell-")); homes.push(directory);
    fs.writeFileSync(path.join(directory, "node"), '#!/bin/sh\n[ "$1" = -e ]\n', { mode: 0o755 });
    const mocks = path.join(directory, "tools.sh");
    fs.writeFileSync(mocks, `
uname() { case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) return 91 ;; esac; }
id() { echo 1000; }
xcode-select() { return 0; }
xcrun() { return 0; }
python3() { return 0; }
node() { [ "$1" = -e ]; }
brew() { echo 'Unexpected installer call' >&2; return 91; }
exec() {
  [ "$#" = 2 ] && [ "$1" = node ] && [[ "$2" = */scripts/dev-environment/setup.mjs ]] || return 92
  echo 'Forwarded zero setup options'
}
`, { mode: 0o600 });
    const result = spawnSync("/bin/bash", [script], { cwd: root, env: { ...systemEnvironment(), PATH: `${directory}:${process.env.PATH}`, BASH_ENV: mocks }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Forwarded zero setup options\n");
  });

  it("shows help without requiring tools, credentials or modifying the home", () => {
    const { home, result } = invoke(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--profile");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.each([["--profile"], ["--unknown"], ["--check", "--profile-only"], ["--profile", "--check"], ["--profile", "one", "--profile", "two"]])("rejects invalid flags before installing anything: %s", (...args) => {
    const { home, result } = invoke(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.skipIf(process.platform === "darwin")("refuses desktop installation on Linux before provisioning or changing files", () => {
    const { home, result } = invoke([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires an Apple silicon Mac");
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
