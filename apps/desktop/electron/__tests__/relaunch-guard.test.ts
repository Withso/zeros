// The real script runs under /bin/sh against real processes: a SIGSTOP'd
// process reports state T exactly like a relaunch LaunchServices abandoned.
// Only the macOS process listing and `open` are shims.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appBundleForExecutable,
  startUpdateRelaunchGuard,
} from "../relaunch-guard";

const FAST = {
  intervalSeconds: 0.05,
  exitWaitTicks: 100,
  watchTicks: 200,
  stuckTicks: 4,
};

let dir = "";
let registry = "";
let listed = "";
let opened = "";
let logPath = "";
let executable = "";
let bundle = "";
const sleepers: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return stat !== "" && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function sleeper(options: { stopped?: boolean } = {}) {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  sleepers.push(child);
  const pid = child.pid!;
  if (options.stopped) {
    process.kill(pid, "SIGSTOP");
    await until(() =>
      execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
      }).startsWith("T"),
    );
  }
  fs.appendFileSync(registry, `${pid}\n`);
  return pid;
}

function shim(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** Lists every registered live process as an instance of the app executable,
 *  in the `pid stat comm` shape macOS `ps -axww -o pid= -o stat= -o comm=`
 *  prints, using the real kernel state. The marker is written after the
 *  registry is read, so it proves the guard's pre-restart snapshot is taken. */
function psShim(): string {
  return shim(
    "ps",
    `while read -r pid; do
  [ -n "$pid" ] || continue
  stat=$(ps -o stat= -p "$pid" 2>/dev/null) || continue
  printf '%s %s %s\\n' "$pid" "$stat" '${executable}'
done < '${registry}'
: >> '${listed}'`,
  );
}

function openShim(next: "running" | "stopped"): string {
  return shim(
    "open",
    `printf '%s\\n' "$*" >> '${opened}'
sleep 30 >/dev/null 2>&1 &
child=$!
${next === "stopped" ? 'kill -STOP "$child"' : ":"}
printf '%s\\n' "$child" >> '${registry}'`,
  );
}

function openedApps(): string[] {
  return fs.existsSync(opened)
    ? fs.readFileSync(opened, "utf8").split("\n").filter(Boolean)
    : [];
}

async function guard(
  oldPid: number,
  next: "running" | "stopped" = "running",
  timing = FAST,
) {
  const child = startUpdateRelaunchGuard({
    platform: "darwin",
    executable,
    pid: oldPid,
    logPath,
    timing,
    psPath: psShim(),
    openPath: openShim(next),
  });
  expect(child).not.toBeNull();
  let exited = false;
  child!.once("exit", () => {
    exited = true;
  });
  await until(() => fs.existsSync(listed));
  return { finished: () => until(() => exited) };
}

describe.skipIf(process.platform === "win32")("update relaunch guard", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-relaunch-guard-"));
    registry = path.join(dir, "registry");
    listed = path.join(dir, "listed");
    opened = path.join(dir, "opened");
    logPath = path.join(dir, "main.log");
    bundle = path.join(dir, "Zeros Alpha.app");
    executable = path.join(bundle, "Contents", "MacOS", "Zeros Alpha");
    fs.writeFileSync(registry, "");
  });

  afterEach(() => {
    const pids = fs
      .readFileSync(registry, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const child of sleepers.splice(0)) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("kills a relaunch left suspended after the update and reopens the app", async () => {
    const oldApp = await sleeper();
    const oldEngine = await sleeper();
    const pausedBeforeUpdate = await sleeper({ stopped: true });
    const run = await guard(oldApp);

    process.kill(oldApp, "SIGTERM");
    const abandoned = await sleeper({ stopped: true });
    await run.finished();

    expect(alive(abandoned)).toBe(false);
    expect(openedApps()).toEqual([bundle]);
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      `relaunch guard: pid ${abandoned} stayed suspended after the update relaunch; reopening`,
    );
    expect(alive(oldEngine)).toBe(true);
    expect(alive(pausedBeforeUpdate)).toBe(true);
  });

  it("leaves a healthy relaunch alone", async () => {
    const oldApp = await sleeper();
    const run = await guard(oldApp);

    process.kill(oldApp, "SIGTERM");
    const relaunched = await sleeper();
    await run.finished();

    expect(alive(relaunched)).toBe(true);
    expect(openedApps()).toEqual([]);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("stops after two reopen attempts when each relaunch is abandoned", async () => {
    const oldApp = await sleeper();
    const run = await guard(oldApp, "stopped");

    process.kill(oldApp, "SIGTERM");
    await sleeper({ stopped: true });
    await run.finished();

    expect(openedApps()).toEqual([bundle, bundle]);
  });

  it("gives up without acting when the app never quits", async () => {
    const oldApp = await sleeper();
    const run = await guard(oldApp, "running", { ...FAST, exitWaitTicks: 10 });

    await run.finished();

    expect(alive(oldApp)).toBe(true);
    expect(openedApps()).toEqual([]);
  });

  it("arms only for a macOS app bundle executable", () => {
    expect(
      appBundleForExecutable(
        "/Applications/Zeros Alpha.app/Contents/MacOS/Zeros Alpha",
      ),
    ).toBe("/Applications/Zeros Alpha.app");
    expect(appBundleForExecutable("/usr/local/bin/node")).toBeNull();
    expect(
      appBundleForExecutable("/Applications/Zeros.app/Contents/Resources/x"),
    ).toBeNull();
    expect(
      startUpdateRelaunchGuard({ platform: "linux", executable }),
    ).toBeNull();
    expect(
      startUpdateRelaunchGuard({
        platform: "darwin",
        executable: "/usr/local/bin/node",
      }),
    ).toBeNull();
  });
});
