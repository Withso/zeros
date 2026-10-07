import { describe, expect, it, vi } from "vitest";
import { CloudIdleStopScheduler, hasCloudUserProcesses, isCloudIdleMaintenance } from "../cloud-idle-stop";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
const authority = {} as CloudDurabilityAuthority;
describe("cloud idle stop", () => {
  it("excludes only the exact root-owned resident workload scope during a live handoff", async () => {
    const residentScope = "/zeros-host.service/engine-workload-11111111-1111-4111-8111-111111111111";
    let membership = `0::${residentScope}\n`;
    const read = async (file: string) => file.endsWith("/cgroup") ? membership
      : "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\nPPid:\t1\n";
    const options = { list: async () => ["12"], read, residentScope };
    expect(await hasCloudUserProcesses(options)).toBe(false);
    // Ordinary idle-stop remains conservative, including detached descendants.
    expect(await hasCloudUserProcesses({ ...options, residentScope: undefined })).toBe(true);
    for (membership of [`0::${residentScope}-foreign\n`, `0::${residentScope}/child\n`, "0::/zeros-cloud/engine-source\n", "unknown"])
      expect(await hasCloudUserProcesses(options)).toBe(true);
    expect(await hasCloudUserProcesses({ ...options, residentScope: "/zeros-cloud/../engine-source" })).toBe(true);
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
  it("ignores attested restartable language-server trees during observation, retaining unrelated work", async () => {
    const root = "State:\tS (sleeping)\nUid:\t10003\t10003\t10003\t10003\nPPid:\t1\n";
    const server = "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\nPPid:\t12\n";
    const user = "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\nPPid:\t1\n";
    const read = async (file: string) => file.includes("/12/") ? root : file.includes("/13/") ? server : user;
    expect(await hasCloudUserProcesses({ list: async () => ["12", "13"], read, infrastructurePids: [12] })).toBe(false);
    expect(await hasCloudUserProcesses({ list: async () => ["12", "13", "14"], read, infrastructurePids: [12] })).toBe(true);
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

  it("lets an old idle terminal shell sleep but retains its foreground and detached children", async () => {
    const list = async () => ["12", "13"];
    const read = vi.fn(async (file: string): Promise<string> => file.endsWith("/stat")
      ? "12 (login shell) S 1 12 12 7 12 0"
      : file.includes("/13/") ? "State:\tZ (zombie)\nUid:\t10001\t10001\t10001\t10001\n"
        : "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\n");
    expect(await hasCloudUserProcesses({ list, read, idleTerminalPids: [12] })).toBe(false);
    read.mockImplementation(async file => file.endsWith("/stat") ? "12 (shell) S 1 12 12 7 13 0"
      : "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\n");
    expect(await hasCloudUserProcesses({ list, read, idleTerminalPids: [12] })).toBe(true);
    read.mockImplementation(async file => file.endsWith("/stat") ? "12 (shell) S 1 12 12 7 12 0"
      : "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\n");
    expect(await hasCloudUserProcesses({ list, read, idleTerminalPids: [12] })).toBe(true);
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
