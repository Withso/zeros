import { createHash, timingSafeEqual } from "node:crypto";

import type pg from "pg";

import { withSystemTx } from "../db.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,512}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,6})?$/;

export const CLOUD_WORKSPACE_USAGE_METERS = [
  "cpu_millisecond",
  "memory_mib_millisecond",
  "storage_mib_hour",
  "egress_byte",
  "agent_input_token",
  "agent_output_token",
  "agent_cached_token",
  "agent_invocation",
] as const;

export type CloudWorkspaceUsageMeter =
  (typeof CLOUD_WORKSPACE_USAGE_METERS)[number];

export class CloudWorkspaceUsageError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "engine_authority_rejected"
      | "idempotency_conflict"
      | "billing_authority_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CloudWorkspaceUsageError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function normalizeQuantity(value: string | number): string {
  const raw = typeof value === "number" ? String(value) : value;
  if (!DECIMAL_PATTERN.test(raw)) {
    throw new CloudWorkspaceUsageError(
      "invalid_input",
      "Usage quantity is invalid",
    );
  }
  const [integer, fraction = ""] = raw.split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return trimmed.length > 0 ? `${integer}.${trimmed}` : integer!;
}

function validateMetadata(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CloudWorkspaceUsageError(
      "invalid_input",
      "Usage metadata is invalid",
    );
  }
  const seen = new Set<object>();
  let nodes = 0;
  const inspect = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (depth > 16 || nodes > 2_000) {
      throw new CloudWorkspaceUsageError(
        "invalid_input",
        "Usage metadata is too complex",
      );
    }
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return;
    }
    if (!entry || typeof entry !== "object") {
      throw new CloudWorkspaceUsageError(
        "invalid_input",
        "Usage metadata contains an unsupported value",
      );
    }
    if (seen.has(entry)) {
      throw new CloudWorkspaceUsageError(
        "invalid_input",
        "Usage metadata cannot contain cycles",
      );
    }
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (entry.length > 512) {
          throw new CloudWorkspaceUsageError(
            "invalid_input",
            "Usage metadata array is too large",
          );
        }
        for (const item of entry) inspect(item, depth + 1);
        return;
      }
      if (Object.getPrototypeOf(entry) !== Object.prototype) {
        throw new CloudWorkspaceUsageError(
          "invalid_input",
          "Usage metadata contains an unsupported object",
        );
      }
      const entries = Object.entries(entry as Record<string, unknown>);
      if (entries.length > 256) {
        throw new CloudWorkspaceUsageError(
          "invalid_input",
          "Usage metadata object is too large",
        );
      }
      for (const [key, item] of entries) {
        if (
          key.length < 1 ||
          key.length > 128 ||
          /[\u0000-\u001f\u007f]/u.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        ) {
          throw new CloudWorkspaceUsageError(
            "invalid_input",
            "Usage metadata key is invalid",
          );
        }
        inspect(item, depth + 1);
      }
    } finally {
      seen.delete(entry);
    }
  };
  inspect(value, 0);
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") > 8_000) {
    throw new CloudWorkspaceUsageError(
      "invalid_input",
      "Usage metadata is too large",
    );
  }
  return value as Record<string, unknown>;
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class DatabaseCloudWorkspaceUsageService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workosEnabled: boolean,
  ) {}

  async ingestEngine(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    meter: CloudWorkspaceUsageMeter;
    quantity: string | number;
    sourceIdempotencyKey: string;
    occurredAt: string;
    metadata: Record<string, unknown>;
  }): Promise<{
    usageEventId: string;
    billingOwnerUserId: string;
    billingEpoch: number;
    replayed: boolean;
  }> {
    if (
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.engineInstanceId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !CLOUD_WORKSPACE_USAGE_METERS.includes(input.meter) ||
      !SOURCE_KEY_PATTERN.test(input.sourceIdempotencyKey)
    ) {
      throw new CloudWorkspaceUsageError("invalid_input", "Usage input is invalid");
    }
    const quantity = normalizeQuantity(input.quantity);
    const metadata = validateMetadata(input.metadata);
    const occurredAt = new Date(input.occurredAt);
    const now = Date.now();
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getTime() > now + 5 * 60_000 ||
      occurredAt.getTime() < now - 31 * 24 * 60 * 60_000
    ) {
      throw new CloudWorkspaceUsageError(
        "invalid_input",
        "Usage occurrence time is invalid",
      );
    }
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          meter: input.meter,
          quantity,
          sourceIdempotencyKey: input.sourceIdempotencyKey,
          occurredAt: occurredAt.toISOString(),
          metadata,
        }),
      )
      .digest();

    try {
      return await withSystemTx(this.pool, async (tx) => {
        const authority = await assertCurrentCloudEngineAuthority(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          heartbeatToken: input.heartbeatToken,
          workosEnabled: this.workosEnabled,
        });
        const scope = (
          await tx.query<{
            billing_epoch: string | number;
            billing_owner_user_id: string;
            provider: string;
            provider_connection_id: string;
            provider_connection_version: string | number;
          }>(
            `SELECT billing.billing_epoch,
                    billing.billing_owner_user_id, generation.provider,
                    generation.provider_connection_id,
                    generation.provider_connection_version
             FROM cloud_workspaces workspace
             JOIN cloud_workspace_generations generation
               ON generation.workspace_id = workspace.id
              AND generation.org_id = workspace.org_id
              AND generation.generation = $3
             JOIN workspace_billing_epochs billing
               ON billing.workspace_id = workspace.id
              AND billing.org_id = workspace.org_id
              AND billing.started_at <= $4
              AND (billing.ended_at IS NULL OR $4 < billing.ended_at)
             WHERE workspace.id = $1 AND workspace.org_id = $2
             ORDER BY billing.started_at DESC, billing.billing_epoch DESC
             LIMIT 1
             FOR SHARE OF generation, billing`,
            [
              input.workspaceId,
              input.organizationId,
              input.generation,
              occurredAt,
            ],
          )
        ).rows[0];
        const billingEpoch = Number(scope?.billing_epoch);
        if (
          !scope ||
          !Number.isSafeInteger(billingEpoch) ||
          billingEpoch < 1 ||
          scope.billing_owner_user_id !== authority.accountUserId
        ) {
          throw new CloudWorkspaceUsageError(
            "billing_authority_unavailable",
            "Current billing authority is unavailable",
          );
        }
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO cloud_workspace_usage_events (
             org_id, workspace_id, generation, authority_epoch, actor_user_id,
             billing_owner_user_id, billing_epoch, provider,
             provider_connection_id, provider_connection_version, meter,
             quantity, source_idempotency_key, request_sha256, occurred_at,
             metadata
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::numeric, $13, $14, $15, $16::jsonb
           )
           ON CONFLICT (
             provider_connection_id, provider_connection_version,
             source_idempotency_key
           ) DO NOTHING
           RETURNING id`,
          [
            input.organizationId,
            input.workspaceId,
            input.generation,
            authority.authorityEpoch,
            authority.accountUserId,
            scope.billing_owner_user_id,
            billingEpoch,
            scope.provider,
            scope.provider_connection_id,
            Number(scope.provider_connection_version),
            input.meter,
            quantity,
            input.sourceIdempotencyKey,
            digest,
            occurredAt,
            canonicalJson(metadata),
          ],
        );
        if (inserted.rows[0]) {
          return {
            usageEventId: inserted.rows[0].id,
            billingOwnerUserId: scope.billing_owner_user_id,
            billingEpoch,
            replayed: false,
          };
        }
        const prior = (
          await tx.query<{
            id: string;
            workspace_id: string;
            request_sha256: Buffer;
            billing_owner_user_id: string;
            billing_epoch: string | number;
          }>(
            `SELECT id, workspace_id, request_sha256,
                    billing_owner_user_id, billing_epoch
             FROM cloud_workspace_usage_events
             WHERE provider_connection_id = $1
               AND provider_connection_version = $2
               AND source_idempotency_key = $3`,
            [
              scope.provider_connection_id,
              Number(scope.provider_connection_version),
              input.sourceIdempotencyKey,
            ],
          )
        ).rows[0];
        if (
          !prior ||
          prior.workspace_id !== input.workspaceId ||
          !sameHash(prior.request_sha256, digest)
        ) {
          throw new CloudWorkspaceUsageError(
            "idempotency_conflict",
            "Usage idempotency key was reused",
          );
        }
        return {
          usageEventId: prior.id,
          billingOwnerUserId: prior.billing_owner_user_id,
          billingEpoch: Number(prior.billing_epoch),
          replayed: true,
        };
      });
    } catch (error) {
      if (error instanceof CloudWorkspaceUsageError) throw error;
      if (
        error instanceof Error &&
        error.name === "CloudWorkspaceEngineAuthorityError"
      ) {
        throw new CloudWorkspaceUsageError(
          "engine_authority_rejected",
          "Usage authority is not current",
        );
      }
      throw error;
    }
  }
}
