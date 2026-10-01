import { describe, expect, it, vi } from "vitest";
import { promoteWorker, WorkerReceipt, validateWorkerReceipt, type WorkerDependencies } from "./worker";
import { buildBoatImage } from "./worker-adapters";
import { workerConnections } from "./worker-test-fixtures";
const sourceSha = "a".repeat(40), buildSha256 = "b".repeat(64), contract = "c".repeat(64), planSha256 = "d".repeat(64);
const input = { channel: "alpha" as const, sourceSha, inputsSha256: "e".repeat(64), actorUserId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222", kinds: ["claude-setup-token", "codex-chatgpt", "cursor-api-key"], qualificationProfile: "smoke" as const,
  repository: "example/zeros", branch: "main", runId: "123", runAttempt: "2", releaseCanaryBindings: workerConnections() };
const connectionFor = (kind: string) => workerConnections().find(row => row.kind === kind)!;
function harness() {
  const calls: string[] = [];
  const completedAt = new Date(Date.now() - 1000).toISOString(), observedAt = new Date().toISOString();
  const builderCleanup = { kind: "physically-deleted" as const, sandboxId: "bx_test", deletionOperationId: `bdop_${"c".repeat(32)}`,
    operation: { id: `bdop_${"c".repeat(32)}`, kind: "sandbox" as const, targetId: "bx_test", status: "completed" as const, completedAt },
    operationObservedAt: observedAt, unavailableObservedAt: observedAt, completedAt };
  const deps: WorkerDependencies = {
    build: async () => { calls.push("build"); return { snapshotId: "zeros-alpha-fixture", buildSha256, sourceCommit: sourceSha, architecture: "linux/amd64", storageMiB: 4096 }; },
    cleanupBuilder: async () => { calls.push("builder-cleanup"); return builderCleanup; },
    qualify: async (_image, kind) => ({ connection: connectionFor(kind), startedAt: Date.now(), outcome: { code: 0, retirement: 0,
      renewal: { accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true },
      report: { version: 3, qualified: true, qualificationProfile: "smoke", executionProfile: "zeros-cloud-native-v1", authority: "isolated-image-canary", qualifiedAt: new Date().toISOString(),
        identity: { sourceCommit: sourceSha, buildSha256, contractSha256: contract, kind, model: connectionFor(kind).model },
        checks: ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission", "stopAndRevocation", "nativeTurn", "nativeResume", "authentication", "nativePermissionSelection", "nativeAccessRefresh", "nativeMcp"] } } }),
    cleanup: async () => { calls.push("cleanup"); return { credentialCanaryResourcesDeleted: true, imageBuilder: builderCleanup }; },
    withOwner: async action => {
      calls.push("owner"); const value = await action({ loginIdentity: "same-login", manage: async (document: any, approval) => {
        expect(document.evidence.channel).toBe("alpha"); calls.push(approval ? "apply" : "plan");
        return { state: approval ? "changed" : "planned", planSha256, targetSha256: "f".repeat(64) };
      } }); calls.push("role-delete"); return { value, deleted: true };
    },
    updateIdentity: async variables => { calls.push("tuple"); expect(Object.keys(variables)).toHaveLength(6); },
  };
  return { calls, deps };
}
describe("worker lane stub contracts", () => {
  it("emits a v2 receipt without the v1 blanket physical-erasure claim", async () => {
    const { deps } = harness();
    const receipt = await promoteWorker(input, deps);
    expect(receipt).toMatchObject({ version: 2, cleanup: { credentialCanaryResourcesDeleted: true,
      imageBuilder: { kind: "physically-deleted" } } });
    expect(receipt).not.toHaveProperty("resourcesDeleted");
    expect(WorkerReceipt.safeParse({ ...receipt, resourcesDeleted: true }).success).toBe(false);
  });
  it("never treats a cleanup object with unconfirmed credential-canary deletion as success", async () => {
    const { calls, deps } = harness();
    const original = deps.cleanup;
    deps.cleanup = async () => ({ ...await original(), credentialCanaryResourcesDeleted: false }) as any;
    await expect(promoteWorker(input, deps)).rejects.toThrow("cleanup");
    expect(calls).not.toContain("owner");
    expect(calls).not.toContain("tuple");
  });
  it("keeps the strict physical meaning of historical v1 receipts", async () => {
    const { deps } = harness(), { cleanup: _cleanup, ...receipt } = await promoteWorker(input, deps) as any;
    const legacy = { ...receipt, version: 1, resourcesDeleted: true };
    expect(validateWorkerReceipt(legacy, input)).toEqual(legacy);
    expect(WorkerReceipt.safeParse({ ...legacy, resourcesDeleted: false }).success).toBe(false);
    expect(WorkerReceipt.safeParse({ ...legacy, cleanup: { credentialCanaryResourcesDeleted: true } }).success).toBe(false);
  });
  it("withholds every native dispatch until a typed builder proof exists", async () => {
    const { calls, deps } = harness();
    deps.cleanupBuilder = async () => null;
    const qualify = vi.fn(deps.qualify); deps.qualify = qualify;
    await expect(promoteWorker(input, deps)).rejects.toThrow("builder cleanup");
    expect(qualify).not.toHaveBeenCalled();
    expect(calls).not.toContain("owner");
    expect(calls).not.toContain("tuple");
  });
  it("binds discovered revisions and designations into private approval evidence, not the public receipt", async () => {
    const { deps } = harness(); let saved: any;
    deps.saveEvidence = async evidence => { saved = evidence; };
    const result = await promoteWorker({ ...input, releaseCanaryBindings: workerConnections() } as any, deps);
    expect(saved.releaseCanaryBindings).toEqual(workerConnections());
    expect(JSON.stringify(result)).not.toContain(workerConnections()[0]!.credentialId);
    expect(result.evidenceSha256).toBe(saved.evidenceSha256);
  });
  it("refuses missing discovered bindings before paid allocation", async () => {
    const { calls, deps } = harness();
    await expect(promoteWorker({ ...input, releaseCanaryBindings: undefined } as any, deps)).rejects.toThrow("designation");
    expect(calls).toEqual([]);
  });
  it("fails a rate-limited canary explicitly, cleans up and never approves or selects it", async () => {
    const { calls, deps } = harness();
    deps.qualify = async (_image, kind) => ({ connection: connectionFor(kind), startedAt: Date.now(),
      outcome: { code: 1, retirement: 0, report: { qualified: false, failureKind: "rate-limited" } } });
    await expect(promoteWorker(input, deps)).rejects.toThrow("canary account rate-limited");
    expect(calls).toEqual(["build", "builder-cleanup", "cleanup"]);
  });
  it("qualifies all credential kinds, applies via the same owner and changes the complete tuple last", async () => {
    const { calls, deps } = harness(); const result = await promoteWorker(input, deps);
    expect(calls).toEqual(["build", "builder-cleanup", "cleanup", "owner", "plan", "apply", "role-delete", "tuple"]);
    expect(result).toMatchObject({ status: "success", sourceSha, roleDeleted: true, version: 2, cleanup: { credentialCanaryResourcesDeleted: true } });
    expect(result).toMatchObject({ repository: input.repository, branch: input.branch, runId: input.runId, runAttempt: input.runAttempt,
      qualifiedKinds: expect.arrayContaining(input.kinds) });
    expect(WorkerReceipt.safeParse({ ...result, runId: undefined }).success).toBe(false);
  });
  it("refuses a partial shipped credential matrix before allocation", async () => {
    const { calls, deps } = harness();
    await expect(promoteWorker({ ...input, kinds: ["claude-api-key"] }, deps)).rejects.toThrow("credential policy");
    expect(calls).toEqual([]);
  });
  it("does not qualify or offer unproven Anthropic/OpenAI API-key modes", async () => {
    const { calls, deps } = harness();
    await expect(promoteWorker({ ...input, kinds: [...input.kinds, "claude-api-key", "codex-api-key"] }, deps)).rejects.toThrow("credential policy");
    expect(calls).toEqual([]);
    expect(WorkerReceipt.safeParse({ qualifiedKinds: ["claude-api-key"] }).success).toBe(false);
  });
  it("binds the selected smoke/full profile to the native report before approval", async () => {
    const { calls, deps } = harness(), original = deps.qualify;
    deps.qualify = async (...args) => {
      const result = await original(...args); (result.outcome as any).report.qualificationProfile = "full"; return result;
    };
    await expect(promoteWorker(input, deps)).rejects.toThrow("exact image");
    expect(calls).not.toContain("owner"); expect(calls).not.toContain("tuple");
  });
  it("refuses unconfirmed cleanup and never publishes a tuple", async () => {
    const { calls, deps } = harness(); deps.cleanup = async () => null;
    await expect(promoteWorker(input, deps)).rejects.toThrow("cleanup");
    expect(calls).not.toContain("owner"); expect(calls).not.toContain("tuple");
  });
  it("rejects failed native qualification, stale images and missing Codex renewal evidence", async () => {
    for (const failure of ["qualified", "source", "renewal"]) {
      const { calls, deps } = harness(); const original = deps.qualify;
      deps.qualify = async (...args) => { const result = await original(...args), outcome = result.outcome as any;
        if (failure === "qualified") outcome.report.qualified = false;
        if (failure === "source") outcome.report.identity.sourceCommit = "f".repeat(40);
        if (failure === "renewal") outcome.renewal = {};
        return result;
      };
      await expect(promoteWorker(input, deps)).rejects.toThrow();
      expect(calls).not.toContain("tuple"); expect(calls).toContain("cleanup");
    }
  });
  it("refuses a changed plan target or role deletion failure", async () => {
    const { calls, deps } = harness();
    deps.withOwner = async action => ({ value: await action({ loginIdentity: "one", manage: async (_doc, approval) =>
      ({ state: approval ? "changed" : "planned", planSha256, targetSha256: approval ? "wrong" : "right" }) }), deleted: true });
    await expect(promoteWorker(input, deps)).rejects.toThrow("plan"); expect(calls).not.toContain("tuple");
    const next = harness(); const withOwner = next.deps.withOwner;
    next.deps.withOwner = async action => ({ ...await withOwner(action), deleted: false });
    await expect(promoteWorker(input, next.deps)).rejects.toThrow("deletion"); expect(next.calls).not.toContain("tuple");
  });
  it("drives build, attestation, fresh sanitation/save and snapshot readiness in order", async () => {
    const calls: string[] = [];
    const image = await buildBoatImage({ sourceSha, directory: "/tmp/fixture", baseSnapshot: "base", maxUsedHours: 1 }, {
      nameSnapshot: async () => "zeros-alpha-fixture", pause: async () => {}, kit: async args => {
        calls.push(args.join(" "));
        if (args[1] === "status" && args[0] !== "attestation") return { state: "ready", wallet: "billing-org" };
        if (args[0] === "attestation") return { finished: true, qualified: true, matchesCommit: true, sourceCommit: sourceSha, measuredStorageMiB: 4096, buildSha256 };
        if (args[2]?.endsWith("build-hash.sh")) return JSON.stringify({ commit: sourceSha });
        if (args[2]?.endsWith("build-status.sh")) return JSON.stringify({ result: { passed: true } });
        return {};
      },
    });
    expect(image.sourceCommit).toBe(sourceSha);
    expect(calls.slice(-4)).toEqual(["attestation status", "generate-post", "snapshot save", "snapshot status"]);
  });
});
