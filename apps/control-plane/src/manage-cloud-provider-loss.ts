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

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";

import { BOAT_RESOURCE_ID_PATTERN, BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { CloudProviderError } from "./cloud-workspaces/provider.js";
import {
  assertInventoryAccount,
  assertInventoryComplete,
  assertInventoryShape,
  beginProviderAttestation,
  databaseClock,
  digest,
  inventoryDigest,
  readBoatInventory,
  reasonDigest,
  validateProviderOperatorRequest,
  type ProviderInventory,
  type ProviderOperator,
  type ProviderOperatorRequest,
  type ProviderOperatorRequestInput,
} from "./cloud-provider-evidence.js";
import { createMigrationPool } from "./db.js";

const OPERATOR: ProviderOperator = { env: "LOSS", noun: "loss", table: "cloud_workspace_provider_loss_attestations" };

/** A direct lookup of the exact resource, stamped with the database clock. */
export type ProviderLookup = { resourceId: string; observedAt: Date; notFound: boolean };

export interface CloudProviderLossRequestInput extends ProviderOperatorRequestInput {
  generation: string | undefined;
  resourceId: string | undefined;
}

export interface ValidatedCloudProviderLossRequest extends ProviderOperatorRequest {
  generation: number;
  resourceId: string;
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
  const base = validateProviderOperatorRequest(input, OPERATOR);
  const generation = input.generation?.trim() ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(generation)) fail("CONTROL_PLANE_PROVIDER_LOSS_GENERATION must be one positive generation");
  const resourceId = input.resourceId?.trim() ?? "";
  if (!BOAT_RESOURCE_ID_PATTERN.test(resourceId)) fail("CONTROL_PLANE_PROVIDER_LOSS_RESOURCE_ID must be one Boat sandbox id");
  return { ...base, generation: Number(generation), resourceId };
}

type OperationRow = {
  resource_id: string | null;
  deletion_requested_at: Date | null;
  deleted_at: Date | null;
  lost_at: Date | null;
};

/** Plan (default) or record the loss. Inventory and lookup are read before
 * this call and are checked against the journal inside the transaction. */
export async function manageCloudProviderLoss(
  pool: pg.Pool,
  request: ValidatedCloudProviderLossRequest,
  inventory: ProviderInventory,
  lookup: ProviderLookup,
): Promise<CloudProviderLossResult> {
  assertInventoryShape(inventory, request, OPERATOR);
  if (lookup.resourceId !== request.resourceId || !lookup.notFound)
    fail("The provider still resolves the resource; a lookup must return not found");
  const listed = [...new Set(inventory.resources.map((resource) => resource.id))];
  if (listed.includes(request.resourceId)) fail("Provider inventory still lists the resource");
  const client = await pool.connect();
  try {
    await beginProviderAttestation(client, {
      operator: OPERATOR, request, generations: [request.generation], observedAt: [inventory.observedAt, lookup.observedAt],
    });
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
    await assertInventoryComplete(client, request.accountScope, listed, request.resourceId);

    const evidence = digest([request.generation, request.resourceId, inventory.providerAccount]).toString("hex").slice(0, 16);
    const approval = [
      "provider-loss", request.channel, request.targetFingerprint, request.organizationId, request.actorUserId,
      request.workspaceId, request.accountScope, request.generation, request.resourceId, evidence, reasonDigest(request.reason),
    ].join(":");
    if (!request.execute) {
      await client.query("ROLLBACK");
      return { state: "planned", approval, inventoryResourceCount: listed.length, settlingLeases: 0 };
    }
    if (request.approval !== approval) fail("CONTROL_PLANE_PROVIDER_LOSS_APPROVAL does not match the current target-bound plan");
    await client.query(
      `INSERT INTO cloud_workspace_provider_loss_attestations
         (id, provider, account_scope, workspace_id, generation, resource_id, attested_by, database_principal, target_fingerprint,
          reason, provider_account, inventory_sha256, inventory_observed_at, inventory_resource_count, lookup_observed_at)
       VALUES ($1, 'boat', $2, $3, $4, $5, $6, current_user, $7, $8, $9, $10, $11, $12, $13)`,
      [randomUUID(), request.accountScope, request.workspaceId, request.generation, request.resourceId, request.actorUserId,
        request.targetFingerprint, request.reason, inventory.providerAccount, inventoryDigest(request.accountScope, inventory),
        inventory.observedAt, listed.length, lookup.observedAt],
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
    const inventory = await readBoatInventory(pool, boat, request.accountScope);
    const lookup = await lookupBoatResource(boat, request.resourceId, await databaseClock(pool));
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
