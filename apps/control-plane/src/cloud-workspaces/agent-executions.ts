import { devConnectionRuntime } from "../dev-connections/runtime.js";
import {createHash,randomUUID} from "node:crypto";
import { CloudRepositoryMcpSchema } from "./mcp-contract.js";
import { admitCustomization, validateCustomizationSnapshot } from "./mcp-admission.js";
import { cloudWorkspaceCustomization, type CloudCustomizationOperationSchema } from "./customization-workspace.js";
import type pg from "pg";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {readGithubGitAuthor} from "../github-git-author.js";
import {withSystemTx,type Tx} from "../db.js";
import {assertCloudEngineAuthorityDeadline,assertCurrentCloudEngineAuthority} from "./engine-authority.js";
import {assertCloudActorSession,assertRecordedCloudActor,type CloudActorEngineScope,type CloudRecordedActor} from "./actor-sessions.js";
import {authorizeCloudWorkspaceActor} from "./actors.js";
import {CloudAgentModelSchema} from "./agent-credentials.js";
import {readCloudAgentComputeTrust} from "./agent-compute-trust.js";
import {DatabaseCodexAuthRenewal} from "./codex-auth-renewal.js";
import {openCloudAgentCredential,type CloudAgentCredentialKind,type CloudAgentCredentialKeys} from "./agent-credential-envelope.js";
import {CloudBackgroundOperationSchema,readCloudBackgroundTasks,writeCloudBackgroundTasks} from "./agent-background-tasks.js";

const uuid=z.string().uuid(),identity=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const CloudAgentExecutionAdmissionSchema=z.object({executionId:identity,delegationId:uuid,provider:z.enum(["claude","cursor","codex"]),model:CloudAgentModelSchema,
  source:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("session"),actorSessionId:uuid}).strict(),
    z.object({kind:z.literal("command"),commandId:uuid,claimId:uuid}).strict(),
  ]),customization:z.object({version:z.union([z.literal(1),z.literal(2)]),repositoryServers:CloudRepositoryMcpSchema}).strict().optional()}).strict();
type Admission=z.infer<typeof CloudAgentExecutionAdmissionSchema>;
type EngineScope=Omit<CloudActorEngineScope,"actorSessionId">;
type Lease={id:string;delegation_id:string;credential_id:string;credential_revision:string;workspace_id:string;org_id:string;generation:number;
  engine_instance_id:string;actor_source_session_id:string;command_id:string|null;command_claim_id:string|null;execution_id:string;model:string;
  provider:"claude"|"cursor"|"codex";expires_at:Date;released_at:Date|null;customization_digest:string|null;
  background_enabled:boolean;background_conversation_id:string|null;background_deadline:Date|null;background_phase:"foreground"|"background"|null};
function leaseAdmission(lease:Lease):Admission{
  return {executionId:lease.execution_id,delegationId:lease.delegation_id,provider:lease.provider,model:lease.model,
    ...(lease.customization_digest?{customization:{version:1 as const,repositoryServers:[]}}:{}),
    // An explicitly retained lease owns spending after the originating command
    // settles. Recorded actor/device/authentication checks still run each time.
    source:lease.command_id&&!lease.background_deadline?{kind:"command",commandId:lease.command_id,claimId:lease.command_claim_id!}:
      {kind:"session",actorSessionId:lease.actor_source_session_id}};
}
type Session={id:string;actor_user_id:string;device_id:string;device_key_version:string;actor_fingerprint:string};
type Binding={material_mode?:string;id:string;owner_user_id:string;kind:CloudAgentCredentialKind;revision:string;current_version:number;key_version:number;
  nonce:Buffer;ciphertext:Buffer;auth_tag:Buffer;lease_expires_at:Date;grantee_user_id:string;owner_fingerprint:string;grantee_fingerprint:string;
  compute_fingerprint:string;compute_trust:string;material_ready:boolean;refresh_due:boolean;native_capabilities:Record<string,unknown>|null};
function rejected():never{throw new HttpError(403,"cloud_agent_authority_rejected","Agent execution authority is unavailable");}

class CredentialPublicationBusy extends HttpError {
  constructor(){super(503,"cloud_agent_credential_busy","Agent authority is temporarily busy");}
}
/** Only retry a known pre-dispatch lock conflict after its transaction has
 * rolled back. Never replay a transaction with an ambiguous commit or external
 * provider call; re-run the complete current authority check each time. */
export async function withCloudAgentCredentialRetry<T>(operation:()=>Promise<T>):Promise<T>{
  const deadline=performance.now()+1000;
  for(;;){try{return await operation();}catch(error){
    if(!(error instanceof CredentialPublicationBusy)||performance.now()>=deadline)throw error;
    await new Promise(resolve=>setTimeout(resolve,25));
  }}
}

type NativeCommandActor=CloudRecordedActor & {nativeCapability?:"goals"|"nativeFork"|"transcriptFork"};
async function source(tx:Tx,scope:EngineScope,input:Admission,retainedSessionId?:string):Promise<NativeCommandActor>{
    let sessionId:string;
    let nativeCapability:NativeCommandActor["nativeCapability"];
    if(input.source.kind==="session"){
      sessionId=input.source.actorSessionId;
      if(!retainedSessionId)await assertCloudActorSession(tx,scope,sessionId,"run");
    }else{
      const command=(await tx.query<{actor_source_session_id:string;operation:{kind?:string;strategy?:string}|null}>(`SELECT actor_source_session_id,payload->'operation' AS operation FROM cloud_workspace_commands
        WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4 AND generation=$5 AND execution_id=$6 AND claim_id=$7
          AND state='dispatching' AND payload->>'agentCredentialGrantId'=$8 AND payload->>'agentId'=$9 AND payload->>'model'=$10`,
      [input.source.commandId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation,input.executionId,input.source.claimId,input.delegationId,input.provider,input.model])).rows[0];
      if(!command?.actor_source_session_id)rejected();sessionId=command.actor_source_session_id;
      nativeCapability=command.operation?.kind==="goal"?"goals":command.operation?.kind==="fork"
        ?command.operation.strategy==="native"?"nativeFork":"transcriptFork":undefined;
    }
    if(retainedSessionId&&retainedSessionId!==sessionId)rejected();
    // Account purge can own credential parents before reaching this session.
    // Admission takes both parents without waiting and rolls back if busy.
    const source=(await tx.query<Session>(`SELECT id,actor_user_id,device_id,device_key_version,actor_fingerprint FROM cloud_workspace_actor_sessions
      WHERE id=$1 AND workspace_id=$2 AND org_id=$3 FOR KEY SHARE SKIP LOCKED`,[sessionId,scope.workspaceId,scope.organizationId])).rows[0];
    if(!source)rejected();
    const actor={sourceSessionId:source.id,actorUserId:source.actor_user_id,deviceId:source.device_id,
      deviceKeyVersion:Number(source.device_key_version),fingerprint:source.actor_fingerprint};
    await assertRecordedCloudActor(tx,{workspaceId:scope.workspaceId,organizationId:scope.organizationId,actorUserId:actor.actorUserId,actor,capability:"run"});
    return {...actor,...(nativeCapability?{nativeCapability}:{})};
  }

async function credentialBinding(tx:Tx,scope:EngineScope,input:Admission,actor:NativeCommandActor,allowStale=false):Promise<Binding>{
    const delegation=(await tx.query<{credential_id:string}>(`SELECT credential_id FROM cloud_agent_credential_delegations
      WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND grantee_user_id=$4`,[input.delegationId,scope.workspaceId,scope.organizationId,actor.actorUserId])).rows[0];
    if(!delegation)rejected();
    // All credential mutations take this parent before changing their grants.
    if(!(await tx.query("SELECT id FROM cloud_agent_credentials WHERE id=$1 FOR SHARE SKIP LOCKED",[delegation.credential_id])).rowCount){
      if((await tx.query("SELECT 1 FROM cloud_agent_credentials WHERE id=$1 AND revoked_at IS NULL",[delegation.credential_id])).rowCount)throw new CredentialPublicationBusy();
      rejected();
    }
    const row=(await tx.query<Binding>(`SELECT credential.id,credential.owner_user_id,credential.kind,credential.revision,credential.current_version,
        material.material_mode,material.key_version,material.nonce,material.ciphertext,material.auth_tag,delegation.grantee_user_id,delegation.owner_fingerprint,delegation.grantee_fingerprint,
        delegation.compute_fingerprint,delegation.compute_trust,qualification.native_capabilities,
        (material.material_expires_at IS NULL OR material.material_expires_at>clock_timestamp()+interval '1 minute') AS material_ready,
        material.material_expires_at<=clock_timestamp()+interval '10 minutes' AS refresh_due,
        least(clock_timestamp()+interval '45 seconds',delegation.expires_at,material.material_expires_at) AS lease_expires_at
      FROM cloud_agent_credentials credential
      JOIN cloud_agent_credential_versions material ON material.credential_id=credential.id AND material.version=credential.current_version
      JOIN cloud_agent_credential_delegations delegation ON delegation.credential_id=credential.id AND delegation.owner_user_id=credential.owner_user_id
        AND delegation.credential_revision=credential.revision
      JOIN cloud_workspace_engine_instances engine ON engine.id=$5 AND engine.workspace_id=delegation.workspace_id AND engine.org_id=delegation.org_id
        AND engine.generation=$6 AND engine.actor_protocol_version=2
      JOIN cloud_workspace_generations generation ON generation.workspace_id=engine.workspace_id AND generation.org_id=engine.org_id AND generation.generation=engine.generation
      JOIN cloud_agent_runtime_qualifications qualification ON qualification.provider=generation.provider::text AND qualification.image_ref=generation.image_ref
        AND qualification.runtime_contract_sha256=engine.agent_runtime_contract_sha256 AND qualification.profile=engine.agent_runtime_profile
        AND qualification.credential_kind=credential.kind AND qualification.enabled
        AND (NOT $8::boolean OR qualification.mcp_qualified)
        AND ($9::text IS NULL OR (qualification.native_capabilities->>'version'='1' AND qualification.native_capabilities->>$9='true'))
      WHERE delegation.id=$1 AND delegation.workspace_id=$2 AND delegation.org_id=$3 AND delegation.grantee_user_id=$4
        AND credential.revoked_at IS NULL AND delegation.revoked_at IS NULL AND delegation.expires_at>clock_timestamp()+interval '5 seconds'
        AND $7=ANY(delegation.models)
      FOR SHARE OF delegation,material`,
    [input.delegationId,scope.workspaceId,scope.organizationId,actor.actorUserId,scope.engineInstanceId,scope.generation,input.model,!!input.customization,actor.nativeCapability??null])).rows[0];
    if(!row||(!allowStale&&!row.material_ready))rejected();
    if(!row.kind.startsWith(`${input.provider}-`))rejected();
    const compute=await readCloudAgentComputeTrust(tx,scope.workspaceId);
    if(!compute||row.compute_fingerprint!==compute.fingerprint||row.compute_trust!==compute.trust)rejected();
    const owner=await authorizeCloudWorkspaceActor(tx,{workspaceId:scope.workspaceId,organizationId:scope.organizationId,actorUserId:row.owner_user_id,capability:"run"});
    if(owner.fingerprint!==row.owner_fingerprint||actor.fingerprint!==row.grantee_fingerprint)rejected();
    // The share locks above can wait. Compute material readiness and the lease
    // deadline again after those locks, immediately before credential delivery.
    const current=(await tx.query<Pick<Binding,"material_ready"|"refresh_due"|"lease_expires_at">>(`SELECT
      (material.material_expires_at IS NULL OR material.material_expires_at>clock_timestamp()+interval '1 minute') AS material_ready,
      material.material_expires_at<=clock_timestamp()+interval '10 minutes' AS refresh_due,
      least(clock_timestamp()+interval '45 seconds',delegation.expires_at,material.material_expires_at) AS lease_expires_at
      FROM cloud_agent_credential_delegations delegation
      JOIN cloud_agent_credential_versions material ON material.credential_id=delegation.credential_id AND material.version=$2
      WHERE delegation.id=$1 AND delegation.expires_at>clock_timestamp()+interval '5 seconds'`,[input.delegationId,row.current_version])).rows[0];
    if(!current||(!allowStale&&!current.material_ready))rejected();
    Object.assign(row,current);
    return row;
  }

/** Sharing a workspace does not share the original actor's paid credentials.
 * Revalidate that execution, then independently authorize the acting member's
 * consent to the SAME credential revision, model and compute boundary. */
export async function assertCloudAgentExecutionActor(tx:Tx,scope:EngineScope,executionId:string,actorSessionId:string,workosEnabled:boolean){
  if(!identity.safeParse(executionId).success||!uuid.safeParse(actorSessionId).success)rejected();
  const lease=(await tx.query<Lease>(`SELECT * FROM cloud_agent_execution_leases
    WHERE execution_id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4 AND generation=$5
      AND released_at IS NULL AND expires_at>clock_timestamp() AND (background_deadline IS NULL OR background_deadline>clock_timestamp())`,[executionId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation])).rows[0];
  if(!lease)rejected();
  const input=leaseAdmission(lease);
  // Lock both source identities before credentials; account erasure takes
  // credential parents first, so these source locks deliberately never wait.
  const original=await source(tx,scope,input,lease.actor_source_session_id);
  const actor=await source(tx,scope,{...input,source:{kind:"session",actorSessionId}});
  if(lease.background_deadline&&actor.actorUserId!==original.actorUserId)rejected();
  if(lease.customization_digest)await validateCustomizationSnapshot(tx,lease.id,actor.actorUserId);
  const originalBinding=await credentialBinding(tx,scope,input,original);
  if(originalBinding.revision!==lease.credential_revision||originalBinding.id!==lease.credential_id)rejected();
  const grant=(await tx.query<{id:string}>(`SELECT id FROM cloud_agent_credential_delegations
    WHERE credential_id=$1 AND credential_revision=$2 AND workspace_id=$3 AND org_id=$4 AND grantee_user_id=$5
      AND grantee_fingerprint=$6 AND owner_fingerprint=$7 AND compute_fingerprint=$8 AND compute_trust=$9
      AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval '5 seconds' AND $10=ANY(models)
    ORDER BY expires_at DESC,id LIMIT 1`,[lease.credential_id,lease.credential_revision,scope.workspaceId,scope.organizationId,actor.actorUserId,
      actor.fingerprint,originalBinding.owner_fingerprint,originalBinding.compute_fingerprint,originalBinding.compute_trust,lease.model])).rows[0];
  if(!grant)rejected();
  const actingBinding=await credentialBinding(tx,scope,{...input,delegationId:grant.id},actor);
  if(actingBinding.id!==lease.credential_id||actingBinding.revision!==lease.credential_revision)rejected();
  // Either binding may have waited. Recheck BOTH principals after the last
  // credential lock; only the new action's device must still be connected.
  await assertRecordedCloudActor(tx,{...scope,actorUserId:original.actorUserId,actor:original,capability:"run"});
  await assertCloudActorSession(tx,scope,actorSessionId,"run");
  await assertCloudEngineAuthorityDeadline(tx,scope.engineInstanceId,workosEnabled);
  if(!(await tx.query("SELECT 1 FROM cloud_agent_execution_leases WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()",[lease.id])).rowCount)rejected();
}

/** This private engine seam is never a browser credential-read endpoint. Each
 * lease binds one recorded actor, credential consent, model and execution to
 * a qualified provider/image. It cannot substitute the compute sponsor. */
export class DatabaseCloudAgentExecutionService {
  constructor(private readonly pool:pg.Pool,private readonly encryption:CloudAgentCredentialKeys,private readonly workosEnabled:boolean,
    private readonly codexRenewal=new DatabaseCodexAuthRenewal(pool,encryption)){}

  private transaction<T>(operation:(tx:Tx)=>Promise<T>){
    return withCloudAgentCredentialRetry(()=>withSystemTx(this.pool,operation));
  }
  customization(scope:EngineScope,actorSessionId:string,operation:z.infer<typeof CloudCustomizationOperationSchema>,params:unknown){
    return cloudWorkspaceCustomization(this.pool,this.encryption,this.workosEnabled,scope,actorSessionId,operation,params);
  }
  private async material(binding:Binding,tx:Tx,scope:EngineScope,input:Admission,forceVersion?:number){
    if(binding.material_mode==='dev-reference') {
      const runtime=devConnectionRuntime(this.pool,this.encryption); if(!runtime)rejected();
      const grant=await runtime.issue(tx,binding.id,binding.owner_user_id,scope.organizationId,
        {action:"agent",workspaceId:scope.workspaceId,model:input.model},forceVersion===undefined?undefined:{expectedVersion:forceVersion});
      if(grant.material.kind==='github-app')rejected();
      binding.current_version=grant.materialVersion??1;
      binding.lease_expires_at=new Date(Math.min(binding.lease_expires_at.getTime(),Date.parse(grant.expiresAt)));
      const material=grant.material;
      return material.kind==='codex-chatgpt'?{kind:material.kind,accessToken:material.accessToken,accountId:material.accountId,expiresAt:material.expiresAt}:
        material.kind==='claude-setup-token'?{kind:material.kind,accessToken:material.accessToken}:{kind:material.kind,apiKey:material.apiKey};
    }
    const material=openCloudAgentCredential({nonce:binding.nonce,ciphertext:binding.ciphertext,authTag:binding.auth_tag},
      {credentialId:binding.id,ownerUserId:binding.owner_user_id,kind:binding.kind,version:binding.current_version,keyVersion:binding.key_version},this.encryption.keys);
    // Positive projection: native caches, refresh and ID tokens can never
    // enter the engine protocol, including future additions to the envelope.
    if(material.kind==="codex-chatgpt")return {kind:material.kind,accessToken:material.accessToken,accountId:material.accountId,expiresAt:material.expiresAt};
    return material.kind==="claude-setup-token"?{kind:material.kind,accessToken:material.accessToken}:{kind:material.kind,apiKey:material.apiKey};
  }
  private authority(scope:EngineScope,input:Admission,actor:CloudRecordedActor,binding:Binding,customizationDigest?:string){
    return createHash("sha256").update(JSON.stringify([scope.workspaceId,scope.generation,scope.engineInstanceId,actor.actorUserId,
      actor.fingerprint,actor.sourceSessionId,input.delegationId,binding.id,binding.revision,input.model,binding.kind,binding.compute_fingerprint,binding.compute_trust,
      ...(customizationDigest?[customizationDigest]:[])])).digest("hex");
  }

  private async publicationAuthority(tx:Tx,scope:EngineScope,input:Admission,actor:CloudRecordedActor,retained:boolean){
    // Retained executions and queued commands survive socket disconnects;
    // identity, source authentication, paid access and device trust never do.
    if(!retained&&input.source.kind==="session")await assertCloudActorSession(tx,scope,actor.sourceSessionId,"run");
    else await assertRecordedCloudActor(tx,{...scope,actorUserId:actor.actorUserId,actor,capability:"run"});
    await assertCloudEngineAuthorityDeadline(tx,scope.engineInstanceId,this.workosEnabled);
  }

  async authorizeAction(scope:EngineScope,executionId:string,actorSessionId:string){
    return this.transaction(async tx=>{
      // A pure recheck on the approval path: share the revocation fence.
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled,lock:"share"});
      await assertCloudAgentExecutionActor(tx,scope,executionId,actorSessionId,this.workosEnabled);
      return {authorized:true as const,executionId,actorSessionId};
    });
  }

  async admit(scope:EngineScope,value:unknown,includeGitAuthor=false,nativeCapabilitiesVersion?:1,backgroundTasksVersion?:1){
    const parsed=CloudAgentExecutionAdmissionSchema.safeParse(value);if(!parsed.success)rejected();const input=parsed.data;
    const dev=devConnectionRuntime(this.pool,this.encryption);
    if(dev)await dev.consumeInvalidations();
    for(let attempt=0;attempt<2;attempt++){
    const result=await this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      const previous=(await tx.query<Lease>("SELECT * FROM cloud_agent_execution_leases WHERE engine_instance_id=$1 AND execution_id=$2",[scope.engineInstanceId,input.executionId])).rows[0];
      if(previous){
        if(Boolean(previous.customization_digest)!==Boolean(input.customization))rejected();
        if(previous.delegation_id!==input.delegationId||previous.provider!==input.provider||previous.model!==input.model||previous.released_at||
          (input.source.kind==="session"?(previous.actor_source_session_id!==input.source.actorSessionId||previous.command_id!==null):
            previous.command_id!==input.source.commandId||previous.command_claim_id!==input.source.claimId))rejected();
        if(!(await tx.query("SELECT 1 FROM cloud_agent_execution_leases WHERE id=$1 AND expires_at>clock_timestamp()",[previous.id])).rowCount)rejected();
      }
      const actor=await source(tx,scope,input,previous?.actor_source_session_id),binding=await credentialBinding(tx,scope,input,actor,true);
      if(dev&&binding.material_mode!=='dev-reference')rejected();
      if(previous&&previous.credential_revision!==binding.revision)rejected();
      if(binding.material_mode!=="dev-reference"&&attempt===0&&binding.kind==="codex-chatgpt"&&binding.refresh_due){
        const renewal=await this.codexRenewal.reserve(tx,binding);if(renewal){await this.publicationAuthority(tx,scope,input,actor,!!previous);return {renewal};}
      }
      if(!binding.material_ready)rejected();
      if(previous&&!(await tx.query("SELECT 1 FROM cloud_agent_execution_leases WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()",[previous.id])).rowCount)rejected();
      if(!previous){
        const count=(await tx.query<{n:number}>(`SELECT count(*)::int AS n FROM cloud_agent_execution_leases
          WHERE workspace_id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()`,[scope.workspaceId])).rows[0]!.n;
        if(count>=8)throw new HttpError(429,"cloud_agent_execution_limit","Concurrent agent execution limit reached");
      }
      const leaseId=previous?.id??randomUUID();
      if(!previous)await tx.query(`INSERT INTO cloud_agent_execution_leases(id,delegation_id,credential_id,credential_revision,workspace_id,org_id,generation,
        engine_instance_id,actor_source_session_id,command_id,command_claim_id,execution_id,model,expires_at,provider)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [leaseId,input.delegationId,binding.id,binding.revision,scope.workspaceId,scope.organizationId,scope.generation,scope.engineInstanceId,actor.sourceSessionId,
        input.source.kind==="command"?input.source.commandId:null,input.source.kind==="command"?input.source.claimId:null,input.executionId,input.model,binding.lease_expires_at,input.provider]);
      if(backgroundTasksVersion===1&&!previous)await tx.query("UPDATE cloud_agent_execution_leases SET background_enabled=true WHERE id=$1",[leaseId]);
      const customization=input.customization?await admitCustomization(tx,{organizationId:scope.organizationId,workspaceId:scope.workspaceId,actorUserId:actor.actorUserId},
        leaseId,input.customization.repositoryServers,this.encryption,!!previous,input.customization.version===2):undefined;
      await this.publicationAuthority(tx,scope,input,actor,!!previous);
      if(customization&&!(await tx.query("SELECT 1 FROM cloud_agent_execution_leases WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()",[leaseId])).rowCount)rejected();
      const material=await this.material(binding,tx,scope,input);
      let publishedExpiry=previous?.expires_at??binding.lease_expires_at;
      if(binding.material_mode==='dev-reference'){
        await this.publicationAuthority(tx,scope,input,actor,!!previous);
        const bounded=(await tx.query<{expires_at:Date}>(`UPDATE cloud_agent_execution_leases SET expires_at=least(expires_at,$2)
          WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp() AND $2>clock_timestamp() RETURNING expires_at`,[leaseId,binding.lease_expires_at])).rows[0];
        if(!bounded)rejected();publishedExpiry=bounded.expires_at;
      }
      const authorityId=this.authority(scope,input,actor,binding,customization?.digest);
      return {leaseId,authorityId,expiresAt:publishedExpiry.toISOString(),credentialVersion:binding.current_version,
        ...(backgroundTasksVersion===1&&(!previous||previous.background_enabled)?{backgroundTasksVersion:1 as const}:{}),
        credentialKind:binding.kind,provider:input.provider,model:input.model,material,...(nativeCapabilitiesVersion===1&&binding.native_capabilities?{nativeCapabilities:binding.native_capabilities}:{}),...(customization?{customization}:{}),
        ...(includeGitAuthor?{gitAuthor:await readGithubGitAuthor(tx,actor.actorUserId)}:{})};
    });
    if("renewal" in result){await this.codexRenewal.complete(result.renewal!);continue;}
    return result;
    }
    return rejected();
  }

  async validate(scope:EngineScope,leaseId:string,renew=false,credentialVersion?:number,refresh=false,nativeCapabilitiesVersion?:1){
    if(!uuid.safeParse(leaseId).success)rejected();
    if(credentialVersion!==undefined&&(!Number.isSafeInteger(credentialVersion)||credentialVersion<1))rejected();
    if(refresh&&(!renew||credentialVersion===undefined))rejected();
    const dev=devConnectionRuntime(this.pool,this.encryption);
    if(dev)await dev.consumeInvalidations();
    for(let attempt=0;attempt<2;attempt++){
    const result=await this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      const lease=(await tx.query<Lease>(`SELECT * FROM cloud_agent_execution_leases WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4
        AND generation=$5 AND released_at IS NULL AND expires_at>clock_timestamp()
        AND (background_deadline IS NULL OR background_deadline>clock_timestamp())`,[leaseId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation])).rows[0];
      if(!lease)rejected();
      const input=leaseAdmission(lease);
      const actor=await source(tx,scope,input,lease.actor_source_session_id),binding=await credentialBinding(tx,scope,input,actor,true);
      if(dev&&binding.material_mode!=='dev-reference')rejected();
      if(lease.customization_digest)await validateCustomizationSnapshot(tx,lease.id,actor.actorUserId);
      if(binding.revision!==lease.credential_revision||binding.id!==lease.credential_id)rejected();
      if(binding.material_mode!=="dev-reference"&&credentialVersion!==undefined&&credentialVersion>binding.current_version)rejected();
      if(refresh&&binding.kind!=="codex-chatgpt")rejected();
      const force=refresh&&credentialVersion===binding.current_version;
      if(binding.material_mode!=="dev-reference"&&attempt===0&&binding.kind==="codex-chatgpt"&&(force||binding.refresh_due)){
        const renewal=await this.codexRenewal.reserve(tx,binding,force);if(renewal){await this.publicationAuthority(tx,scope,input,actor,true);return {renewal};}
      }
      const remoteMaterial=binding.material_mode==='dev-reference'?await this.material(binding,tx,scope,input,refresh?credentialVersion:undefined):undefined;
      if(!binding.material_ready||(refresh&&credentialVersion===binding.current_version))rejected();
      if(lease.background_deadline)binding.lease_expires_at=new Date(Math.min(binding.lease_expires_at.getTime(),lease.background_deadline.getTime()));
      const current=await tx.query(`UPDATE cloud_agent_execution_leases SET expires_at=CASE WHEN $2 THEN $3 ELSE expires_at END
        WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()
          AND (background_deadline IS NULL OR background_deadline>clock_timestamp())`,[leaseId,renew,binding.lease_expires_at]);
      if(!current.rowCount)rejected();
      await this.publicationAuthority(tx,scope,input,actor,true);
      return {leaseId,expiresAt:(renew?binding.lease_expires_at:lease.expires_at).toISOString(),credentialVersion:binding.current_version,
        ...(nativeCapabilitiesVersion===1&&binding.native_capabilities?{nativeCapabilities:binding.native_capabilities}:{}),
        ...(credentialVersion!==undefined&&credentialVersion<binding.current_version?{rotation:{authorityId:this.authority(scope,input,actor,binding,lease.customization_digest??undefined),material:remoteMaterial??await this.material(binding,tx,scope,input)}}:{})};
    });
    if("renewal" in result){await this.codexRenewal.complete(result.renewal!);continue;}
    return result;
    }
    return rejected();
  }

  async background(scope:EngineScope,leaseId:string,value:unknown){
    const parsed=CloudBackgroundOperationSchema.safeParse(value);if(!parsed.success)rejected();const operation=parsed.data;
    // Includes refresh and Dev invalidation processing. Recheck authority in
    // the transaction below; this prior validation is never a mutation grant.
    await this.validate(scope,leaseId);
    return this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      const lease=(await tx.query<Lease>(`SELECT * FROM cloud_agent_execution_leases WHERE id=$1 AND workspace_id=$2 AND org_id=$3
        AND engine_instance_id=$4 AND generation=$5 AND background_enabled AND released_at IS NULL AND expires_at>clock_timestamp()
        AND (background_deadline IS NULL OR background_deadline>clock_timestamp()) FOR UPDATE`,
        [leaseId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation])).rows[0];
      if(!lease||(lease.background_conversation_id&&lease.background_conversation_id!==operation.conversationId))rejected();
      const input=leaseAdmission(lease),actor=await source(tx,scope,input,lease.actor_source_session_id);
      let next:Admission|undefined,incoming:NativeCommandActor|undefined;
      if(operation.kind==="resume"){
        const parsedAdmission=CloudAgentExecutionAdmissionSchema.safeParse(operation.admission);
        if(!parsedAdmission.success)rejected();next=parsedAdmission.data;
        if(lease.background_phase!=="background"||next.executionId!==lease.execution_id||next.delegationId!==lease.delegation_id||
          next.provider!==lease.provider||next.model!==lease.model||next.source.kind!=="command")rejected();
        incoming=await source(tx,scope,next);
        if(incoming.actorUserId!==actor.actorUserId||incoming.fingerprint!==actor.fingerprint||
          incoming.deviceId!==actor.deviceId||incoming.deviceKeyVersion!==actor.deviceKeyVersion)rejected();
      }
      if(operation.kind==="retain"||operation.kind==="resume"){
        const commandId=next?.source.kind==="command"?next.source.commandId:lease.command_id;
        if(!commandId||!(await tx.query(`SELECT 1 FROM cloud_workspace_commands WHERE id=$1 AND conversation_id=$2
          AND workspace_id=$3 AND org_id=$4 AND state='dispatching' AND execution_id=$5`,
          [commandId,operation.conversationId,scope.workspaceId,scope.organizationId,lease.execution_id])).rowCount)rejected();
      }
      const binding=await credentialBinding(tx,scope,input,actor);
      if(binding.id!==lease.credential_id||binding.revision!==lease.credential_revision)rejected();
      if(next&&incoming){
        const nextBinding=await credentialBinding(tx,scope,{...input,source:next.source},incoming);
        if(nextBinding.id!==lease.credential_id||nextBinding.revision!==lease.credential_revision)rejected();
      }
      if(lease.customization_digest)await validateCustomizationSnapshot(tx,lease.id,actor.actorUserId);
      await this.publicationAuthority(tx,scope,input,actor,true);
      if(operation.kind==="retain"){
        if(!operation.snapshot.processWork&&!operation.snapshot.tasks.length)rejected();
        // Crash leftovers are bounded on the next admission, including after
        // engine replacement. Never present them as live tasks after expiry.
        await tx.query(`DELETE FROM cloud_agent_background_tasks WHERE lease_id IN (
          SELECT task.lease_id FROM cloud_agent_background_tasks task JOIN cloud_agent_execution_leases old ON old.id=task.lease_id
          WHERE old.workspace_id=$1 AND old.org_id=$2 AND (old.released_at IS NOT NULL OR old.expires_at<=clock_timestamp()
            OR old.background_deadline<=clock_timestamp()) LIMIT 64)`,[scope.workspaceId,scope.organizationId]);
        const updated=(await tx.query<Lease>(`UPDATE cloud_agent_execution_leases SET background_conversation_id=$2,
          background_deadline=coalesce(background_deadline,clock_timestamp()+interval '4 hours'),background_phase='background'
          WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()
            AND (background_deadline IS NULL OR background_deadline>clock_timestamp()) RETURNING *`,[leaseId,operation.conversationId])).rows[0];
        if(!updated)rejected();Object.assign(lease,updated);
      }else if(operation.kind==="resume"&&next?.source.kind==="command"){
        await tx.query("UPDATE cloud_agent_execution_leases SET background_phase='foreground',command_id=$2,command_claim_id=$3 WHERE id=$1",
          [leaseId,next.source.commandId,next.source.claimId]);
        lease.background_phase="foreground";
      }
      if(operation.kind==="sync"&&!lease.background_deadline)rejected();
      if(operation.kind==="sync"||operation.kind==="retain")await writeCloudBackgroundTasks(tx,leaseId,operation.revision,operation.snapshot);
      // Locks and task persistence may wait; do not publish an expired grant.
      await this.publicationAuthority(tx,scope,input,actor,true);
      if(!(await tx.query(`SELECT 1 FROM cloud_agent_execution_leases WHERE id=$1 AND released_at IS NULL
        AND expires_at>clock_timestamp() AND background_deadline>clock_timestamp()`,[leaseId])).rowCount)rejected();
      return readCloudBackgroundTasks(tx,lease);
    });
  }

  async release(scope:EngineScope,leaseId:string){
    if(!uuid.safeParse(leaseId).success)rejected();
    return this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      await tx.query("UPDATE cloud_agent_execution_leases SET released_at=coalesce(released_at,now()) WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4 AND generation=$5",
        [leaseId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation]);
      await tx.query(`DELETE FROM cloud_agent_background_tasks task USING cloud_agent_execution_leases lease
        WHERE task.lease_id=lease.id AND lease.id=$1 AND lease.workspace_id=$2 AND lease.org_id=$3 AND lease.engine_instance_id=$4 AND lease.generation=$5`,
        [leaseId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation]);
      return {released:true};
    });
  }
}
