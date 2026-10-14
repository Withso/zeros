import { describe, expect, it } from "vitest";
import { CloudWorkspaceDeletionRetirementRequestSchema, CloudWorkspaceDeletionRetirementSchema,
  type CloudWorkspaceDeletionRetirement } from "./deletion-retirement-contract.js";

const id = "11111111-1111-4111-8111-111111111111";
function pending(): CloudWorkspaceDeletionRetirement {
  return { version: 1, organizationId: id, workspaceId: id, ownerUserId: id, createdBy: id, repositoryId: id,
    createdAt: "2026-10-14T08:00:00.000Z", name: "fixture", currentGeneration: 1,
    deleteIntentId: id, deleteIdempotencyKey: "original-delete-key", requestedAt: "2026-10-14T09:00:00.000Z",
    observedAt: "2026-10-14T10:00:00.000Z", status: "compute_retired_storage_pending", deletionConfirmed: false,
    admissionFenced: true, computeSettled: true, accessRetired: true,
    generations: [{ generation: 1, status: "compute_retired_storage_pending", receiptSha256: "a".repeat(64),
      requestedAt: "2026-10-14T09:00:00.000Z", storageStage: "waiting_for_uploads",
      expectedBy: "2026-10-14T15:00:00.000Z", reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 70225 } }],
    reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 70225 } };
}

describe("deletion retirement public contract", () => {
  it("accepts complete pending and physical observations without equating an overdue estimate with erasure", () => {
    const value = pending();
    value.generations[0]!.expectedBy = "2026-10-14T09:30:00.000Z";
    expect(CloudWorkspaceDeletionRetirementSchema.parse(value).deletionConfirmed).toBe(false);
    value.status = "physically_deleted"; value.deletionConfirmed = true; value.reserved.storageMiB = 0;
    Object.assign(value.generations[0]!, { status: "physically_deleted", storageStage: "completed", expectedBy: null,
      reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 } });
    expect(CloudWorkspaceDeletionRetirementSchema.parse(value).deletionConfirmed).toBe(true);
  });

  it("requires exact body fields and refuses caller-supplied proof", () => {
    const body = { generation: 1, deleteIdempotencyKey: "original-delete-key" };
    expect(CloudWorkspaceDeletionRetirementRequestSchema.safeParse(body).success).toBe(true);
    for (const change of [{ generation: 0 }, { generation: 1.2 }, { generation: "1" }, { deleteIdempotencyKey: "short" },
      { deleteIdempotencyKey: "unsafe\nkey" }, { computeSettled: true }])
      expect(CloudWorkspaceDeletionRetirementRequestSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });

  it("keeps the response closed and requires current settled authority", () => {
    for (const change of [{ version: 2 }, { admissionFenced: false }, { computeSettled: false }, { accessRetired: false },
      { deletionConfirmed: true }, { status: "physically_deleted" }, { organizationId: "unknown" }, { providerText: "private" }])
      expect(CloudWorkspaceDeletionRetirementSchema.safeParse({ ...pending(), ...change }).success).toBe(false);
    const value = pending();
    Object.assign(value.generations[0]!, { providerResourceId: "private" });
    expect(CloudWorkspaceDeletionRetirementSchema.safeParse(value).success).toBe(false);
  });

  it("requires a sorted complete bounded generation set while allowing a higher rolled-back candidate", () => {
    const value = pending();
    value.generations.push({ ...value.generations[0]!, generation: 3 });
    value.reserved.storageMiB *= 2;
    expect(CloudWorkspaceDeletionRetirementSchema.safeParse(value).success).toBe(true);
    for (const generations of [[], [value.generations[1]!], [...value.generations].reverse(),
      [value.generations[0]!, value.generations[0]!],
      Array.from({ length: 65 }, (_, i) => ({ ...value.generations[0]!, generation: i + 1 }))])
      expect(CloudWorkspaceDeletionRetirementSchema.safeParse({ ...value, generations }).success).toBe(false);
  });

  it("refuses missing advice, invented completion, nonzero compute and inconsistent disk totals", () => {
    for (const change of [{ storageStage: "retrying" }, { storageStage: "completed" }, { expectedBy: null },
      { receiptSha256: "a".repeat(63) }, { status: "physically_deleted" },
      { reserved: { cpuMillicores: 1, memoryMiB: 0, storageMiB: 70225 } },
      { reserved: { cpuMillicores: 0, memoryMiB: 1, storageMiB: 70225 } },
      { reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 } }]) {
      const value = pending(); Object.assign(value.generations[0]!, change);
      expect(CloudWorkspaceDeletionRetirementSchema.safeParse(value).success).toBe(false);
    }
    const value = pending(); value.reserved.storageMiB--;
    expect(CloudWorkspaceDeletionRetirementSchema.safeParse(value).success).toBe(false);
  });

  it("requires a coherent observation window and bounded provider advice", () => {
    for (const change of [{ createdAt: "2026-10-14T09:00:01.000Z" }, { requestedAt: "2026-10-14T10:00:01.000Z" },
      { observedAt: "not-a-time" }])
      expect(CloudWorkspaceDeletionRetirementSchema.safeParse({ ...pending(), ...change }).success).toBe(false);
    for (const expectedBy of ["2026-10-14T07:59:59.000Z", "2026-10-14T16:00:05.001Z", "invalid"]) {
      const value = pending(); value.generations[0]!.expectedBy = expectedBy;
      expect(CloudWorkspaceDeletionRetirementSchema.safeParse(value).success).toBe(false);
    }
  });
});
