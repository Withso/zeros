import {createHash,randomUUID} from "node:crypto";
import type pg from "pg";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {withSystemTx,type Tx} from "../db.js";
import {assertCloudEngineAuthorityDeadline,assertCurrentCloudEngineAuthority} from "./engine-authority.js";
import {assertCloudActorSession,assertRecordedCloudActor,type CloudActorEngineScope,type CloudRecordedActor} from "./actor-sessions.js";
import {authorizeCloudWorkspaceActor} from "./actors.js";
import {CloudAgentModelSchema} from "./agent-credentials.js";
import {readCloudAgentComputeTrust} from "./agent-compute-trust.js";
import {DatabaseCodexAuthRenewal} from "./codex-auth-renewal.js";
import {openCloudAgentCredential,type CloudAgentCredentialKind,type CloudAgentCredentialKeys} from "./agent-credential-envelope.js";

const uuid=z.string().uuid(),identity=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const CloudAgentExecutionAdmissionSchema=z.object({executionId:identity,delegationId:uuid,provider:z.enum(["claude","cursor","codex"]),model:CloudAgentModelSchema,
  source:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("session"),actorSessionId:uuid}).strict(),
    z.object({kind:z.literal("command"),commandId:uuid,claimId:uuid}).strict(),
  ])}).strict();
type Admission=z.infer<typeof CloudAgentExecutionAdmissionSchema>;
type EngineScope=Omit<CloudActorEngineScope,"actorSessionId">;
type Lease={id:string;delegation_id:string;credential_id:string;credential_revision:string;workspace_id:string;org_id:string;generation:number;
  engine_instance_id:string;actor_source_session_id:string;command_id:string|null;command_claim_id:string|null;execution_id:string;model:string;
  provider:"claude"|"cursor"|"codex";expires_at:Date;released_at:Date|null};
type Session={id:string;actor_user_id:string;device_id:string;device_key_version:string;actor_fingerprint:string};
type Binding={id:string;owner_user_id:string;kind:CloudAgentCredentialKind;revision:string;current_version:number;key_version:number;
  nonce:Buffer;ciphertext:Buffer;auth_tag:Buffer;lease_expires_at:Date;grantee_user_id:string;owner_fingerprint:string;grantee_fingerprint:string;
  compute_fingerprint:string;compute_trust:string;material_ready:boolean;refresh_due:boolean};
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

async function source(tx:Tx,scope:EngineScope,input:Admission,retainedSessionId?:string):Promise<CloudRecordedActor>{
    let sessionId:string;
    if(input.source.kind==="session"){
      sessionId=input.source.actorSessionId;
      if(!retainedSessionId)await assertCloudActorSession(tx,scope,sessionId,"run");
    }else{
      const command=(await tx.query<{actor_source_session_id:string}>(`SELECT actor_source_session_id FROM cloud_workspace_commands
        WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4 AND generation=$5 AND execution_id=$6 AND claim_id=$7
          AND state='dispatching' AND payload->>'agentCredentialGrantId'=$8 AND payload->>'agentId'=$9 AND payload->>'model'=$10`,
      [input.source.commandId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation,input.executionId,input.source.claimId,input.delegationId,input.provider,input.model])).rows[0];
      if(!command?.actor_source_session_id)rejected();sessionId=command.actor_source_session_id;
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
    return actor;
  }

async function credentialBinding(tx:Tx,scope:EngineScope,input:Admission,actor:CloudRecordedActor,allowStale=false):Promise<Binding>{
    const delegation=(await tx.query<{credential_id:string}>(`SELECT credential_id FROM cloud_agent_credential_delegations
      WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND grantee_user_id=$4`,[input.delegationId,scope.workspaceId,scope.organizationId,actor.actorUserId])).rows[0];
    if(!delegation)rejected();
    // All credential mutations take this parent before changing their grants.
    if(!(await tx.query("SELECT id FROM cloud_agent_credentials WHERE id=$1 FOR SHARE SKIP LOCKED",[delegation.credential_id])).rowCount){
      if((await tx.query("SELECT 1 FROM cloud_agent_credentials WHERE id=$1 AND revoked_at IS NULL",[delegation.credential_id])).rowCount)throw new CredentialPublicationBusy();
      rejected();
    }
    const row=(await tx.query<Binding>(`SELECT credential.id,credential.owner_user_id,credential.kind,credential.revision,credential.current_version,
        material.key_version,material.nonce,material.ciphertext,material.auth_tag,delegation.grantee_user_id,delegation.owner_fingerprint,delegation.grantee_fingerprint,
        delegation.compute_fingerprint,delegation.compute_trust,
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
      WHERE delegation.id=$1 AND delegation.workspace_id=$2 AND delegation.org_id=$3 AND delegation.grantee_user_id=$4
        AND credential.revoked_at IS NULL AND delegation.revoked_at IS NULL AND delegation.expires_at>clock_timestamp()+interval '5 seconds'
        AND $7=ANY(delegation.models)
      FOR SHARE OF delegation,material`,
    [input.delegationId,scope.workspaceId,scope.organizationId,actor.actorUserId,scope.engineInstanceId,scope.generation,input.model])).rows[0];
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
      AND released_at IS NULL AND expires_at>clock_timestamp()`,[executionId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation])).rows[0];
  if(!lease)rejected();
  const input:Admission={executionId,delegationId:lease.delegation_id,provider:lease.provider,model:lease.model,
    source:lease.command_id?{kind:"command",commandId:lease.command_id,claimId:lease.command_claim_id!}:{kind:"session",actorSessionId:lease.actor_source_session_id}};
  // Lock both source identities before credentials; account erasure takes
  // credential parents first, so these source locks deliberately never wait.
  const original=await source(tx,scope,input,lease.actor_source_session_id);
  const actor=await source(tx,scope,{...input,source:{kind:"session",actorSessionId}});
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
  private material(binding:Binding){
    const material=openCloudAgentCredential({nonce:binding.nonce,ciphertext:binding.ciphertext,authTag:binding.auth_tag},
      {credentialId:binding.id,ownerUserId:binding.owner_user_id,kind:binding.kind,version:binding.current_version,keyVersion:binding.key_version},this.encryption.keys);
    // Positive projection: native caches, refresh and ID tokens can never
    // enter the engine protocol, including future additions to the envelope.
    if(material.kind==="codex-chatgpt")return {kind:material.kind,accessToken:material.accessToken,accountId:material.accountId,expiresAt:material.expiresAt};
    return material.kind==="claude-setup-token"?{kind:material.kind,accessToken:material.accessToken}:{kind:material.kind,apiKey:material.apiKey};
  }
  private authority(scope:EngineScope,input:Admission,actor:CloudRecordedActor,binding:Binding){
    return createHash("sha256").update(JSON.stringify([scope.workspaceId,scope.generation,scope.engineInstanceId,actor.actorUserId,
      actor.fingerprint,actor.sourceSessionId,input.delegationId,binding.id,binding.revision,input.model,binding.kind,binding.compute_fingerprint,binding.compute_trust])).digest("hex");
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
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      await assertCloudAgentExecutionActor(tx,scope,executionId,actorSessionId,this.workosEnabled);
      return {authorized:true as const,executionId,actorSessionId};
    });
  }

  async admit(scope:EngineScope,value:unknown){
    const parsed=CloudAgentExecutionAdmissionSchema.safeParse(value);if(!parsed.success)rejected();const input=parsed.data;
    for(let attempt=0;attempt<2;attempt++){
    const result=await this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      const previous=(await tx.query<Lease>("SELECT * FROM cloud_agent_execution_leases WHERE engine_instance_id=$1 AND execution_id=$2",[scope.engineInstanceId,input.executionId])).rows[0];
      if(previous){
        if(previous.delegation_id!==input.delegationId||previous.provider!==input.provider||previous.model!==input.model||previous.released_at||
          (input.source.kind==="session"?(previous.actor_source_session_id!==input.source.actorSessionId||previous.command_id!==null):
            previous.command_id!==input.source.commandId||previous.command_claim_id!==input.source.claimId))rejected();
        if(!(await tx.query("SELECT 1 FROM cloud_agent_execution_leases WHERE id=$1 AND expires_at>clock_timestamp()",[previous.id])).rowCount)rejected();
      }
      const actor=await source(tx,scope,input,previous?.actor_source_session_id),binding=await credentialBinding(tx,scope,input,actor,true);
      if(previous&&previous.credential_revision!==binding.revision)rejected();
      if(attempt===0&&binding.kind==="codex-chatgpt"&&binding.refresh_due){
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
      await this.publicationAuthority(tx,scope,input,actor,!!previous);
      const material=this.material(binding),authorityId=this.authority(scope,input,actor,binding);
      return {leaseId,authorityId,expiresAt:(previous?.expires_at??binding.lease_expires_at).toISOString(),credentialVersion:binding.current_version,
        credentialKind:binding.kind,provider:input.provider,model:input.model,material};
    });
    if("renewal" in result){await this.codexRenewal.complete(result.renewal!);continue;}
    return result;
    }
    return rejected();
  }

  async validate(scope:EngineScope,leaseId:string,renew=false,credentialVersion?:number,refresh=false){
    if(!uuid.safeParse(leaseId).success)rejected();
    if(credentialVersion!==undefined&&(!Number.isSafeInteger(credentialVersion)||credentialVersion<1))rejected();
    if(refresh&&(!renew||credentialVersion===undefined))rejected();
    for(let attempt=0;attempt<2;attempt++){
    const result=await this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      const lease=(await tx.query<Lease>(`SELECT * FROM cloud_agent_execution_leases WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4
        AND generation=$5 AND released_at IS NULL AND expires_at>clock_timestamp()`,[leaseId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation])).rows[0];
      if(!lease)rejected();
      const input:Admission={executionId:lease.execution_id,delegationId:lease.delegation_id,provider:lease.provider,model:lease.model,
        source:lease.command_id?{kind:"command",commandId:lease.command_id,claimId:lease.command_claim_id!}:{kind:"session",actorSessionId:lease.actor_source_session_id}};
      const actor=await source(tx,scope,input,lease.actor_source_session_id),binding=await credentialBinding(tx,scope,input,actor,true);
      if(binding.revision!==lease.credential_revision||binding.id!==lease.credential_id)rejected();
      if(credentialVersion!==undefined&&credentialVersion>binding.current_version)rejected();
      if(refresh&&binding.kind!=="codex-chatgpt")rejected();
      const force=refresh&&credentialVersion===binding.current_version;
      if(attempt===0&&binding.kind==="codex-chatgpt"&&(force||binding.refresh_due)){
        const renewal=await this.codexRenewal.reserve(tx,binding,force);if(renewal){await this.publicationAuthority(tx,scope,input,actor,true);return {renewal};}
      }
      if(!binding.material_ready||(refresh&&credentialVersion===binding.current_version))rejected();
      const current=await tx.query(`UPDATE cloud_agent_execution_leases SET expires_at=CASE WHEN $2 THEN $3 ELSE expires_at END
        WHERE id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()`,[leaseId,renew,binding.lease_expires_at]);
      if(!current.rowCount)rejected();
      await this.publicationAuthority(tx,scope,input,actor,true);
      return {leaseId,expiresAt:(renew?binding.lease_expires_at:lease.expires_at).toISOString(),credentialVersion:binding.current_version,
        ...(credentialVersion!==undefined&&credentialVersion<binding.current_version?{rotation:{authorityId:this.authority(scope,input,actor,binding),material:this.material(binding)}}:{})};
    });
    if("renewal" in result){await this.codexRenewal.complete(result.renewal!);continue;}
    return result;
    }
    return rejected();
  }

  async release(scope:EngineScope,leaseId:string){
    if(!uuid.safeParse(leaseId).success)rejected();
    return this.transaction(async tx=>{
      await assertCurrentCloudEngineAuthority(tx,{...scope,workosEnabled:this.workosEnabled});
      await tx.query("UPDATE cloud_agent_execution_leases SET released_at=coalesce(released_at,now()) WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND engine_instance_id=$4 AND generation=$5",
        [leaseId,scope.workspaceId,scope.organizationId,scope.engineInstanceId,scope.generation]);
      return {released:true};
    });
  }
}
