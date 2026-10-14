import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunSchema, type RunHandle } from "../zeros-dev/receipts";
import { DeletionRetirementSchema, FIXTURE_STORAGE_MIB, MAX_PENDING_AGE_MS } from "../zeros-dev/cleanup-contract";
import { cleanupOutcome, requireCleanupCapacity, retirementMatchesRun, summarizeCleanup } from "../zeros-dev/cleanup-state";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";
import { CloudWorkspaceDeletionRetirementSchema } from "../../apps/control-plane/src/cloud-workspaces/deletion-retirement-contract";

function pending() {
  const id = randomUUID(), createdAt = "2026-10-14T11:00:00.000Z";
  const handle: RunHandle = { run: RunSchema.parse({ version: 1, runId: id, fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt, source: { revision: "b".repeat(40), dirty: false }, lifecycle: [], prompts: [], evidence: [], deletionConfirmed: false,
    create: { key: randomUUID(), body: { name: `zd-${id}`, repository: { forge: "github.com", owner: "fixture", name: "fixture", revision: "main", githubInstallationId: randomUUID() } },
      result: { id: randomUUID(), createdBy: randomUUID(), createdAt, generation: 1 } } }), save: async () => {} };
  retireFixtureCompute(handle); return handle.run;
}

describe("fixture compute retirement is distinct from physical erasure", () => {
  it("keeps the standalone CP and harness wire schemas identical", () => {
    expect(readFileSync(new URL("../zeros-dev/deletion-retirement-contract.ts", import.meta.url), "utf8"))
      .toBe(readFileSync(new URL("../../apps/control-plane/src/cloud-workspaces/deletion-retirement-contract.ts", import.meta.url), "utf8"));
  });
  it.each(["exact", "legacy-delete-key", "long-name", "zero-storage", "missing-upload-advice", "late-advice", "physical-advice", "chronology"])(
    "matches the CP retirement contract for %s", condition => {
      const proof: any = structuredClone(pending().retirement!);
      if (condition === "legacy-delete-key") proof.deleteIdempotencyKey = "delete:original_1";
      if (condition === "long-name") proof.name = "x".repeat(121);
      if (condition === "zero-storage") proof.reserved.storageMiB = proof.generations[0].reserved.storageMiB = 0;
      if (condition === "missing-upload-advice") proof.generations[0].expectedBy = null;
      if (condition === "late-advice") proof.generations[0].expectedBy = new Date(Date.parse(proof.observedAt) + 6 * 3_600_000 + 5001).toISOString();
      if (condition === "physical-advice") {
        proof.status = proof.generations[0].status = "physically_deleted"; proof.deletionConfirmed = true;
        proof.generations[0].storageStage = "completed"; proof.reserved.storageMiB = proof.generations[0].reserved.storageMiB = 0;
      }
      if (condition === "chronology") proof.createdAt = new Date(Date.parse(proof.requestedAt) + 1).toISOString();
      const expected = ["exact", "legacy-delete-key"].includes(condition);
      expect(CloudWorkspaceDeletionRetirementSchema.safeParse(proof).success).toBe(expected);
      expect(DeletionRetirementSchema.safeParse(proof).success).toBe(expected);
    });
  it("keeps storage and the original deletion intent pending", () => {
    const run = pending();
    expect(cleanupOutcome(run)).toBe("compute_retired_storage_pending");
    expect(run.deletionConfirmed).toBe(false); expect(run.lifecycle.at(-1)?.confirmed).toBe(false);
    expect(summarizeCleanup([run], run)).toMatchObject({ outcome: "compute_retired_storage_pending", deletionConfirmed: false,
      pendingWorkspaces: 1, pendingGenerations: 1, reservedStorageMiB: 16_384, reservationCoverage: "complete" });
  });
  it("cannot convert a storage-only observation into physical erasure by changing the local boolean", () => {
    const run = pending(); run.deletionConfirmed = true;
    expect(cleanupOutcome(run)).toBe("unconfirmed");
    expect(() => requireCleanupCapacity([run])).toThrow("zeros_dev_cleanup_pending");
  });
  it.each(["workspace", "generation", "delete-key", "name", "creator", "created-at", "unaccounted-generation", "missing-generation"])("refuses %s proof", condition => {
    const run = pending(), proof = structuredClone(run.retirement!);
    if (condition === "workspace") proof.workspaceId = randomUUID();
    if (condition === "generation") proof.currentGeneration = 2;
    if (condition === "delete-key") proof.deleteIdempotencyKey = randomUUID();
    if (condition === "name") proof.name = "zd-another-run";
    if (condition === "creator") proof.createdBy = randomUUID();
    if (condition === "created-at") proof.createdAt = "2026-10-14T10:59:59.000Z";
    if (condition === "unaccounted-generation") { proof.generations.push({ ...proof.generations[0]!, generation: 2 }); proof.reserved.storageMiB *= 2; }
    if (condition === "missing-generation") run.lifecycle.unshift({ operation: "wake", generation: 2, key: randomUUID(), confirmed: true });
    expect(retirementMatchesRun(run, proof)).toBe(false);
    run.retirement = proof; expect(cleanupOutcome(run)).toBe("unconfirmed");
    expect(() => requireCleanupCapacity([run], true)).toThrow("zeros_dev_cleanup_pending");
  });
  it.each(["cpu", "memory", "authority", "failed-stage", "duplicate", "reservation", "physical-claim"])("rejects %s at the response schema", condition => {
    const proof: any = structuredClone(pending().retirement!);
    if (condition === "cpu") proof.reserved.cpuMillicores = 1;
    if (condition === "memory") proof.generations[0].reserved.memoryMiB = 1;
    if (condition === "authority") proof.accessRetired = false;
    if (condition === "failed-stage") proof.generations[0].storageStage = "failed";
    if (condition === "duplicate") proof.generations.push(proof.generations[0]);
    if (condition === "reservation") proof.reserved.storageMiB = 0;
    if (condition === "physical-claim") proof.deletionConfirmed = true;
    expect(DeletionRetirementSchema.safeParse(proof).success).toBe(false);
  });
  it("reserves the eighth workspace and its storage without dropping older debt", () => {
    const runs = Array.from({ length: 8 }, pending);
    for (const run of runs) { run.retirement!.reserved.storageMiB = FIXTURE_STORAGE_MIB; run.retirement!.generations[0]!.reserved.storageMiB = FIXTURE_STORAGE_MIB; }
    expect(() => requireCleanupCapacity(runs.slice(0, 7), true)).not.toThrow();
    expect(() => requireCleanupCapacity(runs)).not.toThrow();
    expect(() => requireCleanupCapacity(runs, true)).toThrow("zeros_dev_cleanup_backlog_exceeded");
    expect(runs).toHaveLength(8);
    runs[0]!.retirement!.reserved.storageMiB++; runs[0]!.retirement!.generations[0]!.reserved.storageMiB++;
    expect(() => requireCleanupCapacity(runs.slice(0, 7), true)).toThrow("zeros_dev_cleanup_backlog_exceeded");
  });
  it("bounds original deletion age despite fresh observations or provider advice", () => {
    const run = pending(), proof = run.retirement!, start = Date.parse(proof.requestedAt);
    proof.observedAt = new Date(start + MAX_PENDING_AGE_MS).toISOString();
    expect(() => requireCleanupCapacity([run])).not.toThrow();
    proof.observedAt = new Date(start + MAX_PENDING_AGE_MS + 1).toISOString();
    proof.generations[0]!.expectedBy = new Date(Date.parse(proof.observedAt) + 6 * 3_600_000).toISOString();
    expect(() => requireCleanupCapacity([run])).toThrow("zeros_dev_cleanup_backlog_exceeded");
    expect(run.deletionConfirmed).toBe(false);
  });
  it("keeps unknown reservation coverage unavailable", () => {
    const run = pending(); delete run.retirement;
    expect(summarizeCleanup([run], run)).toMatchObject({ outcome: "unconfirmed", unconfirmedWorkspaces: 1, reservationCoverage: "unavailable" });
    expect(() => requireCleanupCapacity([run])).toThrow("zeros_dev_cleanup_pending");
  });
});
