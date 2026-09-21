import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import {createMigrationPool} from "./db.js";
import {parseDatabaseTarget} from "./database-target.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const credential = z.enum([
  "claude-api-key",
  "claude-setup-token",
  "cursor-api-key",
  "codex-api-key",
  "codex-chatgpt",
]);
const checks = z
  .object({
    privateCredentialIsolation: z.literal(true),
    workloadCredentialDenial: z.literal(true),
    actorAdmission: z.literal(true),
    stopAndRevocation: z.literal(true),
    nativeTurn: z.literal(true),
    nativeResume: z.literal(true),
    authentication: z.literal(true),
  })
  .strict();
export const CloudAgentRuntimeEvidenceSchema = z
  .object({
    version: z.literal(1),
    channel: z.enum(["development", "alpha", "beta", "production"]),
    provider: z.enum(["boat", "daytona"]),
    runtimeClass: z.literal("linux-vm"),
    imageRef: z.string().min(1).max(512),
    profile: z.literal("zeros-cloud-worker-v3"),
    runtimeContractSha256: digest,
    sourceCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    evidenceSha256: digest,
    qualifiedAt: z.string().datetime(),
    credentials: z
      .array(
        z.object({ kind: credential, checks, renewal: z.boolean() }).strict(),
      )
      .min(1)
      .max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.credentials.map((row) => row.kind)).size !==
      value.credentials.length
    )
      context.addIssue({
        code: "custom",
        message: "Credential qualification kinds must be unique",
      });
    if (
      value.credentials.some(
        (row) => row.kind === "codex-chatgpt" && !row.renewal,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Codex subscription renewal must qualify independently",
      });
    // Boat images bind immutable image identity and the expected baked metadata.
    // Daytona snapshots are opaque IDs; reject mutable aliases and image tags.
    const immutable =
      value.provider === "boat"
        ? /^boat:[a-z0-9][a-z0-9-]{0,62}@sha256:[a-f0-9]{64}$/.test(
            value.imageRef,
          )
        : /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            value.imageRef,
          );
    if (!immutable)
      context.addIssue({
        code: "custom",
        message: "Qualification requires an immutable provider image identity",
      });
  });
export type CloudAgentRuntimeEvidence = z.infer<
  typeof CloudAgentRuntimeEvidenceSchema
>;
const RequestSchema = z
  .object({
    operationId: z.string().uuid(),
    actorUserId: z.string().uuid(),
    enabled: z.boolean(),
    reason: z.string().trim().min(16).max(512),
    evidence: CloudAgentRuntimeEvidenceSchema,
  })
  .strict();
export type CloudAgentRuntimeChange = z.infer<typeof RequestSchema>;
type Row = {
  credential_kind: string;
  profile: string;
  enabled: boolean;
  qualified_at: string;
};

function targetIdentity(databaseUrl: string, channel: string): string {
  const value = parseDatabaseTarget(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(value.protocol) ||
    !value.hostname ||
    value.pathname.length < 2 ||
    value.hash
  )
    throw new Error("Qualification database target is invalid");
  return hash(
    JSON.stringify([
      channel,
      value.hostname,
      value.port || "5432",
      value.pathname,
      decodeURIComponent(value.username),
    ]),
  );
}

/** Application credentials cannot write qualifications. This migration-owner
 * transaction defaults to a plan; execution binds the exact database, channel,
 * evidence, current row state and accountable platform owner. */
export async function manageCloudAgentRuntime(
  pool: pg.Pool,
  input: unknown,
  options: {
    databaseUrl: string;
    channel: string;
    approval?: string | undefined;
    execute?: boolean;
  },
) {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Cloud runtime qualification document is invalid");
  const request = parsed.data,
    evidence = request.evidence;
  if (evidence.channel !== options.channel)
    throw new Error("Cloud runtime qualification channel mismatch");
  const target = targetIdentity(options.databaseUrl, options.channel),
    requestHash = hash(JSON.stringify(request));
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SELECT set_config('app.system','on',true)",
    );
    const privilege = (
      await client.query<{
        allowed: boolean;
        database: string;
      }>(`SELECT current_database() AS database,
      current_user<>'zeros_app' AND bool_and(pg_get_userbyid(relowner)=current_user) AS allowed FROM pg_class
      WHERE oid IN ('public.cloud_agent_runtime_qualifications'::regclass,'public.cloud_agent_runtime_qualification_changes'::regclass)`)
    ).rows[0];
    if (
      !privilege?.allowed ||
      decodeURIComponent(new URL(options.databaseUrl).pathname.slice(1)) !==
        privilege.database
    )
      throw new Error(
        "Cloud runtime qualification requires the exact database migration owner",
      );
    const owner = await client.query(
      "SELECT 1 FROM users WHERE id=$1 AND staff_role='platform_owner' AND auth_status='active' AND deleted_at IS NULL FOR SHARE",
      [request.actorUserId],
    );
    if (owner.rowCount !== 1)
      throw new Error(
        "Cloud runtime qualification requires an active platform owner",
      );
    // One image lock also fences absent rows and operation retries. Acquisition
    // order remains identical for all exact credential-kind subsets.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `cloud-runtime-qualification:${evidence.provider}:${evidence.imageRef}`,
    ]);
    const receipt = (
      await client.query<{
        request_sha256: string;
        target_sha256: string;
        plan_sha256: string;
      }>(
        "SELECT request_sha256,target_sha256,plan_sha256 FROM cloud_agent_runtime_qualification_changes WHERE operation_id=$1",
        [request.operationId],
      )
    ).rows[0];
    if (receipt) {
      if (
        receipt.request_sha256 !== requestHash ||
        receipt.target_sha256 !== target
      )
        throw new Error(
          "Cloud runtime qualification operation identity was reused",
        );
      if (options.execute && options.approval !== receipt.plan_sha256)
        throw new Error("Cloud runtime qualification plan mismatch");
      await client.query("ROLLBACK");
      return {
        state: "replayed" as const,
        planSha256: receipt.plan_sha256,
        targetSha256: target,
      };
    }
    if (
      request.enabled &&
      (Date.parse(evidence.qualifiedAt) > Date.now() + 60000 ||
        Date.parse(evidence.qualifiedAt) < Date.now() - 7 * 86400000)
    )
      throw new Error("Cloud runtime qualification evidence is stale");
    const revision =
      (
        await client.query<{ change_sequence: string }>(
          "SELECT change_sequence::text FROM cloud_agent_runtime_qualification_changes WHERE provider=$1 AND image_ref=$2 ORDER BY change_sequence DESC LIMIT 1",
          [evidence.provider, evidence.imageRef],
        )
      ).rows[0]?.change_sequence ?? "0";
    const kinds = evidence.credentials.map((row) => row.kind).sort();
    const previous = (
      await client.query<Row>(
        `SELECT credential_kind,profile,enabled,qualified_at::text FROM cloud_agent_runtime_qualifications
      WHERE provider=$1 AND image_ref=$2 AND runtime_contract_sha256=$3 AND credential_kind=ANY($4::text[]) ORDER BY credential_kind FOR UPDATE`,
        [
          evidence.provider,
          evidence.imageRef,
          evidence.runtimeContractSha256,
          kinds,
        ],
      )
    ).rows;
    const next = kinds.map((kind) => ({
      credential_kind: kind,
      profile: evidence.profile,
      enabled: request.enabled,
    }));
    const plan = hash(
      JSON.stringify({ target, request, revision, previous, next }),
    );
    if (!options.execute) {
      await client.query("ROLLBACK");
      return {
        state: "planned" as const,
        planSha256: plan,
        targetSha256: target,
        previous,
        next,
      };
    }
    if (options.approval !== plan)
      throw new Error("Cloud runtime qualification plan mismatch");
    for (const kind of kinds)
      await client.query(
        `INSERT INTO cloud_agent_runtime_qualifications
      (provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(provider,image_ref,runtime_contract_sha256,credential_kind) DO UPDATE
      SET enabled=EXCLUDED.enabled,profile=EXCLUDED.profile,qualified_at=EXCLUDED.qualified_at`,
        [
          evidence.provider,
          evidence.imageRef,
          evidence.runtimeContractSha256,
          kind,
          evidence.profile,
          request.enabled,
          evidence.qualifiedAt,
        ],
      );
    await client.query(
      `INSERT INTO cloud_agent_runtime_qualification_changes
      (operation_id,actor_user_id,deployment_channel,target_sha256,request_sha256,plan_sha256,evidence_sha256,provider,image_ref,runtime_contract_sha256,source_commit,previous_state,next_state,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`,
      [
        request.operationId,
        request.actorUserId,
        evidence.channel,
        target,
        requestHash,
        plan,
        evidence.evidenceSha256,
        evidence.provider,
        evidence.imageRef,
        evidence.runtimeContractSha256,
        evidence.sourceCommit,
        JSON.stringify(previous),
        JSON.stringify(next),
        request.reason,
      ],
    );
    await client.query("COMMIT");
    return {
      state: "changed" as const,
      planSha256: plan,
      targetSha256: target,
      previous,
      next,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2),
    execute = args.includes("--execute"),
    file = args.filter((arg) => arg !== "--execute");
  if (file.length !== 1 || file[0]!.startsWith("--"))
    throw new Error(
      "Expected one local qualification document and optional --execute",
    );
  const descriptor = openSync(
    file[0]!,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let document: unknown;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > 65536)
      throw new Error("Invalid qualification file");
    document = JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
  const databaseUrl = process.env.DATABASE_URL,
    channel = process.env.CONTROL_PLANE_RUNTIME_QUALIFICATION_CHANNEL;
  if (!databaseUrl || !channel)
    throw new Error("Database and qualification channel are required");
  const railway = process.env.RAILWAY_ENVIRONMENT_NAME?.toLowerCase();
  if (railway && railway !== channel)
    throw new Error("Railway qualification channel mismatch");
  const pool = createMigrationPool(databaseUrl, {
    maxConnections: 1,
    applicationName: "zeros-runtime-qualification-operator",
  });
  try {
    console.log(
      JSON.stringify(
        await manageCloudAgentRuntime(pool, document, {
          databaseUrl,
          channel,
          execute,
          approval: process.env.CONTROL_PLANE_RUNTIME_QUALIFICATION_APPROVAL,
        }),
      ),
    );
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    // Driver and validation errors can contain private image/identity/SQL data.
    console.error(
      "Cloud runtime qualification was not applied; verify owner access and the current target-bound plan",
    );
    process.exitCode = 1;
  });
