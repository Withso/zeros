import { describe, expect, it, vi } from "vitest";
import { promoteWorker, WorkerReceipt, validateWorkerReceipt } from "./worker";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";

const sourceSha = "a".repeat(40), digest = "b".repeat(64);
const expected = { channel: "alpha" as const, sourceSha, inputsSha256: digest, repository: "example/zeros", branch: "main", runId: "123", runAttempt: "2" };
function storedReceipt(version: 1 | 2 | 3) {
  const now = Date.now(), operationId = `bdop_${"c".repeat(32)}`;
  const builder = { kind: "physically-deleted", sandboxId: "bx_test", deletionOperationId: operationId,
    operation: { id: operationId, kind: "sandbox", targetId: "bx_test", status: "completed", completedAt: new Date(now - 7000).toISOString() },
    operationObservedAt: new Date(now - 6000).toISOString(), unavailableObservedAt: new Date(now - 5000).toISOString(), completedAt: new Date(now - 7000).toISOString() };
  return { version, status: "success", ...expected,
    worker: { provider: "boat", imageRef: `boat:historical-worker@sha256:${digest}`, sourceSha, architecture: "linux/amd64", storageMiB: 4096 },
    qualificationProfile: "smoke", qualifiedKinds: ["claude-setup-token", "codex-chatgpt", "cursor-api-key"], runtimeContractSha256: digest,
    evidenceSha256: digest, approvalPlanSha256: digest, approvalTargetSha256: digest, roleDeleted: true, completedAt: new Date(now).toISOString(),
    ...(version === 1 ? { resourcesDeleted: true } : { cleanup: { imageBuilder: builder, credentialCanaryResourcesDeleted: version === 2,
      ...(version === 3 ? { pendingNativeStorage: { status: "pending", count: 3, proofSha256: digest, physicalBytes: "unmeasured" } } : {}) } }) };
}

describe("retired worker promotion and historical receipts", () => {
  it("refuses without building, qualifying, acquiring an owner login, or updating a tuple", async () => {
    const effect = vi.fn(async () => { throw new Error("No promotion effects permitted"); });
    await expect(promoteWorker({} as any, { build: effect, qualify: effect, withOwner: effect, cleanupBuilder: effect,
      updateIdentity: effect, cleanup: effect })).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(effect).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3] as const)("reads historical v%s receipts without changing proof or issuing a new receipt", version => {
    const stored = storedReceipt(version), bytes = JSON.stringify(stored);
    expect(validateWorkerReceipt(stored, expected)).toEqual(stored);
    expect(JSON.stringify(stored)).toBe(bytes);
    expect(WorkerReceipt.safeParse({ ...stored, diagnostics: { private: true } }).success).toBe(false);
  });
  it("keeps the physical meaning of v1 and the pending-storage distinction of v3", () => {
    expect(WorkerReceipt.safeParse({ ...storedReceipt(1), resourcesDeleted: false }).success).toBe(false);
    const pending = storedReceipt(3);
    expect(WorkerReceipt.safeParse({ ...pending, version: 2 }).success).toBe(false);
    expect(WorkerReceipt.safeParse({ ...pending, cleanup: { ...pending.cleanup, credentialCanaryResourcesDeleted: true } }).success).toBe(false);
    expect(WorkerReceipt.safeParse({ ...pending, resourcesDeleted: true }).success).toBe(false);
  });
  it("retains exact source/run binding and rejects incomplete or future historical proof", () => {
    const stored = storedReceipt(2);
    for (const patch of [{ sourceSha: "c".repeat(40) }, { runId: "124" }, { runAttempt: "3" }, { qualifiedKinds: ["cursor-api-key"] },
      { roleDeleted: false }, { completedAt: new Date(Date.now() + 60_000).toISOString() }])
      expect(() => validateWorkerReceipt({ ...stored, ...patch }, expected)).toThrow();
  });
});
