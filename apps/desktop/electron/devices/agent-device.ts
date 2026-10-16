// agent-device, the open-source (MIT) automation tool Zeros runs for agent
// simulator tools and iOS rotation. It runs on Electron's own Node with
// private state, configuration and XCTest runner folders, one session per
// simulator or Android emulator. Its replies name local paths and its own
// internals, so nothing it prints reaches an agent or the user unedited.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export function agentDeviceCliPath(options: {
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  exists(file: string): boolean;
}): string | null {
  // Packaged builds unpack it: Electron's Node can't run code from inside an
  // asar archive, and xcodebuild needs its runner project as real files.
  const file = options.packaged
    ? path.join(
        options.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "agent-device",
        "bin",
        "agent-device.mjs",
      )
    : path.join(options.repoRoot, "node_modules", "agent-device", "bin", "agent-device.mjs");
  return options.exists(file) ? file : null;
}

export interface AgentDeviceFolders {
  state: string;
  /** Its configuration and plugins folder, kept empty. */
  home: string;
  /** The XCTest runner it builds once per Xcode. */
  runner: string;
  /** Its working directory and screenshot drop. */
  work: string;
}

export function agentDeviceFolders(root: string): AgentDeviceFolders {
  return {
    state: path.join(root, "state"),
    home: path.join(root, "home"),
    runner: path.join(root, "runner"),
    work: path.join(root, "work"),
  };
}

// Anything that could point it at a user configuration, a cloud device
// provider, another daemon or debug output. Device claims stay in their
// shared default folder so Zeros and someone's own agent-device never drive
// one simulator at once.
const SCRUBBED_PREFIXES = ["AGENT_DEVICE_", "LIMRUN_", "LIM_"];
const SCRUBBED_NAMES = new Set([
  "DEBUG",
  "NODE_OPTIONS",
  "NODE_ENV",
  "FORCE_COLOR",
  "NO_COLOR",
  "LOG_TOKENS",
  "LOG_STREAM",
]);

export function agentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  folders: AgentDeviceFolders,
  /** The Android SDK Zeros found. agent-device reads these names in another
   * order than Zeros does, so both are set to it. */
  androidSdk: string | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || SCRUBBED_NAMES.has(name)) continue;
    if (SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  return {
    ...env,
    ...(androidSdk ? { ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk } : {}),
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_DEVICE_STATE_DIR: folders.state,
    AGENT_DEVICE_HOME: folders.home,
    AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: folders.runner,
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
  };
}

export interface AgentDeviceFailure {
  ok: false;
  /** Its error code, such as DEVICE_IN_USE, or Zeros' own UNAVAILABLE,
   * TIMEOUT and UNREADABLE. */
  code: string;
  reason: string | null;
  /** Its own words; may name paths, so never shown as is. */
  message: string;
}

export type AgentDeviceReply =
  | { ok: true; data: Record<string, unknown> }
  | AgentDeviceFailure;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function failureReply(code: string, message = ""): AgentDeviceFailure {
  return { ok: false, code, reason: null, message };
}

/** Its `--json` reply, or null when stdout holds something else. */
export function readAgentDeviceReply(stdout: string): AgentDeviceReply | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const record = plainRecord(value);
  if (record?.success === true) return { ok: true, data: plainRecord(record.data) ?? {} };
  if (record?.success !== false) return null;
  const error = plainRecord(record.error) ?? {};
  const details = plainRecord(error.details);
  return {
    ok: false,
    code: typeof error.code === "string" && error.code ? error.code : "COMMAND_FAILED",
    reason: typeof details?.reason === "string" ? details.reason : null,
    message: typeof error.message === "string" ? error.message : "",
  };
}

export interface AgentDeviceExecOptions {
  /** Written to stdin, then stdin closes. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type AgentDeviceExec = (
  args: readonly string[],
  options: AgentDeviceExecOptions,
) => Promise<AgentDeviceReply>;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

/** Runs the CLI by absolute path with an argument array, never a shell. */
export function spawnAgentDevice(options: {
  execPath: string;
  cliPath(): string | null;
  env(): NodeJS.ProcessEnv;
  cwd: string;
  log?(message: string): void;
}): AgentDeviceExec {
  return async (args, run) => {
    const cli = options.cliPath();
    if (!cli) return failureReply("UNAVAILABLE");
    await mkdir(options.cwd, { recursive: true });
    return new Promise<AgentDeviceReply>((resolve) => {
      const child = spawn(options.execPath, [cli, ...args], {
        cwd: options.cwd,
        env: options.env(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      let outcome: "timeout" | "aborted" | "too-large" | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: NonNullable<typeof outcome>) => {
        outcome ??= reason;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => stop("timeout"), run.timeoutMs);
      timer.unref?.();
      const onAbort = () => stop("aborted");
      if (run.signal?.aborted) onAbort();
      else run.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("too-large");
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(run.stdin ?? "");
      let settled = false;
      const finish = (reply: AgentDeviceReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        run.signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      };
      child.once("error", (error) => {
        options.log?.(`agent-device could not start: ${error.message}`);
        finish(failureReply("UNAVAILABLE"));
      });
      child.once("close", (code) => {
        if (outcome === "timeout") return finish(failureReply("TIMEOUT"));
        if (outcome === "aborted") return finish(failureReply("ABORTED"));
        if (outcome === "too-large") return finish(failureReply("UNREADABLE"));
        const reply = readAgentDeviceReply(Buffer.concat(chunks).toString("utf8"));
        if (reply) return finish(reply);
        options.log?.(
          `agent-device ${args[0] ?? ""} gave no reply (exit ${code ?? "signal"}): ${stderr.trim().slice(-500)}`,
        );
        finish(failureReply("UNREADABLE"));
      });
    });
  };
}

export interface AgentDeviceCommand {
  name: string;
  /** Before `--`, so nothing an agent wrote can read as a flag. */
  flags?: readonly string[];
  operands?: readonly string[];
  stdin?: string;
  /** For commands that read or act on the session app: its runner brings
   * that app back to the front first, so the session moves to whatever app
   * is in front now. */
  followFront?: boolean;
}

export type AgentDeviceScreenshot =
  | { ok: true; png: Buffer; data: Record<string, unknown> }
  | AgentDeviceFailure;

/** How agent-device reaches a device. */
export type AgentDeviceTarget =
  | { platform: "ios"; udid: string }
  | { platform: "android"; serial: string };

export const SPRINGBOARD = "com.apple.springboard";
const RUNNER_APP = /^com\.callstack\.agentdevice\.runner/i;
/** How agent-device refuses an app it can't make the session app. */
const UNBINDABLE_APP_CODES = new Set(["APP_NOT_INSTALLED", "COMMAND_FAILED", "INVALID_ARGS"]);
/** Failures that end a command instead of leaving the session where it is. */
const BLOCKING_CODES = new Set(["ABORTED", "DEVICE_IN_USE", "DEVICE_NOT_FOUND", "UNAVAILABLE", "TOOL_MISSING"]);
// The first command on a device builds and starts the XCTest runner, about
// half a minute on a fast Mac and longer on the first build per Xcode.
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const STOP_TIMEOUT_MS = 15_000;

export interface AgentDeviceSessionsOptions {
  exec: AgentDeviceExec;
  /** How to reach a device now, or null when it isn't running. Without it,
   * every device ID is an iOS simulator's UDID. */
  target?(deviceId: string): AgentDeviceTarget | null;
  /** Bundle ID of the app in front of an iOS simulator, or null for the home
   * screen or unknown. */
  frontApp(udid: string): Promise<string | null>;
  /** Where screenshots land before Zeros reads them. */
  workDir: string;
  timeoutMs?: number;
  files?: {
    mkdir(dir: string): Promise<unknown>;
    readFile(file: string): Promise<Buffer>;
    rm(file: string): Promise<void>;
  };
  log?(message: string): void;
}

export function agentDeviceSessionName(udid: string): string {
  return `zeros-${udid}`;
}

function sessionAlreadyOpen(reply: AgentDeviceReply): boolean {
  return !reply.ok && reply.code === "INVALID_ARGS" && /already active/i.test(reply.message);
}

/** The session ended on agent-device's side, not "this needs an app session",
 * which reuses the same code. */
function sessionGone(reply: AgentDeviceReply): boolean {
  return !reply.ok && reply.code === "SESSION_NOT_FOUND" && reply.reason !== "ios_app_session_required";
}

function sameTarget(a: AgentDeviceTarget, b: AgentDeviceTarget): boolean {
  return a.platform === "android"
    ? b.platform === "android" && a.serial === b.serial
    : b.platform === "ios" && a.udid === b.udid;
}

function openArgs(
  id: string,
  device: AgentDeviceTarget,
  app: string | null,
  relaunch: boolean,
): string[] {
  return [
    "open",
    "--session",
    agentDeviceSessionName(id),
    ...(device.platform === "android"
      ? ["--platform", "android", "--serial", device.serial]
      : ["--platform", "ios", "--udid", device.udid]),
    ...(relaunch ? ["--relaunch"] : []),
    "--json",
    ...(app === null ? [] : ["--", app]),
  ];
}

function sessionArgs(id: string, command: AgentDeviceCommand): string[] {
  return [
    command.name,
    ...(command.flags ?? []),
    "--session",
    agentDeviceSessionName(id),
    "--json",
    ...(command.operands?.length ? ["--", ...command.operands] : []),
  ];
}

/** One agent-device session per device. Commands for one device run in
 * order; devices run in parallel.
 *
 * An iOS session is bound to the app in front, which its runner needs. An
 * Android session is bound to no app: one bound to an app refuses taps that
 * leave it and sends links to it, so opening an app ends the session and the
 * next command opens an unbound one. */
export class AgentDeviceSessions {
  /** Where each open session reaches its device. */
  private readonly open = new Map<string, AgentDeviceTarget>();
  /** The app each iOS session last opened, when known. */
  private readonly bound = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;
  private readonly files: NonNullable<AgentDeviceSessionsOptions["files"]>;
  /** Its daemon starts with the first command; until then quit has nothing
   * to stop. */
  private started = false;

  constructor(private readonly options: AgentDeviceSessionsOptions) {
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.files = options.files ?? {
      mkdir: (dir) => mkdir(dir, { recursive: true }),
      readFile: (file) => readFile(file),
      rm: (file) => rm(file, { force: true }),
    };
  }

  run(id: string, command: AgentDeviceCommand, signal?: AbortSignal): Promise<AgentDeviceReply> {
    return this.queue(id, () => this.runInSession(id, command, signal));
  }

  /** Opens an app or URL. On iOS it also becomes what snapshots read. */
  openTarget(
    id: string,
    target: string,
    options: { relaunch?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<AgentDeviceReply> {
    return this.queue(id, async () => {
      const device = await this.reach(id);
      if (!device) return failureReply("DEVICE_NOT_FOUND");
      const relaunch = options.relaunch === true;
      if (device.platform === "android") {
        const reply = await this.exec(openArgs(id, device, target, relaunch), signal);
        if (!reply.ok) return reply;
        this.forget(id);
        await this.endSession(id);
        return reply;
      }
      const reply = await this.openIos(id, device, target, relaunch, signal);
      if (reply.ok || sessionAlreadyOpen(reply)) this.open.set(id, device);
      return reply;
    });
  }

  /** The screen in points, as tap coordinates are on iOS. An Android screen
   * comes in pixels unless `scale` brings it to points. */
  screenshot(
    id: string,
    signal?: AbortSignal,
    options: { scale?: number } = {},
  ): Promise<AgentDeviceScreenshot> {
    return this.queue(id, async () => {
      const dir = path.join(this.options.workDir, "screenshots");
      const file = path.join(dir, `${randomUUID()}.png`);
      // Android's default capture switches the device into demo mode, which
      // redraws the status bar in the live view and takes about a second.
      const flags = [
        ...(this.targetOf(id)?.platform === "android" ? ["--no-stabilize"] : []),
        ...(options.scale !== undefined && options.scale < 1
          ? ["--scale", options.scale.toFixed(6)]
          : []),
      ];
      try {
        await this.files.mkdir(dir);
        const reply = await this.runInSession(id, { name: "screenshot", flags, operands: [file] }, signal);
        if (!reply.ok) return reply;
        return { ok: true, png: await this.files.readFile(file), data: reply.data };
      } catch (error) {
        this.options.log?.(
          `simulator screenshot unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return failureReply("UNREADABLE");
      } finally {
        await this.files.rm(file).catch(() => undefined);
      }
    });
  }

  /** Ends a device's session, as before its emulator shuts down: ending it
   * gives the device back its own keyboard. */
  close(id: string): Promise<void> {
    return this.queue(id, async () => {
      if (!this.open.has(id)) return;
      this.forget(id);
      await this.endSession(id);
    });
  }

  /** Forgets sessions of devices that are no longer running. Android ones also
   * end, since the next emulator to start may get the same serial. */
  keepOnly(runningIds: ReadonlySet<string>): void {
    for (const [id, device] of [...this.open]) {
      if (runningIds.has(id)) continue;
      this.forget(id);
      if (device.platform === "android") void this.queue(id, () => this.endSession(id));
    }
  }

  /** On quit: ends every session, the daemon and the runners it started. */
  async stop(): Promise<void> {
    this.open.clear();
    this.bound.clear();
    if (!this.started) return;
    const reply = await this.options.exec(["daemon", "stop", "--clean", "--json"], {
      timeoutMs: STOP_TIMEOUT_MS,
    });
    if (!reply.ok && reply.code !== "UNAVAILABLE") {
      this.options.log?.(`agent-device did not stop cleanly: ${reply.code}`);
    }
  }

  private async runInSession(
    id: string,
    command: AgentDeviceCommand,
    signal?: AbortSignal,
  ): Promise<AgentDeviceReply> {
    for (let attempt = 0; ; attempt++) {
      const device = await this.reach(id);
      if (!device) return failureReply("DEVICE_NOT_FOUND");
      if (!this.open.has(id)) {
        const opened =
          device.platform === "android"
            ? await this.openAndroid(id, device, signal)
            : await this.bindToFront(id, device, signal);
        if (!opened.ok && !sessionAlreadyOpen(opened)) return opened;
        this.open.set(id, device);
      } else if (command.followFront && device.platform === "ios") {
        const failure = await this.followFront(id, device, signal);
        if (failure) return failure;
      }
      const reply = await this.exec(sessionArgs(id, command), signal, command.stdin);
      if (!sessionGone(reply) || attempt > 0) return reply;
      this.forget(id);
    }
  }

  private targetOf(id: string): AgentDeviceTarget | null {
    return this.options.target ? this.options.target(id) : { platform: "ios", udid: id };
  }

  /** The device's target now, after ending a session left on an earlier one. */
  private async reach(id: string): Promise<AgentDeviceTarget | null> {
    const device = this.targetOf(id);
    if (!device) return null;
    const known = this.open.get(id);
    if (known && !sameTarget(known, device)) {
      this.forget(id);
      await this.endSession(id);
    }
    return device;
  }

  private async openAndroid(
    id: string,
    device: AgentDeviceTarget,
    signal?: AbortSignal,
  ): Promise<AgentDeviceReply> {
    const reply = await this.exec(openArgs(id, device, null, false), signal);
    if (!sessionAlreadyOpen(reply)) return reply;
    // Left by an earlier run of Zeros, and maybe bound to an app.
    await this.endSession(id);
    return this.exec(openArgs(id, device, null, false), signal);
  }

  /** Moves the session to the app in front when it isn't the session app.
   * The home screen always reads as in front, so it's checked directly. */
  private async followFront(
    id: string,
    device: AgentDeviceTarget & { platform: "ios" },
    signal?: AbortSignal,
  ): Promise<AgentDeviceFailure | null> {
    const bound = this.bound.get(id);
    if (bound !== undefined && bound !== SPRINGBOARD) {
      const state = await this.exec(sessionArgs(id, { name: "appstate" }), signal);
      if (!state.ok) return BLOCKING_CODES.has(state.code) ? state : null;
      if (state.data.state === "runningForeground") return null;
    }
    const front = await this.frontApp(device.udid);
    if ((front ?? SPRINGBOARD) === bound) return null;
    const reply = await this.bindTo(id, device, front, signal);
    return !reply.ok && BLOCKING_CODES.has(reply.code) ? reply : null;
  }

  private async frontApp(udid: string): Promise<string | null> {
    const front = await this.options.frontApp(udid).catch(() => null);
    return front && !RUNNER_APP.test(front) ? front : null;
  }

  /** A session bound to whatever is in front, so the runner brings that back
   * instead of leaving its own blank app on screen. */
  private async bindToFront(
    id: string,
    device: AgentDeviceTarget & { platform: "ios" },
    signal?: AbortSignal,
  ): Promise<AgentDeviceReply> {
    return this.bindTo(id, device, await this.frontApp(device.udid), signal);
  }

  private async bindTo(
    id: string,
    device: AgentDeviceTarget & { platform: "ios" },
    front: string | null,
    signal?: AbortSignal,
  ): Promise<AgentDeviceReply> {
    const target = front ?? SPRINGBOARD;
    const reply = await this.openIos(id, device, target, false, signal);
    if (reply.ok || sessionAlreadyOpen(reply) || target === SPRINGBOARD) return reply;
    if (!UNBINDABLE_APP_CODES.has(reply.code)) return reply;
    // Some system screens in front can't be session apps.
    return this.openIos(id, device, SPRINGBOARD, false, signal);
  }

  private async openIos(
    id: string,
    device: AgentDeviceTarget & { platform: "ios" },
    target: string,
    relaunch: boolean,
    signal?: AbortSignal,
  ): Promise<AgentDeviceReply> {
    const reply = await this.exec(openArgs(id, device, target, relaunch), signal);
    if (reply.ok) {
      const app = reply.data.appBundleId;
      if (typeof app === "string" && app) this.bound.set(id, app);
      // A URL whose app went unreported: the next command reads the front app.
      else if (target.includes(":")) this.bound.delete(id);
      else this.bound.set(id, target);
    } else if (sessionAlreadyOpen(reply)) {
      this.bound.delete(id);
    }
    return reply;
  }

  private async endSession(id: string): Promise<void> {
    const reply = await this.exec(
      ["close", "--session", agentDeviceSessionName(id), "--json"],
      undefined,
      undefined,
      STOP_TIMEOUT_MS,
    );
    if (!reply.ok && reply.code !== "SESSION_NOT_FOUND") {
      this.options.log?.(`agent-device did not end a session: ${reply.code}`);
    }
  }

  private forget(id: string): void {
    this.open.delete(id);
    this.bound.delete(id);
  }

  private exec(
    args: readonly string[],
    signal?: AbortSignal,
    stdin?: string,
    timeoutMs = this.timeoutMs,
  ): Promise<AgentDeviceReply> {
    this.started = true;
    return this.options.exec(args, {
      timeoutMs,
      signal,
      ...(stdin === undefined ? {} : { stdin }),
    });
  }

  private queue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return run;
  }
}
