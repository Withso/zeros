import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { audit } from "./audit.js";
import { loadConfig } from "./config.js";
import { createMigrationPool } from "./db.js";
import { authorizeCloudWorkspaceCleanup } from "./cloud-workspaces/actors.js";
import { requestCloudWorkspaceDeletion } from "./cloud-workspaces/routes.js";
import { retireCloudWorkspaceRuntimeAccess } from "./cloud-workspaces/runtime-access.js";
import { CloudOwnerDiscardDeleteError, CloudOwnerDiscardDeleteSchema, ownerDeleteDigest,
  ownerDeleteTarget, requireOwnerDelete as check, type CloudOwnerDiscardDeleteRequest } from "./cloud-owner-discard-delete-contract.js";

type Options = { databaseUrl: string; execute?: boolean; approval?: string | undefined };
type Source = Record<string, unknown> & { history: { id: string }[] };
export type CloudOwnerDiscardDeleteResult = {
  state: "planned" | "deleting" | "unchanged";
  receiptId: string;
  approval: string;
  sourceSha256: string;
  deleteIntentId: string | null;
  providerDeletion: "pending" | "verified";
  dataErasure: "pending" | "complete";
};

/** Database-owner only. No provider I/O: the ordinary reconciler and erasure
 * worker own all physical deletion and its positive receipts. */
export async function manageCloudOwnerDiscardDelete(pool: pg.Pool, supplied: CloudOwnerDiscardDeleteRequest,
  options: Options): Promise<CloudOwnerDiscardDeleteResult> {
  const parsed = CloudOwnerDiscardDeleteSchema.safeParse(supplied);
  check(parsed.success, "owner_delete_request_invalid");
  const request = parsed.data, target = ownerDeleteTarget(options.databaseUrl, request.channel);
  const requestDigest = ownerDeleteDigest({ target, request });
  const key = `owner-discard-delete.${request.operationId}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SELECT set_config('app.system','on',true)");
    check((await client.query(`SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_delete_receipts'::regclass
      AND pg_get_userbyid(relowner)=current_user AND current_user<>'zeros_app'`)).rowCount === 1,
    "owner_delete_database_owner_required");
    check((await client.query(`SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL
      AND staff_role='platform_owner' FOR SHARE`, [request.operatorUserId])).rowCount === 1, "owner_delete_operator_required");
    check((await client.query("SELECT 1 FROM organizations WHERE id=$1 AND lower(slug::text)=$2 AND NOT is_personal FOR UPDATE",
      [request.organizationId, request.expectedOrganizationSlug])).rowCount === 1, "owner_delete_organization_changed");
    check((await client.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND owner_user_id=$3 FOR UPDATE",
      [request.workspaceId, request.organizationId, request.ownerUserId])).rowCount === 1, "owner_delete_workspace_changed");
    await authorizeCloudWorkspaceCleanup(client, { ...request, actorUserId: request.ownerUserId });
    const previous = (await client.query(`SELECT receipt.*,intent.id AS delete_intent_id,
        workspace.data_deleted_at IS NOT NULL AS erased,
        NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation LEFT JOIN cloud_workspace_provider_bindings binding
          USING(workspace_id,generation,org_id) WHERE generation.workspace_id=receipt.workspace_id AND generation.org_id=receipt.org_id
          AND binding.deletion_verified_at IS NULL) AS provider_deleted
      FROM cloud_workspace_owner_delete_receipts receipt
      JOIN cloud_workspaces workspace ON workspace.id=receipt.workspace_id AND workspace.org_id=receipt.org_id
      LEFT JOIN cloud_workspace_lifecycle_intents intent ON intent.workspace_id=receipt.workspace_id AND intent.org_id=receipt.org_id
        AND intent.idempotency_key=receipt.delete_key
      WHERE receipt.id=$1 OR (receipt.workspace_id=$2 AND receipt.org_id=$3)`,
    [request.operationId, request.workspaceId, request.organizationId])).rows[0];
    if (previous) {
      check(previous.id === request.operationId && previous.request_sha256.equals(requestDigest), "owner_delete_replay_mismatch");
      const approval = `owner-discard-delete:v1:${previous.plan_sha256.toString("hex")}`;
      check(!options.execute || options.approval === approval, "owner_delete_approval_mismatch");
      await client.query("ROLLBACK");
      return { state: "unchanged", receiptId: previous.id, approval, sourceSha256: previous.source_sha256.toString("hex"),
        deleteIntentId: previous.delete_intent_id, providerDeletion: previous.provider_deleted ? "verified" : "pending",
        dataErasure: previous.erased ? "complete" : "pending" };
    }
    const observation = (await client.query<{ source: Source | null; digest: Buffer | null; bytes: number | null }>(`
      WITH observed AS MATERIALIZED (SELECT cloud_owner_delete_source($1) AS source),
      sized AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
      SELECT CASE WHEN bytes<=1048576 THEN source END AS source,
        CASE WHEN bytes<=1048576 THEN digest(convert_to(source::text,'UTF8'),'sha256') END AS digest,bytes FROM sized`,
    [request.stopIntentId])).rows[0]!;
    check(observation.bytes === null || observation.bytes <= 1_048_576, "owner_delete_source_too_large");
    check(observation.source && observation.digest, "owner_delete_source_unavailable");
    const source = observation.source;
    for (const field of ["organizationId", "workspaceId", "ownerUserId", "stopIntentId", "requestId", "engineInstanceId",
      "allocationLeaseId", "providerResourceId", "providerAccountScope"] as const)
      check(source[field] === request[field], "owner_delete_source_changed");
    check(source.generation === request.sourceGeneration, "owner_delete_source_changed");
    const planDigest = ownerDeleteDigest({ requestSha256: requestDigest.toString("hex"), sourceSha256: observation.digest.toString("hex") });
    const approval = `owner-discard-delete:v1:${planDigest.toString("hex")}`;
    const result = { receiptId: request.operationId, approval, sourceSha256: observation.digest.toString("hex"),
      providerDeletion: "pending" as const, dataErasure: "pending" as const };
    if (!options.execute) {
      await client.query("ROLLBACK");
      return { ...result, state: "planned", deleteIntentId: null };
    }
    check(options.approval === approval, "owner_delete_approval_mismatch");
    await client.query(`INSERT INTO cloud_workspace_owner_delete_receipts
      (id,workspace_id,org_id,generation,stop_intent_id,request_id,owner_user_id,operator_user_id,
       owner_acknowledged_complete_loss,owner_approval_reference,reason,source,source_sha256,
       delete_key,request_sha256,plan_sha256,target_fingerprint,database_principal)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,current_user)`,
    [request.operationId, request.workspaceId, request.organizationId, request.sourceGeneration, request.stopIntentId, request.requestId,
      request.ownerUserId, request.operatorUserId, request.ownerApprovalReference, request.reason, JSON.stringify(source), observation.digest,
      key, requestDigest, planDigest, target]);
    await retireCloudWorkspaceRuntimeAccess(client, { ...request, reason: "workspace_delete_requested" });
    const deletion = await requestCloudWorkspaceDeletion(client, { ...request, actorUserId: request.ownerUserId,
      idempotencyKey: key, requestSha256: requestDigest, discardUncheckpointed: true });
    check(!deletion.replayed, "owner_delete_unexpected_existing_delete");
    const ids = [...source.history.map(intent => intent.id), deletion.intent.id];
    // Enroll missing recoveries for the exact loss dispositions without
    // adopting legacy captures: adoption rewrites the receipt's frozen facts,
    // including a generated retirement ID for terminal attempts.
    for (const id of ids) await client.query("SELECT ensure_cloud_final_save_recovery($1)", [id]);
    await client.query(`INSERT INTO cloud_workspace_owner_delete_dispositions
      (lifecycle_intent_id,receipt_id,workspace_id,org_id,generation,operation,intent_sha256,source_sha256,original_state)
      SELECT intent.id,$1,intent.workspace_id,intent.org_id,intent.generation,intent.operation::text,intent.request_sha256,
        cloud_owner_discard_recovery_digest(intent.id),recovery.state
      FROM cloud_workspace_lifecycle_intents intent JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=intent.id
      WHERE intent.id=ANY($2::uuid[]) AND intent.workspace_id=$3 AND intent.org_id=$4
        AND recovery.state NOT IN ('proven','resolved','discarded','not_required')`,
    [request.operationId, ids, request.workspaceId, request.organizationId]);
    await client.query(`UPDATE cloud_workspace_final_save_recoveries recovery SET state='discarded',next_attempt_at='infinity'
      FROM cloud_workspace_owner_delete_dispositions disposition WHERE disposition.lifecycle_intent_id=recovery.lifecycle_intent_id
        AND disposition.receipt_id=$1`, [request.operationId]);
    await client.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1`, [request.stopIntentId]);
    // The owner has explicitly waived the save. Advance the ordinary Delete
    // projection, not provider completion, after closing execution authority.
    await client.query(`UPDATE cloud_workspaces SET desired_state='deleted',status='deleting',authority_epoch=authority_epoch+1,
      version=version+1,updated_at=clock_timestamp(),last_error_code=NULL,last_error_message=NULL
      WHERE id=$1 AND org_id=$2 AND accepted_lifecycle_intent_id=$3`, [request.workspaceId, request.organizationId, deletion.intent.id]);
    await audit(client, request.organizationId, request.operatorUserId, "cloud_workspace.owner_discard_delete", {
      workspaceId: request.workspaceId, receiptId: request.operationId, generation: request.sourceGeneration,
      stopIntentId: request.stopIntentId, deleteIntentId: deletion.intent.id, sourceSha256: result.sourceSha256,
      reasonCode: "owner_acknowledged_complete_data_loss", reasonSha256: ownerDeleteDigest(request.reason).toString("hex"),
    });
    await client.query("COMMIT");
    return { ...result, state: "deleting", deleteIntentId: deletion.intent.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function readOwnerDiscardDeleteRequest(filename: string): Promise<CloudOwnerDiscardDeleteRequest> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= 16_384,
      "owner_delete_request_file_invalid");
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    check(bytesRead === stat.size, "owner_delete_request_file_changed");
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new CloudOwnerDiscardDeleteError("owner_delete_request_invalid"); }
    const parsed = CloudOwnerDiscardDeleteSchema.safeParse(value);
    check(parsed.success, "owner_delete_request_invalid");
    return parsed.data;
  } finally { await file.close(); }
}

async function runCli(): Promise<void> {
  check(process.argv.slice(2).every(value => value === "--execute"), "owner_delete_argument_invalid");
  const filename = process.env.CONTROL_PLANE_OWNER_DELETE_REQUEST_FILE;
  check(filename, "owner_delete_request_file_required");
  const request = await readOwnerDiscardDeleteRequest(filename);
  const config = loadConfig();
  check(config.deploymentChannel === request.channel, "owner_delete_channel_mismatch");
  const pool = createMigrationPool(config.databaseUrl, { maxConnections: 1 });
  try {
    console.log(JSON.stringify(await manageCloudOwnerDiscardDelete(pool, request, { databaseUrl: config.databaseUrl,
      execute: process.argv.includes("--execute"), approval: process.env.CONTROL_PLANE_OWNER_DELETE_APPROVAL })));
  } finally { await pool.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch(error => {
    console.error(JSON.stringify({ state: "refused", code: error instanceof CloudOwnerDiscardDeleteError ? error.code : "owner_delete_failed" }));
    process.exitCode = 1;
  });
}
