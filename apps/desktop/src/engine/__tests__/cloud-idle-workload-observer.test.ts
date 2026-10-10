import { describe, expect, it, vi } from "vitest";
import { CloudIdleStopScheduler } from "../cloud-idle-stop";
import { ZerosEngine } from "../zeros-engine";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";

const authority = {} as CloudDurabilityAuthority;
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));

describe("periodic cloud idle host retirement", () => {
  it("retires eligible original hosts before the mandatory fresh census", async () => {
    let now = 0;
    const order: string[] = [], stop = vi.fn(async () => true);
    const retireIdleWorkloads = vi.fn(async () => { order.push("retire"); });
    const inspectWorkload = vi.fn(async () => { order.push("census"); return true; });
    const options = { now: () => now, busy: () => false, retireIdleWorkloads, inspectWorkload, stop };
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      now = 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(order).toEqual(["retire", "census"]); expect(stop).not.toHaveBeenCalled();
    } finally { await scheduler.close(); }
  });

  it("does not retire on passive reads or while foreground work is busy", async () => {
    const retireIdleWorkloads = vi.fn(async () => undefined), inspectWorkload = vi.fn(async () => false);
    const scheduler = new CloudIdleStopScheduler({ busy: () => true, retireIdleWorkloads, inspectWorkload, stop: async () => true });
    try {
      scheduler.readActivity(); scheduler.readActivity(); scheduler.consider(authority); await scheduler.settled();
      expect(retireIdleWorkloads).not.toHaveBeenCalled(); expect(inspectWorkload).not.toHaveBeenCalled();
    } finally { await scheduler.close(); }
  });

  it("cancels periodic retirement when new activity precedes its callback", async () => {
    const retireIdleWorkloads = vi.fn(async () => undefined);
    const scheduler = new CloudIdleStopScheduler({ busy: () => false, retireIdleWorkloads,
      inspectWorkload: async () => false, stop: async () => true });
    try {
      scheduler.consider(authority); scheduler.activity(); await scheduler.settled();
      expect(retireIdleWorkloads).not.toHaveBeenCalled();
    } finally { await scheduler.close(); }
  });

  it("joins original retirement during disposal and does not inspect or Stop afterward", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const inspectWorkload = vi.fn(async () => false), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ busy: () => false,
      retireIdleWorkloads: async () => { enter(); await gate; }, inspectWorkload, stop });
    scheduler.consider(authority); await entered;
    let closed = false;
    const closing = scheduler.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); release(); await closing;
    expect(inspectWorkload).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  });

  it("keeps failed original group retirement busy", async () => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => false), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false,
      retireIdleWorkloads: async () => { throw new Error("original group proof unavailable"); }, inspectWorkload, stop });
    try {
      now = 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(stop).not.toHaveBeenCalled(); expect(scheduler.readActivity().quietForMs).toBe(0);
    } finally { await scheduler.close(); }
  });

  it("uses the factory's exact retirement CAS instead of conversation-wide Stop", async () => {
    const original = Object.freeze({ id: "original" }), replacement = Object.freeze({ id: "replacement" });
    const retireIdleBootExecution = vi.fn(async (execution: unknown) => execution === original);
    const factory = { idleBootExecutions: () => [original, replacement], retireIdleBootExecution };
    const cancel = vi.fn(), broad = vi.fn();
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      cloudAgentBoot: { authorityActive: true, executionFactory: factory }, cloudLocalNativePump: { cancel },
      retireIdleCloudBootAgents: broad,
    });
    await engine.retireObservedIdleCloudBootAgents();
    expect(retireIdleBootExecution.mock.calls.map(([execution]) => execution)).toEqual([original, replacement]);
    expect(cancel).not.toHaveBeenCalled(); expect(broad).not.toHaveBeenCalled();
    engine.cloudAgentBoot = null; await engine.retireObservedIdleCloudBootAgents();
    expect(retireIdleBootExecution).toHaveBeenCalledTimes(2);
  });
});
