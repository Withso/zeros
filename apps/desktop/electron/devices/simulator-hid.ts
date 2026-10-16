// zeros-simulator-hid, the resident helper that sends the user's touches,
// keys, buttons and turns to iOS simulators in about a millisecond each. An
// AXe command takes about a second to start, so AXe stays only as the
// fallback for when the helper can't run. The helper's protocol is described
// in native/simulator-hid/main.swift.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { SimulatorOrientation, SimulatorTouch } from "@zeros/protocol/simulators";

import { HID_KEYS } from "./axe";
import {
  DeviceActionError,
  type DeviceInputPort,
  type DeviceOrientationPort,
  type SimulatorHidInput,
} from "./device-hub";

// Keep in sync with `protocolVersion` in native/simulator-hid/main.swift and
// scripts/build-simulator-hid.mjs.
export const SIMULATOR_HID_PROTOCOL = 2;
export const SIMULATOR_HID_BINARY = "zeros-simulator-hid";

/** Loading the simulator frameworks takes about 300 ms. */
const READY_MS = 10_000;
const REPLY_MS = 5_000;
const REPLY_MS_PER_CHARACTER = 10;
/** After the helper fails, input goes through AXe this long before the
 * helper is tried again. */
const RETRY_MS = 10_000;
const MAX_LOG_LINE = 300;

export const US_KEYBOARD_ONLY = "Zeros can type only US keyboard characters on iOS simulators.";

export type SimulatorHidRequest =
  | { op: "connect" }
  | { op: "tap"; x: number; y: number }
  | { op: "press"; x: number; y: number; seconds: number }
  | { op: "drag"; x: number; y: number; toX: number; toY: number; seconds: number }
  | { op: "text"; text: string }
  | { op: "key"; usage: number }
  | { op: "button"; button: "home" | "lock" }
  | { op: "orientation"; orientation: SimulatorOrientation }
  /** One step of a finger, or of two with `x2`/`y2`; the HID can only lift
   * a finger, so a cancel goes as an up. */
  | {
      op: "touch";
      phase: "down" | "move" | "up";
      x: number;
      y: number;
      x2?: number;
      y2?: number;
    };

export function simulatorHidTouch(touch: SimulatorTouch): SimulatorHidRequest {
  const phase = touch.phase === "cancel" ? "up" : touch.phase;
  const { x, y } = touch.at;
  return touch.second
    ? { op: "touch", phase, x, y, x2: touch.second.x, y2: touch.second.y }
    : { op: "touch", phase, x, y };
}

export function simulatorHidRequest(input: SimulatorHidInput): SimulatorHidRequest {
  switch (input.kind) {
    case "tap":
      return { op: "tap", x: input.at.x, y: input.at.y };
    case "drag": {
      const { from, to } = input;
      const seconds = input.durationMs / 1_000;
      // A long press holds one point.
      if (from.x === to.x && from.y === to.y) return { op: "press", x: from.x, y: from.y, seconds };
      return { op: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y, seconds };
    }
    case "text":
      return { op: "text", text: input.text };
    case "key":
      return { op: "key", usage: HID_KEYS[input.key] };
    case "button":
      if (input.button === "back") throw new DeviceActionError("iOS simulators have no Back button.");
      return { op: "button", button: input.button };
  }
}

/** The helper couldn't take a request, so nothing reached the device and the
 * caller can send it another way. */
export class SimulatorHidUnavailable extends Error {
  override name = "SimulatorHidUnavailable";
}

/** The helper's answer that the device didn't take a request. */
export class SimulatorHidFailure extends Error {
  override name = "SimulatorHidFailure";

  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`simulator input helper: ${code}: ${detail}`);
  }
}

export interface SimulatorHidProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface SimulatorHidOptions {
  binary(): string | null;
  spawn?(file: string): SimulatorHidProcess;
  log?(line: string): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Pending {
  resolve(): void;
  reject(error: Error): void;
  timer: unknown;
}

interface Helper {
  child: SimulatorHidProcess;
  ready: Promise<void>;
  isReady: boolean;
  /** False once it stopped, or Zeros stopped it. */
  live: boolean;
  pending: Map<number, Pending>;
  settleReady(error?: Error): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function replyMs(request: SimulatorHidRequest): number {
  switch (request.op) {
    case "press":
    case "drag":
      return REPLY_MS + request.seconds * 1_000;
    case "text":
      return REPLY_MS + request.text.length * REPLY_MS_PER_CHARACTER;
    default:
      return REPLY_MS;
  }
}

export class SimulatorHid {
  private helper: Helper | null = null;
  private retryAt = Number.NEGATIVE_INFINITY;
  private lastId = 0;
  private disposed = false;

  constructor(private readonly options: SimulatorHidOptions) {}

  available(): boolean {
    return !this.disposed && this.options.binary() !== null;
  }

  /** Resolves once the device took the request. Throws SimulatorHidUnavailable
   * when it never left Zeros, and SimulatorHidFailure when the device
   * refused it. */
  async send(udid: string, request: SimulatorHidRequest): Promise<void> {
    const helper = this.start();
    await helper.ready;
    if (!helper.live) throw new SimulatorHidUnavailable("The simulator input helper stopped.");
    const id = ++this.lastId;
    await new Promise<void>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (!helper.pending.delete(id)) return;
        this.log(`simulator input helper didn't answer ${request.op} in time; restarting it`);
        // It may still act on this request, so the caller mustn't send it again.
        reject(new Error("The simulator input helper didn't answer in time."));
        this.stop(helper, true);
      }, replyMs(request));
      helper.pending.set(id, { resolve, reject, timer });
      helper.child.stdin.write(`${JSON.stringify({ id, udid, ...request })}\n`);
    });
  }

  /** Starts the helper and connects to the device, so its first input is
   * as quick as the rest. */
  prepare(udid: string): void {
    this.send(udid, { op: "connect" }).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    if (this.helper) this.stop(this.helper, false);
  }

  private start(): Helper {
    if (this.disposed) throw new SimulatorHidUnavailable("Zeros is quitting.");
    if (this.helper?.live) return this.helper;
    if (this.retryAt > this.now()) {
      throw new SimulatorHidUnavailable("The simulator input helper failed a moment ago.");
    }
    const file = this.options.binary();
    if (!file) throw new SimulatorHidUnavailable("This build has no simulator input helper.");
    let child: SimulatorHidProcess;
    try {
      child = (this.options.spawn ?? spawnHelper)(file);
    } catch (error) {
      this.failed(`couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      throw new SimulatorHidUnavailable("The simulator input helper couldn't start.");
    }
    let settle!: (error?: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    // Only requests wait for it; a helper nobody asks anything of mustn't
    // leave an unhandled rejection behind.
    ready.catch(() => undefined);
    const helper: Helper = {
      child,
      ready,
      isReady: false,
      live: true,
      pending: new Map(),
      settleReady: (error) => {
        if (helper.isReady) return;
        helper.isReady = true;
        settle(error);
      },
    };
    this.helper = helper;
    const readyTimer = this.setTimer(() => {
      if (helper.isReady) return;
      this.failed("didn't start in time");
      helper.settleReady(new SimulatorHidUnavailable("The simulator input helper didn't start."));
      this.stop(helper, true);
    }, READY_MS);
    void ready.then(
      () => this.clearTimer(readyTimer),
      () => this.clearTimer(readyTimer),
    );

    createInterface({ input: child.stdout }).on("line", (line) => this.read(helper, line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) this.log(`simulator input helper: ${line.slice(0, MAX_LOG_LINE)}`);
    });
    // A helper that died mid-write is handled by its exit.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => this.ended(helper, `failed: ${error.message}`));
    child.on("exit", (code, signal) => this.ended(helper, `exited (${code ?? signal ?? "?"})`));
    return helper;
  }

  private read(helper: Helper, line: string): void {
    let reply: Record<string, unknown> | null;
    try {
      reply = record(JSON.parse(line));
    } catch {
      reply = null;
    }
    if (!reply) {
      this.log(`simulator input helper: unreadable reply ${line.slice(0, MAX_LOG_LINE)}`);
      return;
    }
    if (!helper.isReady) {
      if (reply.ready === true && reply.protocol === SIMULATOR_HID_PROTOCOL) {
        helper.settleReady();
        return;
      }
      const reason =
        reply.ready === true
          ? `speaks protocol ${String(reply.protocol)}, not ${SIMULATOR_HID_PROTOCOL}`
          : `couldn't start: ${typeof reply.error === "string" ? reply.error.slice(0, MAX_LOG_LINE) : "no reason given"}`;
      this.failed(reason);
      helper.settleReady(new SimulatorHidUnavailable("The simulator input helper couldn't start."));
      this.stop(helper, true);
      return;
    }
    if (typeof reply.id !== "number") return;
    const pending = helper.pending.get(reply.id);
    if (!pending) return;
    helper.pending.delete(reply.id);
    this.clearTimer(pending.timer);
    if (reply.ok === true) {
      pending.resolve();
      return;
    }
    const code = typeof reply.code === "string" ? reply.code : "failed";
    const text = typeof reply.error === "string" ? reply.error.slice(0, MAX_LOG_LINE) : code;
    pending.reject(new SimulatorHidFailure(code, text));
  }

  /** Stops a helper Zeros no longer wants; `failed` keeps input on AXe for
   * a while. */
  private stop(helper: Helper, failed: boolean): void {
    if (failed) this.retryAt = this.now() + RETRY_MS;
    if (!helper.live) return;
    helper.live = false;
    if (this.helper === helper) this.helper = null;
    helper.child.stdin.end();
    helper.child.kill();
    this.rejectAll(helper);
  }

  private ended(helper: Helper, how: string): void {
    const unexpected = helper.live;
    helper.live = false;
    if (this.helper === helper) this.helper = null;
    if (unexpected && !this.disposed) this.failed(how);
    helper.settleReady(new SimulatorHidUnavailable("The simulator input helper couldn't start."));
    this.rejectAll(helper);
  }

  private rejectAll(helper: Helper): void {
    // These may already have reached the device, so they aren't sent again.
    const pending = [...helper.pending.values()];
    helper.pending.clear();
    for (const request of pending) {
      this.clearTimer(request.timer);
      request.reject(new Error("The simulator input helper stopped."));
    }
  }

  private failed(how: string): void {
    this.retryAt = this.now() + RETRY_MS;
    this.log(`simulator input helper ${how}; using AXe for now`);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setTimer(callback: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(callback, ms);
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

function spawnHelper(file: string): SimulatorHidProcess {
  return spawn(file, [], { stdio: ["pipe", "pipe", "pipe"] });
}

/** The user's input through the helper, or through AXe when the helper
 * can't take it. */
export class HidInput implements DeviceInputPort {
  constructor(
    private readonly hid: SimulatorHid,
    private readonly fallback: DeviceInputPort,
  ) {}

  available(): boolean {
    return this.hid.available() || this.fallback.available();
  }

  prepare(udid: string): void {
    this.hid.prepare(udid);
  }

  async perform(udid: string, input: SimulatorHidInput): Promise<void> {
    try {
      await this.hid.send(udid, simulatorHidRequest(input));
      return;
    } catch (error) {
      if (error instanceof SimulatorHidFailure && error.code === "unsupported-text") {
        throw new DeviceActionError(US_KEYBOARD_ONLY);
      }
      if (!(error instanceof SimulatorHidUnavailable)) throw error;
    }
    await this.fallback.perform(udid, input);
  }

  /** Only the helper is quick enough to follow a finger; without it the
   * press goes out whole, through AXe, once it ends. */
  async touch(udid: string, touch: SimulatorTouch): Promise<boolean> {
    try {
      await this.hid.send(udid, simulatorHidTouch(touch));
      return true;
    } catch (error) {
      if (error instanceof SimulatorHidUnavailable) return false;
      throw error;
    }
  }
}

/** Turns through the helper. Upside down goes through XCTest when there is
 * one: it reports the orientation the device kept, and iPhones without a
 * Home button never keep that one, while the HID takes it without a word. */
export function simulatorHidOrientation(
  hid: SimulatorHid,
  fallback: DeviceOrientationPort | null,
): DeviceOrientationPort {
  return {
    async set(udid, orientation, deviceName) {
      if (orientation === "portrait-upside-down" && fallback) {
        await fallback.set(udid, orientation, deviceName);
        return;
      }
      try {
        await hid.send(udid, { op: "orientation", orientation });
        return;
      } catch (error) {
        if (!(error instanceof SimulatorHidUnavailable) || !fallback) throw error;
      }
      await fallback.set(udid, orientation, deviceName);
    },
  };
}
