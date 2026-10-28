import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import { isGithubAccessRevoked } from "../github-availability.js";

export type GithubVerificationScope = {
  organizationId: string; userId: string; repositoryId: string; fingerprint: string;
};
export type GithubVerification = {
  verifiedAt: number | null;
  canonicalRepository?: string | null;
  /** Original database timestamp, used only to order canonical-name updates. */
  observedAt?: Date | null;
  retryAt: number;
  failures: number;
  failure: HttpError | null;
  claimId: string | null;
  claimUntil: number;
  claimStartedAt: number;
};
export type GithubVerificationResult =
  | { allowed: true; canonicalRepository?: string }
  | { allowed: false; temporary: boolean; error: HttpError; retryAfterMs: number };
export interface GithubVerificationStore {
  read(scope: GithubVerificationScope): Promise<GithubVerification | null>;
  backoff(scope: GithubVerificationScope): Promise<GithubVerification | null>;
  claim(scope: GithubVerificationScope): Promise<GithubVerification | null>;
  finish(scope: GithubVerificationScope, claimId: string, result: GithubVerificationResult): Promise<GithubVerification | null>;
}

type Row = {
  verified_at: Date | null; retry_at: Date | null; failures: number;
  canonical_repository: string | null;
  failure_code: string | null; failure_status: HttpError["status"] | null;
  claim_id: string | null; claim_until: Date | null; claim_started_at: Date | null;
  database_now: Date;
};
const columns = "verified_at,canonical_repository,retry_at,failures,failure_code,failure_status,claim_id,claim_until,claim_started_at,clock_timestamp() AS database_now";
const params = (scope: GithubVerificationScope) => [scope.organizationId, scope.userId, scope.repositoryId, scope.fingerprint];

/** No timer, provider call or lock held across I/O. Short claims coalesce
 * replicas; CAS prevents a late result from replacing a newer observation. */
export class PostgresGithubVerificationStore implements GithubVerificationStore {
  constructor(private readonly pool: pg.Pool, private readonly now = () => Date.now()) {}

  private observation(row: Row | undefined, started: number): GithubVerification | null {
    if (!row) return null;
    // Translate server-clock ages at the start of the read. Slow DB responses
    // can shorten a lease, never make old permission evidence young again.
    const serverNow = row.database_now.getTime();
    const age = row.verified_at ? serverNow - row.verified_at.getTime() : -1;
    const remaining = (date: Date | null) => started + Math.max(0, (date?.getTime() ?? serverNow) - serverNow);
    return {
      verifiedAt: age >= 0 ? started - age : null,
      canonicalRepository: row.canonical_repository, observedAt: row.verified_at,
      retryAt: remaining(row.retry_at), failures: row.failures,
      failure: row.failure_code && row.failure_status ? new HttpError(row.failure_status, row.failure_code,
        "GitHub repository access could not be verified. Try again shortly.") : null,
      claimId: row.claim_id, claimUntil: remaining(row.claim_until),
      claimStartedAt: started - Math.max(0, serverNow - (row.claim_started_at?.getTime() ?? serverNow)),
    };
  }

  async read(scope: GithubVerificationScope): Promise<GithubVerification | null> {
    const started = this.now();
    const result = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${columns} FROM cloud_github_source_verifications
       WHERE org_id=$1 AND owner_user_id=$2 AND repository_id=$3 AND fingerprint=$4`, params(scope)));
    return this.observation(result.rows[0], started);
  }

  async claim(scope: GithubVerificationScope): Promise<GithubVerification | null> {
    const started = this.now();
    const result = await withSystemTx(this.pool, tx => tx.query<Row>(
      `INSERT INTO cloud_github_source_verifications AS v
         (org_id,owner_user_id,repository_id,fingerprint,claim_id,claim_started_at,claim_until)
       VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+interval '60 seconds')
       ON CONFLICT(org_id,owner_user_id,repository_id) DO UPDATE SET
         verified_at=CASE WHEN v.fingerprint=EXCLUDED.fingerprint THEN v.verified_at END,
         canonical_repository=CASE WHEN v.fingerprint=EXCLUDED.fingerprint THEN v.canonical_repository END,
         failure_code=CASE WHEN v.fingerprint=EXCLUDED.fingerprint THEN v.failure_code END,
         failure_status=CASE WHEN v.fingerprint=EXCLUDED.fingerprint THEN v.failure_status END,
         failures=CASE WHEN v.fingerprint=EXCLUDED.fingerprint THEN v.failures ELSE 0 END,
         retry_at=CASE WHEN v.fingerprint=EXCLUDED.fingerprint THEN v.retry_at END,
         fingerprint=EXCLUDED.fingerprint,claim_id=EXCLUDED.claim_id,
         claim_started_at=EXCLUDED.claim_started_at,claim_until=EXCLUDED.claim_until
       WHERE v.fingerprint<>EXCLUDED.fingerprint OR
         ((v.claim_until IS NULL OR v.claim_until<=clock_timestamp()) AND (v.retry_at IS NULL OR v.retry_at<=clock_timestamp())
           AND (v.verified_at IS NULL OR v.failure_code IS NOT NULL OR v.verified_at<=clock_timestamp()-interval '30 seconds'))
       RETURNING ${columns}`, [...params(scope), randomUUID()]));
    return this.observation(result.rows[0], started);
  }

  async backoff(scope: GithubVerificationScope): Promise<GithubVerification | null> {
    const started = this.now();
    const result = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${columns} FROM cloud_github_source_verifications
       WHERE org_id=$1 AND owner_user_id=$2 AND fingerprint=$3 AND retry_at>clock_timestamp()
         AND failure_code IN ('github_rate_limited','github_unavailable')
       ORDER BY retry_at DESC LIMIT 1`, [scope.organizationId, scope.userId, scope.fingerprint]));
    return this.observation(result.rows[0], started);
  }

  async finish(scope: GithubVerificationScope, claimId: string, outcome: GithubVerificationResult): Promise<GithubVerification | null> {
    const started = this.now();
    const result = await withSystemTx(this.pool, async tx => {
      const result = await tx.query<Row>(
      `UPDATE cloud_github_source_verifications SET
         verified_at=CASE WHEN $6 THEN claim_started_at WHEN $7 THEN verified_at END,
         canonical_repository=CASE WHEN $6 THEN $11 WHEN $7 THEN canonical_repository END,
         failure_code=$8,failure_status=$9,failures=CASE WHEN $6 THEN 0 ELSE least(failures+1,16) END,
         retry_at=CASE WHEN $6 THEN NULL ELSE clock_timestamp()+make_interval(secs=>$10::double precision/1000) END,
         claim_id=NULL,claim_started_at=NULL,claim_until=NULL
       WHERE org_id=$1 AND owner_user_id=$2 AND repository_id=$3 AND fingerprint=$4 AND claim_id=$5
         AND claim_until>clock_timestamp()
       RETURNING ${columns}`, [...params(scope), claimId, outcome.allowed,
        !outcome.allowed && outcome.temporary, outcome.allowed ? null : outcome.error.code,
        outcome.allowed ? null : outcome.error.status, outcome.allowed ? 0 : outcome.retryAfterMs,
        outcome.allowed ? outcome.canonicalRepository ?? null : null]);
      if (result.rowCount && !outcome.allowed && isGithubAccessRevoked(outcome.error)) {
        // Requests already read this revision with their worker/session proof.
        // A missed NOTIFY must not preserve another replica's positive cache.
        await tx.query(`UPDATE cloud_v2_workspaces w SET login_revision=login_revision+1
          WHERE w.org_id=$1 AND w.creator_user_id=$2 AND w.state NOT IN ('deleted','deleting')
            AND EXISTS (SELECT 1 FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id AND s.repository_id=$3)`,
          [scope.organizationId, scope.userId, scope.repositoryId]);
        await tx.query("SELECT pg_notify('zeros_cloud_github_access',$1)", [JSON.stringify({
          organizationId: scope.organizationId, ownerUserId: scope.userId,
        })]);
      }
      return result;
    });
    return this.observation(result.rows[0], started);
  }
}
