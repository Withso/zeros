import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { enqueueWorkspaceCheckpointRequest, deliverWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { CloudEngineCheckpointProgress, CloudEngineCheckpointProgressRejected } from "./checkpoint-progress.js";
import type { CloudCheckpointProgress } from "./checkpoint-progress-contract.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("bounded checkpoint progress with PostgreSQL", () => {
  let pool: pg.Pool;
  let service: CloudEngineCheckpointProgress;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let requestId: string;
  const report = (override: Partial<CloudCheckpointProgress> = {}) => ({
    version: 1 as const, organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, requestId,
    sequence: 1, stage: "checkpoint_received" as const, state: "running" as const, reason: "none" as const,
    elapsedMs: 0, ...override, token: fixture.heartbeatToken,
  });
  const receipts = () => withSystemTx(pool, async tx => (await tx.query<{ subject: CloudCheckpointProgress }>(
    `SELECT subject FROM audit_log WHERE org_id=$1 AND action='cloud_workspace.checkpoint_progress' ORDER BY id`,
    [fixture.organizationId])).rows.map(row => row.subject));
  const authority = () => withSystemTx(pool, async tx => ({
    engine: (await tx.query(`SELECT state,revoked_at,lease_expires_at,last_heartbeat_at,final_checkpoint_at
      FROM cloud_workspace_engine_instances WHERE id=$1`, [fixture.engineInstanceId])).rows[0],
    request: (await tx.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [requestId])).rows[0],
    workspace: (await tx.query("SELECT authority_epoch,status,desired_state FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0],
  }));
  const enqueue = () => withSystemTx(pool, tx => enqueueWorkspaceCheckpointRequest(tx, {
    workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
    requestedBy: fixture.userId, reason: "before_stop", idempotencyKey: `progress-${randomUUID()}`,
  }));
  const deliver = () => withSystemTx(pool, tx => deliverWorkspaceCheckpointRequest(tx, {
    workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
  }));

  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    requestId = (await enqueue()).id;
    await deliver();
    service = new CloudEngineCheckpointProgress(pool, { workosEnabled: false });
  });

  it("records engine receipt and completed stages without advancing checkpoint or authority", async () => {
    const before = await authority();
    await service.report(report());
    await service.report(report({ sequence: 2, stage: "seal_ack", state: "completed", elapsedMs: 125 }));
    await service.report(report({ sequence: 3, stage: "final_completion", state: "completed", elapsedMs: 126 }));
    const observed = await receipts();
    expect(observed.map(row => [row.sequence, row.stage, row.state])).toEqual([
      [1, "checkpoint_received", "running"], [2, "seal_ack", "completed"], [3, "final_completion", "completed"],
    ]);
    expect(observed.every(row => !Object.hasOwn(row, "token"))).toBe(true);
    expect(await authority()).toEqual(before);
  });

  it("serializes concurrent duplicate reports, ignores stale edges and refuses changed replay", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.report(report())));
    for (const attempt of attempts) if (attempt.status === "rejected") {
      expect(attempt.reason).toMatchObject({ code: "engine_checkpoint_progress_unavailable" });
    }
    // Best-effort ingress can shed contention; uncontended replay remains
    // idempotent regardless of which concurrent duplicate acquired first.
    await service.report(report());
    await service.report(report());
    await service.report(report({ sequence: 3, stage: "setup_stop" }));
    await service.report(report({ sequence: 2, stage: "service_pause" }));
    await expect(service.report(report({ stage: "run_stop" }))).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect((await receipts()).map(row => row.sequence)).toEqual([1, 3]);
  });

  it("retains the first failure even when late, without letting cleanup replace it", async () => {
    await service.report(report({ sequence: 4, stage: "record_flush" }));
    await service.report(report({ sequence: 2, stage: "setup_stop", state: "failed", reason: "storage" }));
    await service.report(report({ sequence: 5, stage: "record_flush", state: "failed", reason: "unknown" }));
    await service.report(report({ sequence: 6, stage: "final_completion", state: "completed" }));
    expect((await receipts()).map(row => [row.sequence, row.state, row.reason])).toEqual([
      [4, "running", "none"], [2, "failed", "storage"],
    ]);
  });

  it("retains one closed seal refusal beside strict v1 receipts without changing authority or the first cause", async () => {
    const before = await authority();
    const sealRefusal = { version: 1 as const, site: "request" as const, code: "command_context_changed" as const, httpClass: "4xx" as const };
    const failure = { ...report({ stage: "seal_ack", state: "failed", reason: "unknown" }), sealRefusal };
    await service.report(failure);
    await service.report(failure);
    await service.report({ ...failure, sequence: 2, sealRefusal: { ...sealRefusal, code: "command_conflict" } });
    const closed = (await pool.query(`SELECT subject FROM audit_log
      WHERE org_id=$1 AND action='cloud_workspace.checkpoint_seal_refusal' ORDER BY id`, [fixture.organizationId])).rows;
    const { token: _token, ...expected } = failure;
    expect(closed).toEqual([{ subject: expected }]);
    expect(await receipts()).toEqual([report({ stage: "seal_ack", state: "failed", reason: "unknown" })].map(({ token: _token, ...body }) => body));
    expect(await authority()).toEqual(before);
  });

  it("retains one closed capture failure with no additional authority reads or provider operations", async () => {
    const before = await authority();
    const captureFailure = { version: 1 as const, site: "native_verify" as const, reason: "native_changed" as const, httpClass: "none" as const };
    const query = vi.spyOn(pg.Client.prototype, "query");
    let ordinary: unknown[], detailed: unknown[];
    const failure = { ...report({ sequence: 2, stage: "durability_capture", state: "failed", reason: "storage" }), captureFailure };
    try {
      await service.report(report()); ordinary = query.mock.calls.map(call => call[0]); query.mockClear();
      await service.report(failure); detailed = query.mock.calls.map(call => call[0]);
    } finally { query.mockRestore(); }
    expect(detailed!.filter(sql => !String(sql).includes("cloud_workspace.checkpoint_capture_failure"))).toEqual(ordinary!);
    expect(detailed!.length).toBe(ordinary!.length + 1);
    await service.report(failure);
    await service.report({ ...failure, sequence: 3, captureFailure: { ...captureFailure, reason: "unknown" } });
    const rows = (await pool.query(`SELECT subject FROM audit_log
      WHERE org_id=$1 AND action='cloud_workspace.checkpoint_capture_failure' ORDER BY id`, [fixture.organizationId])).rows;
    const { token: _token, ...expected } = failure;
    expect(rows).toEqual([{ subject: expected }]);
    expect((await receipts()).at(-1)).not.toHaveProperty("captureFailure");
    expect(await authority()).toEqual(before);
  });

  it("cannot add capture detail after a headerless failure or cancelled request", async () => {
    const failure = report({ stage: "durability_capture", state: "failed", reason: "unknown" });
    const captureFailure = { version: 1 as const, site: "commit" as const, reason: "transport" as const, httpClass: "none" as const };
    await service.report(failure); await service.report({ ...failure, captureFailure });
    await pool.query("UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now() WHERE id=$1", [requestId]);
    await expect(service.report({ ...failure, sequence: 2, captureFailure })).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='cloud_workspace.checkpoint_capture_failure'")).rows[0].count).toBe(0);
  });

  it("rejects superseded capture authority and ignores detail outside the failed capture stage", async () => {
    const captureFailure = { version: 1 as const, site: "native_pack" as const, reason: "git_failed" as const, httpClass: "none" as const };
    await expect(service.report({ ...report({ engineInstanceId: randomUUID(), stage: "durability_capture", state: "failed", reason: "storage" }), captureFailure }))
      .rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    await service.report({ ...report(), captureFailure });
    await service.report({ ...report({ sequence: 2, stage: "record_flush", state: "failed", reason: "unknown" }), captureFailure });
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='cloud_workspace.checkpoint_capture_failure'")).rows[0].count).toBe(0);
    expect(await receipts()).toHaveLength(2);
  });

  it("cannot append seal evidence after a headerless first failure or a cancelled request", async () => {
    const failure = report({ stage: "seal_ack", state: "failed", reason: "unknown" });
    const sealRefusal = { version: 1 as const, site: "request" as const, code: "command_conflict" as const, httpClass: "4xx" as const };
    await service.report(failure);
    await service.report({ ...failure, sealRefusal });
    await pool.query("UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now() WHERE id=$1", [requestId]);
    await expect(service.report({ ...failure, sequence: 2, sealRefusal })).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='cloud_workspace.checkpoint_seal_refusal'")).rows[0].count).toBe(0);
  });

  it("fences foreign seal evidence and ignores it outside a failed seal stage", async () => {
    const sealRefusal = { version: 1 as const, site: "request" as const, code: "command_conflict" as const, httpClass: "4xx" as const };
    await expect(service.report({ ...report({ engineInstanceId: randomUUID(), stage: "seal_ack", state: "failed", reason: "unknown" }), sealRefusal }))
      .rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    await service.report({ ...report(), sealRefusal });
    await service.report({ ...report({ sequence: 2, stage: "record_flush", state: "failed", reason: "unknown" }), sealRefusal });
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='cloud_workspace.checkpoint_seal_refusal'")).rows[0].count).toBe(0);
    expect(await receipts()).toHaveLength(2);
  });

  it("uses one immutable receipt history for UUID case aliases", async () => {
    const canonical = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await withSystemTx(pool, tx => tx.query("UPDATE workspace_checkpoint_requests SET id=$2 WHERE id=$1", [requestId, canonical]));
    requestId = canonical;
    await service.report(report({ state: "failed", reason: "storage" }));
    const alias = report({ requestId: canonical.toUpperCase(), workspaceId: fixture.workspaceId.toUpperCase(),
      organizationId: fixture.organizationId.toUpperCase(), engineInstanceId: fixture.engineInstanceId.toUpperCase(),
      sequence: 2, stage: "final_completion", state: "completed" });
    await service.report(alias);
    expect((await receipts()).map(row => [row.sequence, row.state, row.reason])).toEqual([[1, "failed", "storage"]]);
  });

  it("requires the configured WorkOS authority instead of assuming the fixture is mirrored", async () => {
    const workos = new CloudEngineCheckpointProgress(pool, { workosEnabled: true });
    await expect(workos.report(report())).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect(await receipts()).toEqual([]);
  });

  it("bounds audit storage at sixty-four immutable sequence receipts", async () => {
    for (let sequence = 1; sequence <= 64; sequence++) await service.report(report({ sequence }));
    await service.report(report({ sequence: 64 }));
    await expect(service.report(report({ sequence: 65 }))).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect(await receipts()).toHaveLength(64);
  });

  it.each(["token", "organization", "workspace", "generation", "engine", "request"] as const)(
    "refuses a foreign %s without retaining it", async field => {
      const input = report();
      if (field === "token") input.token = `zwh_${"X".repeat(43)}`;
      else if (field === "organization") input.organizationId = randomUUID();
      else if (field === "workspace") input.workspaceId = randomUUID();
      else if (field === "generation") input.generation++;
      else if (field === "engine") input.engineInstanceId = randomUUID();
      else input.requestId = randomUUID();
      await expect(service.report(input)).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
      expect(await receipts()).toEqual([]);
    },
  );

  it.each(["queued", "cancelled", "expired", "revoked", "lease", "fenced", "membership", "stopped"] as const)(
    "refuses %s scope and does not rewrite its lifecycle", async fence => {
      await withSystemTx(pool, async tx => {
        if (fence === "queued") await tx.query("UPDATE workspace_checkpoint_requests SET state='queued',delivery_count=0,last_delivered_at=NULL WHERE id=$1", [requestId]);
        else if (fence === "cancelled") await tx.query("UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now(),error_code='stop_unsealed' WHERE id=$1", [requestId]);
        else if (fence === "expired") await tx.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '10 minutes',deadline_at=now()-interval '1 second' WHERE id=$1", [requestId]);
        else if (fence === "revoked") await tx.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
        else if (fence === "lease") await tx.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '1 hour',lease_expires_at=now()-interval '1 second' WHERE id=$1", [fixture.engineInstanceId]);
        else if (fence === "fenced") await tx.query("UPDATE cloud_workspace_engine_instances SET final_checkpoint_at=now() WHERE id=$1", [fixture.engineInstanceId]);
        else if (fence === "membership") await tx.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [fixture.teamId, fixture.userId]);
        else await tx.query("UPDATE cloud_workspaces SET desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
      });
      const before = await authority();
      await expect(service.report(report())).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
      expect(await receipts()).toEqual([]);
      expect(await authority()).toEqual(before);
    },
  );

  it("uses the original request window, even after heartbeat redelivery", async () => {
    await withSystemTx(pool, tx => tx.query("UPDATE workspace_checkpoint_requests SET deadline_at=created_at+interval '30 seconds' WHERE id=$1", [requestId]));
    await deliver();
    await expect(service.report(report({ elapsedMs: 30_001 }))).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    await service.report(report({ elapsedMs: 30_000 }));
    expect(await receipts()).toHaveLength(1);
  });

  it("does not attach an undelivered replacement engine to the earlier delivery", async () => {
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_engine_instances SET created_at=clock_timestamp()+interval '1 second' WHERE id=$1", [fixture.engineInstanceId]));
    await expect(service.report(report())).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect(await receipts()).toEqual([]);
  });

  it("does not mix a second engine into the same request after redelivery", async () => {
    await service.report(report());
    const replacement = randomUUID();
    await withSystemTx(pool, async tx => {
      // No dependent engine rows exist in this fixture. Retain the valid grant,
      // runtime and funding while publishing a fresh identity after delivery.
      await tx.query("UPDATE cloud_workspace_engine_instances SET id=$2,created_at=clock_timestamp() WHERE id=$1", [fixture.engineInstanceId, replacement]);
      await assertCurrentCloudEngineAuthority(tx, { ...report({ engineInstanceId: replacement }),
        heartbeatToken: fixture.heartbeatToken, workosEnabled: false });
    });
    await deliver();
    await expect(service.report(report({ engineInstanceId: replacement, sequence: 2 }))).rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect(await receipts()).toHaveLength(1);
  });

  it("rejects private diagnostic fields at the persistence boundary", async () => {
    await expect(service.report({ ...report(), text: "PRIVATE-DIAGNOSTIC-CANARY" } as ReturnType<typeof report>))
      .rejects.toBeInstanceOf(CloudEngineCheckpointProgressRejected);
    expect(await receipts()).toEqual([]);
  });

  it("drops contended diagnostics with a closed outcome and leaves authority untouched", async () => {
    const before = await authority();
    const held = await pool.connect();
    try {
      await held.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      await held.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
      // Hold until the optional report's own bounded acquire fails, never a
      // sleep chosen to race that deadline. No lifecycle operation awaits it.
      await expect(service.report(report())).rejects.toMatchObject({ code: "engine_checkpoint_progress_unavailable" });
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
    expect(await receipts()).toEqual([]);
    expect(await authority()).toEqual(before);
    await service.report(report());
    expect(await receipts()).toHaveLength(1);
  });

  it("orders cancellation before a blocked report and preserves stop_unsealed", async () => {
    const held = await pool.connect();
    let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await held.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      const pid = (await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await held.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [fixture.workspaceId]);
      pending = service.report(report()).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount,
      { interval: 5, timeout: 1_000 }).toBe(1);
      await held.query("UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now(),error_code='stop_unsealed' WHERE id=$1", [requestId]);
      await held.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: expect.any(CloudEngineCheckpointProgressRejected) });
      expect(await receipts()).toEqual([]);
      expect((await authority()).request).toMatchObject({ state: "cancelled", error_code: "stop_unsealed" });
    } finally {
      await held.query("ROLLBACK");
      held.release();
      await pending;
    }
  });
});
