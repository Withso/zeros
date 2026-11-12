import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { createMigrationPool } from "./db.js";
import { SYSTEM_DATABASE_CONTEXT } from "./db-context.js";
import { parseDatabaseTarget } from "./database-target.js";
import { executionActivationDigest as hash, preparedExecutionSnapshot } from "./cloud/execution/activation-snapshot.js";

const Change = z.object({ activationId: z.uuid(), action: z.enum(["prepare", "activate", "rollback"]),
  channel: z.enum(["development", "alpha", "beta", "production"]), organizationId: z.uuid(), workspaceId: z.uuid(),
  initiatorUserId: z.uuid(), operatorUserId: z.uuid(), runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(16).max(512) }).strict();
export type CloudExecutionChange = z.infer<typeof Change>;
export const CLOUD_EXECUTION_ACTIVATION_LIMIT = 128;
/** The application cannot insert plans or receipts. The operator must own the
 * migration tables and approve an exact, freshly inspected target and snapshot. */
export async function manageCloudExecution(pool: pg.Pool, raw: unknown,
  options: { databaseUrl: string; channel: string; execute?: boolean; approval?: string | undefined }) {
  const parsed = Change.safeParse(raw);
  if (!parsed.success) throw new Error("Execution activation document is invalid");
  const input = parsed.data;
  if (input.channel !== options.channel) throw new Error("Execution deployment channel mismatch");
  const target = parseDatabaseTarget(options.databaseUrl);
  const targetFingerprint = hash([input.channel,target.hostname,target.port,target.pathname,decodeURIComponent(target.username)]).slice(0,16);
  const { action, ...identity } = input;
  const requestHash = hash(identity), receiptHash = hash(input), reasonHash = hash(input.reason);
  const client = await pool.connect();
  try {
    await client.query(`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; ${SYSTEM_DATABASE_CONTEXT}`);
    const owner = (await client.query<{ allowed: boolean; database: string; principal: string }>(`SELECT current_user AS principal,current_database() AS database,
      current_user<>'zeros_app' AND bool_and(pg_get_userbyid(relowner)=current_user) AS allowed FROM pg_class
      WHERE oid IN ('cloud_v2_execution_activations'::regclass,'cloud_v2_execution_activation_receipts'::regclass)`)).rows[0];
    if (!owner?.allowed || owner.database !== decodeURIComponent(target.pathname.slice(1))) throw new Error("Execution activation requires the exact database migration owner");
    const accounts = (await client.query<{ id: string; auth_status: string; deleted_at: Date | null; staff_role: string | null; auth_revision: string }>(
      "SELECT id,auth_status,deleted_at,staff_role,auth_revision::text FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE",
      [[input.operatorUserId,input.initiatorUserId]])).rows;
    const operator = accounts.find(row => row.id === input.operatorUserId);
    if (operator?.staff_role !== "platform_owner" || operator.auth_status !== "active" || operator.deleted_at) throw new Error("Execution activation requires an active platform owner");
    const workspace = (await client.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [input.workspaceId,input.organizationId])).rows[0];
    if (!workspace) throw new Error("Execution plan workspace not found");
    const previous = (await client.query("SELECT * FROM cloud_v2_execution_activations WHERE id=$1 FOR UPDATE", [input.activationId])).rows[0];
    if (previous && (previous.workspace_id !== input.workspaceId || previous.target_fingerprint !== targetFingerprint || previous.request_hash.toString("hex") !== requestHash))
      throw new Error("Execution activation identifies another plan");
    const receipt = (await client.query<{ request_hash: Buffer; approval_hash: Buffer }>(
      "SELECT request_hash,approval_hash FROM cloud_v2_execution_activation_receipts WHERE activation_id=$1 AND action=$2", [input.activationId,action])).rows[0];
    if (receipt) {
      if (receipt.request_hash.toString("hex") !== receiptHash || options.execute && options.approval !== receipt.approval_hash.toString("hex")) throw new Error("Execution activation plan changed");
      await client.query("ROLLBACK");
      return { state: options.execute ? "replayed" as const : "committed" as const, planSha256: receipt.approval_hash.toString("hex"), targetFingerprint, activationId: input.activationId };
    }
    const snapshot = action === "rollback" ? null : await preparedExecutionSnapshot(client, input.workspaceId, input.initiatorUserId);
    const prepared = action === "prepare" ? (await client.query<{ id: string }>(
      "SELECT id FROM cloud_v2_execution_activations WHERE workspace_id=$1 AND phase='prepared'", [workspace.id])).rows[0] : undefined;
    if (action === "prepare") {
      if (previous || !["legacy","prepared"].includes(workspace.execution_mode) || workspace.execution_transition_id ||
        !["running","stopped"].includes(workspace.state) || workspace.execution_mode === "prepared" && !prepared)
        throw new Error("Execution plan must prepare an idle lifecycle");
      if ((await client.query("SELECT 1 FROM cloud_v2_execution_activations WHERE workspace_id=$1 LIMIT $2", [workspace.id,CLOUD_EXECUTION_ACTIVATION_LIMIT])).rowCount! >= CLOUD_EXECUTION_ACTIVATION_LIMIT)
        throw new Error("Execution activation receipt limit reached for this workspace");
    } else if (action === "activate") {
      if (!previous || previous.phase !== "prepared" || workspace.execution_mode !== "prepared" || workspace.execution_transition_id ||
        hash(previous.prepared_snapshot) !== hash(snapshot)) throw new Error("Execution prepared plan changed; prepare a new activation");
    } else if (!previous || !["active","failed","cancelled"].includes(previous.phase) || workspace.state !== "stopped" || workspace.worker_token_hash ||
      workspace.execution_transition_id || previous.confirmed_stop_generation !== workspace.stop_generation || !previous.confirmed_stopped_at ||
      (previous.completed_at && previous.phase === "active" && previous.confirmed_stopped_at < previous.completed_at) ||
      (await client.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state<>'retired' LIMIT 1", [workspace.id])).rowCount)
      throw new Error("Execution rollback requires a completed provider Stop");
    const planSha256 = hash({ targetFingerprint, receiptHash, snapshot, phase: previous?.phase ?? null, preparedActivationId: prepared?.id ?? null,
      stopGeneration: workspace.stop_generation, confirmedStop: previous?.confirmed_stopped_at ?? null,
      operatorRevision: operator.auth_revision, principal: owner.principal });
    if (!options.execute) {
      await client.query("ROLLBACK");
      return { state: "planned" as const, planSha256, targetFingerprint, activationId: input.activationId, action, snapshot };
    }
    if (options.approval !== planSha256) throw new Error("Execution activation plan changed; inspect the current target before execution");
    if (action === "prepare") {
      if (prepared) await client.query("UPDATE cloud_v2_execution_activations SET phase='superseded',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [prepared.id]);
      await client.query(`INSERT INTO cloud_v2_execution_activations(id,workspace_id,org_id,initiator_user_id,operator_user_id,
        runtime_sha256,target_fingerprint,request_hash,reason_hash,prepared_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'),decode($9,'hex'),$10)`, [input.activationId,workspace.id,input.organizationId,
      input.initiatorUserId,input.operatorUserId,input.runtimeSha256,targetFingerprint,requestHash,reasonHash,snapshot]);
      await client.query("UPDATE cloud_v2_workspaces SET execution_mode='prepared' WHERE id=$1", [workspace.id]);
    } else if (action === "activate") {
      const started = (await client.query(`UPDATE cloud_v2_workspaces SET execution_transition_id=$2,state='stopping',
        stop_generation=stop_generation+1,access_epoch=access_epoch+1,restart_stop_generation=NULL,
        attempts=0,next_attempt_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING access_epoch,stop_generation`, [workspace.id,input.activationId])).rows[0]!;
      await client.query("DELETE FROM cloud_v2_tokens WHERE workspace_id=$1", [workspace.id]);
      await client.query(`UPDATE cloud_v2_execution_activations SET phase='draining',access_epoch=$2,stop_generation=$3,sandbox_id=$4,
        started_at=clock_timestamp(),deadline_at=clock_timestamp()+interval '30 minutes',next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1`, [input.activationId,started.access_epoch,started.stop_generation,workspace.boat_sandbox_id]);
    } else {
      await client.query(`UPDATE cloud_v2_workspaces SET execution_mode='legacy',execution_transition_id=NULL,
        execution_initiator_user_id=NULL,execution_intent_id=NULL,execution_intent_authority=NULL,access_epoch=access_epoch+1,
        worker_boot_id=NULL,acting_user_boot_ids='{}',updated_at=clock_timestamp() WHERE id=$1`, [workspace.id]);
      await client.query("DELETE FROM cloud_v2_tokens WHERE workspace_id=$1", [workspace.id]);
      await client.query("UPDATE cloud_v2_execution_activations SET phase='rolled_back',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [input.activationId]);
    }
    await client.query(`INSERT INTO cloud_v2_execution_activation_receipts(activation_id,action,request_hash,approval_hash)
      VALUES($1,$2,decode($3,'hex'),decode($4,'hex'))`, [input.activationId,action,receiptHash,planSha256]);
    await client.query("COMMIT");
    return { state: "changed" as const, planSha256, targetFingerprint, activationId: input.activationId, action };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

async function main() {
  const file = process.env.CLOUD_EXECUTION_CHANGE_FILE, databaseUrl = process.env.DATABASE_URL,
    channel = process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.CONTROL_PLANE_EXECUTION_CHANNEL;
  if (!file || !databaseUrl || !channel) throw new Error("Execution operator configuration is incomplete");
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--execute") || args.length > 1) throw new Error("Unsupported operator arguments");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let input: unknown;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16384) throw new Error("Invalid operator document");
    input = JSON.parse(readFileSync(descriptor, "utf8"));
  } finally { closeSync(descriptor); }
  const pool = createMigrationPool(databaseUrl);
  try { console.log(JSON.stringify(await manageCloudExecution(pool, input, { databaseUrl, channel, execute: args.includes("--execute"), approval: process.env.CLOUD_EXECUTION_PLAN_SHA256 }))); }
  finally { await pool.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main().catch(() => {
  console.error("[cloud-execution] operator request failed; inspect the target, authority, state and approval"); process.exitCode = 1;
});
