import { describe, expect, it, vi } from "vitest";
import { CloudIdleStopScheduler, hasCloudUserProcesses, isCloudIdleMaintenance } from "../cloud-idle-stop";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
const authority = {} as CloudDurabilityAuthority;
describe("cloud idle stop", () => {
  it("retains an idle warm host through ten quiet minutes then invokes the real stop callback", async () => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => true), deferWorkloadInspection = vi.fn(() => true), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload, deferWorkloadInspection, stop });
    try {
      scheduler.consider(authority); await scheduler.settled(); now = 599_999;
      scheduler.consider(authority); await scheduler.settled(); expect(stop).not.toHaveBeenCalled();
      expect(scheduler.readActivity()).toMatchObject({ revision: 0, quietForMs: 599_999 });
      now++; scheduler.consider(authority); await scheduler.settled();
      expect(stop).toHaveBeenCalledOnce(); expect(inspectWorkload).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledWith(authority, expect.any(Function));
    } finally { await scheduler.close(); }
  });
  it("drains an exact idle host but still refuses Stop until unrelated kernel work is empty", async () => {
    let now = 600_000, warm = true, unrelated = true;
    const retire = vi.fn(async () => { warm = false; }), committed = vi.fn(), inspectWorkload = vi.fn(async () => true);
    const read = async () => "State:\tS (sleeping)\nUid:\t10001\t10001\t10001\t10001\nPPid:\t1\n";
    const stop = vi.fn(async (_authority: CloudDurabilityAuthority, stillIdle: () => boolean) => {
      await retire();
      if (!stillIdle() || await hasCloudUserProcesses({ list: async () => [...(warm ? ["12"] : []), ...(unrelated ? ["13"] : [])], read }) || !stillIdle()) return false;
      committed(); return true;
    });
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload, deferWorkloadInspection: () => true, stop });
    try {
      now += 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(retire).toHaveBeenCalledOnce(); expect(committed).not.toHaveBeenCalled();
      unrelated = false; now += 15_000; scheduler.consider(authority); await scheduler.settled();
      expect(committed).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledTimes(2);
    } finally { await scheduler.close(); }
  });
  it.each(["background", "unknown", "legacy"])("keeps real observational inspection for %s inventory", async kind => {
    let now = 0;
    const inspectWorkload = vi.fn(async () => true), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload, stop,
      ...(kind === "legacy" ? {} : { deferWorkloadInspection: () => false }) });
    try {
      now = 600_000; scheduler.consider(authority); await scheduler.settled();
      expect(inspectWorkload).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
      expect(scheduler.readActivity().quietForMs).toBe(0);
    } finally { await scheduler.close(); }
  });
  it("never consults the warm exception while foreground work is busy or during activity reads", async () => {
    let now = 600_000;
    const deferWorkloadInspection = vi.fn(() => true), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => true, deferWorkloadInspection, inspectWorkload: async () => true, stop });
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
  it("does not let a superseded warm PID inspection reset the quiet interval", async () => {
    let now = 0, defer = false, finish!: (busy: boolean) => void;
    const gate = new Promise<boolean>(resolve => { finish = resolve; }), stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false,
      inspectWorkload: () => gate, deferWorkloadInspection: () => defer, stop });
    try {
      now = 590_000; scheduler.consider(authority); await Promise.resolve();
      defer = true; scheduler.consider(authority); finish(true); await scheduler.settled();
      expect(scheduler.readActivity()).toMatchObject({ revision: 0, quietForMs: 590_000 });
      now = 600_000; scheduler.consider(authority); await scheduler.settled(); expect(stop).toHaveBeenCalledOnce();
    } finally { await scheduler.close(); }
  });
  it("keeps new activity authoritative while exact warm hosts are being drained", async () => {
    let now = 0, enter!: () => void, drain!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), drained = new Promise<void>(resolve => { drain = resolve; }), committed = vi.fn();
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => false, inspectWorkload: async () => true,
      deferWorkloadInspection: () => true, stop: async (_authority, stillIdle) => { enter(); await drained;
        if (!stillIdle()) return false; committed(); return true; } });
    try {
      now = 600_000; scheduler.consider(authority); await entered; scheduler.activity(); drain(); await scheduler.settled();
      expect(committed).not.toHaveBeenCalled();
    } finally { drain(); await scheduler.close(); }
  });
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
