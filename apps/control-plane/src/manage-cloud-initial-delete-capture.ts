import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createMigrationPool } from "./db.js";
import { authorizeCloudWorkspaceCleanup } from "./cloud-workspaces/actors.js";
import { CloudOwnerDiscardDeleteError,ownerDeleteDigest,ownerDeleteTarget,requireOwnerDelete as check } from "./cloud-owner-discard-delete-contract.js";

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const InitialDeleteCaptureRequestSchema=z.object({
  version:z.literal(1),channel:z.enum(["development","alpha"]),
  organizationId:uuid,expectedOrganizationSlug:z.string().trim().min(1).max(255).transform(value=>value.toLowerCase()),
  workspaceId:uuid,ownerUserId:uuid,operatorUserId:uuid,deleteIntentId:uuid,generation:z.literal(1),
  engineInstanceId:uuid,setupRunId:uuid,bootId:uuid,writerEpoch:uuid,allocationLeaseId:uuid,
}).strict();
export type InitialDeleteCaptureRequest=z.infer<typeof InitialDeleteCaptureRequestSchema>;
type Options={databaseUrl:string;execute?:boolean;approval?:string|undefined};

/** Repairs the first capture of an existing Delete. This never retires native
 * authority, waives data loss, replaces the Delete or calls a provider. */
export async function manageCloudInitialDeleteCapture(pool:pg.Pool,supplied:InitialDeleteCaptureRequest,options:Options) {
  const parsed=InitialDeleteCaptureRequestSchema.safeParse(supplied);check(parsed.success,"initial_delete_request_invalid");
  const request=parsed.data,target=ownerDeleteTarget(options.databaseUrl,request.channel);
  const client=await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SELECT set_config('app.system','on',true)");
    check((await client.query(`SELECT 1 FROM pg_class WHERE oid='public.cloud_workspace_initial_delete_captures'::regclass
      AND pg_get_userbyid(relowner)=current_user AND current_user<>'zeros_app'`)).rowCount===1,"initial_delete_database_owner_required");
    check((await client.query(`SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL
      AND staff_role='platform_owner' FOR SHARE`,[request.operatorUserId])).rowCount===1,"initial_delete_operator_required");
    check((await client.query("SELECT 1 FROM organizations WHERE id=$1 AND lower(slug::text)=$2 AND NOT is_personal FOR SHARE",
      [request.organizationId,request.expectedOrganizationSlug])).rowCount===1,"initial_delete_organization_changed");
    check((await client.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND owner_user_id=$3 FOR UPDATE",
      [request.workspaceId,request.organizationId,request.ownerUserId])).rowCount===1,"initial_delete_workspace_changed");
    await authorizeCloudWorkspaceCleanup(client,{...request,actorUserId:request.ownerUserId});
    const previous=(await client.query(`SELECT setup_run_id,bound_recovery,source_sha256,capture_request_id
      FROM cloud_workspace_initial_delete_captures WHERE lifecycle_intent_id=$1 AND workspace_id=$2 AND org_id=$3`,
    [request.deleteIntentId,request.workspaceId,request.organizationId])).rows[0];
    const observed=previous ? null : (await client.query<{source:Record<string,unknown>|null;digest:Buffer|null}>(`
      WITH observed AS MATERIALIZED (SELECT cloud_initial_delete_capture_source($1,$2) AS source)
      SELECT source,digest(convert_to(source::text,'UTF8'),'sha256') AS digest FROM observed`,
    [request.deleteIntentId,request.channel==="alpha"])).rows[0];
    const source=observed?.source,bound=(previous?.bound_recovery ?? source?.bound) as Record<string,unknown>|undefined;
    const digest=(previous?.source_sha256 ?? observed?.digest) as Buffer|null;
    check(bound && digest,"initial_delete_source_unavailable");
    const expected:Record<string,unknown>={workspace_id:request.workspaceId,org_id:request.organizationId,generation:request.generation,
      lifecycle_intent_id:request.deleteIntentId,engine_instance_id:request.engineInstanceId,boot_id:request.bootId,
      writer_epoch:request.writerEpoch,allocation_lease_id:request.allocationLeaseId,funding_owner_user_id:request.ownerUserId};
    for(const [key,value] of Object.entries(expected))check(bound[key]===value,"initial_delete_source_changed");
    check((previous?.setup_run_id ?? source?.setupRunId)===request.setupRunId,"initial_delete_source_changed");
    const approval=`initial-delete-capture:v1:${ownerDeleteDigest({target,request,sourceSha256:digest.toString("hex")}).toString("hex")}`;
    const result={approval,sourceSha256:digest.toString("hex"),deleteIntentId:request.deleteIntentId,
      captureRequestId:(previous?.capture_request_id ?? null) as string|null};
    if(!options.execute || previous) {
      check(!options.execute || options.approval===approval,"initial_delete_approval_mismatch");
      await client.query("ROLLBACK");return {...result,state:previous?"unchanged" as const:"planned" as const};
    }
    check(options.approval===approval,"initial_delete_approval_mismatch");
    const admitted=(await client.query<{request_id:string|null}>("SELECT admit_cloud_initial_delete_capture($1,$2,$3) AS request_id",
      [request.deleteIntentId,digest,request.channel==="alpha"])).rows[0]?.request_id;
    check(admitted,"initial_delete_source_changed");
    await client.query("COMMIT");return {...result,state:"capture_queued" as const,captureRequestId:admitted};
  } catch(error) {await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally {client.release();}
}

export async function readInitialDeleteCaptureRequest(filename:string):Promise<InitialDeleteCaptureRequest> {
  const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    check(stat.isFile() && stat.uid===process.getuid?.() && (stat.mode&0o777)===0o600 && stat.size>0 && stat.size<=16_384,
      "initial_delete_request_file_invalid");
    const bytes=Buffer.alloc(16_385),{bytesRead}=await file.read(bytes,0,bytes.length,0);
    check(bytesRead===stat.size,"initial_delete_request_file_changed");
    let value:unknown;
    try {value=JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));} catch {throw new CloudOwnerDiscardDeleteError("initial_delete_request_invalid");}
    const parsed=InitialDeleteCaptureRequestSchema.safeParse(value);check(parsed.success,"initial_delete_request_invalid");return parsed.data;
  } finally {await file.close();}
}

async function runCli() {
  check(process.argv.slice(2).every(value=>value==="--execute"),"initial_delete_argument_invalid");
  const filename=process.env.CONTROL_PLANE_INITIAL_DELETE_REQUEST_FILE;check(filename,"initial_delete_request_file_required");
  const request=await readInitialDeleteCaptureRequest(filename),config=loadConfig();
  check(config.deploymentChannel===request.channel,"initial_delete_channel_mismatch");
  const pool=createMigrationPool(config.databaseUrl,{maxConnections:1});
  try {console.log(JSON.stringify(await manageCloudInitialDeleteCapture(pool,request,{databaseUrl:config.databaseUrl,
    execute:process.argv.includes("--execute"),approval:process.env.CONTROL_PLANE_INITIAL_DELETE_APPROVAL})));}
  finally {await pool.end();}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  runCli().catch(error=>{console.error(JSON.stringify({state:"refused",code:error instanceof CloudOwnerDiscardDeleteError
    ? error.code:"initial_delete_capture_failed"}));process.exitCode=1;});
}
