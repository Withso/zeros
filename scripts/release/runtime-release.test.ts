import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { releaseRuntime, type RuntimeReleaseDependencies } from "./runtime-release";
import type { RuntimeReleaseConfig, RuntimeLiveState } from "./runtime-contracts";

function fixture(action: "publish" | "promote" | "rollback" = "publish") {
  const config: RuntimeReleaseConfig = { channel: action === "promote" ? "beta" : "alpha", action, repository: "example/project",
    branch: action === "promote" ? "release/1.2.3" : "main", workflowSha: "1".repeat(40), runId: "123", runAttempt: 1,
    expectedCpSha: "2".repeat(40), expectedRuntimeSha256: "a".repeat(64),
    ...(action === "publish" ? { sourceSha: "3".repeat(40) } : action === "promote" ? { runtimeSha256: "b".repeat(64), alphaRunId: "100", alphaRunAttempt: 1 } : {}) };
  const release = { version: 1 as const, sha256: "b".repeat(64), sourceSha: "3".repeat(40), sourceSha256: "c".repeat(64),
    qualification: { channel: "alpha" as const, runId: action === "promote" ? "100" : "123", runAttempt: 1, completedAt: "2026-11-01T00:00:00.000Z", receiptSha256: "d".repeat(64), deleted: true as const } };
  const live: RuntimeLiveState = { branch: config.branch, current: { sha256: config.expectedRuntimeSha256, release: null },
    previous: { sha256: release.sha256, release },
    identity: { version: 1, channel: config.channel, sourceSha: config.expectedCpSha, ready: true, maintenance: false,
      migrations: { state: "current", head: "0221_fixture.sql", expectedHead: "0221_fixture.sql", manifestSha256: "e".repeat(64) },
      cloud: { enabled: true, ready: true, state: "healthy" }, worker: { sha256: config.expectedRuntimeSha256 }, workerQualified: false, runtimeCanaryAdmission: 1, runtimeBuildDrainVersion: 1 } };
  const manifest = { version: 1 as const, repository: config.repository, sha256: release.sha256, sourceSha: release.sourceSha, sourceSha256: release.sourceSha256, bytes: 123 };
  const lease = { version: 1 as const, id: randomUUID(), runId: config.runId,
    liveCpSha: config.expectedCpSha, priorRuntimeSha256: config.expectedRuntimeSha256, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  const status = { version: 1 as const, lease, state: "active" as const, liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: true };
  const events: string[] = [];
  const record = <T>(name: string, value: T) => vi.fn(async () => { events.push(name); return value; });
  const deps: RuntimeReleaseDependencies = {
    current: record("current", live), source: record("source", undefined),
    prepare: record("prepare", manifest), qualify: record("qualify_deleted", release),
    qualification: record("qualification", release), retain: record("retain", undefined),
    beginDrain: record("begin", status), inspectDrain: record("inspect", status),
    endDrain: record("end", { version: 1, lease, released: true }), pause: record("pause", undefined),
    stage: record("stage", undefined), deploy: record("deploy", "deployment-fixture"),
    wait: record("wait", undefined), recover: record("recover", { releaseDrain: true }), record: record("record", undefined),
  };
  return { config, release, live, manifest, lease, status, events, deps, run: () => releaseRuntime(config, deps) };
}

describe("runtime-only release transaction", () => {
  it("qualifies and deletes the candidate before draining, staging, or redeploying the unchanged CP", async () => {
    const f = fixture(), receipt = await f.run();
    expect(f.events).toEqual(["source", "current", "prepare", "qualify_deleted", "retain", "source", "current", "begin", "source", "current", "inspect", "stage", "current", "inspect", "deploy", "wait", "end", "record"]);
    expect(f.deps.deploy).toHaveBeenCalledExactlyOnceWith(f.config.expectedCpSha, f.lease);
    expect(f.deps.stage).toHaveBeenCalledExactlyOnceWith({ sha256: f.release.sha256, release: f.release }, f.live.current, f.lease);
    expect(receipt).toMatchObject({ status: "success", action: "publish", cpSourceSha: f.config.expectedCpSha, previousRuntimeSha256: f.config.expectedRuntimeSha256, runtime: f.release });
  });

  it("promotes a retained qualification without building or starting a canary", async () => {
    const f = fixture("promote"); await f.run();
    expect(f.deps.qualify).not.toHaveBeenCalled();
    expect(f.deps.qualification).toHaveBeenCalledExactlyOnceWith(f.manifest, { runId: "100", runAttempt: 1 });
    expect(f.events.indexOf("qualification")).toBeLessThan(f.events.indexOf("begin"));
  });

  it("refuses the already-active digest before qualification or replacing the rollback pin", async () => {
    const f = fixture("promote"); f.config.runtimeSha256 = f.config.expectedRuntimeSha256;
    vi.mocked(f.deps.prepare).mockResolvedValue({ ...f.manifest, sha256: f.config.expectedRuntimeSha256 });
    vi.mocked(f.deps.qualification).mockResolvedValue({ ...f.release, sha256: f.config.expectedRuntimeSha256 });
    await expect(f.run()).rejects.toThrow(/already active/);
    expect(f.deps.qualification).not.toHaveBeenCalled(); expect(f.deps.beginDrain).not.toHaveBeenCalled(); expect(f.deps.stage).not.toHaveBeenCalled();
  });

  it("rolls back only to the previous pin and requalifies that archive on Alpha", async () => {
    const f = fixture("rollback"); await f.run();
    expect(f.deps.prepare).toHaveBeenCalledExactlyOnceWith(f.live.previous!.sha256);
    expect(f.deps.qualify).toHaveBeenCalledExactlyOnceWith(f.manifest);
  });

  it.each(["source", "current", "prepare", "qualify", "retain"] as const)("refuses downstream pin authority on %s failure", async name => {
    const f = fixture(); vi.mocked(f.deps[name]).mockRejectedValueOnce(new Error("synthetic-secret-provider-body"));
    await expect(f.run()).rejects.toThrow(/Runtime release stopped/);
    expect(f.deps.beginDrain).not.toHaveBeenCalled(); expect(f.deps.stage).not.toHaveBeenCalled(); expect(f.deps.record).not.toHaveBeenCalled();
  });

  it.each(["ended", "expired", "foreign", "elapsed", "unknown", "missing-adoption-count", "contradictory-ready"])(
    "releases its owned drain after refusing %s inspection", async change => {
      const f = fixture(), next: Record<string, unknown> = { ...f.status };
      if (change === "ended" || change === "expired") { next.state = change; next.ready = false; }
      if (change === "foreign") next.lease = { ...f.lease, runId: "999" };
      if (change === "elapsed") next.lease = { ...f.lease, expiresAt: "2000-01-01T00:00:00.000Z" };
      if (change === "unknown") next.state = "unknown";
      if (change === "missing-adoption-count") delete next.runtimeAdoptionCount;
      if (change === "contradictory-ready") next.runtimeAdoptionCount = 1;
      vi.mocked(f.deps.inspectDrain).mockResolvedValue(next as never);
      await expect(f.run()).rejects.toThrow();
      expect(f.deps.endDrain).toHaveBeenCalledExactlyOnceWith(f.lease); expect(f.deps.stage).not.toHaveBeenCalled(); expect(f.deps.deploy).not.toHaveBeenCalled();
    });

  it.each(["liveCount", "unresolvedCount", "runtimeAdoptionCount"] as const)("waits for admitted %s without renewing the lease or interrupting it", async count => {
    const f = fixture();
    vi.mocked(f.deps.beginDrain).mockResolvedValue({ ...f.status, [count]: 1, ready: false });
    await f.run();
    expect(f.deps.beginDrain).toHaveBeenCalledOnce(); expect(f.deps.pause).toHaveBeenCalledOnce();
    expect(f.deps.inspectDrain).toHaveBeenCalledWith(f.lease);
    expect(f.events.indexOf("pause")).toBeLessThan(f.events.indexOf("stage"));
    expect(f.events.slice(f.events.indexOf("pause") + 1)).toContain("source");
  });

  it("refuses a lease that expires while waiting and never renews its run", async () => {
    const f = fixture(); vi.mocked(f.deps.beginDrain).mockResolvedValue({ ...f.status, liveCount: 1, ready: false });
    vi.mocked(f.deps.inspectDrain).mockResolvedValue({ ...f.status, state: "expired", ready: false });
    await expect(f.run()).rejects.toThrow();
    expect(f.deps.beginDrain).toHaveBeenCalledOnce(); expect(f.deps.endDrain).toHaveBeenCalledExactlyOnceWith(f.lease);
    expect(f.deps.stage).not.toHaveBeenCalled();
  });

  it.each(["owned", "unavailable", "foreign"])("recovers a lost begin reply only to release its %s lease", async recovery => {
    const f = fixture();
    vi.mocked(f.deps.beginDrain).mockRejectedValueOnce(new Error("lost begin acknowledgement"));
    if (recovery === "unavailable") vi.mocked(f.deps.beginDrain).mockRejectedValueOnce(new Error("still unavailable"));
    if (recovery === "foreign") vi.mocked(f.deps.beginDrain).mockResolvedValueOnce({ ...f.status, lease: { ...f.lease, runId: "999" } });
    await expect(f.run()).rejects.toThrow();
    expect(f.deps.beginDrain).toHaveBeenCalledTimes(2);
    if (recovery === "owned") expect(f.deps.endDrain).toHaveBeenCalledExactlyOnceWith(f.lease);
    else expect(f.deps.endDrain).not.toHaveBeenCalled();
    expect(f.deps.stage).not.toHaveBeenCalled(); expect(f.deps.record).not.toHaveBeenCalled();
  });

  it.each(["stage", "deploy", "wait"] as const)("releases on an ambiguous %s without retrying the mutation or publishing success", async name => {
    const f = fixture(); vi.mocked(f.deps[name]).mockRejectedValueOnce(new Error("synthetic-secret-provider-body"));
    await expect(f.run()).rejects.toThrow(/Runtime release stopped/);
    expect(f.deps[name]).toHaveBeenCalledOnce(); expect(f.deps.endDrain).toHaveBeenCalledExactlyOnceWith(f.lease); expect(f.deps.record).not.toHaveBeenCalled();
  });
  it("keeps the lease held when a rollout or staged-variable restoration cannot be confirmed", async () => {
    const f = fixture(); vi.mocked(f.deps.wait).mockRejectedValueOnce(new Error("pending deployment"));
    vi.mocked(f.deps.recover).mockResolvedValue({ releaseDrain: false });
    await expect(f.run()).rejects.toThrow(/unconfirmed/);
    expect(f.deps.endDrain).not.toHaveBeenCalled(); expect(f.deps.record).not.toHaveBeenCalled();
  });

  it("refuses a live CP/pin change immediately before deploy, even after staging", async () => {
    const f = fixture(); vi.mocked(f.deps.current).mockResolvedValueOnce(f.live).mockResolvedValueOnce(f.live).mockResolvedValueOnce(f.live)
      .mockResolvedValueOnce({ ...f.live, identity: { ...f.live.identity, sourceSha: "4".repeat(40) } });
    await expect(f.run()).rejects.toThrow(); expect(f.deps.stage).toHaveBeenCalledOnce(); expect(f.deps.deploy).not.toHaveBeenCalled(); expect(f.deps.endDrain).toHaveBeenCalledOnce();
  });

  it.each([false, undefined, null, { released: true }])("requires the complete confirmed-release proof before recording success (%j)", async proof => {
    const f = fixture(); vi.mocked(f.deps.endDrain).mockResolvedValue(proof as never);
    await expect(f.run()).rejects.toThrow(); expect(f.deps.record).not.toHaveBeenCalled(); expect(f.deps.endDrain).toHaveBeenCalledOnce();
  });

  it("refuses a release proof for a successor lease", async () => {
    const f = fixture(); vi.mocked(f.deps.endDrain).mockResolvedValue({ version: 1, lease: { ...f.lease, id: randomUUID() }, released: true });
    await expect(f.run()).rejects.toThrow(); expect(f.deps.record).not.toHaveBeenCalled();
  });

  it("refuses a borrowed Alpha qualification before any pin authority", async () => {
    const f = fixture(); vi.mocked(f.deps.qualify).mockResolvedValue({ ...f.release, qualification: { ...f.release.qualification, runId: "999" } });
    await expect(f.run()).rejects.toThrow(); expect(f.deps.beginDrain).not.toHaveBeenCalled();
  });

  it("refuses a missing rollback record and a substituted manifest before any drain", async () => {
    const f = fixture("rollback"); f.live.previous = null;
    await expect(f.run()).rejects.toThrow(); expect(f.deps.beginDrain).not.toHaveBeenCalled();
    const p = fixture("publish"); vi.mocked(p.deps.prepare).mockResolvedValue({ ...p.manifest, sourceSha: "9".repeat(40) });
    await expect(p.run()).rejects.toThrow(); expect(p.deps.qualify).not.toHaveBeenCalled();
  });
});
