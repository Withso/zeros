import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";
import {
  inspectWorkOSProviderErasureReadiness,
  manageWorkOSProviderErasureEvidence,
  validateWorkOSProviderErasureRequest,
  workOSProviderErasureApprovalText,
} from "./manage-workos-provider-erasure.js";
import { workOSProviderSubjectHash } from "./workos-provider-locks.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  databaseUrl: "postgres://operator:secret@db.example.test:5432/zeros",
  channel: "alpha",
  railwayEnvironmentName: "alpha",
  execute: false,
  productionConfirmed: undefined,
  approval: undefined,
  deletionRequestId: "71717171-7171-4171-8171-717171717171",
  actorUserId: "72727272-7272-4272-8272-727272727272",
  disposition: "fenced",
  subjectsJson: JSON.stringify([{ kind: "user", id: "user_secret_raw" }]),
  evidenceReference: "CASE-123456 provider audit export",
  ...overrides,
});

describe("WorkOS provider-erasure operator request", () => {
  it("binds approval to subject hashes without exposing raw provider ids", () => {
    const request = validateWorkOSProviderErasureRequest(baseInput());
    const approval = workOSProviderErasureApprovalText(request);
    expect(approval).not.toContain("user_secret_raw");
    expect(approval).toContain(
      workOSProviderSubjectHash({ kind: "user", id: "user_secret_raw" }),
    );
  });

  it("requires explicit production confirmation", () => {
    expect(() =>
      validateWorkOSProviderErasureRequest(
        baseInput({
          channel: "production",
          railwayEnvironmentName: "production",
          execute: true,
        }),
      ),
    ).toThrow(/production confirmation/i);
  });
});

d("WorkOS provider-erasure operator reconciliation", () => {
  let pool: pg.Pool;
  let actorUserId: string;
  let requestId: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    actorUserId = randomUUID();
    requestId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, staff_role)
       VALUES ($1, $2, 'platform_owner')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state, requested_at,
         purge_after, purge_started_at, purged_at
       ) VALUES ($1, 'ZD-OPRR-ECNC', 'account', $1, 'purged',
                 '2025-01-01T00:00:00Z', '2025-01-31T00:00:00Z',
                 '2025-01-31T00:00:00Z', '2025-01-31T00:01:00Z')`,
      [requestId],
    );
  });

  const request = (overrides: Record<string, unknown> = {}) =>
    validateWorkOSProviderErasureRequest(
      baseInput({
        databaseUrl: databaseUrl!,
        deletionRequestId: requestId,
        actorUserId,
        ...overrides,
      }),
    );

  it("plans and atomically records hashed evidence without retaining the raw subject", async () => {
    const rawSubject = `user_${randomUUID()}`;
    const planRequest = request({
      subjectsJson: JSON.stringify([{ kind: "user", id: rawSubject }]),
    });
    const plan = await manageWorkOSProviderErasureEvidence(pool, planRequest);
    expect(plan.state).toBe("planned");
    expect(plan.approval).toBe(workOSProviderErasureApprovalText(planRequest));

    const result = await manageWorkOSProviderErasureEvidence(
      pool,
      request({
        execute: true,
        approval: plan.approval,
        subjectsJson: JSON.stringify([{ kind: "user", id: rawSubject }]),
      }),
    );
    expect(result.state).toBe("reconciled");

    const evidence = await pool.query(
      `SELECT fence.subject_hash, reconciliation.disposition, event.metadata
       FROM workos_provider_erasure_fences fence
       JOIN workos_provider_erasure_reconciliations reconciliation
         ON reconciliation.deletion_request_id = fence.deletion_request_id
       JOIN deletion_request_events event
         ON event.deletion_request_id = fence.deletion_request_id
        AND event.action = 'purge.provider_erasure_reconciled'
       WHERE fence.deletion_request_id = $1`,
      [requestId],
    );
    expect(evidence.rows).toEqual([
      expect.objectContaining({
        subject_hash: workOSProviderSubjectHash({
          kind: "user",
          id: rawSubject,
        }),
        disposition: "fenced",
      }),
    ]);
    expect(JSON.stringify(evidence.rows)).not.toContain(rawSubject);
    await expect(
      inspectWorkOSProviderErasureReadiness(pool),
    ).resolves.toMatchObject({
      ready: true,
      unresolved: [],
    });
  });

  it("supports an explicit provider-audited no-subject disposition", async () => {
    const planRequest = request({
      disposition: "no_workos_subject",
      subjectsJson: "[]",
    });
    const plan = await manageWorkOSProviderErasureEvidence(pool, planRequest);
    await expect(
      manageWorkOSProviderErasureEvidence(
        pool,
        request({
          disposition: "no_workos_subject",
          subjectsJson: "[]",
          execute: true,
          approval: plan.approval,
        }),
      ),
    ).resolves.toMatchObject({ state: "reconciled" });
    await expect(
      inspectWorkOSProviderErasureReadiness(pool),
    ).resolves.toMatchObject({
      ready: true,
      unresolved: [],
    });
  });
});
