import {parseDatabaseTarget} from "./database-target.js";
import {createPool} from "./db.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { readBoundedJsonFile } from "./bounded-json-file.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { DatabaseManagedComputeCreditLedger } from "./cloud-workspaces/compute-credits.js";
import {DatabaseComputeUserFunding} from "./cloud-workspaces/compute-funding.js";

const GrantFields = {
    channel: z.enum(["development", "alpha", "beta", "production"]),
    userId: z.string().uuid(),
    actorUserId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    amountMicroUsd: z.number().int().min(1).max(1_000_000_000_000),
    policyId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    reason: z.string().min(16).max(512),
};
const GrantSchema = z.discriminatedUnion("fundingScope", [
  z.object({ ...GrantFields, fundingScope: z.literal("user") }).strict(),
  z.object({ ...GrantFields, fundingScope: z.literal("organization"),
    organizationId: z.string().uuid(),
    expectedOrganizationSlug: z.string().min(1).max(255),
  }).strict(),
]);

/** A billing adapter can call the ledger directly after validating its signed
 * receipt. Until one exists, this explicit operator receipt is the only CLI
 * grant path. Reading an entitlement never fabricates a compute grant. */
export function planCloudComputeGrant(
  databaseUrl: string,
  document: unknown,
  railwayEnvironment?: string,
) {
  const parsed = GrantSchema.safeParse(document);
  if (!parsed.success) throw new Error("Invalid compute grant document");
  const request = parsed.data,
    start = Date.parse(request.startsAt),
    end = Date.parse(request.endsAt);
  if (end <= start || end - start > 366 * 86400_000)
    throw new Error("Invalid compute grant period");
  let database: URL;
  try {
    database = parseDatabaseTarget(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must identify a PostgreSQL database");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.hostname ||
    database.pathname === "/"
  )
    throw new Error("DATABASE_URL must identify a PostgreSQL database");
  if (
    railwayEnvironment &&
    railwayEnvironment.toLowerCase() !== request.channel
  )
    throw new Error("Compute grant deployment channel mismatch");
  const targetFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        request.channel,
        database.hostname.toLowerCase(),
        database.port || "5432",
        database.pathname,
        decodeURIComponent(database.username),
      ]),
    )
    .digest("hex");
  const digest = createHash("sha256")
    .update(JSON.stringify({ targetFingerprint, ...request }))
    .digest("hex");
  return { request, targetFingerprint, digest };
}

export async function applyCloudComputeGrant(
  pool: pg.Pool,
  plan: ReturnType<typeof planCloudComputeGrant>,
  expectedDigest: string,
) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedDigest) ||
    !timingSafeEqual(
      Buffer.from(expectedDigest, "hex"),
      Buffer.from(plan.digest, "hex"),
    )
  )
    throw new Error(
      "Compute grant plan changed; inspect the current plan before execution",
    );
  if(plan.request.fundingScope==='user') {
    return new DatabaseComputeUserFunding(pool).fund({userId:plan.request.userId,
      startsAt:new Date(plan.request.startsAt),endsAt:new Date(plan.request.endsAt),amountMicroUsd:plan.request.amountMicroUsd,
      source:{kind:'operator',id:plan.request.idempotencyKey,lineItemId:plan.request.policyId},
      operator:{actorUserId:plan.request.actorUserId,targetFingerprint:plan.targetFingerprint,reason:plan.request.reason}});
  }
  return new DatabaseManagedComputeCreditLedger({
    pool,
    workosEnabled: true,
  }).grant({
    organizationId: plan.request.organizationId,
    userId: plan.request.userId,
    startsAt: new Date(plan.request.startsAt),
    endsAt: new Date(plan.request.endsAt),
    amountMicroUsd: plan.request.amountMicroUsd,
    policyId: plan.request.policyId,
    idempotencyKey: plan.request.idempotencyKey,
    operator: {
      actorUserId: plan.request.actorUserId,
      expectedOrganizationSlug: plan.request.expectedOrganizationSlug,
      targetFingerprint: plan.targetFingerprint,
      reason: plan.request.reason,
    },
  });
}

async function run() {
  const args = process.argv.slice(2),
    execute = args.includes("--execute");
  const file = process.env.CLOUD_COMPUTE_GRANT_FILE,
    databaseUrl = process.env.DATABASE_URL;
  if (!file || !databaseUrl)
    throw new Error("CLOUD_COMPUTE_GRANT_FILE and DATABASE_URL are required");
  const plan = planCloudComputeGrant(
    databaseUrl,
    readBoundedJsonFile(file, 16_384),
    process.env.RAILWAY_ENVIRONMENT_NAME,
  );
  if (!execute) {
    console.log(
      JSON.stringify({
        state: "planned",
        sha256: plan.digest,
        targetFingerprint: plan.targetFingerprint,
        ...plan.request,
      }),
    );
    return;
  }
  const pool = createPool(databaseUrl, {maxConnections: 2});
  try {
    const result = await applyCloudComputeGrant(
      pool,
      plan,
      process.env.CLOUD_COMPUTE_GRANT_PLAN_SHA256 ?? "",
    );
    console.log(
      JSON.stringify({
        state: result.replayed ? "replayed" : "granted",
        ...result,
      }),
    );
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  void run().catch(() => {
    // Database/JSON errors can contain credentials or operator-entered data.
    console.error(
      "[cloud-compute-credit] request failed; inspect the grant document, target, operator and plan digest",
    );
    process.exitCode = 1;
  });
