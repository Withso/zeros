import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentDeviceSessions,
  SPRINGBOARD,
  agentDeviceCliPath,
  agentDeviceEnvironment,
  agentDeviceFolders,
  failureReply,
  readAgentDeviceReply,
  spawnAgentDevice,
  type AgentDeviceExecOptions,
  type AgentDeviceReply,
} from "../devices/agent-device";
import {
  deviceFailureText,
  formatDeviceSnapshot,
  formatInstalledApps,
  portraitPoint,
  readActionPoint,
  readDisplayRotation,
  readInstalledApps,
  readSpace,
  uprightPoint,
} from "../devices/agent-device-output";
import { bundleIdForProcess, frontProcessId, readIosFrontApp } from "../devices/ios-front-app";
import { XCRUN, type ToolRunner } from "../devices/tool-runner";

const UDID = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const SESSION = `zeros-${UDID}`;

describe("agent-device location and environment", () => {
  it("runs the unpacked copy in packaged builds and the workspace copy in development", () => {
    const exists = (file: string) => file.endsWith("agent-device.mjs");
    expect(
      agentDeviceCliPath({ packaged: true, resourcesPath: "/App/Resources", repoRoot: "/repo", exists }),
    ).toBe("/App/Resources/app.asar.unpacked/node_modules/agent-device/bin/agent-device.mjs");
    expect(
      agentDeviceCliPath({ packaged: false, resourcesPath: "/App/Resources", repoRoot: "/repo", exists }),
    ).toBe("/repo/node_modules/agent-device/bin/agent-device.mjs");
    expect(
      agentDeviceCliPath({ packaged: true, resourcesPath: "/r", repoRoot: "/repo", exists: () => false }),
    ).toBeNull();
  });

  it("keeps the user's tools but none of agent-device's own configuration or providers", () => {
    const folders = agentDeviceFolders("/data/simulators/agent-device");
    const env = agentDeviceEnvironment(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/someone",
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        AGENT_DEVICE_DAEMON_BASE_URL: "http://example.invalid",
        AGENT_DEVICE_CLAIMS_DIR: "/elsewhere",
        AGENT_DEVICE_STATE_DIR: "/elsewhere",
        LIMRUN_API_KEY: "secret",
        LIM_API_KEY: "secret",
        DEBUG: "*",
        NODE_OPTIONS: "--require /tmp/x.js",
        ELECTRON_RUN_AS_NODE: "0",
      },
      folders,
    );
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/someone",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      ELECTRON_RUN_AS_NODE: "1",
      AGENT_DEVICE_STATE_DIR: "/data/simulators/agent-device/state",
      AGENT_DEVICE_HOME: "/data/simulators/agent-device/home",
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: "/data/simulators/agent-device/runner",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    });
  });

  it("points it at the Android SDK Zeros uses, so both run the same adb", () => {
    const folders = agentDeviceFolders("/data/simulators/agent-device");
    const base = { PATH: "/usr/bin", ANDROID_SDK_ROOT: "/old/sdk", ANDROID_HOME: "/Users/someone/sdk" };
    expect(agentDeviceEnvironment(base, folders, "/Users/someone/sdk")).toMatchObject({
      ANDROID_HOME: "/Users/someone/sdk",
      ANDROID_SDK_ROOT: "/Users/someone/sdk",
    });
    expect(agentDeviceEnvironment(base, folders, null)).toMatchObject({
      ANDROID_HOME: "/Users/someone/sdk",
      ANDROID_SDK_ROOT: "/old/sdk",
    });
  });
});

describe("agent-device replies", () => {
  it("reads its JSON envelope", () => {
    expect(readAgentDeviceReply('{"success":true,"data":{"message":"Home"}}\n')).toEqual({
      ok: true,
      data: { message: "Home" },
    });
    expect(
      readAgentDeviceReply(
        JSON.stringify({
          success: false,
          error: {
            code: "COMMAND_FAILED",
            message: "Ref @e2 belongs to an expired ref frame",
            logPath: "/private/state/requests/1.ndjson",
            details: { reason: "ref_frame_expired" },
          },
        }),
      ),
    ).toEqual({
      ok: false,
      code: "COMMAND_FAILED",
      reason: "ref_frame_expired",
      message: "Ref @e2 belongs to an expired ref frame",
    });
    expect(readAgentDeviceReply('{"success":false}')).toMatchObject({ ok: false, code: "COMMAND_FAILED" });
    for (const stdout of ["", "Usage: agent-device", "{not json", '{"data":{}}', "[]"]) {
      expect(readAgentDeviceReply(stdout)).toBeNull();
    }
  });
});

describe("running agent-device", () => {
  let dir: string;
  let cli: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "zeros-agent-device-"));
    cli = path.join(dir, "fake-cli.mjs");
    await writeFile(
      cli,
      [
        "const args = process.argv.slice(2);",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  if (args[0] === 'sleep') { setTimeout(() => {}, 60_000); return; }",
        "  if (args[0] === 'garbage') { process.stdout.write('not json'); process.exit(3); }",
        "  if (args[0] === 'fail') {",
        "    process.stdout.write(JSON.stringify({ success: false, error: { code: 'DEVICE_IN_USE', message: 'held' } }));",
        "    process.exit(1);",
        "  }",
        "  process.stdout.write(JSON.stringify({ success: true, data: { args, input, cwd: process.cwd(), zeros: process.env.AGENT_DEVICE_HOME } }));",
        "});",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function exec(cliPath: string | null = cli) {
    return spawnAgentDevice({
      execPath: process.execPath,
      cliPath: () => cliPath,
      env: () => ({ ...process.env, AGENT_DEVICE_HOME: "/private-home" }),
      cwd: path.join(dir, "work"),
    });
  }

  it("passes arguments and stdin, and runs in its private folder", async () => {
    const reply = await exec()(["fill", "--text-stdin", "--json", "--", "@e3"], {
      stdin: "héllo -x\n",
      timeoutMs: 10_000,
    });
    expect(reply).toEqual({
      ok: true,
      data: {
        args: ["fill", "--text-stdin", "--json", "--", "@e3"],
        input: "héllo -x\n",
        cwd: await import("node:fs/promises").then((fs) => fs.realpath(path.join(dir, "work"))),
        zeros: "/private-home",
      },
    });
  });

  it("reads failures, and turns silence, timeouts and aborts into its own codes", async () => {
    expect(await exec()(["fail"], { timeoutMs: 10_000 })).toMatchObject({
      ok: false,
      code: "DEVICE_IN_USE",
    });
    expect(await exec()(["garbage"], { timeoutMs: 10_000 })).toMatchObject({ code: "UNREADABLE" });
    expect(await exec()(["sleep"], { timeoutMs: 200 })).toMatchObject({ code: "TIMEOUT" });
    const abort = new AbortController();
    const pending = exec()(["sleep"], { timeoutMs: 10_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    expect(await pending).toMatchObject({ code: "ABORTED" });
    expect(await exec(null)(["apps"], { timeoutMs: 1_000 })).toMatchObject({ code: "UNAVAILABLE" });
  });
});

type ExecCall = { args: readonly string[]; options: AgentDeviceExecOptions };

function fakeExec(answer: (args: readonly string[]) => AgentDeviceReply | Promise<AgentDeviceReply>) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (args: readonly string[], options: AgentDeviceExecOptions) => {
    calls.push({ args, options });
    return answer(args);
  });
  return { exec, calls };
}

const OK: AgentDeviceReply = { ok: true, data: {} };

function sessions(
  answer: (args: readonly string[]) => AgentDeviceReply | Promise<AgentDeviceReply>,
  frontApp: (udid: string) => Promise<string | null> = async () => "com.apple.Preferences",
  files?: ConstructorParameters<typeof AgentDeviceSessions>[0]["files"],
  target?: ConstructorParameters<typeof AgentDeviceSessions>[0]["target"],
) {
  const fake = fakeExec(answer);
  return {
    ...fake,
    sessions: new AgentDeviceSessions({
      exec: fake.exec,
      frontApp,
      workDir: "/work",
      ...(files ? { files } : {}),
      ...(target ? { target } : {}),
    }),
  };
}

const AVD = "Pixel_9_API_37";
const AVD_SESSION = `zeros-${AVD}`;

/** An Android emulator, reached by the serial adb gives it while it runs. */
function androidSessions(
  answer: (args: readonly string[]) => AgentDeviceReply | Promise<AgentDeviceReply>,
  files?: ConstructorParameters<typeof AgentDeviceSessions>[0]["files"],
) {
  const emulator = { serial: "emulator-5554" as string | null };
  const frontApp = vi.fn(async () => "com.example.never");
  const made = sessions(answer, frontApp, files, (deviceId) => {
    if (deviceId !== AVD) return { platform: "ios", udid: deviceId };
    return emulator.serial ? { platform: "android", serial: emulator.serial } : null;
  });
  return { ...made, emulator, frontApp };
}

describe("agent-device sessions", () => {
  it("opens one session per device, bound to the app in front, and keeps flags before --", async () => {
    const { sessions: devices, calls } = sessions(() => OK);
    await devices.run(UDID, { name: "press", flags: ["--double-tap"], operands: ["-12", "40"] });
    await devices.run(UDID, { name: "snapshot", flags: ["-i"] });
    expect(calls.map((call) => call.args)).toEqual([
      ["open", "--session", SESSION, "--platform", "ios", "--udid", UDID, "--json", "--", "com.apple.Preferences"],
      ["press", "--double-tap", "--session", SESSION, "--json", "--", "-12", "40"],
      ["snapshot", "-i", "--session", SESSION, "--json"],
    ]);
  });

  it("binds to the home screen when nothing usable is in front", async () => {
    for (const front of [null, "com.callstack.agentdevice.runner.uitests.xctrunner"]) {
      const { sessions: devices, calls } = sessions(() => OK, async () => front);
      await devices.run(UDID, { name: "home" });
      expect(calls[0]?.args.at(-1)).toBe(SPRINGBOARD);
    }
    const { sessions: failing, calls } = sessions(
      () => OK,
      async () => {
        throw new Error("axe failed");
      },
    );
    await failing.run(UDID, { name: "home" });
    expect(calls[0]?.args.at(-1)).toBe(SPRINGBOARD);
  });

  it("falls back to the home screen when the front app can't be a session app", async () => {
    const { sessions: devices, calls } = sessions((args) =>
      args[0] === "open" && args.at(-1) === "com.apple.iMessageAppsViewService"
        ? failureReply("COMMAND_FAILED", "launch failed")
        : OK,
      async () => "com.apple.iMessageAppsViewService",
    );
    expect(await devices.run(UDID, { name: "home" })).toEqual(OK);
    expect(calls.map((call) => [call.args[0], call.args.at(-1)])).toEqual([
      ["open", "com.apple.iMessageAppsViewService"],
      ["open", SPRINGBOARD],
      ["home", "--json"],
    ]);
  });

  it("treats a session agent-device already has as open, and stops on a device someone else holds", async () => {
    const active = sessions((args) =>
      args[0] === "open" ? failureReply("INVALID_ARGS", 'Session "zeros-x" already active') : OK,
    );
    expect(await active.sessions.run(UDID, { name: "home" })).toEqual(OK);
    const held = sessions((args) => (args[0] === "open" ? failureReply("DEVICE_IN_USE") : OK));
    expect(await held.sessions.run(UDID, { name: "home" })).toMatchObject({ code: "DEVICE_IN_USE" });
    expect(held.calls).toHaveLength(1);
  });

  it("reopens a session agent-device dropped once, but not for app-only commands", async () => {
    let dropped = 0;
    const { sessions: devices, calls } = sessions((args) => {
      if (args[0] === "home" && dropped++ === 0) return failureReply("SESSION_NOT_FOUND");
      return OK;
    });
    expect(await devices.run(UDID, { name: "home" })).toEqual(OK);
    expect(calls.map((call) => call.args[0])).toEqual(["open", "home", "open", "home"]);

    const appOnly = sessions((args) =>
      args[0] === "snapshot"
        ? { ok: false, code: "SESSION_NOT_FOUND", reason: "ios_app_session_required", message: "" }
        : OK,
    );
    expect(await appOnly.sessions.run(UDID, { name: "snapshot" })).toMatchObject({
      reason: "ios_app_session_required",
    });
    expect(appOnly.calls.map((call) => call.args[0])).toEqual(["open", "snapshot"]);
  });

  it("rebinds to the app now in front before commands that act on it", async () => {
    const device = { front: "com.apple.Preferences" as string | null, state: "runningForeground" };
    const frontApp = vi.fn(async () => device.front);
    const { sessions: devices, calls } = sessions(
      (args) => (args[0] === "appstate" ? { ok: true, data: { state: device.state } } : OK),
      frontApp,
    );
    const names = () => calls.splice(0).map((call) => [call.args[0], call.args.at(-1)]);

    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["open", "com.apple.Preferences"],
      ["snapshot", "--json"],
    ]);
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["appstate", "--json"],
      ["snapshot", "--json"],
    ]);
    expect(frontApp).toHaveBeenCalledTimes(1);

    device.front = "com.apple.mobilesafari";
    device.state = "runningBackgroundSuspended";
    await devices.run(UDID, { name: "orientation", operands: ["landscape-left"], followFront: true });
    expect(names()).toEqual([
      ["appstate", "--json"],
      ["open", "com.apple.mobilesafari"],
      ["orientation", "landscape-left"],
    ]);
    await devices.run(UDID, { name: "apps" });
    expect(names()).toEqual([["apps", "--json"]]);
  });

  it("reads the front app every time while bound to the home screen, which always reads as in front", async () => {
    const device = { front: null as string | null };
    const { sessions: devices, calls } = sessions(
      (args) => (args[0] === "appstate" ? { ok: true, data: { state: "runningForeground" } } : OK),
      async () => device.front,
    );
    const names = () => calls.splice(0).map((call) => [call.args[0], call.args.at(-1)]);
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["open", SPRINGBOARD],
      ["snapshot", "--json"],
    ]);
    device.front = SPRINGBOARD;
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([["snapshot", "--json"]]);
    device.front = "com.apple.mobilesafari";
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["open", "com.apple.mobilesafari"],
      ["snapshot", "--json"],
    ]);
  });

  it("keeps a usable binding when the new front app can't be one, and stops when the device is held", async () => {
    const device = { front: "com.apple.Preferences", held: false };
    const { sessions: devices, calls } = sessions((args) => {
      if (args[0] === "appstate") return { ok: true, data: { state: "runningBackground" } };
      if (args[0] === "open" && device.held) return failureReply("DEVICE_IN_USE");
      if (args[0] === "open" && args.at(-1) === "com.apple.iMessageAppsViewService") {
        return failureReply("COMMAND_FAILED", "launch failed");
      }
      return OK;
    }, async () => device.front);
    const names = () => calls.splice(0).map((call) => [call.args[0], call.args.at(-1)]);
    await devices.run(UDID, { name: "home" });
    names();
    device.front = "com.apple.iMessageAppsViewService";
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["appstate", "--json"],
      ["open", "com.apple.iMessageAppsViewService"],
      ["open", SPRINGBOARD],
      ["snapshot", "--json"],
    ]);
    device.front = "com.apple.mobilesafari";
    device.held = true;
    expect(await devices.run(UDID, { name: "snapshot", followFront: true })).toMatchObject({
      code: "DEVICE_IN_USE",
    });
    expect(names()).toEqual([["open", "com.apple.mobilesafari"]]);
  });

  it("binds to the app a URL opened in, or reads the front app next when none is reported", async () => {
    const device = { front: "com.example.deep" };
    const { sessions: devices, calls } = sessions(
      (args) => {
        if (args[0] === "open" && args.at(-1) === "https://example.com") {
          return { ok: true, data: { appBundleId: "com.apple.mobilesafari" } };
        }
        if (args[0] === "appstate") return { ok: true, data: { state: "runningForeground" } };
        return OK;
      },
      async () => device.front,
    );
    const names = () => calls.splice(0).map((call) => [call.args[0], call.args.at(-1)]);
    await devices.openTarget(UDID, "https://example.com");
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["open", "https://example.com"],
      ["appstate", "--json"],
      ["snapshot", "--json"],
    ]);
    await devices.openTarget(UDID, "myapp://settings");
    await devices.run(UDID, { name: "snapshot", followFront: true });
    expect(names()).toEqual([
      ["open", "myapp://settings"],
      ["open", "com.example.deep"],
      ["snapshot", "--json"],
    ]);
  });

  it("opens apps and URLs as the session target", async () => {
    const { sessions: devices, calls } = sessions(() => OK);
    await devices.openTarget(UDID, "com.example.app", { relaunch: true });
    await devices.run(UDID, { name: "home" });
    expect(calls.map((call) => call.args)).toEqual([
      ["open", "--session", SESSION, "--platform", "ios", "--udid", UDID, "--relaunch", "--json", "--", "com.example.app"],
      ["home", "--session", SESSION, "--json"],
    ]);
  });

  it("reads a screenshot from its private folder and always removes the file", async () => {
    const removed: string[] = [];
    const files = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from("png")),
      rm: vi.fn(async (file: string) => {
        removed.push(file);
      }),
    };
    const { sessions: devices, calls } = sessions(
      (args) => (args[0] === "screenshot" ? { ok: true, data: { width: 402, height: 874 } } : OK),
      undefined,
      files,
    );
    const shot = await devices.screenshot(UDID);
    expect(shot).toEqual({ ok: true, png: Buffer.from("png"), data: { width: 402, height: 874 } });
    const file = calls[1]?.args.at(-1) ?? "";
    expect(path.dirname(file)).toBe("/work/screenshots");
    expect(file).toMatch(/\.png$/);
    expect(removed).toEqual([file]);

    files.readFile.mockRejectedValueOnce(new Error("missing"));
    expect(await devices.screenshot(UDID)).toMatchObject({ ok: false, code: "UNREADABLE" });
    expect(removed).toHaveLength(2);
  });

  it("runs one device's commands in order and forgets devices that stopped", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const { sessions: devices, calls } = sessions(async (args) => {
      if (args[0] === "press") {
        order.push("press:start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("press:end");
      }
      if (args[0] === "home") order.push("home");
      return OK;
    });
    const first = devices.run(UDID, { name: "press", operands: ["1", "2"] });
    const second = devices.run(UDID, { name: "home" });
    await vi.waitFor(() => expect(order).toEqual(["press:start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["press:start", "press:end", "home"]);

    devices.keepOnly(new Set());
    await devices.run(UDID, { name: "home" });
    expect(calls.filter((call) => call.args[0] === "open")).toHaveLength(2);
  });

  it("stops the daemon and its runners on quit", async () => {
    const { sessions: devices, calls } = sessions(() => OK);
    await devices.stop();
    expect(calls).toEqual([]);

    await devices.run(UDID, { name: "home" });
    calls.length = 0;
    await devices.stop();
    expect(calls.map((call) => call.args)).toEqual([["daemon", "stop", "--clean", "--json"]]);
  });
});

describe("agent-device sessions on Android", () => {
  it("opens a session on the emulator's serial with no app, and never reads the front app", async () => {
    const { sessions: devices, calls, frontApp } = androidSessions(() => OK);
    await devices.run(AVD, { name: "press", operands: ["540", "1200"], followFront: true });
    await devices.run(AVD, { name: "snapshot", flags: ["-i"], followFront: true });
    expect(calls.map((call) => call.args)).toEqual([
      ["open", "--session", AVD_SESSION, "--platform", "android", "--serial", "emulator-5554", "--json"],
      ["press", "--session", AVD_SESSION, "--json", "--", "540", "1200"],
      ["snapshot", "-i", "--session", AVD_SESSION, "--json"],
    ]);
    expect(frontApp).not.toHaveBeenCalled();
  });

  it("ends the session once an app or URL opens, so no command is tied to one app", async () => {
    const { sessions: devices, calls } = androidSessions((args) =>
      args[0] === "open" && args.at(-1) === "com.example.app"
        ? { ok: true, data: { appBundleId: "com.example.app" } }
        : OK,
    );
    expect(await devices.openTarget(AVD, "com.example.app", { relaunch: true })).toEqual({
      ok: true,
      data: { appBundleId: "com.example.app" },
    });
    await devices.run(AVD, { name: "press", operands: ["@e3"], followFront: true });
    expect(calls.map((call) => call.args)).toEqual([
      [
        "open",
        "--session",
        AVD_SESSION,
        "--platform",
        "android",
        "--serial",
        "emulator-5554",
        "--relaunch",
        "--json",
        "--",
        "com.example.app",
      ],
      ["close", "--session", AVD_SESSION, "--json"],
      ["open", "--session", AVD_SESSION, "--platform", "android", "--serial", "emulator-5554", "--json"],
      ["press", "--session", AVD_SESSION, "--json", "--", "@e3"],
    ]);

    calls.length = 0;
    const missing = failureReply("APP_NOT_INSTALLED");
    const failing = androidSessions((args) => (args[0] === "open" && args.at(-1) === "com.example.gone" ? missing : OK));
    expect(await failing.sessions.openTarget(AVD, "com.example.gone")).toEqual(missing);
    expect(failing.calls.map((call) => call.args[0])).toEqual(["open"]);
  });

  it("replaces a session agent-device still has, such as one on an earlier serial", async () => {
    let active = true;
    const { sessions: devices, calls, emulator } = androidSessions((args) => {
      if (args[0] === "close") active = false;
      if (args[0] === "open" && active) {
        return failureReply("INVALID_ARGS", "Session already active. Close it first or pass a new --session name.");
      }
      if (args[0] === "open") active = true;
      return OK;
    });
    const names = () => calls.splice(0).map((call) => [call.args[0], call.args[6] ?? null]);
    expect(await devices.run(AVD, { name: "home" })).toEqual(OK);
    expect(names()).toEqual([
      ["open", "emulator-5554"],
      ["close", null],
      ["open", "emulator-5554"],
      ["home", null],
    ]);

    emulator.serial = "emulator-5556";
    expect(await devices.run(AVD, { name: "home" })).toEqual(OK);
    expect(names()).toEqual([
      ["close", null],
      ["open", "emulator-5556"],
      ["home", null],
    ]);
  });

  it("refuses an emulator that isn't running without starting agent-device", async () => {
    const { sessions: devices, calls, emulator } = androidSessions(() => OK);
    emulator.serial = null;
    expect(await devices.run(AVD, { name: "home" })).toMatchObject({ ok: false, code: "DEVICE_NOT_FOUND" });
    expect(await devices.openTarget(AVD, "com.example.app")).toMatchObject({ code: "DEVICE_NOT_FOUND" });
    expect(calls).toEqual([]);
    await devices.stop();
    expect(calls).toEqual([]);
  });

  it("captures without demo mode, scaled to the agent's points", async () => {
    const files = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from("png")),
      rm: vi.fn(async () => undefined),
    };
    const { sessions: devices, calls } = androidSessions(
      (args) => (args[0] === "screenshot" ? { ok: true, data: { width: 411, height: 914 } } : OK),
      files,
    );
    expect(await devices.screenshot(AVD, undefined, { scale: 1 / 2.625 })).toMatchObject({
      ok: true,
      data: { width: 411, height: 914 },
    });
    const args = calls[1]?.args ?? [];
    expect(args.slice(0, 7)).toEqual([
      "screenshot",
      "--no-stabilize",
      "--scale",
      "0.380952",
      "--session",
      AVD_SESSION,
      "--json",
    ]);

    const ios = sessions(
      (command) => (command[0] === "screenshot" ? { ok: true, data: { width: 402, height: 874 } } : OK),
      undefined,
      files,
    );
    await ios.sessions.screenshot(UDID);
    expect(ios.calls[1]?.args.slice(0, 4)).toEqual(["screenshot", "--session", SESSION, "--json"]);
  });

  it("ends a session before its emulator shuts down, which gives back the device's own keyboard", async () => {
    const { sessions: devices, calls } = androidSessions(() => OK);
    await devices.close(AVD);
    expect(calls).toEqual([]);
    await devices.run(AVD, { name: "home" });
    calls.length = 0;
    await devices.close(AVD);
    expect(calls.map((call) => call.args)).toEqual([["close", "--session", AVD_SESSION, "--json"]]);
    await devices.run(AVD, { name: "home" });
    expect(calls.map((call) => call.args[0])).toEqual(["close", "open", "home"]);
  });

  it("ends the sessions of emulators that stopped, as their serials may go to other devices", async () => {
    const { sessions: devices, calls } = androidSessions(() => OK);
    await devices.run(AVD, { name: "home" });
    await devices.run(UDID, { name: "home" });
    calls.length = 0;
    devices.keepOnly(new Set());
    devices.keepOnly(new Set());
    await vi.waitFor(() => expect(calls.map((call) => call.args)).toEqual([["close", "--session", AVD_SESSION, "--json"]]));
  });
});

describe("the app in front", () => {
  it("reads the front process from AXe and its bundle ID from launchd", async () => {
    expect(frontProcessId(JSON.stringify([{ pid: 79693, type: "Application" }]))).toBe(79693);
    for (const output of ["", "[]", "[{}]", '[{"pid":-1}]', "nope"]) {
      expect(frontProcessId(output)).toBeNull();
    }
    const jobs = [
      "PID\tStatus\tLabel",
      "-\t0\tcom.apple.progressd",
      "47139\t0\tcom.apple.SpringBoard",
      "79693\t0\tUIKitApplication:com.apple.Preferences[a6da][rb-legacy]",
    ].join("\n");
    expect(bundleIdForProcess(jobs, 79693)).toBe("com.apple.Preferences");
    expect(bundleIdForProcess(jobs, 47139)).toBe(SPRINGBOARD);
    expect(bundleIdForProcess(jobs, 1)).toBeNull();

    const run: ToolRunner = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === "/axe" && args[0] === "describe-ui") return { stdout: '[{"pid":79693}]', stderr: "" };
      if (file === XCRUN) return { stdout: jobs, stderr: "" };
      throw new Error("unexpected");
    });
    expect(await readIosFrontApp(run, "/axe", UDID)).toBe("com.apple.Preferences");
    expect(run).toHaveBeenCalledWith(XCRUN, ["simctl", "spawn", UDID, "launchctl", "list"], expect.anything());
    expect(await readIosFrontApp(run, null, UDID)).toBeNull();
  });

  it("asks AXe and launchd at once, each about a second", async () => {
    const started: string[] = [];
    let answerJobs: (stdout: string) => void = () => undefined;
    const run: ToolRunner = vi.fn((file: string, args: readonly string[]) => {
      started.push(file === XCRUN ? "launchctl" : String(args[0]));
      if (file !== XCRUN) return Promise.resolve({ stdout: '[{"pid":79693}]', stderr: "" });
      return new Promise<{ stdout: string; stderr: string }>((resolve) => {
        answerJobs = (stdout) => resolve({ stdout, stderr: "" });
      });
    });
    const front = readIosFrontApp(run, "/axe", UDID);
    expect([...started].sort()).toEqual(["describe-ui", "launchctl"]);
    answerJobs("79693\t0\tUIKitApplication:com.apple.Preferences[a6da][rb-legacy]");
    expect(await front).toBe("com.apple.Preferences");

    // With no front process, launchd's answer, or failure, goes unused.
    const failing: ToolRunner = vi.fn(async (file: string) => {
      if (file === XCRUN) throw new Error("launchctl failed");
      return { stdout: "[]", stderr: "" };
    });
    expect(await readIosFrontApp(failing, "/axe", UDID)).toBeNull();
    const broken: ToolRunner = vi.fn(async (file: string) => {
      if (file === XCRUN) throw new Error("launchctl failed");
      return { stdout: '[{"pid":79693}]', stderr: "" };
    });
    await expect(readIosFrontApp(broken, "/axe", UDID)).rejects.toThrow("launchctl failed");
  });
});

describe("what agents read", () => {
  it("lists elements with refs, nesting, values and states, and nothing internal", () => {
    const text = formatDeviceSnapshot({
      appName: "Settings",
      appBundleId: "com.apple.Preferences",
      nodes: [
        { index: 0, ref: "e1", kind: "other", label: "Settings", depth: 0 },
        { index: 1, parentIndex: 0, ref: "e2", kind: "collection", hiddenContentBelow: true },
        { index: 2, parentIndex: 1, ref: "e3", kind: "text", label: "No Results for “Wi-Fi”" },
        {
          index: 3,
          parentIndex: 0,
          ref: "e4",
          kind: "search",
          label: "Search",
          value: "Wi-Fi ünïcode",
          placeholder: "Search",
          focused: true,
        },
        { index: 4, parentIndex: 1, ref: "e5", kind: "cell", label: "Wi-Fi", focused: true },
        { index: 5, ref: "e6", kind: "element(44)", label: "Maps", enabled: false },
        { index: 6, ref: "bogus", kind: "button", label: "Skipped" },
      ],
      visibility: { reasons: ["scroll-hidden-below"] },
      keyboard: { kind: "visible" },
      warnings: ["Simulator AX snapshot unavailable (circuit-disabled)"],
      snapshotDiagnostics: { path: "/private/state" },
    });
    expect(text).toBe(
      [
        "Settings (com.apple.Preferences), 6 elements:",
        '@e1 [other] "Settings"',
        "  @e2 [collection] (more below)",
        '    @e3 [text] "No Results for “Wi-Fi”"',
        '  @e4 [search] "Search" value="Wi-Fi ünïcode" (editable, focused)',
        '    @e5 [cell] "Wi-Fi"',
        '@e6 [icon] "Maps" (disabled)',
        "More content is off screen; scroll to reach it.",
        "The keyboard is showing.",
      ].join("\n"),
    );
    const long = formatDeviceSnapshot({
      appBundleId: "com.apple.mobilesafari",
      nodes: [{ ref: "e1", kind: "cell", label: "x".repeat(400) }],
      truncated: true,
    });
    expect(long).toContain("com.apple.mobilesafari, 1 element:");
    expect(long).toContain(`"${"x".repeat(159)}…"`);
    expect(long).toContain("The app's element tree was cut short.");
  });

  it("names the Android app whose window is in front, and shows hints as placeholders", () => {
    const text = formatDeviceSnapshot({
      nodes: [
        { index: 0, ref: "e1", kind: "button", label: "Back", bundleId: "com.google.android.settings.intelligence" },
        {
          index: 1,
          ref: "e2",
          kind: "text-field",
          type: "android.widget.EditText",
          label: "Search settings",
          value: "Search settings",
          placeholder: "Search settings",
          hintShowing: true,
          editable: true,
          focused: true,
          bundleId: "com.google.android.settings.intelligence",
        },
        { index: 2, ref: "e3", kind: "edittext", label: "Name", value: "Ada", editable: true },
        { index: 3, ref: "e4", kind: "text", label: "Battery", bundleId: "com.android.systemui" },
      ],
      viewport: { width: 1080, height: 2400 },
    });
    expect(text).toBe(
      [
        "com.google.android.settings.intelligence, 4 elements:",
        '@e1 [button] "Back"',
        '@e2 [text-field] placeholder="Search settings" (editable, focused)',
        '@e3 [edittext] "Name" value="Ada" (editable)',
        '@e4 [text] "Battery"',
      ].join("\n"),
    );
    expect(formatDeviceSnapshot({ nodes: [] })).toBe("The app, 0 elements:");
  });

  it("lists installed apps without agent-device's runner", () => {
    const apps = readInstalledApps({
      apps: [
        "AgentDeviceRunnerUITests-Runner (com.callstack.agentdevice.runner.uitests.xctrunner)",
        "AgentDeviceRunner (com.callstack.agentdevice.runner)",
        "Imehelper (com.callstack.agentdevice.imehelper)",
        "My App (com.example.my-app)",
        { name: "Safari", bundleId: "com.apple.mobilesafari" },
        "garbage line",
      ],
    });
    expect(apps).toEqual([
      { name: "My App", bundleId: "com.example.my-app" },
      { name: "Safari", bundleId: "com.apple.mobilesafari" },
    ]);
    expect(formatInstalledApps(apps, "iPhone 17", false)).toBe(
      ["Apps on iPhone 17:", "- My App (com.example.my-app)", "- Safari (com.apple.mobilesafari)"].join("\n"),
    );
    expect(formatInstalledApps([], "iPhone 17", false)).toBe(
      "No apps of your own are installed on iPhone 17. Pass all to include the built-in apps.",
    );
  });

  it("reads sizes, rotation and pressed points", () => {
    expect(readSpace({ width: 402, height: 874 }, "screenshot")).toEqual({ width: 402, height: 874 });
    expect(readSpace({ referenceWidth: 874, referenceHeight: 402 }, "action")).toEqual({
      width: 874,
      height: 402,
    });
    expect(readSpace({ width: 0, height: 874 }, "screenshot")).toBeNull();
    expect(readDisplayRotation({ displayRotation: "landscape-left" })).toBe("landscape-left");
    expect(readDisplayRotation({ displayRotation: "sideways" })).toBeNull();
    expect(readActionPoint({ x: 201, y: 319 })).toEqual({ x: 201, y: 319 });
    expect(readActionPoint({ x: "1", y: 2 })).toBeNull();
    // An Android pinch reports its center as where its fingers start.
    expect(readActionPoint({ from: { x: 540, y: 1200 }, to: { x: 540, y: 1200 } })).toEqual({
      x: 540,
      y: 1200,
    });
  });

  it("moves points from a turned app onto the portrait screen", () => {
    const landscape = { width: 874, height: 402 };
    expect(portraitPoint({ x: 100, y: 50 }, { width: 402, height: 874 }, "landscape-left")).toEqual({
      x: 100,
      y: 50,
    });
    expect(portraitPoint({ x: 100, y: 50 }, null, "landscape-left")).toEqual({ x: 100, y: 50 });
    expect(portraitPoint({ x: 100, y: 50 }, landscape, "landscape-left")).toEqual({ x: 352, y: 100 });
    expect(portraitPoint({ x: 100, y: 50 }, landscape, "landscape-right")).toEqual({ x: 50, y: 774 });
    expect(portraitPoint({ x: 900, y: 500 }, landscape, "landscape-left")).toEqual({ x: 0, y: 874 });
    const portrait = { width: 402, height: 874 };
    expect(portraitPoint({ x: 100, y: 50 }, portrait, "portrait-upside-down")).toEqual({ x: 100, y: 50 });
    expect(portraitPoint({ x: 100, y: 50 }, portrait, "portrait-upside-down", true)).toEqual({
      x: 302,
      y: 824,
    });
    expect(portraitPoint({ x: 100, y: 50 }, portrait, "portrait", true)).toEqual({ x: 100, y: 50 });
  });

  it("moves points from the portrait screen back into a turned app", () => {
    const landscape = { width: 874, height: 402 };
    const portrait = { width: 402, height: 874 };
    expect(uprightPoint({ x: 352, y: 100 }, landscape, "landscape-left")).toEqual({ x: 100, y: 50 });
    expect(uprightPoint({ x: 50, y: 774 }, landscape, "landscape-right")).toEqual({ x: 100, y: 50 });
    expect(uprightPoint({ x: 100, y: 50 }, portrait, "landscape-left")).toEqual({ x: 100, y: 50 });
    expect(uprightPoint({ x: 100, y: 50 }, null, "landscape-left")).toEqual({ x: 100, y: 50 });
    expect(uprightPoint({ x: 302, y: 824 }, portrait, "portrait-upside-down", true)).toEqual({
      x: 100,
      y: 50,
    });
    expect(uprightPoint({ x: 500, y: -10 }, landscape, "landscape-left")).toEqual({ x: 0, y: 0 });
    for (const orientation of ["landscape-left", "landscape-right"] as const) {
      for (const point of [
        { x: 0, y: 0 },
        { x: 10, y: 390 },
        { x: 800, y: 200 },
      ]) {
        expect(
          uprightPoint(portraitPoint(point, landscape, orientation), landscape, orientation),
        ).toEqual(point);
      }
    }
  });

  it("writes its own failure text and passes on only short, pathless messages", () => {
    const failure = (code: string, reason: string | null = null, message = "") => ({
      ok: false as const,
      code,
      reason,
      message,
    });
    expect(deviceFailureText(failure("COMMAND_FAILED", "ref_frame_expired", "/x/y"), "iPhone 17")).toBe(
      "That ref is from an older screen. Take a new snapshot and use its refs.",
    );
    expect(deviceFailureText(failure("DEVICE_IN_USE"), "iPhone 17")).toBe(
      "Another automation tool is using iPhone 17. End it and try again.",
    );
    expect(deviceFailureText(failure("TIMEOUT"), "iPhone 17")).toBe(
      "iPhone 17 didn't respond in time. Try again.",
    );
    expect(
      deviceFailureText(failure("UNSUPPORTED_OPERATION", null, "Unable to dismiss the iOS keyboard"), "iPhone 17"),
    ).toBe("Unable to dismiss the iOS keyboard");
    expect(deviceFailureText(failure("TOOL_MISSING"), "iPhone 17")).toBe(
      "Xcode's command-line tools are missing, so Zeros can't control simulators.",
    );
    expect(deviceFailureText(failure("TOOL_MISSING"), "Pixel 9", "android")).toBe(
      "The Android SDK's platform tools are missing, so Zeros can't control Android simulators.",
    );
    for (const message of [
      "App binary not found: /Users/someone/app.app",
      "failed\nstack trace",
      "see ~/.agent-device/daemon.log",
      "x".repeat(301),
      "",
    ]) {
      expect(deviceFailureText(failure("COMMAND_FAILED", null, message), "iPhone 17")).toBe(
        "The action on iPhone 17 failed.",
      );
    }
  });
});

describe("agent-device screenshot folder", () => {
  it("leaves no files behind in a real folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "zeros-agent-device-shots-"));
    try {
      const devices = new AgentDeviceSessions({
        exec: async (args) => {
          if (args[0] === "screenshot") await writeFile(String(args.at(-1)), "png");
          return OK;
        },
        frontApp: async () => null,
        workDir: dir,
      });
      const shot = await devices.screenshot(UDID);
      expect(shot).toMatchObject({ ok: true, png: Buffer.from("png") });
      expect(await readdir(path.join(dir, "screenshots"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
