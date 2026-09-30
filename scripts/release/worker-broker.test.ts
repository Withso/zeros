import { describe, expect, it, vi } from "vitest";
import { releaseCanaryRequest, runReleaseCanaryAdmission, releaseCanaryDesignation } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";
import { BoatAccountAdmission, releaseWorkerOwner } from "../../apps/control-plane/src/cloud-workspaces/boat-account-admission";
import { workerConnections } from "./worker-test-fixtures";

const owner = "11111111-1111-4111-8111-111111111111", credentialId = "22222222-2222-4222-8222-222222222222";
const scope = { ownerUserId: owner, organizationId: "33333333-3333-4333-8333-333333333333", channel: "alpha" as const,
  sourceSha: "a".repeat(40), repository: "example/zeros" };
const request = () => ({ version: 1, ...scope, operationId: "44444444-4444-4444-8444-444444444444", runId: "123", runAttempt: "1", branch: "main",
  credentialId, credentialRevision: 1, designationId: "42", kind: "codex-chatgpt", model: "gpt-5.6-luna", qualificationProfile: "smoke",
  target: { id: "bx_test", attempt: "44444444-4444-4444-8444-444444444444", snapshotId: "worker-test", sourceCommit: scope.sourceSha, buildSha256: "b".repeat(64) } });

describe("owner-designated release-only canary admission", () => {
  it("requires the discovered revision/designation binding in both the private run and disposable job", async () => {
    const selected = releaseCanaryRequest(request(), scope), binding = { kind: selected.kind, credentialId, credentialRevision: 1, designationId: "42", model: selected.model };
    const state: any = { owner: releaseWorkerOwner("alpha"), lease: { expiresAt: Date.now() + 60_000 },
      releaseRuns: [{ runId: "123", actorUserId: owner, sourceSha: scope.sourceSha, qualificationProfile: "smoke",
        releaseCanaryBindings: workerConnections().map(row => row.kind === selected.kind ? binding : row),
        canaries: [{ id: selected.operationId, ...binding, qualificationProfile: "smoke", phase: "starting",
          image: { snapshotId: selected.target.snapshotId, sourceCommit: scope.sourceSha, buildSha256: selected.target.buildSha256 } }] }],
      resources: { images: [{ agentQualificationId: selected.operationId, purpose: "native-agent-qualification", sourceImage: selected.target.snapshotId,
        sourceCommit: scope.sourceSha, builder: { id: selected.target.id }, machineAttestationStarted: true, nativeDispatchStarted: true }] } };
    const service = new BoatAccountAdmission({ readDocument: vi.fn(async () => ({ state })) } as any, {} as any);
    await expect(service.assertCanary(selected)).resolves.toBeUndefined();
    for (const changed of [{ credentialId: owner }, { credentialRevision: 2 }, { designationId: "43" }])
      await expect(service.assertCanary({ ...selected, ...changed })).rejects.toThrow("fenced");
    delete state.releaseRuns[0].releaseCanaryBindings;
    await expect(service.assertCanary(selected)).rejects.toThrow("fenced");
  });
  it("binds the channel, owner, exact API source, repository, VM and offered kind with no workspace authority", () => {
    expect(releaseCanaryRequest(request(), scope).kind).toBe("codex-chatgpt");
    for (const change of [{ channel: "beta" }, { ownerUserId: credentialId }, { sourceSha: "c".repeat(40) }, { repository: "other/repository" },
      { kind: "codex-api-key" }, { kind: "claude-api-key" }, { workspaceId: credentialId }, { sessionId: credentialId },
      { material: { accessToken: "synthetic-never-accepted" } }, { qualificationProfile: "unknown" }]) {
      expect(() => releaseCanaryRequest({ ...request(), ...change }, scope)).toThrow("canary");
    }
  });
  it("defaults opt-in off and requires an exact current owner credential, model and designation", () => {
    const credential = { id: credentialId, owner_user_id: owner, kind: "codex-chatgpt", revision: "1", revoked_at: null };
    const selected = releaseCanaryRequest(request(), scope);
    expect(() => releaseCanaryDesignation(selected, credential, undefined)).toThrow("designated");
    const designation = { id: "42", subject: { enabled: true, credentialId, credentialRevision: 1, models: [selected.model], channel: "alpha", allowanceOwnerUserId: owner } };
    expect(() => releaseCanaryDesignation(selected, credential, designation)).not.toThrow();
    for (const changed of [{ ...designation, id: "41" }, { ...designation, subject: { ...designation.subject, enabled: false } },
      { ...designation, subject: { ...designation.subject, credentialRevision: 2 } }, { ...designation, subject: { ...designation.subject, models: ["another-model"] } }]) {
      expect(() => releaseCanaryDesignation(selected, credential, changed)).toThrow("designated");
    }
    expect(() => releaseCanaryDesignation(selected, { ...credential, owner_user_id: credentialId }, designation)).toThrow("designated");
  });
  it("uses published server-native rotation, uploads access only and returns no provider credentials", async () => {
    const calls: string[] = []; let version = 1;
    const read = vi.fn(async () => ({ credential: { current_version: version }, material: { kind: "codex-chatgpt", accountId: "synthetic-account",
      accessToken: `synthetic-access-${version}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 } }));
    const deps = { phase: "reserved", transition: vi.fn(async (phase: string) => { calls.push(phase); }), read,
      renew: vi.fn(async () => { version++; calls.push("native-rotation-published"); }), assertFresh: vi.fn(async () => { calls.push("fresh-disposable"); }),
      start: vi.fn(async (input: any, renewal: any) => { calls.push("private-upload"); expect(input.material).not.toHaveProperty("refreshToken");
        expect(input.renewedCodex.accessToken).not.toBe(input.material.accessToken); expect(renewal.cachePublished).toBe(true); }),
      observeStarted: vi.fn(async () => true) };
    const result = await runReleaseCanaryAdmission(releaseCanaryRequest(request(), scope), deps as any);
    expect(calls).toEqual(["preparing", "fresh-disposable", "native-rotation-published", "dispatched", "fresh-disposable", "private-upload", "started"]);
    expect(JSON.stringify(result)).not.toContain("synthetic-access"); expect(result).toEqual({ started: true });
    expect(deps.renew).toHaveBeenCalledOnce();
  });
  it("reconciles lost native dispatch and never reuses an uncertain renewal or reads arbitrary credentials", async () => {
    const deps = { phase: "dispatched", transition: vi.fn(), read: vi.fn(), renew: vi.fn(), start: vi.fn(), assertFresh: vi.fn(), observeStarted: vi.fn(async () => true) };
    expect(await runReleaseCanaryAdmission(releaseCanaryRequest(request(), scope), deps as any)).toEqual({ started: true });
    expect(deps.read).not.toHaveBeenCalled(); expect(deps.renew).not.toHaveBeenCalled(); expect(deps.start).not.toHaveBeenCalled();
    deps.observeStarted.mockResolvedValue(false);
    await expect(runReleaseCanaryAdmission(releaseCanaryRequest(request(), scope), deps as any)).rejects.toThrow("reconcil");
    await expect(runReleaseCanaryAdmission(releaseCanaryRequest(request(), scope), { ...deps, phase: "preparing" } as any)).rejects.toThrow("reconcil");
    expect(deps.renew).not.toHaveBeenCalled();
  });
});
