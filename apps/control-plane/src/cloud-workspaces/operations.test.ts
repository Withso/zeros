import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

function retentionHarness(legalHold = false) {
  const checkpointId = randomUUID();
  const policy = { workspace_id: randomUUID(), org_id: randomUUID(), record_event_days: 90,
    content_event_days: 90, checkpoint_days: 90, legal_hold: legalHold };
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    const indexes = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    expect(parameters.length, "every SQL parameter is bound").toBe(Math.max(0, ...indexes));
    if (sql.includes("FOR UPDATE OF policy")) return { rows: [policy] };
    if (sql.includes("SELECT checkpoint.id")) return { rows: [{ id: checkpointId }] };
    return { rows: [] };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool;
  const objects = { deleteUnreferencedSystem: vi.fn(async () => "deleted" as const) };
  const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "retention-unit-test" });
  return { worker, query, policy, checkpointId, objects };
}

describe("checkpoint retention transaction", () => {
  it("binds the daily retention cap and releases v2 native references without deleting objects directly", async () => {
    const harness = retentionHarness();
    await expect(harness.worker.applyRetentionOnce()).resolves.toBe(true);
    const selection = harness.query.mock.calls.find(([sql]) => sql.includes("SELECT checkpoint.id"))!;
    expect(selection[1]).toEqual([harness.policy.workspace_id, harness.policy.org_id, 90, 14]);
    const cleanup = harness.query.mock.calls.find(([sql]) => sql.includes("DELETE FROM workspace_blob_references"))!;
    expect(cleanup[1]).toEqual([harness.policy.workspace_id, harness.policy.org_id,
      [harness.checkpointId, `${harness.checkpointId}:v2`]]);
    expect(harness.objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
    expect(harness.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("does not prune any checkpoints or references under a workspace legal hold", async () => {
    const harness = retentionHarness(true);
    await expect(harness.worker.applyRetentionOnce()).resolves.toBe(true);
    expect(harness.query.mock.calls.some(([sql]) => sql.includes("DELETE FROM"))).toBe(false);
  });
});
