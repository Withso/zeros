import { describe, expect, it, vi } from "vitest";
import { advanceHostedAgents, nativeRuntimeEvidence, retireUnfinishedHostedAgents } from "../dev-environment/hosted-agents.mjs";
import { hostedAgentRequest } from "../dev-environment/hosted-agent-canary.mjs";

function fixture() {
  const image = { qualified: true, inputsSha256: "a".repeat(64), snapshotId: "dev-test-image", sourceCommit: "b".repeat(40), buildSha256: "c".repeat(64) };
  const connection = { provider: "claude", kind: "claude-setup-token", credentialId: "11111111-1111-4111-8111-111111111111", credentialRevision: 1, connectionRevision: 1, model: "claude-haiku-4-5", enabled: false };
  const state: any = { status: "ready", owner: "a".repeat(24), generation: "22222222-2222-4222-8222-222222222222", source: { workerInputsSha256: image.inputsSha256 }, resources: { images: [image] } };
  const lease = { state, save: vi.fn(), fence: vi.fn(), signal: new AbortController().signal };
  const status = { actorUserId: "33333333-3333-4333-8333-333333333333", connections: [connection] };
  const deps = { inspect: vi.fn(async () => status), seed: vi.fn(), allocate: vi.fn(async () => {}), ready: vi.fn(async () => true),
    start: vi.fn(async () => {}), poll: vi.fn(async (): Promise<any> => ({ running: true })), enable: vi.fn(), retire: vi.fn(), now: () => Date.now() };
  return { image, connection, state, lease, status, deps, profile: { fixture: {} } };
}
function outcome(f: ReturnType<typeof fixture>) {
  return { code: 0, retirement: 0, report: { version: 3, executionProfile: "zeros-cloud-native-v1", qualified: true,
    authority: "isolated-image-canary", qualifiedAt: new Date().toISOString(),
    identity: { sourceCommit: f.image.sourceCommit, buildSha256: f.image.buildSha256, contractSha256: "d".repeat(64), kind: f.connection.kind, model: f.connection.model },
    checks: ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission", "stopAndRevocation", "nativeTurn", "nativeResume", "authentication", "nativePermissionSelection", "nativeMcp"] } };
}

describe("automatic hosted Dev agent enablement", () => {
  function organizationFixture() {
    const f = fixture();
    const organizationImage = { id: "44444444-4444-4444-8444-444444444444", snapshotId: `zeros-org-${"4".repeat(32)}`,
      sourceCommit: f.image.sourceCommit, buildSha256: "e".repeat(64), contractSha256: "d".repeat(64),
      connections: [{ ...f.connection }] };
    f.connection.enabled = true;
    Object.assign(f.status, { organizationImages: [organizationImage] });
    return { ...f, organizationImage };
  }
  it("qualifies an attested organization image independently of the enabled worker image", async () => {
    const f = organizationFixture();
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("testing");
    expect(f.deps.allocate).toHaveBeenCalledWith(expect.anything(), f.organizationImage);
    const job = f.state.agentQualifications[0];
    expect(job.organizationImageId).toBe(f.organizationImage.id);
    const result = outcome(f); result.report.identity.buildSha256 = f.organizationImage.buildSha256;
    expect(() => nativeRuntimeEvidence({ ...f.organizationImage, contractSha256: "f".repeat(64) },
      f.connection, result, job.startedAt)).toThrow();
    f.deps.poll.mockResolvedValue(result);
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("enabled");
    expect(f.deps.enable).toHaveBeenCalledWith(expect.objectContaining({ evidence: expect.objectContaining({
      imageRef: `boat:${f.organizationImage.snapshotId}@sha256:${f.organizationImage.buildSha256}`,
    }) }));
    expect(f.state.resources.images).toEqual([f.image]);
    const request = hostedAgentRequest(f.state, { fixture: {}, boat: { accountScope: "fixture" }, connections: { enabled: true } }, f.organizationImage);
    expect(request).toMatchObject({ image: { snapshotId: f.image.snapshotId }, accountScope: "fixture", referenceMode: true,
      organizationImage: { id: f.organizationImage.id, snapshotId: f.organizationImage.snapshotId } });
  });
  it("retires removed organization images and bounds retries without approving base-image evidence", async () => {
    const f = organizationFixture();
    f.deps.poll.mockResolvedValue(outcome(f)); // Wrong image digest.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await advanceHostedAgents(f.lease, f.profile, f.deps, { retry: true })).state).toBe("testing");
      expect((await advanceHostedAgents(f.lease, f.profile, f.deps, { retry: true })).state).toBe("failed");
    }
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps, { retry: true })).state).toBe("failed");
    expect(f.deps.allocate).toHaveBeenCalledTimes(3); expect(f.deps.enable).not.toHaveBeenCalled();
    const pending = organizationFixture();
    await advanceHostedAgents(pending.lease, pending.profile, pending.deps);
    Object.assign(pending.status, { organizationImages: [] });
    expect((await advanceHostedAgents(pending.lease, pending.profile, pending.deps)).state).toBe("ready");
    expect(pending.deps.retire).toHaveBeenCalledOnce(); expect(pending.deps.enable).not.toHaveBeenCalled();
  });
  it("preserves only explicitly completed native extension proofs",()=>{
    const f=fixture(),result=outcome(f);
    result.report.checks.push("transcriptFork","nativeGoals","nativeFork","nativeReview","nativeApps","nativeMultiAgent","inventedFeature");
    const evidence=nativeRuntimeEvidence(f.image,f.connection,result,Date.now()-1000);
    expect(evidence.credentials[0].checks).toMatchObject({transcriptFork:true,nativeGoals:true,nativeFork:true,nativeReview:true,nativeApps:true,nativeMultiAgent:true});
    expect(evidence.credentials[0].checks).not.toHaveProperty("inventedFeature");
    expect(nativeRuntimeEvidence(f.image,f.connection,outcome(f),Date.now()-1000).credentials[0].checks).not.toHaveProperty("nativeGoals");
  });
  it("waits for real sign-in and connections without allocating paid workers", async () => {
    const f = fixture(); f.deps.inspect.mockResolvedValue({ needsSignIn: true } as any);
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("sign-in");
    expect(f.deps.allocate).not.toHaveBeenCalled(); expect(f.deps.enable).not.toHaveBeenCalled();
    f.deps.inspect.mockResolvedValue({ ...f.status, connections: [] });
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("connections");
  });
  it("automatically seeds the verified fixture after first sign-in", async () => {
    const f = fixture(); f.deps.inspect.mockResolvedValue({ needsSeed: true } as any);
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.deps.seed).toHaveBeenCalledOnce(); expect(f.deps.allocate).not.toHaveBeenCalled();
  });
  it("never sends account material to a clone that failed machine attestation", async () => {
    const f = fixture(); f.deps.ready.mockResolvedValue("failed" as any);
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("failed");
    expect(f.deps.start).not.toHaveBeenCalled(); expect(f.deps.enable).not.toHaveBeenCalled(); expect(f.deps.retire).toHaveBeenCalledOnce();
  });
  it("persists dispatch before testing and only enables a successful exact-image report", async () => {
    const f = fixture(); f.deps.start.mockImplementation(async () => { expect(f.state.agentQualifications[0].phase).toBe("starting"); });
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("testing");
    expect(f.deps.enable).not.toHaveBeenCalled();
    f.deps.poll.mockResolvedValue(outcome(f));
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("enabled");
    expect(f.deps.enable).toHaveBeenCalledOnce(); expect(f.deps.retire).toHaveBeenCalledOnce();
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.deps.start).toHaveBeenCalledOnce(); expect(f.deps.enable).toHaveBeenCalledOnce();
  });
  it("does not redispatch a lost start response or repeat paid failures on later launches", async () => {
    const f = fixture(); f.deps.start.mockRejectedValueOnce(new Error("private-provider-output"));
    await expect(advanceHostedAgents(f.lease, f.profile, f.deps)).rejects.toThrow();
    expect(f.state.agentQualifications[0].phase).toBe("starting");
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.deps.start).toHaveBeenCalledOnce();
    f.deps.poll.mockResolvedValue({ code: 1, retirement: 0 });
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("failed");
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.deps.start).toHaveBeenCalledOnce(); expect(f.deps.enable).not.toHaveBeenCalled();
    expect(JSON.stringify(f.state)).not.toContain("private-provider-output");
  });
  it("retires a known failure before dispatch immediately instead of polling an unstarted VM", async () => {
    const f = fixture(); f.deps.start.mockRejectedValueOnce(Object.assign(new Error("private-output"), { code: "DEV_AGENT_NOT_DISPATCHED" }));
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("failed");
    expect(f.state.agentQualifications[0]).toMatchObject({ phase: "failed", retired: true });
    expect(f.deps.poll).not.toHaveBeenCalled(); expect(f.deps.retire).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.state)).not.toContain("private-output");
  });
  it("retires a test when its connected credential is revoked or switched", async () => {
    const f = fixture(); await advanceHostedAgents(f.lease, f.profile, f.deps);
    f.deps.inspect.mockResolvedValue({ ...f.status, connections: [] });
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.deps.retire).toHaveBeenCalledOnce(); expect(f.deps.enable).not.toHaveBeenCalled();
  });
  it("keeps cleanup retryable and refuses another image's evidence", async () => {
    const f = fixture(); await advanceHostedAgents(f.lease, f.profile, f.deps);
    const report = outcome(f); report.report.identity.buildSha256 = "e".repeat(64); f.deps.poll.mockResolvedValue(report);
    f.deps.retire.mockRejectedValueOnce(new Error("deletion pending"));
    await expect(advanceHostedAgents(f.lease, f.profile, f.deps)).rejects.toThrow();
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.deps.retire).toHaveBeenCalledTimes(2); expect(f.deps.enable).not.toHaveBeenCalled();
  });
  it("retains bounded fixed failure evidence before deleting a failed native test VM", async () => {
    const f = fixture(); await advanceHostedAgents(f.lease, f.profile, f.deps);
    f.deps.poll.mockResolvedValue({ code: 1, retirement: 0, report: { qualified: false,
      checks: ["privateProviderHome", "nativeTurn", "secret-sentinel"], error: "private-provider-output" } });
    f.deps.retire.mockImplementation(async () => { expect(f.state.agentQualifications[0].failure).toEqual({
      stage: "native", exitCode: 1, retirementCode: 0, qualified: false, completedChecks: ["privateProviderHome", "nativeTurn"],
    }); });
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("failed");
    expect(JSON.stringify(f.state)).not.toContain("private-provider-output");
    expect(JSON.stringify(f.state)).not.toContain("secret-sentinel");
  });
  it("does not qualify during archive or silently adopt a mismatched worker", async () => {
    const f = fixture(); f.state.status = "archiving";
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("inactive");
    expect(f.deps.inspect).not.toHaveBeenCalled(); f.state.status = "ready";
    f.state.source.workerInputsSha256 = "f".repeat(64);
    await expect(advanceHostedAgents(f.lease, f.profile, f.deps)).rejects.toThrow(/image/);
    expect(f.deps.allocate).not.toHaveBeenCalled();
  });
  it("requires independent Codex renewal and worker refresh adoption evidence", () => {
    const f = fixture(); f.connection.kind = "codex-chatgpt"; f.connection.provider = "codex"; f.connection.model = "gpt-5.6-luna";
    const report: any = outcome(f);
    expect(() => nativeRuntimeEvidence(f.image, f.connection, report, Date.now() - 1000)).toThrow();
    report.report.checks.push("nativeAccessRefresh");
    report.renewal = { accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true };
    expect(nativeRuntimeEvidence(f.image, f.connection, report, Date.now() - 1000).credentials[0].renewal).toBe(true);
    report.retirement = 1;
    expect(() => nativeRuntimeEvidence(f.image, f.connection, report, Date.now() - 1000)).toThrow();
  });
  it("reconciles a lost enablement acknowledgement without repeating the privileged write", async () => {
    const f = fixture(); await advanceHostedAgents(f.lease, f.profile, f.deps);
    f.deps.poll.mockResolvedValue(outcome(f)); f.deps.enable.mockRejectedValueOnce(new Error("response lost after commit"));
    await expect(advanceHostedAgents(f.lease, f.profile, f.deps)).rejects.toThrow();
    f.connection.enabled = true;
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("enabled");
    expect(f.deps.enable).toHaveBeenCalledOnce();
  });
});

describe("native agent qualification deadline", () => {
  it("lets an extended native run finish, then retires an overdue one with an explicit deadline failure", async () => {
    // Codex's extended checks (goals, forks, review, multi-agent, apps) run
    // past twelve minutes; its canary machine must also outlive that run.
    const f = fixture(); let now = Date.now(); f.deps.now = () => now;
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("testing");
    now += 20 * 60_000;
    expect((await advanceHostedAgents(f.lease, f.profile, f.deps)).state).toBe("testing");
    expect(f.deps.retire).not.toHaveBeenCalled();
    now += 25 * 60_000;
    await advanceHostedAgents(f.lease, f.profile, f.deps);
    expect(f.state.agentQualifications[0]).toMatchObject({ phase: "failed", retired: true, failure: { stage: "deadline" } });
  });
});

it("reports a failed native run's fixed-format error code and class name, never free text", async () => {
  const f = fixture();
  await advanceHostedAgents(f.lease, f.profile, f.deps);
  f.deps.poll.mockResolvedValue({ code: 1, retirement: 0, report: { qualified: false, phase: "native-start", checks: ["actorAdmission"], failure: "runtime",
    failureCode: "EROFS", failureName: "Error" } });
  await advanceHostedAgents(f.lease, f.profile, f.deps);
  expect(f.state.agentQualifications[0].failure).toMatchObject({ nativePhase: "native-start", category: "runtime", errorCode: "EROFS", errorName: "Error" });
  const g = fixture();
  await advanceHostedAgents(g.lease, g.profile, g.deps);
  g.deps.poll.mockResolvedValue({ code: 1, retirement: 0, report: { qualified: false, phase: "native-start", failure: "runtime", failureCode: "read-only: /srv", failureName: "Error: text" } });
  await advanceHostedAgents(g.lease, g.profile, g.deps);
  expect(g.state.agentQualifications[0].failure).not.toHaveProperty("errorCode");
  expect(g.state.agentQualifications[0].failure).not.toHaveProperty("errorName");
});

it("retires unfinished checks of a replaced image so the new build can take the owner's builder slot", async () => {
  // A canary holds the owner's builder reservation, and only a ready
  // environment advances it; a relaunch with new worker source must not wait.
  const f = fixture();
  f.state.agentQualifications = [
    { id: "running", phase: "running", retired: false },
    { id: "failed", phase: "failed", retired: false, failure: { stage: "native" } },
    { id: "enabled", phase: "enabled", retired: true },
  ];
  expect(await retireUnfinishedHostedAgents(f.lease, f.deps)).toBe(2);
  expect(f.deps.retire.mock.calls.map(([job]: any) => job.id)).toEqual(["running", "failed"]);
  expect(f.state.agentQualifications).toMatchObject([
    { id: "running", phase: "failed", retired: true, failure: { stage: "superseded" } },
    { id: "failed", phase: "failed", retired: true, failure: { stage: "native" } },
    { id: "enabled", phase: "enabled", retired: true },
  ]);
  expect(await retireUnfinishedHostedAgents(f.lease, f.deps)).toBe(0);
});
