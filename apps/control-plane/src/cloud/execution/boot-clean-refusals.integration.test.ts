import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("closed boot-clean diagnostics through the real router", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool); await f.activate();
    expect((await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) })).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const report = (extra: Record<string, unknown> = {}) => f.worker("execution-leases/boot-clean", {
    retirementId: randomUUID(), processes: 0, legacyMaterial: "refused", ...extra,
  });
  const boot = async () => (await pool.query(`SELECT last_refusals,first_failed_refusals,last_processes,
    first_failed_at,clean_at FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2`, [f.workspace.id, f.boot])).rows[0];

  it("persists the first failure, updates the latest classes, and logs only the first committed refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const receipt = { retirementId: randomUUID(), processes: 0, legacyMaterial: "refused", refusals: ["seed_target_modified"] };
    for (let i = 0; i < 2; i++) {
      const response = await f.worker("execution-leases/boot-clean", receipt);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "execution_not_retired" } });
    }
    expect(await boot()).toMatchObject({ last_refusals: ["seed_target_modified"], first_failed_refusals: ["seed_target_modified"],
      last_processes: 0, clean_at: null });
    expect(warn.mock.calls).toEqual([[`[cloud-v2] activation boot-clean refused classes=seed_target_modified workspace=${f.workspace.id.slice(0, 8)}`]]);
    expect((await report({ processes: 1, refusals: ["io_error", "survivors"] })).status).toBe(409);
    expect(await boot()).toMatchObject({ last_refusals: ["io_error", "survivors"], first_failed_refusals: ["seed_target_modified"], clean_at: null });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps an unreported first failure unknown when a later request includes a class", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await report()).status).toBe(409);
    expect((await report({ refusals: ["seed_journal_outdated"] })).status).toBe(409);
    expect(await boot()).toMatchObject({ first_failed_refusals: null, last_refusals: ["seed_journal_outdated"], clean_at: null });
    expect(warn.mock.calls).toEqual([[`[cloud-v2] activation boot-clean refused classes=unreported workspace=${f.workspace.id.slice(0, 8)}`]]);
  });

  it("accepts an old clean body and replays it", async () => {
    const receipt = { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" };
    const first = await f.worker("execution-leases/boot-clean", receipt);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ retired: 0 });
    expect(await (await f.worker("execution-leases/boot-clean", receipt)).json()).toEqual({ retired: 0 });
    expect(await boot()).toMatchObject({ last_refusals: null, first_failed_refusals: null, clean_at: expect.any(Date) });
    expect((await report({ legacyMaterial: "none", refusals: ["seed_target_modified"] })).status).toBe(400);
  });

  it("replays a successful receipt stored by the previous control plane", async () => {
    const retirementId = "10000000-0000-4000-8000-000000000001";
    // The persisted N-1 digest predates the optional diagnostics field.
    const digest = "75bc59c05c5bc27ff49676760d00c991d5f1b93ebe370b610d1060400c1dcf45";
    await pool.query(`UPDATE cloud_v2_execution_boots SET retirement_id=$3,retirement_hash=decode($4,'hex'),
      retired_count=2,clean_at=clock_timestamp(),last_processes=0,legacy_material='none' WHERE workspace_id=$1 AND boot_id=$2`,
    [f.workspace.id, f.boot, retirementId, digest]);
    const response = await report({ retirementId, legacyMaterial: "none" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ retired: 2 });
    expect((await pool.query("SELECT encode(retirement_hash,'hex') AS digest FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2",
      [f.workspace.id, f.boot])).rows).toEqual([{ digest }]);
  });

  it("rejects unknown, empty, duplicate, unsorted, excessive and clean-result classes before any diagnostic write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const extra of [
      { refusals: ["/private/secret"] }, { refusals: ["seed_target_replaced"] }, { refusals: [] },
      { refusals: ["io_error", "io_error"] }, { refusals: ["survivors", "io_error"] },
      { refusals: Array(25).fill("io_error") }, { refusals: [null] },
      { legacyMaterial: "removed", refusals: ["seed_target_modified"] },
    ]) {
      const response = await report(extra);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(await boot()).toMatchObject({ last_refusals: null, first_failed_refusals: null, first_failed_at: null, clean_at: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not let a diagnostic field make missing material proof or surviving processes clean", async () => {
    expect((await f.worker("execution-leases/boot-clean", {
      retirementId: randomUUID(), processes: 0, refusals: ["seed_journal_outdated"],
    })).status).toBe(409);
    expect((await report({ processes: 1, legacyMaterial: "none", refusals: ["survivors"] })).status).toBe(409);
    expect(await boot()).toMatchObject({ first_failed_refusals: ["seed_journal_outdated"], last_refusals: ["survivors"], clean_at: null });
  });

  it("bounds the database projection to closed, one-dimensional, nonempty arrays", async () => {
    for (const value of [["unknown"], [], Array(25).fill("io_error"), [null], [["io_error"]]]) {
      await expect(pool.query("UPDATE cloud_v2_execution_boots SET last_refusals=$3 WHERE workspace_id=$1 AND boot_id=$2",
        [f.workspace.id, f.boot, value])).rejects.toMatchObject({ code: "23514" });
    }
  });
});
