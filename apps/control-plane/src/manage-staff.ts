// Guarded database-owner utility for granting and revoking product-wide staff
// roles. The default mode is read-only. Execution is bound to one database,
// deployment channel, subject, actor, current role, next role, and audit reason.
// The application role has no UPDATE privilege on users.staff_role and no
// access to staff_role_changes, so this cannot become a remote self-promotion
// path.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { z } from "zod";

import type { StaffRole } from "./authz.js";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const StaffRoleInputSchema = z.enum(["developer", "support_admin", "none"]);
const UserIdSchema = z.string().uuid();
const EmailSchema = z.string().trim().email().max(320);
const ReasonSchema = z.string().trim().min(16).max(512);

export interface StaffRoleRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  subjectUserId: string | undefined;
  expectedEmail: string | undefined;
  actorUserId: string | undefined;
  nextRole: string | undefined;
  reason: string | undefined;
}

export interface ValidatedStaffRoleRequest {
  databaseUrl: string;
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  subjectUserId: string;
  expectedEmail: string;
  actorUserId: string;
  nextRole: StaffRole | null;
  reason: string;
  targetFingerprint: string;
}

export interface StaffRoleChangeResult {
  state: "planned" | "changed" | "unchanged";
  subjectUserId: string;
  actorUserId: string;
  previousRole: StaffRole | null;
  nextRole: StaffRole | null;
  targetFingerprint: string;
  approval: string | null;
  accountRevision: number;
}

export class StaffManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffManagementError";
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new StaffManagementError(
      "Invalid staff configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new StaffManagementError(
      "Invalid staff configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

function targetFingerprint(databaseUrl: string, channel: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  const target = [
    "zeros-control-plane-staff.v1",
    channel,
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    parsed.pathname,
  ].join("\0");
  return createHash("sha256").update(target, "utf8").digest("hex").slice(0, 16);
}

function roleLabel(role: StaffRole | null): string {
  return role ?? "none";
}

function reasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 12);
}

export function validateStaffRoleRequest(
  input: StaffRoleRequestInput,
): ValidatedStaffRoleRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_CHANNEL must be development, alpha, beta, or production",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new StaffManagementError(
      "Staff channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }
  if (
    input.execute &&
    channel === "production" &&
    input.productionConfirmed !== "true"
  ) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_PRODUCTION_CONFIRMED=true is required for production confirmation",
    );
  }

  const subjectUserId = UserIdSchema.safeParse(input.subjectUserId);
  const actorUserId = UserIdSchema.safeParse(input.actorUserId);
  const expectedEmail = EmailSchema.safeParse(input.expectedEmail);
  const nextRole = StaffRoleInputSchema.safeParse(input.nextRole);
  const reason = ReasonSchema.safeParse(input.reason);
  if (!subjectUserId.success) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_SUBJECT_USER_ID must be one exact UUID",
    );
  }
  if (!actorUserId.success) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_ACTOR_USER_ID must be one exact UUID",
    );
  }
  if (!expectedEmail.success) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_EXPECTED_EMAIL must be one valid email address",
    );
  }
  if (!nextRole.success) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_ROLE must be developer, support_admin, or none",
    );
  }
  if (!reason.success) {
    throw new StaffManagementError(
      "CONTROL_PLANE_STAFF_REASON must contain 16 to 512 characters",
    );
  }

  return {
    databaseUrl: input.databaseUrl,
    channel: channel as ValidatedStaffRoleRequest["channel"],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    subjectUserId: subjectUserId.data,
    expectedEmail: expectedEmail.data.toLowerCase(),
    actorUserId: actorUserId.data,
    nextRole: nextRole.data === "none" ? null : nextRole.data,
    reason: reason.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel),
  };
}

export function staffRoleApprovalText(
  request: ValidatedStaffRoleRequest,
  previousRole: StaffRole | null,
): string {
  return [
    "staff",
    request.channel,
    request.targetFingerprint,
    request.subjectUserId,
    request.actorUserId,
    roleLabel(previousRole),
    roleLabel(request.nextRole),
    reasonFingerprint(request.reason),
  ].join(":");
}

export async function manageStaffRole(
  pool: pg.Pool,
  request: ValidatedStaffRoleRequest,
): Promise<StaffRoleChangeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const privilege = await client.query<{
      principal: string;
      owns_users: boolean;
      owns_audit: boolean;
      can_update_staff: boolean;
      can_write_audit: boolean;
    }>(
      `SELECT current_user AS principal,
              pg_get_userbyid(users_table.relowner) = current_user AS owns_users,
              pg_get_userbyid(audit_table.relowner) = current_user AS owns_audit,
              has_column_privilege(
                current_user, 'public.users', 'staff_role', 'UPDATE'
              ) AS can_update_staff,
              has_table_privilege(
                current_user, 'public.staff_role_changes', 'INSERT'
              ) AS can_write_audit
       FROM pg_class users_table
       CROSS JOIN pg_class audit_table
       WHERE users_table.oid = 'public.users'::regclass
         AND audit_table.oid = 'public.staff_role_changes'::regclass`,
    );
    const owner = privilege.rows[0];
    if (
      !owner ||
      owner.principal === "zeros_app" ||
      !owner.owns_users ||
      !owner.owns_audit ||
      !owner.can_update_staff ||
      !owner.can_write_audit
    ) {
      throw new StaffManagementError(
        "Staff changes require the database/migration owner; the application role is refused",
      );
    }

    const users = await client.query<{
      id: string;
      email: string;
      staff_role: StaffRole | null;
      auth_status: string;
      auth_revision: string | number;
    }>(
      `SELECT id, email, staff_role, auth_status, auth_revision
       FROM users
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [[request.subjectUserId, request.actorUserId]],
    );
    const subject = users.rows.find((row) => row.id === request.subjectUserId);
    const actor = users.rows.find((row) => row.id === request.actorUserId);
    if (!subject) {
      throw new StaffManagementError("Staff subject user was not found");
    }
    if (!actor || actor.auth_status !== "active") {
      throw new StaffManagementError(
        "Staff actor must be one active Zeros user",
      );
    }
    if (subject.email.toLowerCase() !== request.expectedEmail) {
      throw new StaffManagementError(
        "Staff subject UUID does not match CONTROL_PLANE_STAFF_EXPECTED_EMAIL",
      );
    }
    if (request.nextRole !== null && subject.auth_status !== "active") {
      throw new StaffManagementError(
        "Staff authority can be granted only to an active Zeros user",
      );
    }

    const previousRole = subject.staff_role;
    const approval = staffRoleApprovalText(request, previousRole);
    const accountRevision = Number(subject.auth_revision);
    if (previousRole === request.nextRole) {
      if (request.execute) {
        throw new StaffManagementError(
          "Staff role is already at the requested value; generate a fresh plan",
        );
      }
      await client.query("ROLLBACK");
      return {
        state: "unchanged",
        subjectUserId: subject.id,
        actorUserId: actor.id,
        previousRole,
        nextRole: request.nextRole,
        targetFingerprint: request.targetFingerprint,
        approval: null,
        accountRevision,
      };
    }

    if (!request.execute) {
      await client.query("ROLLBACK");
      return {
        state: "planned",
        subjectUserId: subject.id,
        actorUserId: actor.id,
        previousRole,
        nextRole: request.nextRole,
        targetFingerprint: request.targetFingerprint,
        approval,
        accountRevision,
      };
    }
    if (request.approval !== approval) {
      throw new StaffManagementError(
        "CONTROL_PLANE_STAFF_APPROVAL does not match the current target-bound plan",
      );
    }

    const updated = await client.query<{ auth_revision: string | number }>(
      `UPDATE users
       SET staff_role = $2::staff_role,
           auth_revision = auth_revision + 1
       WHERE id = $1
       RETURNING auth_revision`,
      [subject.id, request.nextRole],
    );
    const nextRevision = Number(updated.rows[0]!.auth_revision);
    await client.query(
      `INSERT INTO staff_role_changes (
         subject_user_id, actor_user_id, previous_role, next_role,
         account_revision, deployment_channel, target_fingerprint,
         database_principal, reason
       ) VALUES ($1, $2, $3::staff_role, $4::staff_role, $5, $6, $7, $8, $9)`,
      [
        subject.id,
        actor.id,
        previousRole,
        request.nextRole,
        nextRevision,
        request.channel,
        request.targetFingerprint,
        owner.principal,
        request.reason,
      ],
    );
    await client.query(
      `INSERT INTO security_events (
         kind, user_id, account_revision, payload
       ) VALUES (
         'account.authorization_changed', $1, $2,
         jsonb_build_object(
           'reason', 'staff_role_changed',
           'previous_role', $3::text,
           'next_role', $4::text
         )
       )`,
      [subject.id, nextRevision, previousRole, request.nextRole],
    );
    await client.query("COMMIT");
    return {
      state: "changed",
      subjectUserId: subject.id,
      actorUserId: actor.id,
      previousRole,
      nextRole: request.nextRole,
      targetFingerprint: request.targetFingerprint,
      approval: null,
      accountRevision: nextRevision,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new StaffManagementError("DATABASE_URL is required");
  }
  const request = validateStaffRoleRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_STAFF_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed: process.env.CONTROL_PLANE_STAFF_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_STAFF_APPROVAL,
    subjectUserId: process.env.CONTROL_PLANE_STAFF_SUBJECT_USER_ID,
    expectedEmail: process.env.CONTROL_PLANE_STAFF_EXPECTED_EMAIL,
    actorUserId: process.env.CONTROL_PLANE_STAFF_ACTOR_USER_ID,
    nextRole: process.env.CONTROL_PLANE_STAFF_ROLE,
    reason: process.env.CONTROL_PLANE_STAFF_REASON,
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await manageStaffRole(pool, request);
    console.log(
      `[staff] state=${result.state} channel=${request.channel} ` +
        `target=${result.targetFingerprint} subject=${result.subjectUserId} ` +
        `actor=${result.actorUserId} previous=${roleLabel(result.previousRole)} ` +
        `next=${roleLabel(result.nextRole)} revision=${result.accountRevision}`,
    );
    if (result.approval) {
      console.log(`[staff] approval=${result.approval}`);
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
      `[staff] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
