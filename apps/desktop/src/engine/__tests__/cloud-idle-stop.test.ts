import { describe, expect, it, vi } from "vitest";
import { CloudIdleStopScheduler, hasCloudUserProcesses, isCloudIdleMaintenance } from "../cloud-idle-stop";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
const authority = {} as CloudDurabilityAuthority;
const inspection=(workloadPids:number[]=[])=>({complete:true,pendingLaunches:0,failedRetirements:0,workloadPids,infrastructurePids:[]});
describe("cloud idle stop", () => {
  it("requires a fresh census despite a cached warm-host deferral hint", async () => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => true), stop = vi.fn(async () => true);
    const options = { now: () => now, busy: () => false, inspectWorkload, stop,
      deferWorkloadInspection: () => true };
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      now = 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(inspectWorkload).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(scheduler.readActivity().quietForMs).toBe(0);
    } finally { await scheduler.close(); }
  });
  it("retains a pending census when cached warm inventory changes", async () => {
    let now = 0, hint = false, finish!: (busy: boolean) => void;
    const gate = new Promise<boolean>(resolve => { finish = resolve; });
    const inspectWorkload = vi.fn(() => gate), stop = vi.fn(async () => true);
    const options = { now: () => now, busy: () => false, inspectWorkload, stop,
      deferWorkloadInspection: () => hint };
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      now = 590_000; scheduler.consider(authority); await Promise.resolve();
      hint = true; scheduler.consider(authority); finish(true); await scheduler.settled();
      expect(scheduler.readActivity().quietForMs).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(inspectWorkload).toHaveBeenCalledOnce();
    } finally { finish(true); await scheduler.close(); }
  });
  it("waits ten minutes of confirmed quiet census before invoking the real stop callback", async () => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => false), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload, stop });
    try {
      scheduler.consider(authority); await scheduler.settled(); now = 599_999;
      scheduler.consider(authority); await scheduler.settled(); expect(stop).not.toHaveBeenCalled();
      expect(scheduler.readActivity()).toMatchObject({ revision: 0, quietForMs: 599_999 });
      now++; scheduler.consider(authority); await scheduler.settled();
      expect(stop).toHaveBeenCalledOnce(); expect(inspectWorkload).toHaveBeenCalledTimes(3);
      expect(stop).toHaveBeenCalledWith(authority, expect.any(Function));
    } finally { await scheduler.close(); }
  });
  it("refuses Stop while unrelated kernel work remains despite idle native metadata", async () => {
    let now = 600_000, warm = true, unrelated = true;
    const retire = vi.fn(async () => { warm = false; }), committed = vi.fn(), inspectWorkload = vi.fn(async () => unrelated);
    const stop = vi.fn(async (_authority: CloudDurabilityAuthority, stillIdle: () => boolean) => {
      await retire();
      if (!stillIdle() || await hasCloudUserProcesses({ inspect:async()=>inspection([...(warm?[12]:[]),...(unrelated?[13]:[])]) }) || !stillIdle()) return false;
      committed(); return true;
    });
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload, stop });
    try {
      now += 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(retire).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
      unrelated = false; now += 15_000; scheduler.consider(authority); await scheduler.settled();
      expect(committed).not.toHaveBeenCalled();
      now += 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(retire).toHaveBeenCalledOnce(); expect(committed).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
  });
  it.each(["background", "unknown", "legacy"])("keeps real observational inspection for %s inventory", async kind => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => true), stop = vi.fn(async () => true);
    const options = { now: () => now, busy: () => false, inspectWorkload, stop,
      ...(kind === "legacy" ? {} : { deferWorkloadInspection: () => false }) };
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      now = 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(inspectWorkload).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
      expect(scheduler.readActivity().quietForMs).toBe(0);
    } finally { await scheduler.close(); }
  });
  it("does not consult cached warm hints while foreground work is busy or during activity reads", async () => {
    let now = 600_000;
    const deferWorkloadInspection = vi.fn(() => true), stop = vi.fn(async () => true);
    const options = { now: () => now, busy: () => true, deferWorkloadInspection, inspectWorkload: async () => true, stop };
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      scheduler.readActivity(); scheduler.readActivity(); expect(deferWorkloadInspection).not.toHaveBeenCalled();
      now += 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(deferWorkloadInspection).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    } finally { await scheduler.close(); }
  });
  it.each(["throws", "promise"])("retains conservative inspection and contains a %s warm hook", async kind => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => true), stop = vi.fn(async () => true);
    const options = { now: () => now, busy: () => false, inspectWorkload, stop, deferWorkloadInspection: () => false };
    // Exercise malformed runtime callbacks without granting an asynchronous
    // authority API or trusting Promise truthiness.
    Object.assign(options, { deferWorkloadInspection: kind === "throws" ? () => { throw new Error("Unknown inventory"); }
      : async () => { throw new Error("Synthetic rejected callback"); } });
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      now = 600_000; scheduler.consider(authority); await scheduler.settled(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(inspectWorkload).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
    } finally { await scheduler.close(); }
  });
  it("requires ten fresh quiet minutes after a busy census settles", async () => {
    let now = 0, defer = false, finish!: (busy: boolean) => void;
    const gate = new Promise<boolean>(resolve => { finish = resolve; }), stop = vi.fn(async () => true);
    const inspectWorkload = vi.fn(() => gate);
    const options = { now: () => now, busy: () => false, inspectWorkload, deferWorkloadInspection: () => defer, stop };
    const scheduler = new CloudIdleStopScheduler(options);
    try {
      now = 590_000; scheduler.consider(authority); await Promise.resolve();
      defer = true; scheduler.consider(authority); finish(true); await scheduler.settled();
      expect(scheduler.readActivity().quietForMs).toBe(0);
      inspectWorkload.mockImplementation(async () => false);
      now = 600_000; scheduler.consider(authority); await scheduler.settled(); expect(stop).not.toHaveBeenCalled();
      now += 599_999; scheduler.consider(authority); await scheduler.settled(); expect(stop).not.toHaveBeenCalled();
      now++; scheduler.consider(authority); await scheduler.settled(); expect(stop).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
  });
  it("keeps new activity authoritative while exact warm hosts are being drained", async () => {
    let now = 0, enter!: () => void, drain!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), drained = new Promise<void>(resolve => { drain = resolve; }), committed = vi.fn();
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload: async () => false,
      stop: async (_authority, stillIdle) => { enter(); await drained;
        if (!stillIdle()) return false; committed(); return true; } });
    try {
      now = 600_000; scheduler.consider(authority); await entered; scheduler.activity(); drain(); await scheduler.settled();
      expect(committed).not.toHaveBeenCalled();
    } finally { drain(); await scheduler.close(); }
  });
  it("cannot exempt a workload using a resident name or an unrelated numeric PID",async()=>{
    expect(await hasCloudUserProcesses({inspect:async()=>inspection([12])})).toBe(true);
    expect(await hasCloudUserProcesses({})).toBe(true);
  });
  it("exposes a read-only activity revision and record-sync state", () => {
    let now = 0, busy = false;
    const stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => busy, stop });
    now = 60_000;
    expect(scheduler.readActivity()).toEqual({ revision: 0, quietForMs: 60_000, recordSync: "ready" });
    expect(scheduler.readActivity()).toEqual({ revision: 0, quietForMs: 60_000, recordSync: "ready" });
    scheduler.recordSync("pending"); scheduler.activity();
    expect(scheduler.readActivity()).toEqual({ revision: 1, quietForMs: 0, recordSync: "pending" });
    busy = true; scheduler.consider(authority); now += 60_000;
    expect(scheduler.readActivity()).toMatchObject({ revision: 2, quietForMs: 0 });
    expect(stop).not.toHaveBeenCalled();
  });
  it("ignores only registered pinned infrastructure and retains its workload descendants",async()=>{
    expect(await hasCloudUserProcesses({inspect:async()=>({...inspection(),infrastructurePids:[12,13]})})).toBe(false);
    expect(await hasCloudUserProcesses({inspect:async()=>({...inspection([14]),infrastructurePids:[12,13]})})).toBe(true);
  });

  it("observes foreground processes independently and waits ten minutes after they finish", async () => {
    let now = 0, workload = true;
    const stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false,
      inspectWorkload: async () => workload, stop });
    now = 600_000; scheduler.consider(authority); await scheduler.settled(); expect(stop).not.toHaveBeenCalled();
    workload = false; now += 15_000; scheduler.consider(authority); await scheduler.settled();
    now += 599_999; scheduler.consider(authority); await scheduler.settled(); expect(stop).not.toHaveBeenCalled();
    now++; scheduler.consider(authority); await scheduler.settled(); expect(stop).toHaveBeenCalledOnce();
  });

  it("requires the original inspector to prove idle terminals, retaining their other owned work",async()=>{
    const inspect=vi.fn(async()=>inspection());
    expect(await hasCloudUserProcesses({inspect})).toBe(false);
    inspect.mockResolvedValue(inspection([12]));
    expect(await hasCloudUserProcesses({inspect})).toBe(true);
    inspect.mockResolvedValue({...inspection(),complete:false});
    expect(await hasCloudUserProcesses({inspect})).toBe(true);
  });
  it("exempts only passive PR reconciliation from the user-activity clock", () => {
    expect(isCloudIdleMaintenance("gh.prSync")).toBe(true);
    for (const op of ["gh.prCreate", "gh.prUpdate", "gh.prMerge", "git.commit", "git.fetch", "chats.upsert", "unknown"])
      expect(isCloudIdleMaintenance(op)).toBe(false);
  });
  it("bounds content-free observations and isolates diagnostic failures", async () => {
    let now = 0;
    const observed = vi.fn(() => { throw new Error("logger unavailable"); });
    const failed = vi.fn(() => { throw new Error("logger unavailable"); });
    const stop = vi.fn(async () => { throw new Error("stop unavailable"); });
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, observed, failed, stop });
    scheduler.consider(authority); scheduler.consider(authority);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith({ busy: false, quietSeconds: 0 });
    now = 600_000; scheduler.consider(authority); await scheduler.settled();
    expect(failed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenLastCalledWith({ busy: false, quietSeconds: 600 });
    scheduler.consider(authority); expect(stop).toHaveBeenCalledOnce();
  });
  it("waits ten quiet minutes and resets the clock for work and explicit activity", async () => {
    let now = 0, busy = false;
    const stop = vi.fn(async () => undefined);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => busy, stop });
    scheduler.consider(authority); now = 599_999; scheduler.consider(authority); expect(stop).not.toHaveBeenCalled();
    busy = true; now = 600_000; scheduler.consider(authority);
    busy = false; now = 1_199_999; scheduler.consider(authority); expect(stop).not.toHaveBeenCalled();
    scheduler.activity(); now += 599_999; scheduler.consider(authority); expect(stop).not.toHaveBeenCalled();
    now++; scheduler.consider(authority); await scheduler.settled(); expect(stop).toHaveBeenCalledTimes(1);
  });
  it("rejects activity that arrives during asynchronous inactivity inspection", async () => {
    let now = 0, continueInspection!: () => void;
    const gate = new Promise<void>(resolve => { continueInspection = resolve; });
    const stopped = vi.fn();
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, stop: async (_authority, stillIdle) => { await gate; if (stillIdle()) stopped(); } });
    scheduler.consider(authority); now = 600_000; scheduler.consider(authority); scheduler.consider(authority);
    scheduler.activity(); continueInspection(); await scheduler.settled(); expect(stopped).not.toHaveBeenCalled();
    await scheduler.close(); now += 600_000; scheduler.consider(authority); expect(stopped).not.toHaveBeenCalled();
  });
  it("does not stop when suspended workload, pending launch or unknown ownership remains",async()=>{
    expect(await hasCloudUserProcesses({inspect:async()=>inspection([12])})).toBe(true);
    expect(await hasCloudUserProcesses({inspect:async()=>({...inspection(),pendingLaunches:1})})).toBe(true);
    expect(await hasCloudUserProcesses({inspect:async()=>({...inspection(),failedRetirements:1})})).toBe(true);
    expect(await hasCloudUserProcesses({inspect:async()=>{throw new Error('unreadable');}})).toBe(true);
    expect(await hasCloudUserProcesses({inspect:async()=>inspection()})).toBe(false);
  });
});
