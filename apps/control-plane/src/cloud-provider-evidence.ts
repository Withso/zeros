// Evidence rules shared by the guarded Boat provider operators
// (cloud-provider-absence:manage and cloud-provider-loss:manage): request
// validation, the database-owner transaction preamble, and the proof that an
// account inventory belongs to, and completely lists, the journal's account.

import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

import { BOAT_RESOURCE_ID_PATTERN, type BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { parseDatabaseTarget } from "./database-target.js";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const MAX_INVENTORY_PAGES = 100;
/** Provider evidence must be fresh by the database clock when it is attested. */
const MAX_INVENTORY_AGE_MS = 15 * 60_000;

export type ProviderInventory = {
  /** Database clock read before the first page was requested. */
  observedAt: Date;
  /** The provider account the listing belongs to. */
  providerAccount: string;
  /** A deletion receipt from this account scope's journal, read back with the
   * same key: proof the listing's account owns the scope's history. */
  accountProof: { deletionOperationId: string; targetId: string } | null;
  resources: Array<{ id: string; state: string }>;
};

export class CloudProviderEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudProviderEvidenceError";
  }
}

function fail(message: string): never {
  throw new CloudProviderEvidenceError(message);
}

/** One operator: its environment prefix, audit noun and attestation table. */
export type ProviderOperator = {
  env: "ABSENCE" | "LOSS";
  noun: "absence" | "loss";
  table: "cloud_workspace_provider_absence_attestations" | "cloud_workspace_provider_loss_attestations";
};

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest();
export const reasonDigest = (reason: string) => createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 12);

/** Binds an operator approval to one database target and channel. */
function targetFingerprint(databaseUrl: string, channel: string, operator: Pick<ProviderOperator, "noun">): string {
  let parsed: URL;
  try {
    parsed = parseDatabaseTarget(databaseUrl);
  } catch {
    fail("Invalid configuration: DATABASE_URL must be a PostgreSQL URL");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || parsed.pathname === "/")
    fail("Invalid configuration: DATABASE_URL must identify one PostgreSQL database");
  const target = [
    `zeros-control-plane-provider-${operator.noun}.v1`,
    channel,
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    parsed.pathname,
    decodeURIComponent(parsed.username),
  ].join("\0");
  return createHash("sha256").update(target, "utf8").digest("hex").slice(0, 16);
}

export interface ProviderOperatorRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  organizationId: string | undefined;
  expectedOrganizationSlug: string | undefined;
  actorUserId: string | undefined;
  workspaceId: string | undefined;
  accountScope: string | undefined;
  expectedProviderAccount: string | undefined;
  reason: string | undefined;
}

export interface ProviderOperatorRequest {
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  workspaceId: string;
  accountScope: string;
  expectedProviderAccount: string;
  reason: string;
  targetFingerprint: string;
}

/** The target, attribution and audit fields every provider operator binds. */
export function validateProviderOperatorRequest(
  input: ProviderOperatorRequestInput, operator: ProviderOperator,
): ProviderOperatorRequest {
  const env = `CONTROL_PLANE_PROVIDER_${operator.env}`;
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number]))
    fail(`${env}_CHANNEL must be development, alpha, beta, or production`);
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel)
    fail(`Provider ${operator.noun} channel does not match RAILWAY_ENVIRONMENT_NAME`);
  if (input.execute && channel === "production" && input.productionConfirmed !== "true")
    fail(`${env}_PRODUCTION_CONFIRMED=true is required for production`);
  const uuid = z.string().uuid();
  const organizationId = uuid.safeParse(input.organizationId);
  const actorUserId = uuid.safeParse(input.actorUserId);
  const workspaceId = uuid.safeParse(input.workspaceId);
  if (!organizationId.success) fail(`${env}_ORGANIZATION_ID must be one exact UUID`);
  if (!actorUserId.success) fail(`${env}_ACTOR_USER_ID must be one exact UUID`);
  if (!workspaceId.success) fail(`${env}_WORKSPACE_ID must be one exact UUID`);
  const slug = z.string().trim().min(1).max(255).safeParse(input.expectedOrganizationSlug);
  if (!slug.success) fail(`${env}_EXPECTED_ORGANIZATION_SLUG is required`);
  const accountScope = input.accountScope?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(accountScope)) fail("BOAT_ACCOUNT_SCOPE must be the stable provider account scope");
  const expectedProviderAccount = input.expectedProviderAccount?.trim() ?? "";
  if (!/^[A-Za-z0-9._@:+-]{1,256}$/.test(expectedProviderAccount))
    fail(`${env}_EXPECTED_ACCOUNT must name the Boat account that owns this scope`);
  const reason = z.string().trim().min(16).max(512).safeParse(input.reason);
  if (!reason.success) fail(`${env}_REASON must contain 16 to 512 characters`);
  return {
    channel: channel as (typeof CHANNELS)[number],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data,
    expectedOrganizationSlug: slug.data.toLowerCase(),
    actorUserId: actorUserId.data,
    workspaceId: workspaceId.data,
    accountScope,
    expectedProviderAccount,
    reason: reason.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel, operator),
  };
}

/** Evidence that can be checked before any database access. */
export function assertInventoryShape(inventory: ProviderInventory, request: ProviderOperatorRequest, operator: ProviderOperator): void {
  if (inventory.resources.some((resource) => !BOAT_RESOURCE_ID_PATTERN.test(resource.id)))
    fail("Provider inventory contains an unrecognized resource identifier");
  if (inventory.providerAccount !== request.expectedProviderAccount)
    fail(`Provider inventory belongs to a different account than CONTROL_PLANE_PROVIDER_${operator.env}_EXPECTED_ACCOUNT`);
}

/** Opens the operator's transaction as the database owner, checks evidence
 * freshness and attribution, and locks the Organization, workspace and
 * generations in the journal store's parent-before-journal order. */
export async function beginProviderAttestation(
  client: pg.PoolClient,
  input: { operator: ProviderOperator; request: ProviderOperatorRequest; generations: number[]; observedAt: Date[] },
): Promise<void> {
  const { operator, request } = input;
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SELECT set_config('app.system', 'on', true)");
  const table = `public.${operator.table}`;
  const owner = (await client.query<{ principal: string; owns: boolean; can_insert: boolean; now: Date }>(
    `SELECT current_user AS principal, clock_timestamp() AS now,
            pg_get_userbyid(relowner) = current_user AS owns,
            has_table_privilege(current_user, $1, 'INSERT') AS can_insert
     FROM pg_class WHERE oid = $1::regclass`, [table],
  )).rows[0];
  if (!owner || owner.principal === "zeros_app" || !owner.owns || !owner.can_insert)
    fail(`Provider ${operator.noun} attestations require the database/migration owner; the application role is refused`);
  for (const observedAt of input.observedAt) {
    const age = owner.now.getTime() - observedAt.getTime();
    if (age < 0 || age > MAX_INVENTORY_AGE_MS)
      fail("Provider evidence must be observed by the database clock within the last 15 minutes");
  }
  const actor = (await client.query<{ auth_status: string; deleted_at: Date | null; staff_role: string | null }>(
    "SELECT auth_status, deleted_at, staff_role FROM users WHERE id = $1", [request.actorUserId],
  )).rows[0];
  if (!actor || actor.auth_status !== "active" || actor.deleted_at !== null || actor.staff_role !== "platform_owner")
    fail(`Provider ${operator.noun} actor must be one active Zeros platform owner`);
  const organization = (await client.query<{ slug: string }>(
    "SELECT slug::text FROM organizations WHERE id = $1 FOR SHARE", [request.organizationId],
  )).rows[0];
  if (!organization || organization.slug.toLowerCase() !== request.expectedOrganizationSlug)
    fail(`Provider ${operator.noun} Organization does not match the expected slug`);
  const workspace = await client.query("SELECT 1 FROM cloud_workspaces WHERE id = $1 AND org_id = $2 FOR SHARE", [request.workspaceId, request.organizationId]);
  if (!workspace.rowCount) fail(`Provider ${operator.noun} workspace is not in the Organization`);
  await client.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id = $1 AND generation = ANY($2::integer[]) FOR SHARE",
    [request.workspaceId, input.generations]);
}

/** The listing's key must belong to the account that holds this scope's
 * history: it must have read back one of the scope's deletion receipts. */
export async function assertInventoryAccount(
  client: pg.PoolClient, accountScope: string, inventory: ProviderInventory,
): Promise<void> {
  const receipts = (await client.query<{ proven: boolean; any_receipt: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM cloud_workspace_provider_operations WHERE provider = 'boat' AND account_scope = $1
                      AND deletion_operation_id = $2 AND resource_id = $3) AS proven,
            EXISTS (SELECT 1 FROM cloud_workspace_provider_operations WHERE provider = 'boat' AND account_scope = $1
                      AND deletion_operation_id IS NOT NULL) AS any_receipt`,
    [accountScope, inventory.accountProof?.deletionOperationId ?? null, inventory.accountProof?.targetId ?? null],
  )).rows[0]!;
  if (receipts.any_receipt && !receipts.proven)
    fail("Provider inventory cannot be proven to belong to this account scope: read back one of its deletion receipts");
}

/** A listing from another account, or a partial one, omits sandboxes this
 * scope still holds. Resources being deleted or attested lost may already be
 * unlisted; so may the one resource whose loss is being attested. */
export async function assertInventoryComplete(
  client: pg.PoolClient, accountScope: string, listed: string[], exceptResourceId: string | null = null,
): Promise<void> {
  const missing = (await client.query<{ resource_id: string }>(
    `SELECT resource_id FROM cloud_workspace_provider_operations
     WHERE provider = 'boat' AND account_scope = $1 AND resource_id IS NOT NULL
       AND deletion_requested_at IS NULL AND deleted_at IS NULL AND lost_at IS NULL
       AND NOT (resource_id = ANY($2::text[])) AND resource_id IS DISTINCT FROM $3
     ORDER BY resource_id LIMIT 20`,
    [accountScope, listed, exceptResourceId],
  )).rows.map((row) => row.resource_id);
  if (missing.length)
    fail(`Provider inventory is incomplete or belongs to another account: bound resources not listed: ${missing.join(",")}`);
}

/** The recorded inventory evidence, identical across attestation tables. */
export function inventoryDigest(accountScope: string, inventory: ProviderInventory): Buffer {
  return digest({
    accountScope, providerAccount: inventory.providerAccount, observedAt: inventory.observedAt.toISOString(),
    resources: inventory.resources.map((resource) => [resource.id, resource.state]).sort(),
  });
}

const SandboxListSchema = z.object({
  sandboxes: z.array(z.object({ id: z.string(), state: z.string().max(64) }).passthrough()).max(1000),
  pageInfo: z.object({ nextCursor: z.string().nullable().optional(), hasMore: z.boolean() }).passthrough(),
}).passthrough();

// The API path accepts only [A-Za-z0-9_=&%.-] in a query; escape the rest.
const encodeCursor = (cursor: string) =>
  encodeURIComponent(cursor).replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

/** Every sandbox the Zeros Boat account created. Boat listings are
 * creator-private, so organization-billed sandboxes appear without an
 * organization scope, and the default listing includes archived sandboxes
 * (observed live on 2026-09-23). `observedAt` is the database clock read before
 * the first request; `receipt` is a deletion receipt from the account scope's
 * journal to read back as proof of account ownership. */
export async function listBoatInventory(
  client: Pick<BoatApiClient, "request">, observedAt: Date,
  receipt: { deletionOperationId: string; targetId: string } | null = null,
): Promise<ProviderInventory> {
  const account = z.object({ user: z.object({ id: z.string().min(1).max(256) }).passthrough() }).passthrough().safeParse(await client.request("/me"));
  if (!account.success) fail("Boat returned no account identity");
  let accountProof: ProviderInventory["accountProof"] = null;
  if (receipt) {
    if (!/^bdop_[A-Za-z0-9]{1,64}$/.test(receipt.deletionOperationId)) fail("The account-scope deletion receipt is malformed");
    const operation = z.object({ operation: z.object({ id: z.string(), targetId: z.string() }).passthrough() }).passthrough()
      .safeParse(await client.request(`/deletion-operations/${receipt.deletionOperationId}`));
    if (!operation.success || operation.data.operation.id !== receipt.deletionOperationId || operation.data.operation.targetId !== receipt.targetId)
      fail("This Boat key cannot read the account scope's deletion receipt");
    accountProof = receipt;
  }
  const resources: ProviderInventory["resources"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    const parsed = SandboxListSchema.safeParse(
      await client.request(`/sandboxes?limit=100${cursor ? `&cursor=${encodeCursor(cursor)}` : ""}`),
    );
    if (!parsed.success) fail("Boat returned an unrecognized sandbox listing");
    resources.push(...parsed.data.sandboxes.map((sandbox) => ({ id: sandbox.id, state: sandbox.state })));
    if (!parsed.data.pageInfo.hasMore) return { observedAt, providerAccount: account.data.user.id, accountProof, resources };
    cursor = parsed.data.pageInfo.nextCursor ?? null;
    if (!cursor) fail("Boat reported more sandboxes without a cursor");
  }
  fail("Boat inventory exceeds the operator page limit");
}

export async function databaseClock(pool: pg.Pool): Promise<Date> {
  return (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
}

/** The complete account inventory, stamped with the database clock before its
 * first request and carrying one of the scope's deletion receipts as proof of
 * account ownership. */
export async function readBoatInventory(
  pool: pg.Pool, client: Pick<BoatApiClient, "request">, accountScope: string,
): Promise<ProviderInventory> {
  const observedAt = await databaseClock(pool);
  const lookup = await pool.connect();
  let receipt: { deletion_operation_id: string; resource_id: string } | undefined;
  try {
    await lookup.query("BEGIN READ ONLY");
    await lookup.query("SELECT set_config('app.system', 'on', true)");
    receipt = (await lookup.query<{ deletion_operation_id: string; resource_id: string }>(
      `SELECT deletion_operation_id, resource_id FROM cloud_workspace_provider_operations
       WHERE provider = 'boat' AND account_scope = $1 AND deletion_operation_id IS NOT NULL
       ORDER BY deletion_requested_at DESC LIMIT 1`, [accountScope],
    )).rows[0];
  } finally {
    await lookup.query("ROLLBACK").catch(() => {});
    lookup.release();
  }
  return listBoatInventory(client, observedAt,
    receipt ? { deletionOperationId: receipt.deletion_operation_id, targetId: receipt.resource_id } : null);
}
