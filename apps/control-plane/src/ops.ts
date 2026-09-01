import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { withSystemTx, type Tx } from "./db.js";
import {
  forceDeletionRequestPurgeByStaff,
  publicDeletionRequest,
  requiresFreshAuthentication,
  restoreDeletionRequestByStaff,
  SENSITIVE_ACTION_MAX_AGE_SECONDS,
  type DeletionRequestRow,
} from "./deletion-lifecycle.js";

export type OpsDeploymentChannel = "development" | "alpha" | "production";
type StaffOperationCapability =
  | "deletion.read"
  | "deletion.restore"
  | "deletion.force_purge";

const RecoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
const SupportCaseSchema = z
  .string()
  .trim()
  .min(6)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$/);
const OwnershipVerificationSchema = z.literal("confirmed_out_of_band");
const UuidSchema = z.string().uuid();
const LookupSchema = z.object({
  supportCaseReference: SupportCaseSchema,
  ownershipVerification: OwnershipVerificationSchema,
});
const GrantSchema = LookupSchema.extend({
  granteeUserId: UuidSchema,
  capability: z.enum([
    "deletion.read",
    "deletion.restore",
    "deletion.force_purge",
  ]),
  expiresInMinutes: z.number().int().min(5).max(60).default(15),
});
const ActionSchema = LookupSchema.extend({
  grantId: UuidSchema.optional(),
  confirmation: z.string().trim().max(64).optional(),
});

type OpsRequestRow = DeletionRequestRow & {
  target_user_id: string | null;
  target_organization_id: string | null;
};

type GrantRow = {
  id: string;
  capability: StaffOperationCapability;
  expires_at: Date;
  grantee_user_id: string;
  granted_by_user_id: string;
};

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(422, "invalid_input", "Invalid request body");
  }
  return result.data;
}

export function requireFreshOpsUser(user: AuthedUser): void {
  if (user.staffRole !== "platform_owner" && user.staffRole !== "developer") {
    throw new HttpError(404, "not_found", "Not found");
  }
  if (
    user.identity.provider !== "workos" ||
    requiresFreshAuthentication(user.authentication.authTime)
  ) {
    throw new HttpError(
      401,
      "reauthentication_required",
      "Sign in again before using Zeros Ops.",
      { maxAgeSeconds: SENSITIVE_ACTION_MAX_AGE_SECONDS },
    );
  }
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${"*".repeat(Math.min(6, Math.max(3, local.length - 1)))}${email.slice(at)}`;
}

function requestByCode(tx: Tx, code: string): Promise<OpsRequestRow | null> {
  return tx
    .query<OpsRequestRow>(
      `SELECT id, public_code, target_kind, target_id, state,
              requested_at, purge_after, target_user_id,
              target_organization_id
       FROM deletion_requests
       WHERE public_code = $1`,
      [code],
    )
    .then((result) => result.rows[0] ?? null);
}

async function activeGrant(
  tx: Tx,
  input: {
    requestId: string;
    granteeUserId: string;
    supportCaseReference: string;
    capability?: StaffOperationCapability;
    grantId?: string;
    channel: OpsDeploymentChannel;
  },
): Promise<GrantRow | null> {
  const result = await tx.query<GrantRow>(
    `SELECT id, capability, expires_at, grantee_user_id, granted_by_user_id
     FROM staff_operation_grants
     WHERE deletion_request_id = $1 AND grantee_user_id = $2
       AND support_case_reference = $3 AND deployment_channel = $4
       AND expires_at > now() AND revoked_at IS NULL AND used_at IS NULL
       AND ($5::staff_operation_capability IS NULL OR capability = $5)
       AND ($6::uuid IS NULL OR id = $6)
     ORDER BY expires_at, created_at, id
     LIMIT 1`,
    [
      input.requestId,
      input.granteeUserId,
      input.supportCaseReference,
      input.channel,
      input.capability ?? null,
      input.grantId ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function authorizeLookup(
  tx: Tx,
  input: {
    user: AuthedUser;
    requestId: string;
    supportCaseReference: string;
    channel: OpsDeploymentChannel;
  },
): Promise<void> {
  if (input.user.staffRole === "platform_owner") return;
  const grant = await activeGrant(tx, {
    requestId: input.requestId,
    granteeUserId: input.user.id,
    supportCaseReference: input.supportCaseReference,
    channel: input.channel,
  });
  if (!grant)
    throw new HttpError(404, "not_found", "Deletion request not found");
}

async function consumeGrant(
  pool: pg.Pool,
  input: {
    requestId: string;
    granteeUserId: string;
    supportCaseReference: string;
    capability: StaffOperationCapability;
    grantId: string | undefined;
    channel: OpsDeploymentChannel;
  },
): Promise<GrantRow> {
  return withSystemTx(pool, async (tx) => {
    // Consume the exact grant in the authorization transaction. If the
    // privileged state transition later fails, the one-shot approval remains
    // burned and the operator must obtain a fresh, auditable grant.
    const consumed = await tx.query<GrantRow>(
      `WITH selected AS (
         SELECT id
         FROM staff_operation_grants
         WHERE deletion_request_id = $1 AND grantee_user_id = $2
           AND support_case_reference = $3 AND deployment_channel = $4
           AND capability = $5 AND expires_at > now()
           AND revoked_at IS NULL AND used_at IS NULL
           AND ($6::uuid IS NULL OR id = $6)
         ORDER BY expires_at, created_at, id
         LIMIT 1
         FOR UPDATE
       )
       UPDATE staff_operation_grants target_grant
       SET used_at = now()
       FROM selected
       WHERE target_grant.id = selected.id AND target_grant.used_at IS NULL
       RETURNING target_grant.id, target_grant.capability,
                 target_grant.expires_at, target_grant.grantee_user_id,
                 target_grant.granted_by_user_id`,
      [
        input.requestId,
        input.granteeUserId,
        input.supportCaseReference,
        input.channel,
        input.capability,
        input.grantId ?? null,
      ],
    );
    const grant = consumed.rows[0];
    if (!grant) {
      throw new HttpError(
        403,
        "staff_grant_required",
        "An exact, unexpired owner approval is required.",
      );
    }
    await tx.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, actor_user_id, action,
         support_case_reference, metadata
       ) VALUES ($1, $2, 'staff.grant.consumed', $3, $4::jsonb)`,
      [
        input.requestId,
        input.granteeUserId,
        input.supportCaseReference,
        JSON.stringify({ grantId: grant.id, capability: grant.capability }),
      ],
    );
    return grant;
  });
}

async function targetSummary(tx: Tx, request: OpsRequestRow) {
  if (request.target_kind === "account") {
    const account = request.target_user_id
      ? await tx.query<{
          email: string;
          auth_status: string;
        }>(`SELECT email, auth_status FROM users WHERE id = $1`, [
          request.target_user_id,
        ])
      : null;
    return {
      kind: "account" as const,
      maskedEmail: account?.rows[0] ? maskEmail(account.rows[0].email) : null,
      accountStatus: account?.rows[0]?.auth_status ?? "purged",
      businessOrganization: false,
    };
  }
  const organization = request.target_organization_id
    ? await tx.query<{
        name: string;
        lifecycle_status: string;
        member_count: string | number;
      }>(
        `SELECT o.name, o.lifecycle_status, count(om.user_id)::integer AS member_count
         FROM organizations o
         LEFT JOIN organization_members om ON om.org_id = o.id
         WHERE o.id = $1
         GROUP BY o.id`,
        [request.target_organization_id],
      )
    : null;
  const row = organization?.rows[0];
  return {
    kind: "organization" as const,
    name: row?.name ?? null,
    lifecycleStatus: row?.lifecycle_status ?? "purged",
    memberCount: row ? Number(row.member_count) : 0,
    businessOrganization: row ? Number(row.member_count) > 1 : false,
  };
}

/** Isolated operator API: exact-code lookups only, no customer directory and
 * no email search. Cloudflare supplies a separate Ops host; this server remains
 * the final authority for role, reauthentication, grants, and audit evidence. */
export function createOpsRoutes(
  pool: pg.Pool,
  channel: OpsDeploymentChannel,
): Hono {
  const app = new Hono();

  app.use("/v1/ops/*", async (c, next) => {
    requireFreshOpsUser(c.get("user"));
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    await next();
  });

  app.get("/v1/ops/session", async (c) => {
    const user = c.get("user") as AuthedUser;
    const developers =
      user.staffRole === "platform_owner"
        ? await withSystemTx(pool, (tx) =>
            tx.query<{
              id: string;
              display_name: string | null;
              email: string;
            }>(
              `SELECT id, display_name, email
               FROM users
               WHERE staff_role = 'developer' AND auth_status = 'active'
                 AND deleted_at IS NULL
               ORDER BY lower(email), id`,
            ),
          )
        : null;
    return c.json({
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        role: user.staffRole,
      },
      deploymentChannel: channel,
      developers:
        developers?.rows.map((developer) => ({
          id: developer.id,
          displayName: developer.display_name,
          email: developer.email,
        })) ?? [],
    });
  });

  app.post("/v1/ops/deletions/:code/lookup", async (c) => {
    const user = c.get("user") as AuthedUser;
    const code = RecoveryCodeSchema.safeParse(c.req.param("code"));
    if (!code.success) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    const body = parsed(LookupSchema, await c.req.json().catch(() => ({})));
    const result = await withSystemTx(pool, async (tx) => {
      const request = await requestByCode(tx, code.data);
      if (!request) {
        throw new HttpError(404, "not_found", "Deletion request not found");
      }
      await authorizeLookup(tx, {
        user,
        requestId: request.id,
        supportCaseReference: body.supportCaseReference,
        channel,
      });
      const target = await targetSummary(tx, request);
      await tx.query(
        `INSERT INTO deletion_request_events (
           deletion_request_id, actor_user_id, action,
           support_case_reference, metadata
         ) VALUES ($1, $2, 'staff.lookup', $3, $4::jsonb)`,
        [
          request.id,
          user.id,
          body.supportCaseReference,
          JSON.stringify({ ownershipVerification: true }),
        ],
      );
      const grants =
        user.staffRole === "platform_owner"
          ? await tx.query<{
              id: string;
              capability: StaffOperationCapability;
              grantee_user_id: string;
              expires_at: Date;
              used_at: Date | null;
              revoked_at: Date | null;
            }>(
              `SELECT id, capability, grantee_user_id, expires_at,
                      used_at, revoked_at
               FROM staff_operation_grants
               WHERE deletion_request_id = $1
                 AND support_case_reference = $2
               ORDER BY created_at DESC, id`,
              [request.id, body.supportCaseReference],
            )
          : null;
      return { request, target, grants: grants?.rows ?? [] };
    });
    return c.json({
      deletion: publicDeletionRequest(result.request),
      target: result.target,
      grants: result.grants.map((grant) => ({
        id: grant.id,
        capability: grant.capability,
        granteeUserId: grant.grantee_user_id,
        expiresAt: grant.expires_at.toISOString(),
        used: grant.used_at !== null,
        revoked: grant.revoked_at !== null,
      })),
    });
  });

  app.post("/v1/ops/deletions/:code/grants", async (c) => {
    const user = c.get("user") as AuthedUser;
    if (user.staffRole !== "platform_owner") {
      throw new HttpError(404, "not_found", "Not found");
    }
    const code = RecoveryCodeSchema.safeParse(c.req.param("code"));
    if (!code.success) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    const body = parsed(GrantSchema, await c.req.json().catch(() => ({})));
    const created = await withSystemTx(pool, async (tx) => {
      const request = await requestByCode(tx, code.data);
      if (!request || request.state !== "scheduled") {
        throw new HttpError(404, "not_found", "Deletion request not found");
      }
      const grantee = await tx.query(
        `SELECT 1 FROM users
         WHERE id = $1 AND staff_role = 'developer'
           AND auth_status = 'active' AND deleted_at IS NULL`,
        [body.granteeUserId],
      );
      if (!grantee.rows[0] || body.granteeUserId === user.id) {
        throw new HttpError(
          422,
          "invalid_grantee",
          "Select an active developer.",
        );
      }
      const grant = await tx.query<GrantRow>(
        `INSERT INTO staff_operation_grants (
           deletion_request_id, grantee_user_id, granted_by_user_id,
           capability, support_case_reference, deployment_channel, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           now() + ($7::integer * interval '1 minute')
         )
         RETURNING id, capability, expires_at, grantee_user_id,
                   granted_by_user_id`,
        [
          request.id,
          body.granteeUserId,
          user.id,
          body.capability,
          body.supportCaseReference,
          channel,
          body.expiresInMinutes,
        ],
      );
      await tx.query(
        `INSERT INTO deletion_request_events (
           deletion_request_id, actor_user_id, action,
           support_case_reference, metadata
         ) VALUES ($1, $2, 'staff.grant.created', $3, $4::jsonb)`,
        [
          request.id,
          user.id,
          body.supportCaseReference,
          JSON.stringify({
            grantId: grant.rows[0]!.id,
            granteeUserId: body.granteeUserId,
            capability: body.capability,
            ownershipVerification: true,
          }),
        ],
      );
      return grant.rows[0]!;
    });
    return c.json(
      {
        grant: {
          id: created.id,
          capability: created.capability,
          granteeUserId: created.grantee_user_id,
          expiresAt: created.expires_at.toISOString(),
        },
      },
      201,
    );
  });

  app.post("/v1/ops/deletions/:code/restore", async (c) => {
    const user = c.get("user") as AuthedUser;
    const code = RecoveryCodeSchema.safeParse(c.req.param("code"));
    if (!code.success) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    const body = parsed(ActionSchema, await c.req.json().catch(() => ({})));
    const found = await withSystemTx(pool, async (tx) => {
      const request = await requestByCode(tx, code.data);
      if (!request) {
        throw new HttpError(404, "not_found", "Deletion request not found");
      }
      const target = await targetSummary(tx, request);
      return { request, target };
    });

    const twoPersonRequired = found.target.businessOrganization === true;
    if (user.staffRole === "developer") {
      await consumeGrant(pool, {
        requestId: found.request.id,
        granteeUserId: user.id,
        supportCaseReference: body.supportCaseReference,
        capability: "deletion.restore",
        grantId: body.grantId,
        channel,
      });
    } else if (twoPersonRequired) {
      throw new HttpError(
        409,
        "two_person_approval_required",
        "A developer must execute Business organization recovery using an owner grant.",
      );
    }

    const restored = await restoreDeletionRequestByStaff(pool, {
      requestId: found.request.id,
      operatorUserId: user.id,
      supportCaseReference: body.supportCaseReference,
    });
    return c.json({ deletion: publicDeletionRequest(restored) });
  });

  app.post("/v1/ops/deletions/:code/force-purge", async (c) => {
    const user = c.get("user") as AuthedUser;
    const code = RecoveryCodeSchema.safeParse(c.req.param("code"));
    if (!code.success) {
      throw new HttpError(404, "not_found", "Deletion request not found");
    }
    const body = parsed(ActionSchema, await c.req.json().catch(() => ({})));
    if (body.confirmation !== `FORCE PURGE ${code.data}`) {
      throw new HttpError(
        422,
        "confirmation_mismatch",
        "Enter the exact force-purge confirmation.",
      );
    }
    if (user.staffRole !== "developer") {
      throw new HttpError(
        409,
        "two_person_approval_required",
        "A developer must execute forced purge using an owner grant.",
      );
    }
    const request = await withSystemTx(pool, async (tx) => {
      const result = await requestByCode(tx, code.data);
      if (!result) {
        throw new HttpError(404, "not_found", "Deletion request not found");
      }
      return result;
    });
    await consumeGrant(pool, {
      requestId: request.id,
      granteeUserId: user.id,
      supportCaseReference: body.supportCaseReference,
      capability: "deletion.force_purge",
      grantId: body.grantId,
      channel,
    });
    const purging = await forceDeletionRequestPurgeByStaff(pool, {
      requestId: request.id,
      operatorUserId: user.id,
      supportCaseReference: body.supportCaseReference,
    });
    return c.json({ deletion: publicDeletionRequest(purging) }, 202);
  });

  return app;
}
