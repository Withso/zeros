// Guarded database-owner utility that records operator-attested provider loss
// of one bound Boat allocation (host loss or provider-side deletion). Without
// it, a lost allocation can never be deleted, metered to a final state or
// recovered: the provider returns not-found for its sandbox and usage meter,
// which is never accepted as proof by itself. The default mode is read-only.
// The evidence is an exhaustive inventory of the provider account that omits
// the resource while listing every other allocation the scope still holds,
// plus a not-found lookup of the exact resource. Execution is bound to one
// database, deployment channel, Organization, platform owner, workspace,
// generation, resource and audit reason. The running service then treats the
// allocation as absent: its compute reservations finalize at the last meter
// and its owner can recover the durable checkpoint into a new generation.

import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { z } from "zod";

import { BOAT_RESOURCE_ID_PATTERN, BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { CloudProviderError } from "./cloud-workspaces/provider.js";
import { createMigrationPool } from "./db.js";
import {
  CHANNELS,
  MAX_INVENTORY_AGE_MS,
  assertInventoryAccount,
  listBoatInventory,
  readAccountScopeReceipt,
  targetFingerprint,
  type ProviderInventory,
} from "./manage-cloud-provider-absence.js";

/** A direct lookup of the exact resource, stamped with the database clock. */
export type ProviderLookup = { resourceId: string; observedAt: Date; notFound: boolean };

export interface CloudProviderLossRequestInput {
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
  generation: string | undefined;
  resourceId: string | undefined;
  accountScope: string | undefined;
  expectedProviderAccount: string | undefined;
  reason: string | undefined;
}

export interface ValidatedCloudProviderLossRequest {
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  workspaceId: string;
  generation: number;
  resourceId: string;
  accountScope: string;
  expectedProviderAccount: string;
  reason: string;
  targetFingerprint: string;
}

export interface CloudProviderLossResult {
  state: "planned" | "attested" | "unchanged";
  approval: string | null;
  inventoryResourceCount: number;
  /** Unsettled compute leases asked to settle now. */
  settlingLeases: number;
}

export class CloudProviderLossManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudProviderLossManagementError";
  }
}

function fail(message: string): never {
  throw new CloudProviderLossManagementError(message);
}

export function validateCloudProviderLossRequest(input: CloudProviderLossRequestInput): ValidatedCloudProviderLossRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number]))
    fail("CONTROL_PLANE_PROVIDER_LOSS_CHANNEL must be development, alpha, beta, or production");
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel)
    fail("Provider loss channel does not match RAILWAY_ENVIRONMENT_NAME");
  if (input.execute && channel === "production" && input.productionConfirmed !== "true")
    fail("CONTROL_PLANE_PROVIDER_LOSS_PRODUCTION_CONFIRMED=true is required for production");
  const uuid = z.string().uuid();
  const organizationId = uuid.safeParse(input.organizationId);
  const actorUserId = uuid.safeParse(input.actorUserId);
  const workspaceId = uuid.safeParse(input.workspaceId);
  if (!organizationId.success) fail("CONTROL_PLANE_PROVIDER_LOSS_ORGANIZATION_ID must be one exact UUID");
  if (!actorUserId.success) fail("CONTROL_PLANE_PROVIDER_LOSS_ACTOR_USER_ID must be one exact UUID");
  if (!workspaceId.success) fail("CONTROL_PLANE_PROVIDER_LOSS_WORKSPACE_ID must be one exact UUID");
  const slug = z.string().trim().min(1).max(255).safeParse(input.expectedOrganizationSlug);
  if (!slug.success) fail("CONTROL_PLANE_PROVIDER_LOSS_EXPECTED_ORGANIZATION_SLUG is required");
  const generation = input.generation?.trim() ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(generation)) fail("CONTROL_PLANE_PROVIDER_LOSS_GENERATION must be one positive generation");
  const resourceId = input.resourceId?.trim() ?? "";
  if (!BOAT_RESOURCE_ID_PATTERN.test(resourceId)) fail("CONTROL_PLANE_PROVIDER_LOSS_RESOURCE_ID must be one Boat sandbox id");
  const accountScope = input.accountScope?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(accountScope)) fail("BOAT_ACCOUNT_SCOPE must be the stable provider account scope");
  const expectedProviderAccount = input.expectedProviderAccount?.trim() ?? "";
  if (!/^[A-Za-z0-9._@:+-]{1,256}$/.test(expectedProviderAccount))
    fail("CONTROL_PLANE_PROVIDER_LOSS_EXPECTED_ACCOUNT must name the Boat account that owns this scope");
  const reason = z.string().trim().min(16).max(512).safeParse(input.reason);
  if (!reason.success) fail("CONTROL_PLANE_PROVIDER_LOSS_REASON must contain 16 to 512 characters");
  let fingerprint: string;
  try {
    fingerprint = targetFingerprint(input.databaseUrl, channel, "provider-loss");
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid configuration: DATABASE_URL");
  }
  return {
    channel: channel as (typeof CHANNELS)[number],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data,
    expectedOrganizationSlug: slug.data.toLowerCase(),
    actorUserId: actorUserId.data,
    workspaceId: workspaceId.data,
    generation: Number(generation),
    resourceId,
    accountScope,
    expectedProviderAccount,
    reason: reason.data,
    targetFingerprint: fingerprint,
  };
}

type OperationRow = {
  resource_id: string | null;
  deletion_requested_at: Date | null;
  deleted_at: Date | null;
  lost_at: Date | null;
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest();

/** Plan (default) or record the loss. Inventory and lookup are read before
 * this call and are checked against the journal inside the transaction. */
export async function manageCloudProviderLoss(
  pool: pg.Pool,
  request: ValidatedCloudProviderLossRequest,
  inventory: ProviderInventory,
  lookup: ProviderLookup,
): Promise<CloudProviderLossResult> {
  if (inventory.resources.some((resource) => !BOAT_RESOURCE_ID_PATTERN.test(resource.id)))
    fail("Provider inventory contains an unrecognized resource identifier");
  if (inventory.providerAccount !== request.expectedProviderAccount)
    fail("Provider inventory belongs to a different account than CONTROL_PLANE_PROVIDER_LOSS_EXPECTED_ACCOUNT");
  if (lookup.resourceId !== request.resourceId || !lookup.notFound)
    fail("The provider still resolves the resource; a lookup must return not found");
  const listed = [...new Set(inventory.resources.map((resource) => resource.id))];
  if (listed.includes(request.resourceId)) fail("Provider inventory still lists the resource");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");
    const owner = (await client.query<{ principal: string; owns: boolean; can_insert: boolean; now: Date }>(
      `SELECT current_user AS principal, clock_timestamp() AS now,
              pg_get_userbyid(relowner) = current_user AS owns,
              has_table_privilege(current_user, 'public.cloud_workspace_provider_loss_attestations', 'INSERT') AS can_insert
       FROM pg_class WHERE oid = 'public.cloud_workspace_provider_loss_attestations'::regclass`,
    )).rows[0];
    if (!owner || owner.principal === "zeros_app" || !owner.owns || !owner.can_insert)
      fail("Provider loss attestations require the database/migration owner; the application role is refused");
    for (const observedAt of [inventory.observedAt, lookup.observedAt]) {
      const age = owner.now.getTime() - observedAt.getTime();
      if (age < 0 || age > MAX_INVENTORY_AGE_MS)
        fail("Provider inventory and lookup must be observed by the database clock within the last 15 minutes");
    }
    const actor = (await client.query<{ auth_status: string; deleted_at: Date | null; staff_role: string | null }>(
      "SELECT auth_status, deleted_at, staff_role FROM users WHERE id = $1", [request.actorUserId],
    )).rows[0];
    if (!actor || actor.auth_status !== "active" || actor.deleted_at !== null || actor.staff_role !== "platform_owner")
      fail("Provider loss actor must be one active Zeros platform owner");
    // Parent-before-journal lock order, as in the journal store and erasure.
    const organization = (await client.query<{ slug: string }>(
      "SELECT slug::text FROM organizations WHERE id = $1 FOR SHARE", [request.organizationId],
    )).rows[0];
    if (!organization || organization.slug.toLowerCase() !== request.expectedOrganizationSlug)
      fail("Provider loss Organization does not match the expected slug");
    const workspace = await client.query("SELECT 1 FROM cloud_workspaces WHERE id = $1 AND org_id = $2 FOR SHARE", [request.workspaceId, request.organizationId]);
    if (!workspace.rowCount) fail("Provider loss workspace is not in the Organization");
    await client.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id = $1 AND generation = $2 FOR SHARE",
      [request.workspaceId, request.generation]);
    const row = (await client.query<OperationRow>(
      `SELECT resource_id, deletion_requested_at, deleted_at, lost_at FROM cloud_workspace_provider_operations
       WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3 AND org_id = $4 FOR UPDATE`,
      [request.accountScope, request.workspaceId, request.generation, request.organizationId],
    )).rows[0];
    if (!row) fail(`Generation ${request.generation} has no Boat journal in this account scope`);
    if (row.resource_id !== request.resourceId) fail(`Generation ${request.generation} is not bound to ${request.resourceId}`);
    if (row.lost_at !== null) {
      await client.query("ROLLBACK");
      return { state: "unchanged", approval: null, inventoryResourceCount: listed.length, settlingLeases: 0 };
    }
    if (row.deletion_requested_at !== null || row.deleted_at !== null)
      fail("Zeros already started deleting this allocation; its deletion receipt is the evidence");
    // A live engine proves the allocation still runs somewhere.
    const engine = await client.query(
      `SELECT 1 FROM cloud_workspace_engine_instances
       WHERE workspace_id = $1 AND org_id = $2 AND generation = $3 AND state IN ('starting', 'ready')
         AND revoked_at IS NULL AND lease_expires_at > clock_timestamp() LIMIT 1`,
      [request.workspaceId, request.organizationId, request.generation],
    );
    if (engine.rowCount) fail("A live engine still holds this allocation's authority");
    await assertInventoryAccount(client, request.accountScope, inventory);
    // A listing from another account, or a partial one, omits sandboxes this
    // scope still holds. Resources being deleted may already be unlisted.
    const missing = (await client.query<{ resource_id: string }>(
      `SELECT resource_id FROM cloud_workspace_provider_operations
       WHERE provider = 'boat' AND account_scope = $1 AND resource_id IS NOT NULL AND resource_id <> $3
         AND deletion_requested_at IS NULL AND deleted_at IS NULL AND lost_at IS NULL AND NOT (resource_id = ANY($2::text[]))
       ORDER BY resource_id LIMIT 20`,
      [request.accountScope, listed, request.resourceId],
    )).rows.map((missingRow) => missingRow.resource_id);
    if (missing.length)
      fail(`Provider inventory is incomplete or belongs to another account: bound resources not listed: ${missing.join(",")}`);

    const approval = [
      "provider-loss", request.channel, request.targetFingerprint, request.organizationId, request.actorUserId,
      request.workspaceId, request.accountScope, request.generation, request.resourceId, inventory.providerAccount,
      createHash("sha256").update(request.reason, "utf8").digest("hex").slice(0, 12),
    ].join(":");
    if (!request.execute) {
      await client.query("ROLLBACK");
      return { state: "planned", approval, inventoryResourceCount: listed.length, settlingLeases: 0 };
    }
    if (request.approval !== approval) fail("CONTROL_PLANE_PROVIDER_LOSS_APPROVAL does not match the current target-bound plan");
    const inventoryDigest = digest({
      accountScope: request.accountScope, providerAccount: inventory.providerAccount, observedAt: inventory.observedAt.toISOString(),
      resources: inventory.resources.map((resource) => [resource.id, resource.state]).sort(),
    });
    await client.query(
      `INSERT INTO cloud_workspace_provider_loss_attestations
         (id, provider, account_scope, workspace_id, generation, resource_id, attested_by, database_principal, target_fingerprint,
          reason, provider_account, inventory_sha256, inventory_observed_at, inventory_resource_count, lookup_observed_at)
       VALUES ($1, 'boat', $2, $3, $4, $5, $6, current_user, $7, $8, $9, $10, $11, $12, $13)`,
      [randomUUID(), request.accountScope, request.workspaceId, request.generation, request.resourceId, request.actorUserId,
        request.targetFingerprint, request.reason, inventory.providerAccount, inventoryDigest, inventory.observedAt, listed.length,
        lookup.observedAt],
    );
    await client.query(
      `UPDATE cloud_workspace_provider_operations SET lost_at = clock_timestamp()
       WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3 AND resource_id = $4`,
      [request.accountScope, request.workspaceId, request.generation, request.resourceId],
    );
    // Settle now instead of after the lease worker's failure backoff.
    const leases = await client.query(
      `UPDATE managed_compute_allocation_leases SET next_check_at = clock_timestamp(), updated_at = now()
       WHERE workspace_id = $1 AND org_id = $2 AND generation = $3 AND state <> 'settled'`,
      [request.workspaceId, request.organizationId, request.generation],
    );
    await client.query("COMMIT");
    return { state: "attested", approval, inventoryResourceCount: listed.length, settlingLeases: leases.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A not-found lookup of the exact sandbox. Any other failure is not evidence. */
export async function lookupBoatResource(
  client: Pick<BoatApiClient, "request">, resourceId: string, observedAt: Date,
): Promise<ProviderLookup> {
  try {
    await client.request(`/sandboxes/${resourceId}`);
    return { resourceId, observedAt, notFound: false };
  } catch (error) {
    if (error instanceof CloudProviderError && error.code === "provider_not_found") return { resourceId, observedAt, notFound: true };
    throw error;
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const apiKey = process.env.BOAT_API_KEY?.trim();
  if (!apiKey) fail("BOAT_API_KEY is required to read the provider inventory");
  const request = validateCloudProviderLossRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_PROVIDER_LOSS_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed: process.env.CONTROL_PLANE_PROVIDER_LOSS_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_PROVIDER_LOSS_APPROVAL,
    organizationId: process.env.CONTROL_PLANE_PROVIDER_LOSS_ORGANIZATION_ID,
    expectedOrganizationSlug: process.env.CONTROL_PLANE_PROVIDER_LOSS_EXPECTED_ORGANIZATION_SLUG,
    actorUserId: process.env.CONTROL_PLANE_PROVIDER_LOSS_ACTOR_USER_ID,
    workspaceId: process.env.CONTROL_PLANE_PROVIDER_LOSS_WORKSPACE_ID,
    generation: process.env.CONTROL_PLANE_PROVIDER_LOSS_GENERATION,
    resourceId: process.env.CONTROL_PLANE_PROVIDER_LOSS_RESOURCE_ID,
    accountScope: process.env.BOAT_ACCOUNT_SCOPE,
    expectedProviderAccount: process.env.CONTROL_PLANE_PROVIDER_LOSS_EXPECTED_ACCOUNT,
    reason: process.env.CONTROL_PLANE_PROVIDER_LOSS_REASON,
  });
  const pool = createMigrationPool(databaseUrl, { maxConnections: 1 });
  try {
    const boat = new BoatApiClient({ apiKey, timeoutMs: 30_000 });
    const now = async () => (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    // Stamp each observation with the database clock before its first request.
    const inventory = await listBoatInventory(boat, await now(), await readAccountScopeReceipt(pool, request.accountScope));
    const lookup = await lookupBoatResource(boat, request.resourceId, await now());
    const result = await manageCloudProviderLoss(pool, request, inventory, lookup);
    console.log(
      `[provider-loss] state=${result.state} channel=${request.channel} target=${request.targetFingerprint} ` +
        `workspace=${request.workspaceId} generation=${request.generation} resource=${request.resourceId} ` +
        `inventory=${result.inventoryResourceCount} settling_leases=${result.settlingLeases}`,
    );
    if (result.state === "planned" && result.approval) console.log(`[provider-loss] approval=${result.approval}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(`[provider-loss] failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
