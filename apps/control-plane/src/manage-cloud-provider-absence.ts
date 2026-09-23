import {parseDatabaseTarget} from "./database-target.js";
import {createMigrationPool} from "./db.js";
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

import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { z } from "zod";

import { BoatApiClient } from "./cloud-workspaces/boat-client.js";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
/** An allocation made by a covered dispatch must have been observable for at
 * least the longest provider lease plus a margin before it can be ruled out. */
export const MIN_DISPATCH_AGE_MS = 2 * 60 * 60_000;
const MAX_INVENTORY_PAGES = 100;
const RESOURCE_ID = /^bx_[a-z0-9]{8,32}$/;

export type ProviderInventory = {
  observedAt: Date;
  resources: Array<{ id: string; state: string }>;
};

export interface CloudProviderAbsenceRequestInput {
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
  generations: string | undefined;
  accountScope: string | undefined;
  knownResources?: string | undefined;
  reason: string | undefined;
}

export interface ValidatedCloudProviderAbsenceRequest {
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  workspaceId: string;
  generations: number[];
  accountScope: string;
  knownResources: string[];
  reason: string;
  targetFingerprint: string;
}

export interface CloudProviderAbsenceResult {
  state: "planned" | "attested" | "unchanged";
  approval: string | null;
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

function targetFingerprint(databaseUrl: string, channel: string): string {
  let parsed: URL;
  try {
    parsed = parseDatabaseTarget(databaseUrl);
  } catch {
    fail("Invalid configuration: DATABASE_URL must be a PostgreSQL URL");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || parsed.pathname === "/")
    fail("Invalid configuration: DATABASE_URL must identify one PostgreSQL database");
  const target = [
    "zeros-control-plane-provider-absence.v1",
    channel,
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    parsed.pathname,
    decodeURIComponent(parsed.username),
  ].join("\0");
  return createHash("sha256").update(target, "utf8").digest("hex").slice(0, 16);
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest();

export function validateCloudProviderAbsenceRequest(
  input: CloudProviderAbsenceRequestInput,
): ValidatedCloudProviderAbsenceRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number]))
    fail("CONTROL_PLANE_PROVIDER_ABSENCE_CHANNEL must be development, alpha, beta, or production");
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel)
    fail("Provider absence channel does not match RAILWAY_ENVIRONMENT_NAME");
  if (input.execute && channel === "production" && input.productionConfirmed !== "true")
    fail("CONTROL_PLANE_PROVIDER_ABSENCE_PRODUCTION_CONFIRMED=true is required for production");
  const uuid = z.string().uuid();
  const organizationId = uuid.safeParse(input.organizationId);
  const actorUserId = uuid.safeParse(input.actorUserId);
  const workspaceId = uuid.safeParse(input.workspaceId);
  if (!organizationId.success) fail("CONTROL_PLANE_PROVIDER_ABSENCE_ORGANIZATION_ID must be one exact UUID");
  if (!actorUserId.success) fail("CONTROL_PLANE_PROVIDER_ABSENCE_ACTOR_USER_ID must be one exact UUID");
  if (!workspaceId.success) fail("CONTROL_PLANE_PROVIDER_ABSENCE_WORKSPACE_ID must be one exact UUID");
  const slug = z.string().trim().min(1).max(255).safeParse(input.expectedOrganizationSlug);
  if (!slug.success) fail("CONTROL_PLANE_PROVIDER_ABSENCE_EXPECTED_ORGANIZATION_SLUG is required");
  const generations = (input.generations ?? "").split(",").map((value) => value.trim());
  if (generations.length === 0 || generations.length > 16 || generations.some((value) => !/^[1-9][0-9]{0,8}$/.test(value)))
    fail("CONTROL_PLANE_PROVIDER_ABSENCE_GENERATIONS must list 1 to 16 positive generations");
  const uniqueGenerations = [...new Set(generations.map(Number))].sort((a, b) => a - b);
  if (uniqueGenerations.length !== generations.length) fail("CONTROL_PLANE_PROVIDER_ABSENCE_GENERATIONS must not repeat a generation");
  const accountScope = input.accountScope?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(accountScope)) fail("BOAT_ACCOUNT_SCOPE must be the stable provider account scope");
  const knownResources = (input.knownResources ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (knownResources.some((value) => !RESOURCE_ID.test(value)))
    fail("CONTROL_PLANE_PROVIDER_ABSENCE_KNOWN_RESOURCES must list Boat sandbox ids");
  const reason = z.string().trim().min(16).max(512).safeParse(input.reason);
  if (!reason.success) fail("CONTROL_PLANE_PROVIDER_ABSENCE_REASON must contain 16 to 512 characters");
  return {
    channel: channel as (typeof CHANNELS)[number],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data,
    expectedOrganizationSlug: slug.data.toLowerCase(),
    actorUserId: actorUserId.data,
    workspaceId: workspaceId.data,
    generations: uniqueGenerations,
    accountScope,
    knownResources: [...new Set(knownResources)].sort(),
    reason: reason.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel),
  };
}

type OperationRow = {
  generation: number;
  resource_id: string | null;
  create_closed_at: Date | null;
  deletion_requested_at: Date | null;
  deleted_at: Date | null;
  create_attempts_tracked: boolean;
  created_at_exact: string;
};

/** Plan (default) or record attestations. The inventory must be taken before
 * this call and is checked against the journal inside the transaction. */
export async function manageCloudProviderAbsence(
  pool: pg.Pool,
  request: ValidatedCloudProviderAbsenceRequest,
  inventory: ProviderInventory,
): Promise<CloudProviderAbsenceResult> {
  if (inventory.resources.some((resource) => !RESOURCE_ID.test(resource.id)))
    fail("Provider inventory contains an unrecognized resource identifier");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");
    const owner = (await client.query<{ principal: string; owns: boolean; can_insert: boolean }>(
      `SELECT current_user AS principal,
              pg_get_userbyid(relowner) = current_user AS owns,
              has_table_privilege(current_user, 'public.cloud_workspace_provider_absence_attestations', 'INSERT') AS can_insert
       FROM pg_class WHERE oid = 'public.cloud_workspace_provider_absence_attestations'::regclass`,
    )).rows[0];
    if (!owner || owner.principal === "zeros_app" || !owner.owns || !owner.can_insert)
      fail("Provider absence attestations require the database/migration owner; the application role is refused");
    const actor = (await client.query<{ auth_status: string; deleted_at: Date | null; staff_role: string | null }>(
      "SELECT auth_status, deleted_at, staff_role FROM users WHERE id = $1", [request.actorUserId],
    )).rows[0];
    if (!actor || actor.auth_status !== "active" || actor.deleted_at !== null || actor.staff_role !== "platform_owner")
      fail("Provider absence actor must be one active Zeros platform owner");
    const organization = (await client.query<{ slug: string }>(
      "SELECT slug::text FROM organizations WHERE id = $1", [request.organizationId],
    )).rows[0];
    if (!organization || organization.slug.toLowerCase() !== request.expectedOrganizationSlug)
      fail("Provider absence Organization does not match the expected slug");
    const workspace = await client.query("SELECT 1 FROM cloud_workspaces WHERE id = $1 AND org_id = $2", [request.workspaceId, request.organizationId]);
    if (!workspace.rowCount) fail("Provider absence workspace is not in the Organization");

    const evidence: Array<{ generation: number; tracked: boolean; latest: Date; latestExact: string; attempts: unknown[] }> = [];
    for (const generation of request.generations) {
      const row = (await client.query<OperationRow>(
        `SELECT generation, resource_id, create_closed_at, deletion_requested_at, deleted_at, create_attempts_tracked,
                created_at::text AS created_at_exact
         FROM cloud_workspace_provider_operations
         WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3 AND org_id = $4 FOR UPDATE`,
        [request.accountScope, request.workspaceId, generation, request.organizationId],
      )).rows[0];
      if (!row) fail(`Generation ${generation} has no Boat journal in this account scope`);
      const attested = await client.query(
        `SELECT 1 FROM cloud_workspace_provider_absence_attestations
         WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3`,
        [request.accountScope, request.workspaceId, generation],
      );
      if (attested.rowCount) continue;
      if (row.resource_id !== null) fail(`Generation ${generation} is bound to a provider resource; use its deletion evidence instead`);
      if (row.create_closed_at !== null || row.deleted_at !== null) fail(`Generation ${generation} is already closed or deleted`);
      const active = await client.query(
        `SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id = $1 AND generation = $2
           AND operation IN ('create', 'wake') AND state IN ('queued', 'dispatching', 'observing')`,
        [request.workspaceId, generation],
      );
      if (active.rowCount) fail(`Generation ${generation} still has an active create or wake`);
      const attempts = (await client.query<{ attempt_id: string; dispatched_exact: string; rejection_code: string | null }>(
        `SELECT attempt_id, dispatched_at::text AS dispatched_exact, rejection_code FROM cloud_workspace_provider_create_attempts
         WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3 ORDER BY dispatched_at, attempt_id`,
        [request.accountScope, request.workspaceId, generation],
      )).rows;
      if (row.create_attempts_tracked && attempts.every((attempt) => attempt.rejection_code !== null))
        fail(`Generation ${generation} has no uncertified dispatch; the service can close it without an attestation`);
      // Computed in SQL at full precision: a millisecond Date would round the
      // instant below the microsecond dispatch it must cover. An untracked
      // journal records no dispatches; any create/wake of the generation may
      // have dispatched until it finished.
      const covered = (await client.query<{ latest: Date; latest_exact: string }>(
        `SELECT latest, latest::text AS latest_exact FROM (SELECT greatest(
           $4::timestamptz,
           (SELECT max(dispatched_at) FROM cloud_workspace_provider_create_attempts
            WHERE provider = 'boat' AND account_scope = $1 AND workspace_id = $2 AND generation = $3),
           CASE WHEN $5::boolean THEN NULL ELSE (
             SELECT max(greatest(created_at, updated_at, coalesce(completed_at, created_at)))
             FROM cloud_workspace_lifecycle_intents WHERE workspace_id = $2 AND generation = $3 AND operation IN ('create', 'wake')
           ) END) AS latest) coverage`,
        [request.accountScope, request.workspaceId, generation, row.created_at_exact, row.create_attempts_tracked],
      )).rows[0]!;
      if (inventory.observedAt.getTime() - covered.latest.getTime() < MIN_DISPATCH_AGE_MS)
        fail(`Generation ${generation} dispatched too recently for its absence to be observable`);
      evidence.push({
        generation, tracked: row.create_attempts_tracked, latest: covered.latest, latestExact: covered.latest_exact,
        attempts: attempts.map((attempt) => [attempt.attempt_id, attempt.dispatched_exact, attempt.rejection_code]),
      });
    }

    const listed = [...new Set(inventory.resources.map((resource) => resource.id))];
    const bound = new Set((await client.query<{ resource_id: string }>(
      `SELECT resource_id FROM cloud_workspace_provider_operations
       WHERE provider = 'boat' AND account_scope = $1 AND resource_id = ANY($2::text[])`,
      [request.accountScope, listed],
    )).rows.map((row) => row.resource_id));
    const unaccounted = listed.filter((id) => !bound.has(id) && !request.knownResources.includes(id)).sort();
    if (unaccounted.length)
      fail(`Provider inventory has unaccounted resources: ${unaccounted.slice(0, 20).join(",")}${unaccounted.length > 20 ? ",..." : ""}`);

    const generations = evidence.map((item) => ({ generation: item.generation, coversDispatchesThrough: item.latestExact, tracked: item.tracked }));
    if (evidence.length === 0) {
      await client.query("ROLLBACK");
      return { state: "unchanged", approval: null, generations, inventoryResourceCount: listed.length };
    }
    const historyDigest = digest(evidence.map((item) => [item.generation, item.tracked, item.latestExact, item.attempts]))
      .toString("hex").slice(0, 16);
    const approval = [
      "provider-absence", request.channel, request.targetFingerprint, request.organizationId, request.actorUserId,
      request.workspaceId, request.accountScope, evidence.map((item) => item.generation).join("+"), historyDigest,
      createHash("sha256").update(request.reason, "utf8").digest("hex").slice(0, 12),
    ].join(":");
    if (!request.execute) {
      await client.query("ROLLBACK");
      return { state: "planned", approval, generations, inventoryResourceCount: listed.length };
    }
    if (request.approval !== approval) fail("CONTROL_PLANE_PROVIDER_ABSENCE_APPROVAL does not match the current target-bound plan");
    const inventoryDigest = digest({
      accountScope: request.accountScope, observedAt: inventory.observedAt.toISOString(),
      resources: inventory.resources.map((resource) => [resource.id, resource.state]).sort(),
    });
    for (const item of evidence) {
      await client.query(
        `INSERT INTO cloud_workspace_provider_absence_attestations
           (provider, account_scope, workspace_id, generation, id, attested_by, database_principal, target_fingerprint,
            reason, inventory_sha256, inventory_observed_at, inventory_resource_count, covers_dispatches_through)
         VALUES ('boat', $1, $2, $3, $4, $5, current_user, $6, $7, $8, $9, $10, $11::timestamptz)`,
        [request.accountScope, request.workspaceId, item.generation, randomUUID(), request.actorUserId, request.targetFingerprint,
          request.reason, inventoryDigest, inventory.observedAt, listed.length, item.latestExact],
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

const SandboxListSchema = z.object({
  sandboxes: z.array(z.object({ id: z.string(), state: z.string().max(64) }).passthrough()).max(1000),
  pageInfo: z.object({ nextCursor: z.string().nullable().optional(), hasMore: z.boolean() }).passthrough(),
}).passthrough();

/** Every sandbox visible to the Zeros Boat account, all states included. */
export async function listBoatInventory(client: Pick<BoatApiClient, "request">): Promise<ProviderInventory> {
  const resources: ProviderInventory["resources"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    const parsed = SandboxListSchema.safeParse(
      await client.request(`/sandboxes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    );
    if (!parsed.success) fail("Boat returned an unrecognized sandbox listing");
    resources.push(...parsed.data.sandboxes.map((sandbox) => ({ id: sandbox.id, state: sandbox.state })));
    if (!parsed.data.pageInfo.hasMore) return { observedAt: new Date(), resources };
    cursor = parsed.data.pageInfo.nextCursor ?? null;
    if (!cursor) fail("Boat reported more sandboxes without a cursor");
  }
  fail("Boat inventory exceeds the operator page limit");
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
    knownResources: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_KNOWN_RESOURCES,
    reason: process.env.CONTROL_PLANE_PROVIDER_ABSENCE_REASON,
  });
  const inventory = await listBoatInventory(new BoatApiClient({ apiKey, timeoutMs: 30_000 }));
  const pool = createMigrationPool(databaseUrl, { maxConnections: 1 });
  try {
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
