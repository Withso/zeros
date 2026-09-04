import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withSystemTx, type Tx } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  workOSProviderErasureFenceStatus,
  workOSProviderSubjectHash,
} from "./workos-provider-locks.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("WorkOS provider erasure readiness", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  const status = (kind: "user" | "organization", id: string) =>
    withSystemTx(pool, (tx) =>
      workOSProviderErasureFenceStatus(tx, [{ kind, id }]),
    );

  it("allows an unknown subject only when every historical purge has evidence", async () => {
    await expect(status("user", `user_${randomUUID()}`)).resolves.toBe(
      "unfenced",
    );

    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state, requested_at,
         purge_after, purge_started_at, purged_at
       ) VALUES ($1, 'ZD-RCNC-PEND', 'account', $1, 'purged',
                 '2025-01-01T00:00:00Z', '2025-01-31T00:00:00Z',
                 '2025-01-31T00:00:00Z', '2025-01-31T00:01:00Z')`,
      [requestId],
    );
    await expect(status("user", `user_${randomUUID()}`)).resolves.toBe(
      "not_ready",
    );
  });

  it("never admits a subject reconciled between the evidence probe and snapshot", async () => {
    const requestId = randomUUID();
    const subject = `user_${randomUUID()}`;
    const subjectHash = workOSProviderSubjectHash({ kind: "user", id: subject });
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state, requested_at,
         purge_after, purge_started_at, purged_at
       ) VALUES ($1, 'ZD-RCNC-RACE', 'account', $1, 'purged',
                 '2025-01-01T00:00:00Z', '2025-01-31T00:00:00Z',
                 '2025-01-31T00:00:00Z', '2025-01-31T00:01:00Z')`,
      [requestId],
    );

    let reconciliationCommitted = false;
    const result = await withSystemTx(pool, async (tx) => {
      const interposed = {
        query: async (queryText: string, values?: unknown[]) => {
          const queryResult = await tx.query(queryText, values);
          if (
            !reconciliationCommitted &&
            queryText.includes("workos_provider_erasure_fences fence")
          ) {
            await pool.query(
              `WITH inserted_fence AS (
                 INSERT INTO workos_provider_erasure_fences (
                   provider, subject_kind, hash_version, subject_hash,
                   deletion_request_id, evidence_source
                 ) VALUES (
                   'workos', 'user', 1, $2, $1, 'operator_reconciliation'
                 )
                 RETURNING deletion_request_id
               )
               INSERT INTO workos_provider_erasure_reconciliations (
                 deletion_request_id, disposition, evidence_source,
                 evidence_reference
               )
               SELECT deletion_request_id, 'fenced',
                      'operator_reconciliation', 'test-race-reconciliation'
               FROM inserted_fence`,
              [requestId, subjectHash],
            );
            reconciliationCommitted = true;
          }
          return queryResult;
        },
      } as unknown as Tx;
      return workOSProviderErasureFenceStatus(interposed, [
        { kind: "user", id: subject },
      ]);
    });

    expect(reconciliationCommitted).toBe(true);
    expect(result).toBe("not_ready");
    await expect(status("user", subject)).resolves.toBe("fenced");
  });

  it("keeps known active mappings usable while evidence is unavailable", async () => {
    const userId = randomUUID();
    const subject = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      userId,
      `${userId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO user_identities (
         user_id, provider, provider_sub, email_at_link,
         email_verified_at, linked_via
       ) VALUES ($1, 'workos', $2, $3, now(), 'jit')`,
      [userId, subject, `${userId}@example.test`],
    );
    await pool.query("DROP TABLE workos_provider_erasure_reconciliations");
    await pool.query("DROP TABLE workos_provider_erasure_fences");

    await expect(status("user", subject)).resolves.toBe("unfenced");
    await expect(status("user", `user_${randomUUID()}`)).resolves.toBe(
      "not_ready",
    );
  });

  it("projects append-only lifecycle evidence into an exact subject fence", async () => {
    const requestId = randomUUID();
    const subject = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state,
         purge_started_at, next_attempt_at
       ) VALUES ($1, 'ZD-FENC-EXCT', 'account', $1,
                 'provider_deleting', now(), now())`,
      [requestId],
    );
    await pool.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, action, metadata
       ) VALUES ($1, 'purge.provider_erasure_fenced', $2::jsonb)`,
      [
        requestId,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [
            workOSProviderSubjectHash({ kind: "user", id: subject }),
          ],
        }),
      ],
    );

    await expect(status("user", subject)).resolves.toBe("fenced");
  });
});
