import { describe, expect, it, vi } from "vitest";
import { CloudIdleStopScheduler } from "../cloud-idle-stop";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
const authority = {} as CloudDurabilityAuthority;
describe("idle stop retry clock", () => {
  it("continues observation while record synchronization is hung and reports bounded blocking", async () => {
    vi.useFakeTimers();
    try {
      let now=0;
      const blocked=vi.fn();
      const stop=vi.fn(async()=>{throw new Error("synthetic synchronization failure");});
      const scheduler=new CloudIdleStopScheduler({now:()=>now,busy:()=>false,stop,blocked});
      scheduler.recordSync("pending");
      scheduler.observe(authority); // called before any synchronization promise
      now=600_000;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stop).toHaveBeenCalledOnce();
      expect(blocked).toHaveBeenCalledWith({code:"idle_stop_blocked",reason:"record_sync",quietSeconds:600,retrySeconds:15});
      now+=15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stop).toHaveBeenCalledTimes(2);
      await scheduler.close();
      now+=600_000;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(stop).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it.each([true, false])("retries without fabricating activity (failure=%s)", async failure => {
    let now = 0;
    const observed = vi.fn();
    const stop = vi.fn(async () => { if (failure) throw new Error("synthetic"); });
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, stop, observed });
    now = 600_000; scheduler.consider(authority); await scheduler.settled();
    now += 60_000; scheduler.consider(authority); await scheduler.settled();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith({ busy: false, quietSeconds: 660 });
    scheduler.activity(); now += 60_000; scheduler.consider(authority);
    expect(stop).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });
});
