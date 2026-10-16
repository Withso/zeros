import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActionError, type DeviceInputPort } from "../devices/device-hub";
import {
  HidInput,
  SIMULATOR_HID_PROTOCOL,
  SimulatorHid,
  SimulatorHidFailure,
  SimulatorHidUnavailable,
  US_KEYBOARD_ONLY,
  simulatorHidOrientation,
  simulatorHidRequest,
  simulatorHidTouch,
  type SimulatorHidProcess,
} from "../devices/simulator-hid";

class FakeHelper extends EventEmitter implements SimulatorHidProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  killed = false;

  constructor() {
    super();
    createInterface({ input: this.stdin }).on("line", (line) => {
      this.requests.push(JSON.parse(line) as Record<string, unknown>);
    });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  say(line: unknown): void {
    this.stdout.write(`${JSON.stringify(line)}\n`);
  }

  ready(protocol = SIMULATOR_HID_PROTOCOL): void {
    this.say({ ready: true, protocol });
  }

  answer(index: number, reply: Record<string, unknown> = { ok: true }): void {
    this.say({ id: this.requests[index]!.id, ...reply });
  }
}

class Clock {
  now = 1_000;
  timers: Array<{ at: number; callback: () => void }> = [];
  setTimer = (callback: () => void, ms: number) => {
    const timer = { at: this.now + ms, callback };
    this.timers.push(timer);
    return timer;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer !== handle);
  };
  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((timer) => timer.at <= this.now);
    this.timers = this.timers.filter((timer) => timer.at > this.now);
    for (const timer of due) timer.callback();
  }
}

describe("simulator HID helper", () => {
  let clock: Clock;
  let helpers: FakeHelper[];
  let logs: string[];
  let binary: string | null;

  const make = () =>
    new SimulatorHid({
      binary: () => binary,
      spawn: () => {
        const helper = new FakeHelper();
        helpers.push(helper);
        return helper;
      },
      log: (line) => logs.push(line),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

  const fallback = (): DeviceInputPort & { perform: ReturnType<typeof vi.fn> } => ({
    available: () => true,
    perform: vi.fn(async () => undefined),
  });

  beforeEach(() => {
    clock = new Clock();
    helpers = [];
    logs = [];
    binary = "/axe/zeros-simulator-hid";
  });

  it("maps the user's input to requests, holding one point for a long press", () => {
    expect(simulatorHidRequest({ kind: "tap", at: { x: 10.5, y: 20 } })).toEqual({
      op: "tap",
      x: 10.5,
      y: 20,
    });
    expect(
      simulatorHidRequest({ kind: "drag", from: { x: 5, y: 6 }, to: { x: 5, y: 6 }, durationMs: 800 }),
    ).toEqual({ op: "press", x: 5, y: 6, seconds: 0.8 });
    expect(
      simulatorHidRequest({ kind: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 250 }),
    ).toEqual({ op: "drag", x: 1, y: 2, toX: 3, toY: 4, seconds: 0.25 });
    expect(simulatorHidRequest({ kind: "text", text: "--help" })).toEqual({
      op: "text",
      text: "--help",
    });
    expect(simulatorHidRequest({ kind: "key", key: "enter" })).toEqual({ op: "key", usage: 40 });
    expect(simulatorHidRequest({ kind: "button", button: "lock" })).toEqual({
      op: "button",
      button: "lock",
    });
    expect(() => simulatorHidRequest({ kind: "button", button: "back" })).toThrow(
      DeviceActionError,
    );
  });

  it("maps each step of a live touch to a request, lifting the finger for a cancel", () => {
    expect(simulatorHidTouch({ phase: "down", at: { x: 10.5, y: 20 } })).toEqual({
      op: "touch",
      phase: "down",
      x: 10.5,
      y: 20,
    });
    expect(simulatorHidTouch({ phase: "cancel", at: { x: 1, y: 2 } })).toEqual({
      op: "touch",
      phase: "up",
      x: 1,
      y: 2,
    });
    expect(
      simulatorHidTouch({ phase: "move", at: { x: 1, y: 2 }, second: { x: 401, y: 872 } }),
    ).toEqual({ op: "touch", phase: "move", x: 1, y: 2, x2: 401, y2: 872 });
  });

  it("sends touches live, and says when the helper can't so the press goes out whole", async () => {
    const axe = fallback();
    const input = new HidInput(make(), axe);
    const pressed = input.touch("U", { phase: "down", at: { x: 5, y: 6 } });
    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(1));
    expect(helpers[0]!.requests[0]).toEqual({ id: 1, udid: "U", op: "touch", phase: "down", x: 5, y: 6 });
    helpers[0]!.answer(0);
    await expect(pressed).resolves.toBe(true);

    const refused = input.touch("U", { phase: "up", at: { x: 5, y: 6 } });
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(2));
    helpers[0]!.answer(1, { ok: false, code: "not-booted", error: "off" });
    await expect(refused).rejects.toThrow(SimulatorHidFailure);

    binary = null;
    await expect(new HidInput(make(), axe).touch("U", { phase: "down", at: { x: 1, y: 1 } })).resolves.toBe(
      false,
    );
    expect(axe.perform).not.toHaveBeenCalled();
  });

  it("starts one helper, sends once it is ready, and settles each request by its reply", async () => {
    const hid = make();
    const tap = hid.send("U", { op: "tap", x: 1, y: 2 });
    const key = hid.send("V", { op: "key", usage: 40 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.requests).toEqual([]);

    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(2));
    expect(helpers[0]!.requests).toEqual([
      { id: 1, udid: "U", op: "tap", x: 1, y: 2 },
      { id: 2, udid: "V", op: "key", usage: 40 },
    ]);
    // Replies for different devices may come in any order.
    helpers[0]!.answer(1, { ok: false, code: "not-booted", error: "The simulator isn't running." });
    helpers[0]!.answer(0);
    await expect(tap).resolves.toBeUndefined();
    await expect(key).rejects.toThrow(
      new SimulatorHidFailure("not-booted", "The simulator isn't running."),
    );

    const next = hid.send("U", { op: "button", button: "home" });
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(3));
    helpers[0]!.answer(2);
    await expect(next).resolves.toBeUndefined();
    expect(helpers).toHaveLength(1);
  });

  it("falls back to AXe when the helper is missing or can't start, and tries again later", async () => {
    binary = null;
    let axe = fallback();
    let input = new HidInput(make(), axe);
    await input.perform("U", { kind: "tap", at: { x: 1, y: 1 } });
    expect(axe.perform).toHaveBeenCalledWith("U", { kind: "tap", at: { x: 1, y: 1 } });
    expect(helpers).toEqual([]);

    binary = "/axe/zeros-simulator-hid";
    axe = fallback();
    input = new HidInput(make(), axe);
    const first = input.perform("U", { kind: "key", key: "tab" });
    helpers[0]!.say({ ready: false, error: "Xcode isn't installed" });
    await first;
    expect(axe.perform).toHaveBeenCalledWith("U", { kind: "key", key: "tab" });
    expect(logs).toContain(
      "simulator input helper couldn't start: Xcode isn't installed; using AXe for now",
    );

    await input.perform("U", { kind: "key", key: "space" });
    expect(helpers).toHaveLength(1);
    expect(axe.perform).toHaveBeenCalledTimes(2);

    clock.advance(10_000);
    const later = input.perform("U", { kind: "key", key: "enter" });
    expect(helpers).toHaveLength(2);
    helpers[1]!.ready();
    await vi.waitFor(() => expect(helpers[1]!.requests).toHaveLength(1));
    helpers[1]!.answer(0);
    await later;
    expect(axe.perform).toHaveBeenCalledTimes(2);
  });

  it("refuses a helper that speaks another protocol, or never gets ready", async () => {
    const axe = fallback();
    const input = new HidInput(make(), axe);
    const old = input.perform("U", { kind: "key", key: "tab" });
    helpers[0]!.ready(1);
    await old;
    expect(helpers[0]!.killed).toBe(true);
    expect(logs).toContain("simulator input helper speaks protocol 1, not 2; using AXe for now");

    clock.advance(10_000);
    const slow = input.perform("U", { kind: "key", key: "tab" });
    clock.advance(10_000);
    await slow;
    expect(helpers[1]!.killed).toBe(true);
    expect(axe.perform).toHaveBeenCalledTimes(2);
    expect(logs).toContain("simulator input helper didn't start in time; using AXe for now");
  });

  it("never sends input again once it may have reached the device", async () => {
    const axe = fallback();
    const input = new HidInput(make(), axe);
    const crashed = input.perform("U", { kind: "tap", at: { x: 1, y: 1 } });
    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(1));
    helpers[0]!.emit("exit", null, "SIGSEGV");
    await expect(crashed).rejects.toThrow("The simulator input helper stopped.");
    expect(axe.perform).not.toHaveBeenCalled();
    expect(logs).toContain("simulator input helper exited (SIGSEGV); using AXe for now");

    const hung = input.perform("U", { kind: "drag", from: { x: 1, y: 1 }, to: { x: 9, y: 9 }, durationMs: 1_000 });
    await hung;
    expect(axe.perform).toHaveBeenCalledTimes(1);

    clock.advance(10_000);
    const stuck = input.perform("U", { kind: "drag", from: { x: 1, y: 1 }, to: { x: 9, y: 9 }, durationMs: 1_000 });
    helpers[1]!.ready();
    await vi.waitFor(() => expect(helpers[1]!.requests).toHaveLength(1));
    clock.advance(5_999);
    expect(helpers[1]!.killed).toBe(false);
    clock.advance(1);
    await expect(stuck).rejects.toThrow("didn't answer in time");
    expect(helpers[1]!.killed).toBe(true);
    expect(axe.perform).toHaveBeenCalledTimes(1);
  });

  it("words text it can't type for people, and passes other failures on", async () => {
    const axe = fallback();
    const input = new HidInput(make(), axe);
    const typed = input.perform("U", { kind: "text", text: "café" });
    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(1));
    helpers[0]!.answer(0, { ok: false, code: "unsupported-text", error: "only US keys" });
    await expect(typed).rejects.toThrow(new DeviceActionError(US_KEYBOARD_ONLY));

    const failed = input.perform("U", { kind: "key", key: "tab" });
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(2));
    helpers[0]!.answer(1, { ok: false, code: "failed", error: "HID connection lost" });
    await expect(failed).rejects.toThrow(SimulatorHidFailure);
    expect(axe.perform).not.toHaveBeenCalled();
  });

  it("connects to a device ahead of its first input", async () => {
    const hid = make();
    hid.prepare("U");
    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toEqual([{ id: 1, udid: "U", op: "connect" }]));
    helpers[0]!.answer(0, { ok: false, code: "not-booted", error: "off" });
    binary = null;
    expect(() => make().prepare("U")).not.toThrow();
  });

  it("turns through the helper, and upside down through XCTest, which checks it stuck", async () => {
    const xctest = { set: vi.fn(async () => undefined) };
    const turn = simulatorHidOrientation(make(), xctest);
    const left = turn.set("U", "landscape-left", "iPhone 17");
    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(1));
    expect(helpers[0]!.requests[0]).toEqual({
      id: 1,
      udid: "U",
      op: "orientation",
      orientation: "landscape-left",
    });
    helpers[0]!.answer(0);
    await left;

    await turn.set("U", "portrait-upside-down", "iPhone 17");
    expect(xctest.set).toHaveBeenCalledWith("U", "portrait-upside-down", "iPhone 17");
    expect(helpers[0]!.requests).toHaveLength(1);

    binary = null;
    await simulatorHidOrientation(make(), xctest).set("U", "portrait", "iPhone 17");
    expect(xctest.set).toHaveBeenLastCalledWith("U", "portrait", "iPhone 17");
    await expect(simulatorHidOrientation(make(), null).set("U", "portrait", "iPhone 17")).rejects.toThrow(
      SimulatorHidUnavailable,
    );
  });

  it("stops the helper on dispose and takes nothing after", async () => {
    const hid = make();
    const pending = hid.send("U", { op: "tap", x: 1, y: 1 });
    helpers[0]!.ready();
    await vi.waitFor(() => expect(helpers[0]!.requests).toHaveLength(1));
    hid.dispose();
    await expect(pending).rejects.toThrow("stopped");
    expect(helpers[0]!.killed).toBe(true);
    expect(hid.available()).toBe(false);
    await expect(hid.send("U", { op: "tap", x: 1, y: 1 })).rejects.toThrow(SimulatorHidUnavailable);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs).toEqual([]);
  });
});
