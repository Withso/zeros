import { describe, expect, it, vi } from "vitest";
import { advanceHostedAgents, nativeRuntimeEvidence, retireUnfinishedHostedAgents, QUALIFICATION_DEADLINE_MS, qualificationRateLimited } from "../dev-environment/hosted-agents.mjs";
import { hostedAgentRequest, canaryBudgetHours } from "../dev-environment/hosted-agent-canary.mjs";

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

describe("retired hosted Dev native qualification", () => {
  it.each([undefined, "allocating", "starting", "running", "passed", "failed", "enabled"])("refuses native qualification with historical phase %s before any effect", async phase => {
    const f = fixture();
    if (phase) f.state.agentQualifications = [{ id: "historical", phase, evidence: { digest: "stored" }, retired: phase === "enabled" }];
    const before = structuredClone(f.state);
    await expect(advanceHostedAgents(f.lease, f.profile, f.deps, { retry: true })).rejects.toMatchObject({
      status: 409, code: "release_worker_images_retired", message: "v3 release worker images are retired; v4 runtime bundles are the supported artifact" });
    for (const name of ["inspect", "seed", "allocate", "ready", "start", "poll", "enable", "retire"] as const) expect(f.deps[name]).not.toHaveBeenCalled();
    expect(f.lease.save).not.toHaveBeenCalled(); expect(f.lease.fence).not.toHaveBeenCalled(); expect(f.state).toEqual(before);
  });
  it("preserves inactive and no-fixture callers without native qualification", async () => {
    const f = fixture(); f.state.status = "archiving";
    expect(await advanceHostedAgents(f.lease, f.profile, f.deps)).toEqual({ state: "inactive" });
    f.state.status = "ready";
    expect(await advanceHostedAgents(f.lease, {}, f.deps)).toEqual({ state: "inactive" });
    expect(f.deps.inspect).not.toHaveBeenCalled(); expect(f.lease.save).not.toHaveBeenCalled();
  });
  it("keeps failed retirement retryable without approving historical evidence or dispatching another attempt", async () => {
    const f = fixture(); f.state.agentQualifications = [{ id: "historical", phase: "passed", retired: false, evidence: { digest: "stored" } }];
    f.deps.retire.mockRejectedValueOnce(new Error("deletion pending"));
    await expect(retireUnfinishedHostedAgents(f.lease, f.deps)).rejects.toThrow("deletion pending");
    expect(f.state.agentQualifications[0]).toMatchObject({ phase: "failed", retired: false, evidence: { digest: "stored" } });
    expect(await retireUnfinishedHostedAgents(f.lease, f.deps)).toBe(1);
    expect(f.state.agentQualifications[0].retired).toBe(true); expect(f.deps.retire).toHaveBeenCalledTimes(2);
    expect(f.deps.allocate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled(); expect(f.deps.enable).not.toHaveBeenCalled();
  });
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


describe("historical native evidence and request readers", () => {
  it("preserves only explicitly completed native extension proofs", () => {
    const f = fixture(), result = outcome(f);
    result.report.checks.push("transcriptFork", "nativeGoals", "nativeFork", "nativeReview", "nativeApps", "nativeMultiAgent", "inventedFeature");
    const evidence = nativeRuntimeEvidence(f.image, f.connection, result, Date.now() - 1000);
    expect(evidence.credentials[0].checks).toMatchObject({ transcriptFork: true, nativeGoals: true, nativeFork: true, nativeReview: true, nativeApps: true, nativeMultiAgent: true });
    expect(evidence.credentials[0].checks).not.toHaveProperty("inventedFeature");
    expect(nativeRuntimeEvidence(f.image, f.connection, outcome(f), Date.now() - 1000).credentials[0].checks).not.toHaveProperty("nativeGoals");
  });
  it.each(["source", "digest", "model", "MCP", "retirement", "profile", "stale time"])("rejects historical %s proof", failure => {
    const f = fixture(), result = outcome(f);
    if (failure === "source") result.report.identity.sourceCommit = "f".repeat(40);
    if (failure === "digest") result.report.identity.buildSha256 = "e".repeat(64);
    if (failure === "model") result.report.identity.model = "another-model";
    if (failure === "MCP") result.report.checks = result.report.checks.filter(check => check !== "nativeMcp");
    if (failure === "retirement") result.retirement = 1;
    if (failure === "profile") result.report.executionProfile = "unsupported";
    if (failure === "stale time") result.report.qualifiedAt = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    expect(() => nativeRuntimeEvidence(f.image, f.connection, result, Date.now() - 1000)).toThrow();
  });
  it("requires independent Codex renewal and worker refresh adoption evidence", () => {
    const f = fixture(); f.connection.kind = "codex-chatgpt"; f.connection.provider = "codex"; f.connection.model = "gpt-5.6-luna";
    const report: any = outcome(f);
    expect(() => nativeRuntimeEvidence(f.image, f.connection, report, Date.now() - 1000)).toThrow();
    report.report.checks.push("nativeAccessRefresh"); report.renewal = { accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true };
    expect(nativeRuntimeEvidence(f.image, f.connection, report, Date.now() - 1000).credentials[0].renewal).toBe(true);
    report.retirement = 1; expect(() => nativeRuntimeEvidence(f.image, f.connection, report, Date.now() - 1000)).toThrow();
  });
  it("retains bounded historical rate-limit classification and budget calculations", () => {
    expect(qualificationRateLimited({ code: 1, report: { qualified: false, failureKind: "rate-limited" } })).toBe(true);
    expect(qualificationRateLimited({ code: 0, report: { qualified: true, failureKind: "rate-limited" } })).toBe(false);
    expect(canaryBudgetHours({ builderBudgetHours: 2 })).toBeCloseTo(QUALIFICATION_DEADLINE_MS / 3_600_000 + 0.25);
    expect(canaryBudgetHours({ builderBudgetHours: 0.5 })).toBe(0.5);
  });
  it("keeps organization-image metadata bound to the current base without preparing credentials", () => {
    const f = fixture(), profile = { fixture: { workosUserId: "user_test", workosOrganizationId: "org_test", expectedEmail: "dev@example.test", expectedOrganizationSlug: "test" } };
    const image = { ...f.image, id: "image-id", snapshotId: "org-image" };
    expect(hostedAgentRequest(f.state, profile, image)).toMatchObject({ image: { snapshotId: f.image.snapshotId }, organizationImage: { id: image.id, snapshotId: image.snapshotId } });
    f.state.source.workerInputsSha256 = "f".repeat(64);
    expect(() => hostedAgentRequest(f.state, profile, image)).toThrow("current worker base");
  });
});
