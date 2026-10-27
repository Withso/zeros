import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KeepAwakeController,
  KEEP_AWAKE_ACTIVITY_LEASE_MS,
  KEEP_AWAKE_POLL_MS,
  type KeepAwakePower,
} from "../keep-awake";

const controllers: KeepAwakeController[] = [];
function setup(enabled = true, supported = true) {
  const readPower = vi.fn<() => Promise<KeepAwakePower | null>>()
    .mockResolvedValue({ onBattery: false, percent: null });
  const start = vi.fn(() => 0); // Zero is a valid Electron blocker ID.
  const stop = vi.fn();
  const requestActivity = vi.fn();
  const controller = new KeepAwakeController({
    enabled, supported, readPower, start, stop, requestActivity, now: () => Date.now(),
  });
  controllers.push(controller);
  return { controller, readPower, start, stop, requestActivity };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("Mac idle sleep assertion", () => {
  it("does no battery I/O or polling while disabled, idle or unsupported", async () => {
    const disabled = setup(false);
    disabled.controller.reportActivity(true);
    const idle = setup();
    const unsupported = setup(true, false);
    unsupported.controller.reportActivity(true);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_ACTIVITY_LEASE_MS * 2);
    for (const item of [disabled, idle, unsupported]) {
      expect(item.start).not.toHaveBeenCalled();
      expect(item.readPower).not.toHaveBeenCalled();
      expect(item.requestActivity).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one assertion across repeated activity and releases ID zero on idle", async () => {
    const { controller, start, stop, readPower } = setup();
    controller.reportActivity(true);
    expect(start).not.toHaveBeenCalled(); // First read must establish battery safety.
    await settle();
    for (let i = 0; i < 100; i++) controller.reportActivity(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(readPower).toHaveBeenCalledTimes(1);
    controller.reportActivity(false);
    expect(stop).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_MS * 2);
    expect(readPower).toHaveBeenCalledTimes(1);
  });

  it("applies enable/disable immediately without persisting runtime activity", async () => {
    const { controller, start, stop, requestActivity } = setup(false);
    controller.reportActivity(true);
    controller.setEnabled(true);
    expect(requestActivity).toHaveBeenCalledOnce();
    await settle();
    expect(start).toHaveBeenCalledOnce();
    controller.setEnabled(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    controller.setEnabled(true);
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1, 9, null, NaN, -1, 101])("does not block on unsafe/unknown battery charge %s", async percent => {
    const { controller, start, readPower } = setup();
    readPower.mockResolvedValue({ onBattery: true, percent });
    controller.reportActivity(true);
    await settle();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([10, 50, 100])("allows battery charge %s at or above the cutoff", async percent => {
    const { controller, start, readPower } = setup();
    readPower.mockResolvedValue({ onBattery: true, percent });
    controller.reportActivity(true);
    await settle();
    expect(start).toHaveBeenCalledOnce();
  });

  it("polls charge in main, pauses below 10%, and resumes after charging", async () => {
    const { controller, start, stop, readPower, requestActivity } = setup();
    readPower.mockResolvedValue({ onBattery: true, percent: 10 });
    controller.reportActivity(true);
    await settle();
    readPower.mockResolvedValue({ onBattery: true, percent: 9 });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_MS);
    expect(stop).toHaveBeenCalledOnce();
    expect(requestActivity).toHaveBeenCalledOnce();
    controller.reportActivity(true);
    readPower.mockResolvedValue({ onBattery: true, percent: 10 });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_MS);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("releases immediately on a power-source change until the new read resolves", async () => {
    const { controller, start, stop, readPower } = setup();
    controller.reportActivity(true);
    await settle();
    readPower.mockResolvedValue({ onBattery: true, percent: 4 });
    controller.powerChanged();
    expect(stop).toHaveBeenCalledOnce();
    await settle();
    expect(start).toHaveBeenCalledOnce();
    readPower.mockResolvedValue({ onBattery: false, percent: 4 });
    controller.powerChanged();
    await settle();
    expect(start).toHaveBeenCalledTimes(2); // AC is safe even with an empty battery.
  });

  it("fails closed on a failed battery read and retries only at the poll cadence", async () => {
    const { controller, start, stop, readPower } = setup();
    controller.reportActivity(true);
    await settle();
    readPower.mockRejectedValueOnce(new Error("pmset unavailable"));
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_MS);
    expect(stop).toHaveBeenCalledOnce();
    expect(readPower).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_MS);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("expires a stalled renderer's activity without a renderer timer", async () => {
    const { controller, start, stop, requestActivity } = setup();
    controller.reportActivity(true);
    await settle();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_ACTIVITY_LEASE_MS);
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(requestActivity).toHaveBeenCalledTimes(3);
    controller.reportActivity(true);
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not reuse expired activity when enabled later", async () => {
    const { controller, start } = setup(false);
    controller.reportActivity(true);
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_ACTIVITY_LEASE_MS + 1);
    controller.setEnabled(true);
    await settle();
    expect(start).not.toHaveBeenCalled();
    controller.reportActivity(true);
    await settle();
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(["idle", "disable", "dispose"] as const)("ignores a late power read after %s", async action => {
    const { controller, start, readPower } = setup();
    let resolve!: (value: KeepAwakePower) => void;
    readPower.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    controller.reportActivity(true);
    await settle();
    if (action === "idle") controller.clearActivity();
    else if (action === "disable") controller.setEnabled(false);
    else controller.dispose();
    resolve({ onBattery: false, percent: null });
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences late AC reads and coalesces source changes into one follow-up read", async () => {
    const { controller, start, readPower } = setup();
    let resolve!: (value: KeepAwakePower) => void;
    readPower.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    controller.reportActivity(true);
    await settle();
    readPower.mockResolvedValue({ onBattery: true, percent: 5 });
    controller.powerChanged();
    controller.powerChanged();
    expect(readPower).toHaveBeenCalledOnce();
    resolve({ onBattery: false, percent: null });
    await settle();
    expect(readPower).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it("rechecks after a stop/start while an old read is in flight", async () => {
    const { controller, start, readPower } = setup();
    let resolve!: (value: KeepAwakePower) => void;
    readPower.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    controller.reportActivity(true);
    await settle();
    controller.reportActivity(false);
    controller.reportActivity(true);
    resolve({ onBattery: true, percent: 3 });
    await settle();
    expect(readPower).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
  });

  it("disposes idempotently and ignores all later calls", async () => {
    const { controller, start, stop, readPower } = setup();
    controller.reportActivity(true);
    await settle();
    controller.dispose();
    controller.dispose();
    controller.reportActivity(true);
    controller.setEnabled(true);
    controller.powerChanged();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_ACTIVITY_LEASE_MS);
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(readPower).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
