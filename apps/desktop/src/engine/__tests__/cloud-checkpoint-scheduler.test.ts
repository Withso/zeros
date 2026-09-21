import { describe, expect, it, vi } from "vitest";
import { CloudCheckpointScheduler } from "../cloud-checkpoint-scheduler";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";

const authority: CloudDurabilityAuthority = { heartbeatEndpoint: "https://control.example.test/heartbeat", heartbeatToken: "fixture",
  workspaceId: "workspace", organizationId: "org", generation: 1, engineInstanceId: "engine" };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("periodic cloud recovery points", () => {
  it("requires healthy heartbeats, admits one bounded capture and yields to lifecycle work", async () => {
    let now = 0, eligible = true, finish!: () => void;
    const capture = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const scheduler = new CloudCheckpointScheduler({ capture, eligible: () => eligible, now: () => now });
    scheduler.consider(authority); now = 299_999; scheduler.consider(authority);
    await settle(); expect(capture).not.toHaveBeenCalled();
    now = 300_000; eligible = false; scheduler.consider(authority); await settle(); expect(capture).not.toHaveBeenCalled();
    eligible = true; scheduler.consider(authority); await settle();
    expect(capture).toHaveBeenCalledWith({ id: expect.any(String), reason: "periodic", deadlineAtMs: 360_000 }, authority);
    scheduler.consider(authority); let paused = false;
    const pause = scheduler.pause().then(() => { paused = true; }); await settle(); expect(paused).toBe(false);
    finish(); await pause; now = 900_000; scheduler.consider(authority); await settle(); expect(capture).toHaveBeenCalledOnce();
    scheduler.resume(); now += 300_000; scheduler.consider(authority); await settle(); expect(capture).toHaveBeenCalledTimes(2);
    finish(); await scheduler.close(); now += 300_000; scheduler.resume(); scheduler.consider(authority);
    await settle(); expect(capture).toHaveBeenCalledTimes(2);
  });

  it("backs off changing captures without failing the healthy heartbeat", async () => {
    let now = 0;
    const capture = vi.fn().mockRejectedValue(new Error("changed during capture"));
    const failed = vi.fn(() => { throw new Error("diagnostic failed"); });
    const scheduler = new CloudCheckpointScheduler({ capture, eligible: () => true, failed, now: () => now });
    scheduler.consider(authority); now = 300_000; scheduler.consider(authority); await settle();
    expect(failed).toHaveBeenCalledOnce();
    now = 359_999; scheduler.consider(authority); await settle(); expect(capture).toHaveBeenCalledOnce();
    now++; scheduler.consider(authority); await settle(); expect(capture).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("does not begin queued work after authority loss or a lifecycle pause", async () => {
    let now = 0;
    const capture = vi.fn();
    const scheduler = new CloudCheckpointScheduler({ capture, eligible: () => true, now: () => now });
    scheduler.consider(authority); now = 300_000; scheduler.consider(authority);
    await scheduler.close(); expect(capture).not.toHaveBeenCalled();
  });
});
