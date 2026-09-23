import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type {AuthedUser} from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceActor, type CloudWorkspaceActorRole, type CloudWorkspaceActorScope, type CloudWorkspaceCapability } from "./actors.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { consumeCloudWorkspaceDeviceProof, type CloudWorkspaceDeviceProof } from "./replicas.js";
import type { CloudEngineRelayGrant } from "./engine-client-admission.js";

export const CLOUD_ACTOR_ADMISSION_PATH = "/internal/v2/cloud-workspaces/engine/client-admission";
export const CLOUD_ACTOR_ADMISSION_AUDIENCE = "zeros-cloud-workspace-engine-client-admission-v2";
export const CLOUD_ACTOR_TOKEN_PATTERN = /^zwa_[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (token:string) => createHash("sha256").update(token).digest();
function rejected():never { throw new HttpError(401,"cloud_actor_admission_rejected","Workspace actor admission was rejected"); }

export type CloudRecordedActor = {
  actorUserId:string;deviceId:string;deviceKeyVersion:number;fingerprint:string;sourceSessionId:string;
};
export type CloudActorEngineScope = {
  workspaceId:string;organizationId:string;generation:number;engineInstanceId:string;heartbeatToken:string;
  actorSessionId?:string;
};
type Session = {
  id:string;workspace_id:string;org_id:string;generation:number;engine_instance_id:string;
  actor_user_id:string;device_id:string;device_key_version:string;actor_fingerprint:string;
  actor_role:CloudWorkspaceActorRole;authority_epoch:string;
};
function recordedActor(row:Session):CloudRecordedActor {
  return {actorUserId:row.actor_user_id,deviceId:row.device_id,deviceKeyVersion:Number(row.device_key_version),fingerprint:row.actor_fingerprint,sourceSessionId:row.id};
}

/** A persisted command survives disconnect, but never a user/device/access
 * revocation. Do not require the original socket/session to remain connected. */
export async function assertRecordedCloudActor(
  tx:Tx,input:CloudWorkspaceActorScope & {actor:CloudRecordedActor;capability:CloudWorkspaceCapability},
) {
  if (input.actor.actorUserId!==input.actorUserId || !uuid.test(input.actor.deviceId) || !uuid.test(input.actor.sourceSessionId) ||
      !Number.isSafeInteger(input.actor.deviceKeyVersion) || input.actor.deviceKeyVersion<1 ||
      !/^[a-f0-9]{64}$/.test(input.actor.fingerprint)) rejected();
  const authority = await authorizeCloudWorkspaceActor(tx,input);
  const source=await tx.query(`SELECT 1 FROM cloud_workspace_actor_sessions session WHERE session.id=$1
    AND session.workspace_id=$2 AND session.org_id=$3 AND session.actor_user_id=$4
    AND session.device_id=$5 AND session.device_key_version=$6 AND session.actor_fingerprint=$7
    AND cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,session.auth_session_id,session.auth_session_created_at)`,
  [input.actor.sourceSessionId,input.workspaceId,input.organizationId,input.actorUserId,input.actor.deviceId,input.actor.deviceKeyVersion,input.actor.fingerprint]);
  if(source.rowCount!==1)rejected();
  const device = await tx.query(`SELECT 1 FROM devices WHERE id=$1 AND user_id=$2
    AND key_version=$3 AND trust_state='trusted' AND revoked_at IS NULL`,[input.actor.deviceId,input.actorUserId,input.actor.deviceKeyVersion]);
  if (device.rowCount!==1 || !timingSafeEqual(Buffer.from(authority.fingerprint,"hex"),Buffer.from(input.actor.fingerprint,"hex"))) rejected();
  return authority;
}

export async function assertCloudActorSession(
  tx:Tx,scope:Omit<CloudActorEngineScope,"heartbeatToken">,
  actorSessionId:string,capability:CloudWorkspaceCapability,
):Promise<CloudRecordedActor & {role:CloudWorkspaceActorRole;sessionId:string}> {
  if (!uuid.test(actorSessionId)) rejected();
  const row = (await tx.query<Session>(`SELECT session.* FROM cloud_workspace_actor_sessions session
    JOIN cloud_workspaces workspace ON workspace.id=session.workspace_id AND workspace.org_id=session.org_id
      AND workspace.authority_epoch=session.authority_epoch AND workspace.current_generation=session.generation
    WHERE session.id=$1 AND session.workspace_id=$2 AND session.org_id=$3 AND session.generation=$4 AND session.engine_instance_id=$5
      AND session.revoked_at IS NULL AND session.consumed_at IS NOT NULL AND session.session_expires_at>clock_timestamp()
      AND cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,session.auth_session_id,session.auth_session_created_at)
      AND session.last_renewed_at>clock_timestamp()-interval '30 seconds'`,
  [actorSessionId,scope.workspaceId,scope.organizationId,scope.generation,scope.engineInstanceId])).rows[0];
  if (!row) rejected();
  const actor = recordedActor(row);
  const authority = await assertRecordedCloudActor(tx,{...scope,actorUserId:actor.actorUserId,actor,capability});
  const current = await tx.query(`SELECT 1 FROM cloud_workspace_actor_sessions WHERE id=$1
    AND revoked_at IS NULL AND session_expires_at>clock_timestamp()
    AND last_renewed_at>clock_timestamp()-interval '30 seconds'`,[row.id]);
  if (current.rowCount!==1) rejected();
  return {...actor,role:authority.role,sessionId:row.id};
}

/** Compatibility is limited to an untouched, owner-only v1 runtime. A missing
 * actor is never interpreted as the sponsor after collaboration is enabled. */
export async function assertCloudRequestActor(
  tx:Tx,scope:CloudActorEngineScope,capability:CloudWorkspaceCapability,
) {
  if (scope.actorSessionId!==undefined) return assertCloudActorSession(tx,scope,scope.actorSessionId,capability);
  const legacy=await tx.query(`SELECT 1 FROM cloud_workspaces workspace
    JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.single_member_mode=true
      AND workspace.sharing_mode='private' AND engine.id=$3 AND engine.generation=$4 AND engine.actor_protocol_version=1`,
  [scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation]);
  if (legacy.rowCount!==1) rejected();
  return null;
}

export class DatabaseCloudWorkspaceActorSessionService {
  constructor(private readonly options:{pool:pg.Pool;enginePort:number;bridgeUrl:string;workosEnabled:boolean}) {}

  /** Closing a device connection does not revoke another device or cancel
   * durable queued intent. No provider-wide SSH credential is involved. */
  async revoke(input:CloudWorkspaceActorScope & {token:string}):Promise<void> {
    if(![input.workspaceId,input.organizationId,input.actorUserId].every(value=>uuid.test(value)) || !CLOUD_ACTOR_TOKEN_PATTERN.test(input.token))rejected();
    await withSystemTx(this.options.pool,async tx=>{
      await tx.query(`UPDATE cloud_workspace_actor_sessions SET revoked_at=coalesce(revoked_at,now())
        WHERE workspace_id=$1 AND org_id=$2 AND actor_user_id=$3 AND token_hash=$4`,
        [input.workspaceId,input.organizationId,input.actorUserId,hash(input.token)]);
    });
  }

  async issue(input:CloudWorkspaceActorScope & {proof:CloudWorkspaceDeviceProof;authenticatedUser:AuthedUser}) {
    if (![input.workspaceId,input.organizationId,input.actorUserId].every(value=>uuid.test(value))) rejected();
    return withSystemTx(this.options.pool,async tx=>{
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[input.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",[input.workspaceId,input.organizationId]);
      const user=input.authenticatedUser;
      if(!user||user.id!==input.actorUserId||user.identity.provider!=="workos"||!user.authentication.sessionId)rejected();
      const source=(await tx.query<{created_at:string}>(`SELECT source.created_at::text FROM auth_sessions source
        JOIN users account ON account.id=source.user_id AND account.auth_revision=$4
        WHERE source.provider='workos' AND source.provider_session_id=$1 AND source.user_id=$2 AND source.provider_sub=$3
          AND cloud_workspace_actor_auth_live($2,'workos',$3,$1,source.created_at)
          AND $5::bigint IS NOT NULL AND to_timestamp($5::bigint)>clock_timestamp()`,
      [user.authentication.sessionId,user.id,user.identity.subject,user.accountRevision,user.authentication.tokenExpiresAt])).rows[0];
      if(!source)rejected();
      const actor = await authorizeCloudWorkspaceActor(tx,{...input,capability:"read"});
      const device = await consumeCloudWorkspaceDeviceProof(tx,{accountUserId:input.actorUserId,action:"engine.connect",
        payload:{organizationId:input.organizationId,workspaceId:input.workspaceId},proof:input.proof});
      const engines = await tx.query<{id:string;generation:number;authority_epoch:string}>(`SELECT engine.id,engine.generation,workspace.authority_epoch
        FROM cloud_workspace_engine_instances engine
        JOIN cloud_workspaces workspace ON workspace.id=engine.workspace_id AND workspace.org_id=engine.org_id
          AND workspace.current_generation=engine.generation AND workspace.owner_user_id=engine.account_user_id
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL AND workspace.desired_state='running'
          AND workspace.status IN ('ready','busy') AND engine.state='ready' AND engine.revoked_at IS NULL
          AND engine.lease_expires_at>clock_timestamp() AND engine.actor_protocol_version=2
          AND cloud_workspace_generation_policy_current(workspace.id,engine.generation,workspace.org_id)
          AND cloud_workspace_runtime_authority_live(workspace.id,engine.generation,workspace.owner_user_id,$3)
        LIMIT 2`,[input.workspaceId,input.organizationId,this.options.workosEnabled]);
      if (engines.rows.length!==1) throw new HttpError(409,"cloud_actor_runtime_unavailable","An actor-aware cloud runtime is required");
      const engine = engines.rows[0]!;
      const active = (await tx.query<{count:string}>(`SELECT count(*) FROM cloud_workspace_actor_sessions
        WHERE workspace_id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()
          AND ((consumed_at IS NULL AND admission_expires_at>clock_timestamp()) OR last_renewed_at>clock_timestamp()-interval '30 seconds')`,[input.workspaceId])).rows[0]!;
      if (Number(active.count)>=100) throw new HttpError(429,"cloud_actor_session_limit","Workspace connection limit reached");
      const token = `zwa_${randomBytes(32).toString("base64url")}`;
      const row = (await tx.query<{admission_expires_at:Date}>(`INSERT INTO cloud_workspace_actor_sessions
        (id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,
         authority_epoch,actor_fingerprint,actor_role,token_hash,admission_expires_at,session_expires_at,
         auth_provider,auth_subject,auth_session_id,auth_session_created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '24 hours','workos',$13,$14,$15)
        RETURNING admission_expires_at`,[randomUUID(),input.workspaceId,input.organizationId,engine.generation,engine.id,
        input.actorUserId,device.id,Number(device.key_version),engine.authority_epoch,actor.fingerprint,actor.role,hash(token),
        user.identity.subject,user.authentication.sessionId,source.created_at])).rows[0]!;
      return {version:2 as const,audience:CLOUD_ACTOR_ADMISSION_AUDIENCE,workspaceId:input.workspaceId,
        organizationId:input.organizationId,generation:engine.generation,authorityEpoch:Number(engine.authority_epoch),
        engineInstanceId:engine.id,remotePort:this.options.enginePort,grantToken:token,expiresAt:row.admission_expires_at.toISOString(),bridgeUrl:this.options.bridgeUrl};
    });
  }

  async consume(input:CloudActorEngineScope & {token:string;renew?:boolean}) {
    if (!CLOUD_ACTOR_TOKEN_PATTERN.test(input.token)) rejected();
    return withSystemTx(this.options.pool,async tx=>{
      // Each device renews every few seconds and writes only its session row,
      // so admissions share the revocation fence instead of queueing engine work.
      const engine = await assertCurrentCloudEngineAuthority(tx,{...input,workosEnabled:this.options.workosEnabled,lock:"share"});
      const row = (await tx.query<Session>(`SELECT session.* FROM cloud_workspace_actor_sessions session
        JOIN cloud_workspace_engine_instances engine ON engine.id=session.engine_instance_id AND engine.actor_protocol_version=2
        WHERE session.token_hash=$1 AND session.workspace_id=$2 AND session.org_id=$3 AND session.generation=$4
          AND session.engine_instance_id=$5 AND session.authority_epoch=$6 AND session.revoked_at IS NULL AND session.session_expires_at>clock_timestamp()
          AND cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,session.auth_session_id,session.auth_session_created_at)
          AND ((NOT $7::boolean AND session.consumed_at IS NULL AND session.admission_expires_at>clock_timestamp())
            OR ($7::boolean AND session.consumed_at IS NOT NULL AND session.last_renewed_at>clock_timestamp()-interval '30 seconds'))
        FOR UPDATE OF session`,[hash(input.token),input.workspaceId,input.organizationId,input.generation,input.engineInstanceId,engine.authorityEpoch,input.renew===true])).rows[0];
      if (!row) rejected();
      const actor = recordedActor(row);
      const authority = await assertRecordedCloudActor(tx,{...input,actorUserId:actor.actorUserId,actor,capability:"read"});
      const current=await tx.query(`UPDATE cloud_workspace_actor_sessions
        SET consumed_at=coalesce(consumed_at,clock_timestamp()),last_renewed_at=clock_timestamp()
        WHERE id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()
          AND ((NOT $2::boolean AND consumed_at IS NULL AND admission_expires_at>clock_timestamp())
            OR ($2::boolean AND consumed_at IS NOT NULL AND last_renewed_at>clock_timestamp()-interval '30 seconds'))`,[row.id,input.renew===true]);
      if(current.rowCount!==1)rejected();
      return {version:2 as const,audience:CLOUD_ACTOR_ADMISSION_AUDIENCE,admitted:true as const,
        authorityEpoch:engine.authorityEpoch,accountUserId:actor.actorUserId,actorSessionId:row.id,
        deviceId:actor.deviceId,role:authority.role,fingerprint:actor.fingerprint};
    });
  }

  async authorizeRelay(token:string,options:{connected?:boolean}={}):Promise<CloudEngineRelayGrant|null> {
    if (!CLOUD_ACTOR_TOKEN_PATTERN.test(token)) return null;
    return withSystemTx(this.options.pool,async tx=>{
      const row = (await tx.query<Session & {provider_resource_id:string}>(`SELECT session.*,binding.provider_resource_id
        FROM cloud_workspace_actor_sessions session
        JOIN cloud_workspaces workspace ON workspace.id=session.workspace_id AND workspace.org_id=session.org_id
          AND workspace.current_generation=session.generation AND workspace.authority_epoch=session.authority_epoch
        JOIN cloud_workspace_engine_instances engine ON engine.id=session.engine_instance_id AND engine.workspace_id=workspace.id
          AND engine.generation=session.generation AND engine.actor_protocol_version=2 AND engine.account_user_id=workspace.owner_user_id
          AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp()
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=session.workspace_id AND binding.org_id=session.org_id
          AND binding.generation=session.generation AND binding.observed_state='running'
        WHERE session.token_hash=$1 AND session.revoked_at IS NULL AND session.session_expires_at>clock_timestamp()
          AND cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,session.auth_session_id,session.auth_session_created_at)
          AND (($2::boolean AND session.consumed_at IS NOT NULL AND session.last_renewed_at>clock_timestamp()-interval '30 seconds')
            OR (NOT $2::boolean AND session.consumed_at IS NULL AND session.admission_expires_at>clock_timestamp()))
          AND workspace.deleted_at IS NULL AND workspace.desired_state='running' AND workspace.status IN ('ready','busy')
          AND cloud_workspace_generation_policy_current(workspace.id,session.generation,workspace.org_id)
          AND cloud_workspace_runtime_authority_live(workspace.id,session.generation,workspace.owner_user_id,$3)`,
      [hash(token),options.connected===true,this.options.workosEnabled])).rows[0];
      if (!row || !row.provider_resource_id) return null;
      try { await assertRecordedCloudActor(tx,{workspaceId:row.workspace_id,organizationId:row.org_id,
        actorUserId:row.actor_user_id,actor:recordedActor(row),capability:"read"}); }
      catch (error) { if (error instanceof HttpError) return null; throw error; }
      return {workspaceId:row.workspace_id,organizationId:row.org_id,generation:row.generation,
        authorityEpoch:Number(row.authority_epoch),engineInstanceId:row.engine_instance_id,resourceId:row.provider_resource_id};
    });
  }
}
