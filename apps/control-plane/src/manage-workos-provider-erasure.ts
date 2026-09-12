// Guarded database-owner utility for reconciling WorkOS provider subjects that
// may have been purged before durable subject fences existed. Raw provider ids
// are hashed in process and are never logged or persisted.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

import {
  workOSProviderSubjectHash,
  workOSProviderSubjectLockKey,
  withWorkOSProviderLocks,
  type WorkOSProviderSubject,
} from "./workos-provider-locks.js";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const Uuid = z.string().uuid();
const EvidenceReference = z.string().trim().min(16).max(512);
const ProviderSubject = z
  .object({
    kind: z.enum(["user", "organization"]),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
  })
  .strict();

export interface WorkOSProviderErasureRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  deletionRequestId: string | undefined;
  actorUserId: string | undefined;
  disposition: string | undefined;
  subjectsJson: string | undefined;
  evidenceReference: string | undefined;
}

export interface ValidatedWorkOSProviderErasureRequest {
  databaseUrl: string;
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  deletionRequestId: string;
  actorUserId: string;
  disposition: "fenced" | "no_workos_subject";
  subjects: readonly WorkOSProviderSubject[];
  subjectHashes: readonly string[];
  evidenceReference: string;
  targetFingerprint: string;
}

export interface WorkOSProviderErasureResult {
  state: "planned" | "reconciled" | "unchanged";
  deletionRequestId: string;
  disposition: "fenced" | "no_workos_subject";
  subjectHashes: readonly string[];
  targetFingerprint: string;
  approval: string | null;
}

export interface WorkOSProviderErasureReadiness {
  ready: boolean;
  totalPurged: number;
  unresolvedCount: number;
  unresolved: Array<{
    deletionRequestId: string;
    publicCode: string;
    targetKind: "account" | "organization";
    purgedAt: string;
  }>;
}

export class WorkOSProviderErasureManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkOSProviderErasureManagementError";
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new WorkOSProviderErasureManagementError(
      "Invalid provider-erasure configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new WorkOSProviderErasureManagementError(
      "Invalid provider-erasure configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

function targetFingerprint(databaseUrl: string, channel: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  return createHash("sha256")
    .update(
      [
        "zeros-control-plane-workos-provider-erasure.v1",
        channel,
        parsed.hostname.toLowerCase(),
        parsed.port || "5432",
        parsed.pathname,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
}

function evidenceFingerprint(reference: string): string {
  return createHash("sha256")
    .update(reference, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function validateWorkOSProviderErasureRequest(
  input: WorkOSProviderErasureRequestInput,
): ValidatedWorkOSProviderErasureRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_CHANNEL must be development, alpha, beta, or production",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new WorkOSProviderErasureManagementError(
      "Provider-erasure channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }
  if (
    input.execute &&
    channel === "production" &&
    input.productionConfirmed !== "true"
  ) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_PRODUCTION_CONFIRMED=true is required for production confirmation",
    );
  }

  const deletionRequestId = Uuid.safeParse(input.deletionRequestId);
  const actorUserId = Uuid.safeParse(input.actorUserId);
  const disposition = z
    .enum(["fenced", "no_workos_subject"])
    .safeParse(input.disposition);
  const evidenceReference = EvidenceReference.safeParse(
    input.evidenceReference,
  );
  if (!deletionRequestId.success) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_DELETION_REQUEST_ID must be one exact UUID",
    );
  }
  if (!actorUserId.success) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_ACTOR_USER_ID must be one exact UUID",
    );
  }
  if (!disposition.success) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_DISPOSITION must be fenced or no_workos_subject",
    );
  }
  if (!evidenceReference.success) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_EVIDENCE_REFERENCE must contain 16 to 512 characters",
    );
  }

  let rawSubjects: unknown;
  try {
    rawSubjects = JSON.parse(input.subjectsJson ?? "[]");
  } catch {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_SUBJECTS_JSON must be valid JSON",
    );
  }
  const subjects = z.array(ProviderSubject).max(16).safeParse(rawSubjects);
  if (!subjects.success) {
    throw new WorkOSProviderErasureManagementError(
      "CONTROL_PLANE_WORKOS_ERASURE_SUBJECTS_JSON must contain at most 16 exact WorkOS subjects",
    );
  }
  const uniqueSubjects = Array.from(
    new Map(
      subjects.data.map((subject) => [
        `${subject.kind}\0${subject.id}`,
        subject,
      ]),
    ).values(),
  );
  if (
    (disposition.data === "fenced" && uniqueSubjects.length === 0) ||
    (disposition.data === "no_workos_subject" && uniqueSubjects.length !== 0)
  ) {
    throw new WorkOSProviderErasureManagementError(
      "A fenced disposition requires subjects; no_workos_subject requires an empty subject list",
    );
  }
  const subjectHashes = uniqueSubjects.map(workOSProviderSubjectHash).sort();
  return {
    databaseUrl: input.databaseUrl,
    channel: channel as ValidatedWorkOSProviderErasureRequest["channel"],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    deletionRequestId: deletionRequestId.data,
    actorUserId: actorUserId.data,
    disposition: disposition.data,
    subjects: uniqueSubjects,
    subjectHashes,
    evidenceReference: evidenceReference.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel),
  };
}

export function workOSProviderErasureApprovalText(
  request: ValidatedWorkOSProviderErasureRequest,
): string {
  return [
    "workos-provider-erasure",
    request.channel,
    request.targetFingerprint,
    request.deletionRequestId,
    request.actorUserId,
    request.disposition,
    request.subjectHashes.join(",") || "none",
    evidenceFingerprint(request.evidenceReference),
  ].join(":");
}

async function assertDatabaseOwner(client: pg.PoolClient): Promise<string> {
  const result = await client.query<{
    principal: string;
    owns_fences: boolean;
    owns_reconciliations: boolean;
    owns_events: boolean;
  }>(
    `SELECT current_user AS principal,
            pg_get_userbyid(fence.relowner) = current_user AS owns_fences,
            pg_get_userbyid(reconciliation.relowner) = current_user
              AS owns_reconciliations,
            pg_get_userbyid(event.relowner) = current_user AS owns_events
     FROM pg_class fence
     CROSS JOIN pg_class reconciliation
     CROSS JOIN pg_class event
     WHERE fence.oid = 'public.workos_provider_erasure_fences'::regclass
       AND reconciliation.oid =
           'public.workos_provider_erasure_reconciliations'::regclass
       AND event.oid = 'public.deletion_request_events'::regclass`,
  );
  const authority = result.rows[0];
  if (
    !authority ||
    authority.principal === "zeros_app" ||
    !authority.owns_fences ||
    !authority.owns_reconciliations ||
    !authority.owns_events
  ) {
    throw new WorkOSProviderErasureManagementError(
      "Provider-erasure reconciliation requires the database/migration owner; the application role is refused",
    );
  }
  return authority.principal;
}

export async function inspectWorkOSProviderErasureReadiness(
  pool: pg.Pool,
): Promise<WorkOSProviderErasureReadiness> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");
    await assertDatabaseOwner(client);
    const counts = await client.query<{
      total_purged: number;
      unresolved_count: number;
    }>(
      `SELECT count(*)::integer AS total_purged,
              count(*) FILTER (WHERE reconciliation.deletion_request_id IS NULL)::integer
                AS unresolved_count
       FROM deletion_requests request
       LEFT JOIN workos_provider_erasure_reconciliations reconciliation
         ON reconciliation.deletion_request_id = request.id
       WHERE request.state = 'purged'`,
    );
    const unresolved = await client.query<{
      deletion_request_id: string;
      public_code: string;
      target_kind: "account" | "organization";
      purged_at: Date | string;
    }>(
      `SELECT request.id AS deletion_request_id, request.public_code,
              request.target_kind, request.purged_at
       FROM deletion_requests request
       LEFT JOIN workos_provider_erasure_reconciliations reconciliation
         ON reconciliation.deletion_request_id = request.id
       WHERE request.state = 'purged'
         AND reconciliation.deletion_request_id IS NULL
       ORDER BY request.purged_at, request.id
       LIMIT 100`,
    );
    await client.query("ROLLBACK");
    const row = counts.rows[0] ?? { total_purged: 0, unresolved_count: 0 };
    return {
      ready: row.unresolved_count === 0,
      totalPurged: row.total_purged,
      unresolvedCount: row.unresolved_count,
      unresolved: unresolved.rows.map((request) => ({
        deletionRequestId: request.deletion_request_id,
        publicCode: request.public_code,
        targetKind: request.target_kind,
        purgedAt: new Date(request.purged_at).toISOString(),
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function manageWorkOSProviderErasureEvidence(
  pool: pg.Pool,
  request: ValidatedWorkOSProviderErasureRequest,
): Promise<WorkOSProviderErasureResult> {
  const lockKeys = request.execute
    ? request.subjects.map(workOSProviderSubjectLockKey)
    : [];
  return withWorkOSProviderLocks(pool, lockKeys, () =>
    manageWorkOSProviderErasureEvidenceUnlocked(pool, request),
  );
}

async function manageWorkOSProviderErasureEvidenceUnlocked(
  pool: pg.Pool,
  request: ValidatedWorkOSProviderErasureRequest,
): Promise<WorkOSProviderErasureResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");
    await assertDatabaseOwner(client);

    const actor = await client.query<{
      auth_status: string;
      deleted_at: Date | string | null;
      staff_role: string | null;
    }>(
      `SELECT auth_status, deleted_at, staff_role
       FROM users WHERE id = $1 FOR SHARE`,
      [request.actorUserId],
    );
    if (
      actor.rows[0]?.auth_status !== "active" ||
      actor.rows[0]?.deleted_at !== null ||
      actor.rows[0]?.staff_role !== "platform_owner"
    ) {
      throw new WorkOSProviderErasureManagementError(
        "Provider-erasure actor must be one active Zeros platform owner",
      );
    }

    const target = await client.query<{
      target_kind: "account" | "organization";
      state: string;
    }>(
      `SELECT target_kind, state FROM deletion_requests
       WHERE id = $1 FOR SHARE`,
      [request.deletionRequestId],
    );
    if (!target.rows[0] || target.rows[0].state !== "purged") {
      throw new WorkOSProviderErasureManagementError(
        "Provider-erasure reconciliation requires one exact purged deletion request",
      );
    }
    const expectedKind =
      target.rows[0].target_kind === "account" ? "user" : "organization";
    if (request.subjects.some((subject) => subject.kind !== expectedKind)) {
      throw new WorkOSProviderErasureManagementError(
        `Provider-erasure subjects must be ${expectedKind} identifiers for this request`,
      );
    }

    const existing = await client.query<{
      disposition: "fenced" | "no_workos_subject";
    }>(
      `SELECT disposition
       FROM workos_provider_erasure_reconciliations
       WHERE deletion_request_id = $1`,
      [request.deletionRequestId],
    );
    if (existing.rows[0]) {
      if (request.execute) {
        throw new WorkOSProviderErasureManagementError(
          "Deletion request is already reconciled; generate a fresh status report",
        );
      }
      await client.query("ROLLBACK");
      return {
        state: "unchanged",
        deletionRequestId: request.deletionRequestId,
        disposition: existing.rows[0].disposition,
        subjectHashes: request.subjectHashes,
        targetFingerprint: request.targetFingerprint,
        approval: null,
      };
    }

    if (request.subjectHashes.length > 0) {
      const conflicts = await client.query<{
        subject_hash: string;
        deletion_request_id: string;
      }>(
        `SELECT subject_hash, deletion_request_id
         FROM workos_provider_erasure_fences
         WHERE provider = 'workos' AND hash_version = 1
           AND subject_hash = ANY($1::text[])
           AND deletion_request_id <> $2`,
        [request.subjectHashes, request.deletionRequestId],
      );
      if (conflicts.rows[0]) {
        throw new WorkOSProviderErasureManagementError(
          "A requested provider subject is already fenced by another deletion request",
        );
      }
    }

    const approval = workOSProviderErasureApprovalText(request);
    if (!request.execute) {
      await client.query("ROLLBACK");
      return {
        state: "planned",
        deletionRequestId: request.deletionRequestId,
        disposition: request.disposition,
        subjectHashes: request.subjectHashes,
        targetFingerprint: request.targetFingerprint,
        approval,
      };
    }
    if (request.approval !== approval) {
      throw new WorkOSProviderErasureManagementError(
        "CONTROL_PLANE_WORKOS_ERASURE_APPROVAL does not match the current target-bound plan",
      );
    }

    for (const subject of request.subjects) {
      await client.query(
        `INSERT INTO workos_provider_erasure_fences (
           provider, subject_kind, hash_version, subject_hash,
           deletion_request_id, evidence_source
         ) VALUES ('workos', $1, 1, $2, $3, 'operator_reconciliation')
         ON CONFLICT (provider, subject_kind, hash_version, subject_hash)
         DO NOTHING`,
        [
          subject.kind,
          workOSProviderSubjectHash(subject),
          request.deletionRequestId,
        ],
      );
    }
    await client.query(
      `INSERT INTO workos_provider_erasure_reconciliations (
         deletion_request_id, disposition, evidence_source,
         evidence_reference
       ) VALUES ($1, $2, 'operator_reconciliation', $3)`,
      [
        request.deletionRequestId,
        request.disposition,
        request.evidenceReference,
      ],
    );
    await client.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action, metadata
       ) VALUES ($1, $2, 'purge.provider_erasure_reconciled', $3::jsonb)`,
      [
        request.deletionRequestId,
        request.actorUserId,
        JSON.stringify({
          provider: "workos",
          disposition: request.disposition,
          hashVersion: 1,
          workosSubjectHashes: request.subjectHashes,
          evidenceReference: request.evidenceReference,
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      state: "reconciled",
      deletionRequestId: request.deletionRequestId,
      disposition: request.disposition,
      subjectHashes: request.subjectHashes,
      targetFingerprint: request.targetFingerprint,
      approval: null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new WorkOSProviderErasureManagementError("DATABASE_URL is required");
  }
  // Execution holds a session-level provider lock while the database work uses
  // a separate connection.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    if (process.argv.includes("--status")) {
      const status = await inspectWorkOSProviderErasureReadiness(pool);
      console.log(`[workos-erasure] ${JSON.stringify(status)}`);
      return;
    }
    const request = validateWorkOSProviderErasureRequest({
      databaseUrl,
      channel: process.env.CONTROL_PLANE_WORKOS_ERASURE_CHANNEL,
      railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      execute: process.argv.includes("--execute"),
      productionConfirmed:
        process.env.CONTROL_PLANE_WORKOS_ERASURE_PRODUCTION_CONFIRMED,
      approval: process.env.CONTROL_PLANE_WORKOS_ERASURE_APPROVAL,
      deletionRequestId:
        process.env.CONTROL_PLANE_WORKOS_ERASURE_DELETION_REQUEST_ID,
      actorUserId: process.env.CONTROL_PLANE_WORKOS_ERASURE_ACTOR_USER_ID,
      disposition: process.env.CONTROL_PLANE_WORKOS_ERASURE_DISPOSITION,
      subjectsJson: process.env.CONTROL_PLANE_WORKOS_ERASURE_SUBJECTS_JSON,
      evidenceReference:
        process.env.CONTROL_PLANE_WORKOS_ERASURE_EVIDENCE_REFERENCE,
    });
    const result = await manageWorkOSProviderErasureEvidence(pool, request);
    console.log(
      `[workos-erasure] state=${result.state} channel=${request.channel} ` +
        `target=${result.targetFingerprint} request=${result.deletionRequestId} ` +
        `actor=${request.actorUserId} disposition=${result.disposition} ` +
        `subjectHashes=${result.subjectHashes.join(",") || "none"}`,
    );
    if (result.approval) {
      console.log(`[workos-erasure] approval=${result.approval}`);
    }
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runCli().catch((error) => {
    console.error(
      `[workos-erasure] failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  });
}
