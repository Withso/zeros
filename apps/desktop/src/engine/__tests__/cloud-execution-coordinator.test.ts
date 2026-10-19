import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudExecutionCoordinator, createCloudExecutionCoordinator, type CloudFrontendLaunch } from "../cloud-execution-coordinator";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const launches: CloudFrontendLaunch[] = [];
  const owners = { ledger: {}, writer: randomUUID(), uplink: {}, acceptedWork: { state: "running" } };
  const openLedger = vi.fn(() => owners.ledger), renewWriter = vi.fn(() => owners.writer);
  const initialize = vi.fn(async () => { openLedger(); renewWriter(); });
  const retired = vi.fn(async () => {}), changed = vi.fn();
  const spawn = vi.fn(async (launch: CloudFrontendLaunch) => {
    launches.push(launch);
    return { challenge: vi.fn((challengeId: string) => launch.message({ type: "pong", frontendId: launch.frontendId, challengeId })),
      stopAndProve: retired };
  });
  const coordinator = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize, spawn, changed });
  const ready = () => {
    const launch = launches.at(-1)!;
    launch.message({ type: "ready", frontendId: launch.frontendId });
  };
  return { coordinator, launches, owners, openLedger, renewWriter, retired, changed, spawn, ready };
}

describe("stable cloud coordinator", () => {
  it("frontend_restart_does_not_reopen_ledger_or_renew_writer", async () => {
    const f = fixture();
    await f.coordinator.start(); f.ready();
    const first = f.launches[0]!;
    expect(f.coordinator.isInteractiveReady()).toBe(true);
    first.exited();
    expect(f.coordinator.isInteractiveReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    f.ready();
    expect(f.launches).toHaveLength(2);
    expect(f.coordinator.isInteractiveReady()).toBe(true);
    expect(f.openLedger).toHaveBeenCalledOnce(); expect(f.renewWriter).toHaveBeenCalledOnce();
    expect(f.owners.acceptedWork.state).toBe("running");
    await f.coordinator.stop();
  });

  it("late_old_frontend_cannot_publish_ready", async () => {
    const f = fixture(); await f.coordinator.start(); f.ready();
    const old = f.launches[0]!;
    old.exited(); await vi.advanceTimersByTimeAsync(1_000);
    const revision = f.coordinator.snapshot().revision;
    old.message({ type: "ready", frontendId: old.frontendId });
    old.exited();
    expect(f.coordinator.isInteractiveReady()).toBe(false);
    expect(f.coordinator.snapshot().revision).toBe(revision);
    f.ready();
    expect(f.coordinator.snapshot().frontendId).not.toBe(old.frontendId);
    expect(f.coordinator.isInteractiveReady()).toBe(true);
    await f.coordinator.stop();
  });

  it("missed frontend exit expires a challenged proof and cannot revive it with a late pong", async () => {
    const f = fixture(); await f.coordinator.start(); f.ready();
    const native = await f.spawn.mock.results[0]!.value;
    native.challenge.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.coordinator.isInteractiveReady()).toBe(false);
    expect(f.retired).toHaveBeenCalled();
    const challengeId = native.challenge.mock.calls.at(-1)![0];
    f.launches[0]!.message({ type: "pong", frontendId: f.launches[0]!.frontendId, challengeId });
    expect(f.coordinator.isInteractiveReady()).toBe(false);
    await f.coordinator.stop();
  });

  it("local_factory_never_constructs_coordinator", () => {
    const spawn = vi.fn();
    for (const cloud of [false, true]) for (const negotiated of [false, true]) {
      if (cloud && negotiated) continue;
      expect(createCloudExecutionCoordinator({ cloud, negotiated, bootId: randomUUID(), initialize: vi.fn(), spawn, changed: vi.fn() })).toBeNull();
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not replace a frontend before a raced spawn and its exact retirement both settle", async () => {
    vi.useFakeTimers();
    const releases: ((value: { challenge(): void; stopAndProve(): Promise<void> }) => void)[] = [];
    let retired!: () => void;
    const retirement = new Promise<void>(resolve => { retired = resolve; });
    const spawn = vi.fn((launch: CloudFrontendLaunch) => {
      // Exit may be observed before spawn reports its handle. The handle
      // still belongs to this original attempt until positive retirement.
      launch.exited();
      return new Promise<{ challenge(): void; stopAndProve(): Promise<void> }>(resolve => { releases.push(resolve); });
    });
    const owner = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize: async () => {}, spawn, changed: vi.fn() });
    const starting = owner.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect.soft(spawn).toHaveBeenCalledOnce();
    const stopped = owner.stop();
    for (const release of releases) release({ challenge() {}, stopAndProve: () => retirement });
    retired(); await starting; await stopped;
    expect(owner.isInteractiveReady()).toBe(false);
  });

  it("ignores a pong without an outstanding challenge", async () => {
    const f = fixture(); await f.coordinator.start(); f.ready();
    const launch = f.launches[0]!;
    const before = f.coordinator.snapshot();
    expect(() => launch.message({ type: "pong", frontendId: launch.frontendId, unknown: true })).not.toThrow();
    expect(f.coordinator.snapshot()).toEqual(before);
    await f.coordinator.stop();
  });

  it("an unproven retirement stays unavailable and cannot start a second frontend", async () => {
    const f = fixture(); await f.coordinator.start(); f.ready();
    f.retired.mockRejectedValue(new Error("retirement unknown"));
    f.launches[0]!.exited();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.coordinator.isInteractiveReady()).toBe(false);
    expect(f.spawn).toHaveBeenCalledOnce();
    await expect(f.coordinator.stop()).rejects.toThrow("retirement unknown");
  });

  it("retries a positively empty launch after reversible admission resumes without reopening the owner", async () => {
    vi.useFakeTimers();
    let fenced = true;
    const initialize = vi.fn(async () => {}), changed = vi.fn();
    const spawn = vi.fn(async (launch: CloudFrontendLaunch) => {
      if (fenced) return null;
      launch.message({ type: "ready", frontendId: launch.frontendId });
      return { challenge() {}, stopAndProve: async () => {} };
    });
    const owner = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize, spawn, changed });
    await owner.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect.soft(spawn).toHaveBeenCalledTimes(4);
    expect.soft(changed).not.toHaveBeenCalled();
    expect(owner.isInteractiveReady()).toBe(false);
    fenced = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect.soft(owner.isInteractiveReady()).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
    await owner.stop();
  });

  it("does not treat a rejected spawn as proof that no process exists", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => { throw new Error("preparation retirement unknown"); });
    const owner = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize: async () => {}, spawn, changed: vi.fn() });
    await owner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledOnce(); expect(owner.isInteractiveReady()).toBe(false);
    await expect(owner.stop()).rejects.toThrow("preparation retirement unknown");
  });

  it("stop during owner initialization never launches ingress afterward", async () => {
    let ready!: () => void;
    const initialize = vi.fn(() => new Promise<void>(resolve => { ready = resolve; })), spawn = vi.fn();
    const owner = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize, spawn, changed: vi.fn() });
    const start = owner.start(); await owner.stop(); ready(); await start;
    expect(spawn).not.toHaveBeenCalled(); expect(owner.isInteractiveReady()).toBe(false);
  });
});
