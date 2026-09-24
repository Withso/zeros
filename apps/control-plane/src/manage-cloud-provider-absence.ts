// Guarded database-owner utility that records operator-attested provider
// absence for Boat create journals whose outcome is otherwise permanently
// unknown (historical untracked journals, or dispatches whose refusal could not
// be certified). The default mode is read-only. The evidence is an exhaustive
// inventory of the provider account: every listed sandbox must be bound in this
// account scope's journal or named as a known non-workspace resource, and every
// covered dispatch must be old enough that an allocation from it would appear.
// Execution is bound to one database, deployment channel, Organization,
// platform owner, workspace, generation set, their dispatch history and an
// audit reason. Attestations are append-only; the running service then closes
// each generation through its ordinary absence check.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";

import { BOAT_RESOURCE_ID_PATTERN, BoatApiClient } from "./cloud-workspaces/boat-client.js";
import {
  assertInventoryAccount,
  assertInventoryComplete,
  assertInventoryShape,
  beginProviderAttestation,
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

export { listBoatInventory, type ProviderInventory } from "./cloud-provider-evidence.js";

/** An allocation made by a covered dispatch must have been observable for at
 * least the longest provider lease plus a margin before it can be ruled out. */
export const MIN_DISPATCH_AGE_MS = 2 * 60 * 60_000;
const OPERATOR: ProviderOperator = { env: "ABSENCE", noun: "absence", table: "cloud_workspace_provider_absence_attestations" };

export interface CloudProviderAbsenceRequestInput extends ProviderOperatorRequestInput {
  generations: string | undefined;
  knownResources?: string | undefined;
}

export interface ValidatedCloudProviderAbsenceRequest extends ProviderOperatorRequest {
  generations: number[];
  knownResources: string[];
}

export interface CloudProviderAbsenceResult {
  state: "planned" | "attested" | "unchanged";
  approval: string | null;
  /** Generations that need an attestation; closable ones are omitted. */
  generations: Array<{ generation: number; coversDispatchesThrough: string; tracked: boolean }>;
  inventoryResourceCount: number;
}

export class CloudProviderAbsenceManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudProviderAbsenceManagementError";
  }
}

function fail(message: string): never {
  throw new CloudProviderAbsenceManagementError(message);
}

export function validateCloudProviderAbsenceRequest(
  input: CloudProviderAbsenceRequestInput,
): ValidatedCloudProviderAbsenceRequest {
  const base = validateProviderOperatorRequest(input, OPERATOR);
  const generations = (input.generations ?? "").split(",").map((value) => value.trim());
  if (generations.length === 0 || generations.length > 16 || generations.some((value) => !/^[1-9][0-9]{0,8}$/.test(value)))
    fail("CONTROL_PLANE_PROVIDER_ABSENCE_GENERATIONS must list 1 to 16 positive generations");
  const uniqueGenerations = [...new Set(generations.map(Number))].sort((a, b) => a - b);
  if (uniqueGenerations.length !== generations.length) fail("CONTROL_PLANE_PROVIDER_ABSENCE_GENERATIONS must not repeat a generation");
  const knownResources = (input.knownResources ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (knownResources.length > 64 || knownResources.some((value) => !BOAT_RESOURCE_ID_PATTERN.test(value)))
    fail("CONTROL_PLANE_PROVIDER_ABSENCE_KNOWN_RESOURCES must list at most 64 Boat sandbox ids");
  return { ...base, generations: uniqueGenerations, knownResources: [...new Set(knownResources)].sort() };
}

type OperationRow = {
  resource_id: string | null;
  create_closed_at: Date | null;
  deleted_at: Date | null;
  create_attempts_tracked: boolean;
  closable: boolean;
};

/** Plan (default) or record attestations. The inventory must be taken before
 * this call and is checked against the journal inside the transaction. */
export async function manageCloudProviderAbsence(
  pool: pg.Pool,
  request: ValidatedCloudProviderAbsenceRequest,
  inventory: ProviderInventory,
): Promise<CloudProviderAbsenceResult> {
  assertInventoryShape(inventory, request, OPERATOR);
  const client = await pool.connect();
  try {
    await beginProviderAttestation(client, { operator: OPERATOR, request, generations: request.generations, observedAt: [inventory.observedAt] });

    const evidence: Array<{ generation: number; tracked: boolean; latest: Date; latestExact: string; attempts: unknown[] }> = [];
    for (const generation of request.generations) {
      const row = (await client.query<OperationRow>(
        `SELECT resource_id, create_closed_at, deleted_at, create_attempts_tracked,
                cloud_provider_create_absence_confirmed(provider, account_scope, workspace_id, generation, create_attempts_tracked) AS closable
         FROM cloud_workspace_provider_operations
         WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3 AND org_id = $4 FOR UPDATE`,
        [request.accountScope, request.workspaceId, generation, request.organizationId],
      )).rows[0];
      if (!row) fail(`Generation ${generation} has no Boat journal in this account scope`);
      if (row.create_closed_at !== null || row.deleted_at !== null) continue;
      if (row.resource_id !== null) fail(`Generation ${generation} is bound to a provider resource; use its deletion evidence instead`);
      const active = (await client.query<{ active: boolean }>(
        "SELECT cloud_provider_create_dispatch_active($1, $2) AS active", [request.workspaceId, generation],
      )).rows[0]!.active;
      if (active) fail(`Generation ${generation} still has an active create, wake or generation transition`);
      // Already covered, or every dispatch certified: the service can close it.
      if (row.closable) continue;
      const attempts = (await client.query<{ attempt_id: string; dispatched_exact: string; rejection_code: string | null }>(
        `SELECT attempt_id, dispatched_at::text AS dispatched_exact, rejection_code FROM cloud_workspace_provider_create_attempts
         WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3 ORDER BY dispatched_at, attempt_id`,
        [request.accountScope, request.workspaceId, generation],
      )).rows;
      // The shared dispatch horizon, kept at database precision: a millisecond
      // Date would round the instant below the microsecond dispatch it covers.
      const covered = (await client.query<{ latest: Date; latest_exact: string }>(
        `SELECT horizon AS latest, horizon::text AS latest_exact
         FROM (SELECT cloud_provider_create_dispatch_horizon('boat', $1, $2, $3, $4) AS horizon) coverage`,
        [request.accountScope, request.workspaceId, generation, row.create_attempts_tracked],
      )).rows[0]!;
      if (inventory.observedAt.getTime() - covered.latest.getTime() < MIN_DISPATCH_AGE_MS)
        fail(`Generation ${generation} dispatched too recently for its absence to be observable`);
      evidence.push({
        generation, tracked: row.create_attempts_tracked, latest: covered.latest, latestExact: covered.latest_exact,
        attempts: attempts.map((attempt) => [attempt.attempt_id, attempt.dispatched_exact, attempt.rejection_code]),
      });
    }

    await assertInventoryAccount(client, request.accountScope, inventory);
    const listed = [...new Set(inventory.resources.map((resource) => resource.id))];
    const bound = new Set((await client.query<{ resource_id: string }>(
      `SELECT resource_id FROM cloud_workspace_provider_operations
       WHERE provider = 'boat' AND account_scope = $1 AND resource_id = ANY($2::text[])`,
      [request.accountScope, listed],
    )).rows.map((row) => row.resource_id));
    const unaccounted = listed.filter((id) => !bound.has(id) && !request.knownResources.includes(id)).sort();
    if (unaccounted.length)
      fail(`Provider inventory has unaccounted resources: ${unaccounted.slice(0, 20).join(",")}${unaccounted.length > 20 ? ",..." : ""}`);
    await assertInventoryComplete(client, request.accountScope, listed);

    const generations = evidence.map((item) => ({ generation: item.generation, coversDispatchesThrough: item.latestExact, tracked: item.tracked }));
    if (evidence.length === 0) {
      await client.query("ROLLBACK");
      return { state: "unchanged", approval: null, generations, inventoryResourceCount: listed.length };
    }
    const excused = request.knownResources.filter((id) => listed.includes(id));
    const historyDigest = digest([
      evidence.map((item) => [item.generation, item.tracked, item.latestExact, item.attempts]),
      request.knownResources, inventory.providerAccount,
    ]).toString("hex").slice(0, 16);
    const approval = [
      "provider-absence", request.channel, request.targetFingerprint, request.organizationId, request.actorUserId,
      request.workspaceId, request.accountScope, evidence.map((item) => item.generation).join("+"), historyDigest,
      reasonDigest(request.reason),
    ].join(":");
    if (!request.execute) {
      await client.query("ROLLBACK");
      return { state: "planned", approval, generations, inventoryResourceCount: listed.length };
    }
    if (request.approval !== approval) fail("CONTROL_PLANE_PROVIDER_ABSENCE_APPROVAL does not match the current target-bound plan");
    const evidenceDigest = inventoryDigest(request.accountScope, inventory);
    for (const item of evidence) {
      await client.query(
        `INSERT INTO cloud_workspace_provider_absence_attestations
           (id, provider, account_scope, workspace_id, generation, attested_by, database_principal, target_fingerprint, reason,
            provider_account, excused_resources, inventory_sha256, inventory_observed_at, inventory_resource_count, covers_dispatches_through)
         VALUES ($1, 'boat', $2, $3, $4, $5, current_user, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
        [randomUUID(), request.accountScope, request.workspaceId, item.generation, request.actorUserId, request.targetFingerprint,
          request.reason, inventory.providerAccount, excused, evidenceDigest, inventory.observedAt, listed.length, item.latestExact],
      );
    }
    await client.query("COMMIT");
    return { state: "attested", approval, generations, inventoryResourceCount: listed.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const apiKey = process.env.BOAT_API_KEY?.trim();
  if (!apiKey) fail("BOAT_API_KEY is required to read the provider inventory");
  const request = validateCloudProviderAbsenceRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_APPROVAL,
    organizationId: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_ORGANIZATION_ID,
    expectedOrganizationSlug: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_EXPECTED_ORGANIZATION_SLUG,
    actorUserId: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_ACTOR_USER_ID,
    workspaceId: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_WORKSPACE_ID,
    generations: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_GENERATIONS,
    accountScope: process.env.BOAT_ACCOUNT_SCOPE,
    expectedProviderAccount: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_EXPECTED_ACCOUNT,
    knownResources: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_KNOWN_RESOURCES,
    reason: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_REASON,
  });
  const pool = createMigrationPool(databaseUrl, { maxConnections: 1 });
  try {
    const inventory = await readBoatInventory(pool, new BoatApiClient({ apiKey, timeoutMs: 30_000 }), request.accountScope);
    const result = await manageCloudProviderAbsence(pool, request, inventory);
    console.log(
      `[provider-absence] state=${result.state} channel=${request.channel} target=${request.targetFingerprint} ` +
        `workspace=${request.workspaceId} inventory=${result.inventoryResourceCount} ` +
        `generations=${result.generations.map((item) => `${item.generation}@${item.coversDispatchesThrough}${item.tracked ? "" : "(untracked)"}`).join(",") || "none"}`,
    );
    if (result.state === "planned" && result.approval) console.log(`[provider-absence] approval=${result.approval}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(`[provider-absence] failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
