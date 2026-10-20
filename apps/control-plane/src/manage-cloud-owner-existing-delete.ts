import type pg from "pg";
import { audit } from "./audit.js";
import { authorizeCloudWorkspaceCleanup } from "./cloud-workspaces/actors.js";
import { retireCloudWorkspaceRuntimeAccess } from "./cloud-workspaces/runtime-access.js";
import { CloudOwnerExistingDeleteSchema, ownerDeleteDigest, ownerDeleteTarget,
  requireOwnerDelete as check, type CloudOwnerExistingDeleteRequest } from "./cloud-owner-discard-delete-contract.js";
import type { CloudOwnerDiscardDeleteResult } from "./manage-cloud-owner-discard-delete.js";

/** Acknowledges loss on an already accepted Delete. It creates no lifecycle
 * intent, capture, save, provider observation, settlement or erasure proof. */
export async function manageCloudOwnerExistingDelete(pool: pg.Pool, supplied: CloudOwnerExistingDeleteRequest,
  options: { databaseUrl:string;execute?:boolean;approval?:string | undefined }): Promise<CloudOwnerDiscardDeleteResult> {
  const parsed = CloudOwnerExistingDeleteSchema.safeParse(supplied);
  check(parsed.success,"owner_delete_request_invalid");
  const request = parsed.data, target = ownerDeleteTarget(options.databaseUrl,request.channel);
  const requestDigest = ownerDeleteDigest({ target,request });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SELECT set_config('app.system','on',true)");
    check((await client.query(`SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_owner_existing_delete_receipts'::regclass
      AND pg_get_userbyid(relowner)=current_user AND current_user<>'zeros_app'`)).rowCount === 1,"owner_delete_database_owner_required");
    check((await client.query(`SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL
      AND staff_role='platform_owner' FOR SHARE`, [request.operatorUserId])).rowCount === 1,"owner_delete_operator_required");
    check((await client.query("SELECT 1 FROM organizations WHERE id=$1 AND lower(slug::text)=$2 AND NOT is_personal FOR UPDATE",
      [request.organizationId,request.expectedOrganizationSlug])).rowCount === 1,"owner_delete_organization_changed");
    check((await client.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND owner_user_id=$3 FOR UPDATE",
      [request.workspaceId,request.organizationId,request.ownerUserId])).rowCount === 1,"owner_delete_workspace_changed");
    await authorizeCloudWorkspaceCleanup(client,{ ...request,actorUserId:request.ownerUserId });
    const previous = (await client.query(`SELECT receipt.*,workspace.data_deleted_at IS NOT NULL AS erased,
        NOT EXISTS (SELECT 1 FROM cloud_workspace_generations generation LEFT JOIN cloud_workspace_provider_bindings binding
          USING(workspace_id,generation,org_id) WHERE generation.workspace_id=receipt.workspace_id AND generation.org_id=receipt.org_id
          AND binding.deletion_verified_at IS NULL) AS provider_deleted
      FROM cloud_workspace_owner_existing_delete_receipts receipt
      JOIN cloud_workspaces workspace ON workspace.id=receipt.workspace_id AND workspace.org_id=receipt.org_id
      WHERE receipt.id=$1 OR (receipt.workspace_id=$2 AND receipt.org_id=$3)`,
    [request.operationId,request.workspaceId,request.organizationId])).rows[0];
    if (previous) {
      check(previous.id===request.operationId && previous.request_sha256.equals(requestDigest),"owner_delete_replay_mismatch");
      const approval = `owner-existing-delete:v1:${previous.plan_sha256.toString("hex")}`;
      check(!options.execute || options.approval===approval,"owner_delete_approval_mismatch");
      await client.query("ROLLBACK");
      return { state:"unchanged",receiptId:previous.id,approval,sourceSha256:previous.source_sha256.toString("hex"),
        deleteIntentId:previous.delete_intent_id,providerDeletion:previous.provider_deleted ? "verified" : "pending",
        dataErasure:previous.erased ? "complete" : "pending" };
    }
    const observation = (await client.query<{ source:Record<string,unknown> | null;digest:Buffer | null;bytes:number | null }>(`
      WITH observed AS MATERIALIZED (SELECT cloud_owner_existing_delete_source($1,$2) AS source),
      sized AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
      SELECT CASE WHEN bytes<=1048576 THEN source END AS source,
        CASE WHEN bytes<=1048576 THEN digest(convert_to(source::text,'UTF8'),'sha256') END AS digest,bytes FROM sized`,
    [request.deleteIntentId,request.recoveryIntentId])).rows[0]!;
    check(observation.bytes===null || observation.bytes<=1_048_576,"owner_delete_source_too_large");
    check(observation.source && observation.digest,"owner_delete_source_unavailable");
    const source = observation.source;
    for (const key of ["organizationId","workspaceId","ownerUserId","deleteIntentId","recoveryIntentId","engineInstanceId",
      "allocationLeaseId","providerResourceId","providerAccountScope"] as const)
      check(source[key]===request[key],"owner_delete_source_changed");
    check(source.generation===request.sourceGeneration,"owner_delete_source_changed");
    const planDigest = ownerDeleteDigest({ requestSha256:requestDigest.toString("hex"),sourceSha256:observation.digest.toString("hex") });
    const approval = `owner-existing-delete:v1:${planDigest.toString("hex")}`;
    const result = { receiptId:request.operationId,approval,sourceSha256:observation.digest.toString("hex"),deleteIntentId:request.deleteIntentId,
      providerDeletion:source.kind==="retired_history" ? "verified" as const : "pending" as const,dataErasure:"pending" as const };
    if (!options.execute) { await client.query("ROLLBACK"); return { ...result,state:"planned" }; }
    check(options.approval===approval,"owner_delete_approval_mismatch");
    await client.query(`INSERT INTO cloud_workspace_owner_existing_delete_receipts
      (id,workspace_id,org_id,generation,delete_intent_id,recovery_intent_id,kind,owner_user_id,operator_user_id,
       owner_acknowledged_complete_loss,owner_approval_reference,reason,source,source_sha256,recovery_sha256,delete_key,
       delete_sha256,request_sha256,plan_sha256,target_fingerprint,database_principal)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12::jsonb,$13,decode($14,'hex'),$15,decode($16,'hex'),$17,$18,$19,current_user)`,
    [request.operationId,request.workspaceId,request.organizationId,request.sourceGeneration,request.deleteIntentId,request.recoveryIntentId,
      source.kind,request.ownerUserId,request.operatorUserId,request.ownerApprovalReference,request.reason,JSON.stringify(source),observation.digest,
      source.recoverySha256,source.deleteKey,source.deleteSha256,requestDigest,planDigest,target]);
    await client.query(`UPDATE cloud_workspace_final_save_recoveries SET state='discarded',next_attempt_at='infinity'
      WHERE lifecycle_intent_id=$1`, [request.recoveryIntentId]);
    if (source.kind==="pending_delete") {
      await retireCloudWorkspaceRuntimeAccess(client,{ ...request,reason:"workspace_delete_requested" });
      await client.query(`UPDATE cloud_workspaces SET desired_state='deleted',status='deleting',authority_epoch=authority_epoch+1,
        version=version+1,updated_at=clock_timestamp(),last_error_code=NULL,last_error_message=NULL
        WHERE id=$1 AND org_id=$2 AND accepted_lifecycle_intent_id=$3`, [request.workspaceId,request.organizationId,request.deleteIntentId]);
    }
    await audit(client,request.organizationId,request.operatorUserId,"cloud_workspace.owner_existing_delete_loss",{
      workspaceId:request.workspaceId,receiptId:request.operationId,deleteIntentId:request.deleteIntentId,recoveryIntentId:request.recoveryIntentId,
      sourceSha256:result.sourceSha256,reasonCode:"owner_acknowledged_complete_data_loss",reasonSha256:ownerDeleteDigest(request.reason).toString("hex"),
    });
    await client.query("COMMIT");
    return { ...result,state:"deleting" };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
