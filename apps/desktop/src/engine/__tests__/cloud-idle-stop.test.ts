import { describe, expect, it, vi } from "vitest";
import { CloudIdleStopScheduler, hasCloudUserProcesses, isCloudIdleMaintenance } from "../cloud-idle-stop";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
const authority = {} as CloudDurabilityAuthority;
describe("cloud idle stop", () => {
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
  it("does not stop when worker processes, suspended work or unknown proc state remain", async () => {
    const read = vi.fn(async () => "Name:\tworker\nState:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\n");
    const list = async () => ["12", "self", "net"];
    expect(await hasCloudUserProcesses({ list, read })).toBe(true);
    read.mockResolvedValue("State:\tT (stopped)\nUid:\t10004\t10004\t10004\t10004\n");
    expect(await hasCloudUserProcesses({ list, read })).toBe(true);
    read.mockRejectedValueOnce(Object.assign(new Error(), { code: "EACCES" }));
    expect(await hasCloudUserProcesses({ list, read })).toBe(true);
    read.mockResolvedValue("State:\tS (sleeping)\nUid:\t0\t0\t0\t0\n");
    expect(await hasCloudUserProcesses({ list, read })).toBe(false);
    read.mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" }));
    expect(await hasCloudUserProcesses({ list, read })).toBe(false);
    read.mockResolvedValue("State:\tZ (zombie)\nUid:\t10001\t10001\t10001\t10001\n");
    expect(await hasCloudUserProcesses({ list, read })).toBe(false);
  });
});
