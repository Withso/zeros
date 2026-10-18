import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import {z} from "zod";
import type {AuthedUser} from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceActor, authorizeRecordedCloudWorkspaceActor, type CloudWorkspaceActorRole, type CloudWorkspaceActorScope, type CloudWorkspaceCapability } from "./actors.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { consumeCloudWorkspaceDeviceProof, type CloudWorkspaceDeviceProof } from "./replicas.js";
import type { CloudEngineRelayGrant } from "./engine-client-admission.js";
import { requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";
import {readCurrentCloudAgentBootBinding} from "./agent-boot-credentials.js";
import {CloudAgentBootScopeSchema,type CloudAgentBootScope} from "./agent-boot-contract.js";
import { CloudRuntimeAdmissionError, type CloudRuntimeAdmissionPhase } from "./runtime-admission-errors.js";
import type { CapabilityClaims } from "./capability-contract.js";

export const CLOUD_ACTOR_ADMISSION_PATH = "/internal/v2/cloud-workspaces/engine/client-admission";
export const CLOUD_ACTOR_ADMISSION_AUDIENCE = "zeros-cloud-workspace-engine-client-admission-v2";
export const CLOUD_ACTOR_TOKEN_PATTERN = /^zwa_[A-Za-z0-9_-]{43}$/;
/** Capability-backed actor admission: the engine forwards a client's S1
 * `zeros:engine` capability and proof with its heartbeat credential. */
export const CLOUD_CAPABILITY_ACTOR_ADMISSION_PATH = "/internal/v2/cloud-workspaces/engine/capability-admission";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (token:string) => createHash("sha256").update(token).digest();
const actorGrantSchema=z.object({version:z.literal(2),audience:z.literal(CLOUD_ACTOR_ADMISSION_AUDIENCE),workspaceId:z.string().uuid(),organizationId:z.string().uuid(),
  generation:z.number().int().positive().safe(),authorityEpoch:z.number().int().positive().safe(),engineInstanceId:z.string().uuid(),
  remotePort:z.number().int().min(1024).max(65535),grantToken:z.string().regex(CLOUD_ACTOR_TOKEN_PATTERN),expiresAt:z.string().datetime(),bridgeUrl:z.string().url()}).strict();
export const CloudActorConnectionGrantSchema=actorGrantSchema.extend({bootScope:CloudAgentBootScopeSchema.optional(),directProvider:z.object({
  version:z.literal(1),provider:z.literal("boat"),url:z.string().max(2048),}).strict().optional()}).strict().superRefine((value,context)=>{
  if(value.bootScope&&(["organizationId","workspaceId","generation","engineInstanceId"] as const).some(field=>value.bootScope![field]!==value[field])||
    value.directProvider&&(!value.bootScope||!directUrl(value.directProvider.url,value.remotePort)))context.addIssue({code:"custom",message:"Direct provider binding is inconsistent"});
});
function directUrl(value:string,port:number):boolean {
  try{const url=new URL(value);return value.length<=2048&&url.toString()===value&&url.protocol==="wss:"&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==="/ws"&&
    new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?-${port}\\.on\\.boat\\.dev$`).test(url.hostname)&&port>=1024&&port<=65535&&port!==22222;}catch{return false;}
}
export type CloudDirectProviderLookupScope={organizationId:string;workspaceId:string;generation:number;engineInstanceId:string;resourceId:string;remotePort:number};
export type CloudDirectProviderEndpointLookup=(scope:CloudDirectProviderLookupScope)=>Promise<{url:string;headerName?:string;headerValue?:string}>;
/** The engine's direct WebSocket URL for a provider endpoint lookup result,
 * or null unless that result is a bare https origin on the port's Boat host. */
export function cloudDirectProviderWebSocketUrl(endpoint:{url:string;headerName?:string;headerValue?:string},port:number):string|null {
  let url:URL;try{url=new URL(endpoint.url);}catch{return null;}
  if(endpoint.headerName!==undefined||endpoint.headerValue!==undefined||url.protocol!=="https:"||url.pathname!=="/"||url.toString()!==endpoint.url||url.search||url.hash||url.username||url.password)return null;
  url.protocol="wss:";url.pathname="/ws";
  const value=url.toString();
  return directUrl(value,port)?value:null;
}
function rejected():never { throw new HttpError(401,"cloud_actor_admission_rejected","Workspace actor admission was rejected"); }
function clientUpdateRequired():never { throw new HttpError(409,"cloud_workspace_client_update_required","Update Zeros to connect to cloud workspaces."); }

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
  return recordedActorAuthority(tx,input,false);
}

/** Authority, source session and device in one round trip, checked in that order. */
async function recordedActorAuthority(
  tx:Tx,input:CloudWorkspaceActorScope & {actor:CloudRecordedActor;capability:CloudWorkspaceCapability},currentSession:boolean,
) {
  if (input.actor.actorUserId!==input.actorUserId || !uuid.test(input.actor.deviceId) || !uuid.test(input.actor.sourceSessionId) ||
      !Number.isSafeInteger(input.actor.deviceKeyVersion) || input.actor.deviceKeyVersion<1 ||
      !/^[a-f0-9]{64}$/.test(input.actor.fingerprint)) rejected();
  const {authority,sourceLive,deviceLive} = await authorizeRecordedCloudWorkspaceActor(tx,{...input,currentSession});
  if (!sourceLive) rejected();
  if (!deviceLive || !timingSafeEqual(Buffer.from(authority.fingerprint,"hex"),Buffer.from(input.actor.fingerprint,"hex"))) rejected();
  return authority;
}

/** Background confirmation of an already consumed actor. Disconnect does not
 * erase accepted work; current account/auth/device/access proof still does. */
export async function confirmDetachedCloudActor(tx:Tx,scope:Omit<CloudActorEngineScope,"heartbeatToken">,
  actorSessionId:string,options:{consistentRead?:boolean}={}):Promise<CloudRecordedActor & {role:CloudWorkspaceActorRole;confirmedUntilMs:number}> {
  if(!uuid.test(actorSessionId))rejected();
  const row=(await tx.query<Session & {confirmed_until:Date}>(`SELECT session.*,least(${options.consistentRead ? "transaction_timestamp()" : "clock_timestamp()"}+interval '10 seconds',engine.lease_expires_at,
      auth.last_token_expires_at) AS confirmed_until
    FROM cloud_workspace_actor_sessions session JOIN cloud_workspace_engine_instances engine ON engine.id=session.engine_instance_id
    JOIN auth_sessions auth ON auth.provider_session_id=session.auth_session_id AND auth.user_id=session.actor_user_id
    WHERE session.id=$1 AND session.workspace_id=$2 AND session.org_id=$3 AND session.generation=$4 AND session.engine_instance_id=$5
      AND session.consumed_at IS NOT NULL AND auth.status='active' AND auth.last_token_expires_at>clock_timestamp()
      AND engine.revoked_at IS NULL AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()${options.consistentRead ? "" : " FOR SHARE OF session,auth"}`,
      [actorSessionId,scope.workspaceId,scope.organizationId,scope.generation,scope.engineInstanceId])).rows[0];
  if(!row)rejected();
  const actor=recordedActor(row),authority=await assertRecordedCloudActor(tx,{...scope,actorUserId:actor.actorUserId,actor,capability:"read"});
  const confirmedUntilMs=row.confirmed_until.getTime();
  if(!Number.isSafeInteger(confirmedUntilMs)||confirmedUntilMs<=Date.now())rejected();
  return {...actor,role:authority.role,confirmedUntilMs};
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
  await requireSupportedCloudWorkspaceGeneration(tx,scope);
  const actor = recordedActor(row);
  // The same statement confirms the session is still current after authorization.
  const authority = await recordedActorAuthority(tx,{...scope,actorUserId:actor.actorUserId,actor,capability},true);
  return {...actor,role:authority.role,sessionId:row.id};
}

/** Every request carries its device's actor session, including owner-only workspaces. */
export async function assertCloudRequestActor(
  tx:Tx,scope:CloudActorEngineScope,capability:CloudWorkspaceCapability,
) {
  if (scope.actorSessionId!==undefined) return assertCloudActorSession(tx,scope,scope.actorSessionId,capability);
  clientUpdateRequired();
}

export class DatabaseCloudWorkspaceActorSessionService {
  constructor(private readonly options:{pool:pg.Pool;enginePort:number;bridgeUrl:string;workosEnabled:boolean;directProviderEndpoint?:CloudDirectProviderEndpointLookup}) {}

  /** Closing a device connection does not revoke another device or cancel
   * durable queued intent. No provider-wide SSH credential is involved. */
  async revoke(input:CloudWorkspaceActorScope & {token:string}):Promise<void> {
    if(![input.workspaceId,input.organizationId,input.actorUserId].every(value=>uuid.test(value)) || !CLOUD_ACTOR_TOKEN_PATTERN.test(input.token))rejected();
    await withSystemTx(this.options.pool,async tx=>{
      await tx.query(`UPDATE cloud_workspace_actor_sessions SET revoked_at=now()
        WHERE workspace_id=$1 AND org_id=$2 AND actor_user_id=$3 AND token_hash=$4 AND revoked_at IS NULL`,
        [input.workspaceId,input.organizationId,input.actorUserId,hash(input.token)]);
    });
  }

  async issue(input:CloudWorkspaceActorScope & {proof:CloudWorkspaceDeviceProof;authenticatedUser:AuthedUser;directProviderVersion?:1;connectionChannel?:"control-plane-websocket"}) {
    if (![input.workspaceId,input.organizationId,input.actorUserId].every(value=>uuid.test(value))) rejected();
    const grant=await withSystemTx<z.infer<typeof actorGrantSchema>>(this.options.pool,async tx=>{
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[input.organizationId]);
      const workspace=(await tx.query<{current_generation:number}>("SELECT current_generation FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE",[input.workspaceId,input.organizationId])).rows[0];
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
      if(!workspace)rejected();
      await requireSupportedCloudWorkspaceGeneration(tx,{...input,generation:workspace.current_generation});
      const engines = await tx.query<{id:string;generation:number;authority_epoch:string;actor_protocol_version:number}>(`SELECT engine.id,engine.generation,workspace.authority_epoch,engine.actor_protocol_version
        FROM cloud_workspace_engine_instances engine
        JOIN cloud_workspaces workspace ON workspace.id=engine.workspace_id AND workspace.org_id=engine.org_id
          AND workspace.current_generation=engine.generation AND workspace.owner_user_id=engine.account_user_id
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL AND workspace.desired_state='running'
          AND workspace.status IN ('ready','busy') AND engine.state='ready' AND engine.revoked_at IS NULL
          AND engine.lease_expires_at>clock_timestamp()
          AND cloud_workspace_generation_policy_current(workspace.id,engine.generation,workspace.org_id)
          AND cloud_workspace_runtime_authority_live(workspace.id,engine.generation,workspace.owner_user_id,$3)
        LIMIT 2`,[input.workspaceId,input.organizationId,this.options.workosEnabled]);
      if (engines.rows.length!==1) throw new HttpError(409,"cloud_actor_runtime_unavailable","An actor-aware cloud runtime is required");
      const engine = engines.rows[0]!;
      if(engine.actor_protocol_version!==2)clientUpdateRequired();
      const device = await consumeCloudWorkspaceDeviceProof(tx,{accountUserId:input.actorUserId,action:"engine.connect",
        payload:{organizationId:input.organizationId,workspaceId:input.workspaceId},proof:input.proof});
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
    if(input.directProviderVersion!==1)return grant;
    let phase:CloudRuntimeAdmissionPhase="grant";
    try {
      const admitted=await this.authorizeRelay(grant.grantToken);
      if(!admitted)rejected();
      const before=await withSystemTx(this.options.pool,tx=>this.directBootScope(tx,grant,admitted));
      // Legacy generations remain on their unchanged transport. Unknown or
      // corrupt activated bindings are refusals, never guessed legacy state.
      if(!before)return grant;
      let directProvider:{version:1;provider:"boat";url:string}|undefined;
      if(input.connectionChannel!=="control-plane-websocket") {
        phase="provider_endpoint";
        if(!this.options.directProviderEndpoint)throw new HttpError(503,"cloud_actor_runtime_unavailable","Cloud runtime endpoint is unavailable");
        const endpoint=await this.options.directProviderEndpoint({workspaceId:grant.workspaceId,organizationId:grant.organizationId,generation:grant.generation,
          engineInstanceId:grant.engineInstanceId,resourceId:admitted.resourceId,remotePort:this.options.enginePort});
        const url=cloudDirectProviderWebSocketUrl(endpoint,this.options.enginePort);
        if(!url)rejected();
        directProvider={version:1,provider:"boat",url};
      }
      // Provider I/O owns no DB locks. Reauthorize the exact original one-use
      // actor grant and boot/writer after that asynchronous boundary.
      phase="grant";
      return await withSystemTx(this.options.pool,async tx=>{
        await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR SHARE",[grant.workspaceId,grant.organizationId]);
        await tx.query("SELECT id FROM cloud_workspace_engine_instances WHERE id=$1 FOR SHARE",[grant.engineInstanceId]);
        const current=await this.authorizeRelayInTx(tx,grant.grantToken,{});
        if(!current||Object.entries(admitted).some(([field,value])=>current[field as keyof CloudEngineRelayGrant]!==value))rejected();
        const bootScope=await this.directBootScope(tx,grant,current);
        if(!bootScope||Object.entries(before).some(([field,value])=>bootScope[field as keyof CloudAgentBootScope]!==value))rejected();
        if(!await this.authorizeRelayInTx(tx,grant.grantToken,{}))rejected();
        return CloudActorConnectionGrantSchema.parse({...grant,bootScope,...(directProvider?{directProvider}:{})});
      });
    }catch(error){
      try { await this.revoke({...input,token:grant.grantToken}); }
      catch { throw new CloudRuntimeAdmissionError(phase,error,"unconfirmed"); }
      throw new CloudRuntimeAdmissionError(phase,error,"confirmed");
    }
  }
  private async directBootScope(tx:Tx,grant:z.infer<typeof actorGrantSchema>,authority:CloudEngineRelayGrant):Promise<CloudAgentBootScope|null> {
    const current=await readCurrentCloudAgentBootBinding(tx,{organizationId:grant.organizationId,workspaceId:grant.workspaceId});
    if(current.mode==="legacy")return null;
    if(current.binding.writerState!=="active"||current.binding.generation!==authority.generation||current.binding.engineInstanceId!==authority.engineInstanceId)rejected();
    return CloudAgentBootScopeSchema.parse(Object.fromEntries(Object.keys(CloudAgentBootScopeSchema.shape).map(field=>[field,current.binding[field as keyof typeof current.binding]])));
  }

  /** Admits a client that authenticated to this engine with its S1
   * `zeros:engine` capability, which the caller verified (steps 1-13 with
   * proof of possession) against this engine's placement. The client gets the
   * session a redeemed grant gets, already consumed: the engine renews it with
   * the returned token like a grant session, so every renewal check applies.
   * The token's role, epochs, device key and source session must still be
   * current, so one issued before a revocation, role change or key change is
   * refused even inside its lifetime. The session never opens a relay, which
   * requires an unconsumed grant. */
  async admitCapability(input:CloudActorEngineScope & {claims:CapabilityClaims}) {
    const {claims}=input;
    const actorUserId=claims.sub.startsWith("user:")?claims.sub.slice(5):"";
    const {role,sid,did,cnf}=claims,deviceKeyVersion=claims.ep.dk;
    if(claims.knd!=="client"||claims.aud!=="zeros:engine"||claims.wsp!==input.workspaceId.toLowerCase()||
      claims.org!==input.organizationId.toLowerCase()||claims.gen!==input.generation||
      (claims.ein!==undefined&&claims.ein!==input.engineInstanceId.toLowerCase())||!uuid.test(actorUserId)||
      !role||!sid||!did||!cnf||deviceKeyVersion===undefined)rejected();
    return withSystemTx(this.options.pool,async tx=>{
      const engine=await assertCurrentCloudEngineAuthority(tx,{...input,workosEnabled:this.options.workosEnabled,lock:"share"});
      await requireSupportedCloudWorkspaceGeneration(tx,input);
      if(claims.ep.wa!==engine.authorityEpoch)rejected();
      const facts=(await tx.query<{access_revision:string;member_epoch:string;auth_revision:string;device_key_version:string;
        device_public_key:Buffer;provider_session_id:string;provider_sub:string;created_at:string}>(`SELECT workspace.access_revision,
          coalesce((SELECT member.epoch FROM cloud_capability_member_epochs member
            WHERE member.org_id=workspace.org_id AND member.user_id=$3),1) AS member_epoch,
          account.auth_revision,device.key_version AS device_key_version,device.public_key AS device_public_key,
          source.provider_session_id,source.provider_sub,source.created_at::text
        FROM cloud_workspaces workspace
        JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id
          AND engine.org_id=workspace.org_id AND engine.generation=$5 AND engine.actor_protocol_version=2
        JOIN users account ON account.id=$3
        JOIN devices device ON device.id=$6 AND device.user_id=$3 AND device.trust_state='trusted' AND device.revoked_at IS NULL
        JOIN auth_sessions source ON source.id=$7 AND source.user_id=$3 AND source.provider='workos'
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL
          AND cloud_workspace_actor_auth_live($3,'workos',source.provider_sub,source.provider_session_id,source.created_at)`,
      [input.workspaceId,input.organizationId,actorUserId,input.engineInstanceId,input.generation,did,sid])).rows[0];
      if(!facts||([[facts.access_revision,claims.ep.wr],[facts.member_epoch,claims.ep.me],[facts.auth_revision,claims.ep.ac],
        [facts.device_key_version,deviceKeyVersion]] as const).some(([current,token])=>Number(current)!==token)||
        facts.device_public_key.length!==32||facts.device_public_key.toString("base64url")!==cnf.jwk.x)rejected();
      const authority=await authorizeCloudWorkspaceActor(tx,{workspaceId:input.workspaceId,organizationId:input.organizationId,actorUserId,capability:"read"});
      if(authority.role!==role)rejected();
      // Unlike issue(), this holds share locks only, so concurrent admissions
      // may pass the count together; the limit bounds resources, not authority.
      const active=(await tx.query<{count:string}>(`SELECT count(*) FROM cloud_workspace_actor_sessions
        WHERE workspace_id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()
          AND ((consumed_at IS NULL AND admission_expires_at>clock_timestamp()) OR last_renewed_at>clock_timestamp()-interval '30 seconds')`,[input.workspaceId])).rows[0]!;
      if(Number(active.count)>=100)throw new HttpError(429,"cloud_actor_session_limit","Workspace connection limit reached");
      const id=randomUUID(),token=`zwa_${randomBytes(32).toString("base64url")}`;
      await tx.query(`INSERT INTO cloud_workspace_actor_sessions
        (id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,
         authority_epoch,actor_fingerprint,actor_role,token_hash,admission_expires_at,session_expires_at,consumed_at,last_renewed_at,
         auth_provider,auth_subject,auth_session_id,auth_session_created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '24 hours',
          clock_timestamp(),clock_timestamp(),'workos',$13,$14,$15)`,[id,input.workspaceId,input.organizationId,input.generation,
        input.engineInstanceId,actorUserId,did,deviceKeyVersion,engine.authorityEpoch,authority.fingerprint,authority.role,hash(token),
        facts.provider_sub,facts.provider_session_id,facts.created_at]);
      // The checks every renewal of this session makes, on the new row.
      const current=await recordedActorAuthority(tx,{workspaceId:input.workspaceId,organizationId:input.organizationId,actorUserId,
        actor:{actorUserId,deviceId:did,deviceKeyVersion,fingerprint:authority.fingerprint,sourceSessionId:id},capability:"read"},true);
      if(current.role!==authority.role)rejected();
      return {version:2 as const,audience:CLOUD_ACTOR_ADMISSION_AUDIENCE,admitted:true as const,authorityEpoch:engine.authorityEpoch,
        accountUserId:actorUserId,actorSessionId:id,deviceId:did,role:authority.role,fingerprint:authority.fingerprint,renewalToken:token};
    });
  }

  async consume(input:CloudActorEngineScope & {token:string;renew?:boolean}) {
    if (!CLOUD_ACTOR_TOKEN_PATTERN.test(input.token)) rejected();
    return withSystemTx(this.options.pool,async tx=>{
      // Each device renews every few seconds and writes only non-key columns of
      // its session row, so admissions share the revocation fence instead of
      // queueing engine work. NO KEY UPDATE stays compatible with the KEY SHARE
      // an approval recheck takes on the same session.
      const engine = await assertCurrentCloudEngineAuthority(tx,{...input,workosEnabled:this.options.workosEnabled,lock:"share"});
      await requireSupportedCloudWorkspaceGeneration(tx,input);
      const row = (await tx.query<Session>(`SELECT session.* FROM cloud_workspace_actor_sessions session
        JOIN cloud_workspace_engine_instances engine ON engine.id=session.engine_instance_id AND engine.actor_protocol_version=2
        WHERE session.token_hash=$1 AND session.workspace_id=$2 AND session.org_id=$3 AND session.generation=$4
          AND session.engine_instance_id=$5 AND session.authority_epoch=$6 AND session.revoked_at IS NULL AND session.session_expires_at>clock_timestamp()
          AND cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,session.auth_session_id,session.auth_session_created_at)
          AND ((NOT $7::boolean AND session.consumed_at IS NULL AND session.admission_expires_at>clock_timestamp())
            OR ($7::boolean AND session.consumed_at IS NOT NULL AND session.last_renewed_at>clock_timestamp()-interval '30 seconds'))
        FOR NO KEY UPDATE OF session`,[hash(input.token),input.workspaceId,input.organizationId,input.generation,input.engineInstanceId,engine.authorityEpoch,input.renew===true])).rows[0];
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
    const deadline=Date.now()+10_000;
    const result=await withSystemTx(this.options.pool,tx=>this.authorizeRelayInTx(tx,token,{...options,consistentRead:true}),{consistentRead:true});
    return Date.now()<deadline?result:null;
  }
  private async authorizeRelayInTx(tx:Tx,token:string,options:{connected?:boolean;consistentRead?:boolean}):Promise<CloudEngineRelayGrant|null> {
      const row = (await tx.query<Session & {provider_resource_id:string;confirmed_until:Date}>(`SELECT session.*,binding.provider_resource_id,
          least(transaction_timestamp()+interval '10 seconds',engine.lease_expires_at,session.session_expires_at) AS confirmed_until
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
      let role:CloudWorkspaceActorRole;
      try {
        await requireSupportedCloudWorkspaceGeneration(tx,{workspaceId:row.workspace_id,organizationId:row.org_id,generation:row.generation},
          {consistentRead:options.consistentRead===true});
        ({role}=await assertRecordedCloudActor(tx,{workspaceId:row.workspace_id,organizationId:row.org_id,
        actorUserId:row.actor_user_id,actor:recordedActor(row),capability:"read"})); }
      catch (error) { if (error instanceof HttpError) return null; throw error; }
      if(row.confirmed_until.getTime()<=Date.now())return null;
      return {workspaceId:row.workspace_id,organizationId:row.org_id,generation:row.generation,
        authorityEpoch:Number(row.authority_epoch),engineInstanceId:row.engine_instance_id,resourceId:row.provider_resource_id,
        readOnly:role==="viewer"};
  }
}
