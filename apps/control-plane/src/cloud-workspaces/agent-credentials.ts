import {createHash} from "node:crypto";
import type pg from "pg";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {withSystemTx,type Tx} from "../db.js";
import {authorizeCloudWorkspaceActor} from "./actors.js";
import {lockCloudWorkspaceScope} from "./authorization.js";
import {parseCloudAgentCredential,sealCloudAgentCredential,type CloudAgentCredentialKeys,type CloudAgentCredentialKind,type CloudAgentCredentialMaterial} from "./agent-credential-envelope.js";
import type {CloudWorkspaceBackendConfig} from "../config.js";
import {readCloudAgentComputeTrust} from "./agent-compute-trust.js";
import {CODEX_AUTH_RUNTIME_VERSION,parseCodexNativeCache,sealCodexNativeCache,type CodexNativeAuthCache} from "./codex-auth-cache.js";
import {rememberCodexRefreshSeed} from "./codex-auth-renewal.js";

const uuid=z.string().uuid().transform(value=>value.toLowerCase()),revision=z.number().int().positive().safe();
export const CloudAgentModelSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
export const CloudAgentDelegationSchema=z.object({id:uuid,credentialId:uuid,expectedRevision:revision,workspaceId:uuid,
  granteeUserId:uuid,models:z.array(CloudAgentModelSchema).min(1).max(32),expiresAt:z.string().datetime(),
  computeConsent:z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),trust:z.enum(["zeros-managed","compute-administrator"])}).strict().optional()}).strict();
type Credential={id:string;owner_user_id:string;kind:CloudAgentCredentialKind;display_name:string;revision:string;current_version:number;
  revoked_at:Date|null;last_operation_id:string;last_request_sha256:Buffer};
type Delegation={id:string;credential_id:string;owner_user_id:string;credential_revision:string;workspace_id:string;org_id:string;
  grantee_user_id:string;owner_fingerprint:string;grantee_fingerprint:string;compute_fingerprint:string;compute_trust:"zeros-managed"|"compute-administrator";models:string[];expires_at:Date;revoked_at:Date|null};
function invalid():never{throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");}
function unavailable():never{throw new HttpError(404,"agent_credential_unavailable","Agent credential access is unavailable");}
const metadata=(row:Credential)=>({id:row.id,kind:row.kind,displayName:row.display_name,revision:Number(row.revision),revoked:row.revoked_at!==null});
const grantMetadata=(row:Delegation)=>({id:row.id,credentialId:row.credential_id,credentialRevision:Number(row.credential_revision),
  workspaceId:row.workspace_id,granteeUserId:row.grantee_user_id,models:row.models,expiresAt:row.expires_at.toISOString(),revoked:row.revoked_at!==null,
  computeConsent:{fingerprint:row.compute_fingerprint,trust:row.compute_trust}});

export function cloudAgentCredentialKeys(config:CloudWorkspaceBackendConfig|null):CloudAgentCredentialKeys|null{
  if(!config)return null;
  const currentKeyVersion=config.currentSettingsSecretEncryptionKeyVersion??(config.settingsSecretKeyV1?1:null);
  const keys:Record<number,string>={...(config.settingsSecretKeyV1?{1:config.settingsSecretKeyV1}:{}),...config.settingsSecretEncryptionKeys};
  return currentKeyVersion&&keys[currentKeyVersion]?{keys,currentKeyVersion,...(config.codexRefreshFingerprints?{refreshFingerprints:config.codexRefreshFingerprints}:{})}:null;
}

/** Only the credential's verified account may create, replace or delegate it.
 * Workspace managers can withdraw workspace access but cannot consent for a
 * provider account owner. Personal credentials never enter workspace settings. */
export class DatabaseCloudAgentCredentialService {
  constructor(private readonly pool:pg.Pool,private readonly encryption:CloudAgentCredentialKeys){}

  private async owner(tx:Tx,userId:string,requirePilot=false):Promise<void>{
    if(!uuid.safeParse(userId).success)unavailable();
    const account=await tx.query(`SELECT account.id FROM users account WHERE account.id=$1 AND account.auth_status='active' AND account.deleted_at IS NULL
      AND (NOT $2::boolean OR cloud_workspace_pilot_user_live(account.id))
      AND EXISTS(SELECT 1 FROM user_identities identity WHERE identity.user_id=account.id AND identity.provider='workos'
        AND identity.status='active' AND identity.email_verified_at IS NOT NULL) FOR KEY SHARE OF account SKIP LOCKED`,[userId,requirePilot]);
    if(account.rowCount!==1)unavailable();
  }

  async list(ownerUserId:string){
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      return {credentials:(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE owner_user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 100",[ownerUserId])).rows.map(metadata)};
    });
  }

  async importCodex(input:{ownerUserId:string;credentialId:string;operationId:string;expectedRevision:number;displayName:string;nativeCache:unknown}){
    let parsed;try{parsed=parseCodexNativeCache(input.nativeCache);}catch{invalid();}
    return this.put({...input,material:parsed.material},parsed.cache);
  }

  async put(input:{ownerUserId:string;credentialId:string;operationId:string;expectedRevision:number;displayName:string;material:unknown},nativeCache?:CodexNativeAuthCache){
    if(![input.credentialId,input.operationId].every(value=>uuid.safeParse(value).success)||
      !z.number().int().nonnegative().safe().safeParse(input.expectedRevision).success||
      !z.string().trim().min(1).max(80).safeParse(input.displayName).success)invalid();
    input={...input,credentialId:input.credentialId.toLowerCase(),operationId:input.operationId.toLowerCase(),ownerUserId:input.ownerUserId.toLowerCase()};
    let material:CloudAgentCredentialMaterial;try{material=parseCloudAgentCredential(input.material);}catch{invalid();}
    const displayName=input.displayName.trim(),hash=createHash("sha256").update(JSON.stringify(nativeCache?[displayName,material,nativeCache]:[displayName,material])).digest();
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,input.ownerUserId,true);
      // A per-owner transaction lock bounds concurrent creation without taking
      // mutable user authorization locks or allowing duplicate count checks.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412))",[input.ownerUserId]);
      const previous=(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE id=$1 FOR UPDATE",[input.credentialId])).rows[0];
      if(previous){
        if(previous.owner_user_id!==input.ownerUserId)unavailable();
        if(previous.last_operation_id===input.operationId){
          if(!previous.last_request_sha256.equals(hash)||Number(previous.revision)!==input.expectedRevision+1||previous.revoked_at)
            throw new HttpError(409,"agent_credential_conflict","Agent credential changed");
          return {credential:metadata(previous),replayed:true};
        }
        if(previous.revoked_at||Number(previous.revision)!==input.expectedRevision||previous.kind!==material.kind)
          throw new HttpError(409,"agent_credential_conflict","Agent credential changed");
      }else{
        if(input.expectedRevision!==0)throw new HttpError(409,"agent_credential_conflict","Agent credential changed");
        const count=(await tx.query<{n:number}>("SELECT count(*)::int AS n FROM cloud_agent_credentials WHERE owner_user_id=$1 AND revoked_at IS NULL",[input.ownerUserId])).rows[0]!.n;
        if(count>=100)throw new HttpError(429,"agent_credential_limit","Agent credential limit reached");
      }
      const version=(previous?.current_version??0)+1;
      if(version>=2_147_483_647||input.expectedRevision>=Number.MAX_SAFE_INTEGER-1)invalid();
      const keyVersion=this.encryption.currentKeyVersion,key=this.encryption.keys[keyVersion];
      if(!key)throw new Error("Agent credential encryption is unavailable");
      const envelope=sealCloudAgentCredential(material,{credentialId:input.credentialId,ownerUserId:input.ownerUserId,kind:material.kind,version,keyVersion},key);
      if(material.kind==="codex-chatgpt"&&!nativeCache){
        const live=await tx.query("SELECT 1 WHERE to_timestamp($1::bigint)>clock_timestamp()+interval '1 minute'",[material.expiresAt]);
        if(!live.rowCount)invalid();
      }
      const row=previous?(await tx.query<Credential>(`UPDATE cloud_agent_credentials SET display_name=$2,revision=revision+1,current_version=$3,
        last_operation_id=$4,last_request_sha256=$5,updated_at=now() WHERE id=$1 RETURNING *`,[input.credentialId,displayName,version,input.operationId,hash])).rows[0]!:
        (await tx.query<Credential>(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[input.credentialId,input.ownerUserId,material.kind,displayName,input.operationId,hash])).rows[0]!;
      await tx.query(`INSERT INTO cloud_agent_credential_versions(credential_id,version,key_version,nonce,ciphertext,auth_tag,material_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::bigint))`,[row.id,version,keyVersion,envelope.nonce,envelope.ciphertext,envelope.authTag,material.kind==="codex-chatgpt"?material.expiresAt:null]);
      await tx.query("DELETE FROM cloud_agent_credential_versions WHERE credential_id=$1 AND version<>$2",[row.id,version]);
      await tx.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=$1",[row.id]);
      if(nativeCache){
        const parsed=parseCodexNativeCache(nativeCache);
        if(material.kind!=="codex-chatgpt"||JSON.stringify(parsed.material)!==JSON.stringify(material))invalid();
        await rememberCodexRefreshSeed(tx,row.id,nativeCache.tokens.refresh_token,this.encryption,true);
        const sealed=sealCodexNativeCache(nativeCache,{credentialId:row.id,ownerUserId:input.ownerUserId,revision:Number(row.revision),version,keyVersion},key);
        await tx.query(`INSERT INTO cloud_codex_auth_caches(credential_id,credential_revision,material_version,runtime_version,binding_sha256,key_version,nonce,ciphertext,auth_tag)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[row.id,row.revision,version,CODEX_AUTH_RUNTIME_VERSION,parsed.bindingSha256,keyVersion,sealed.nonce,sealed.ciphertext,sealed.authTag]);
      }
      await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=$1 AND revoked_at IS NULL",[row.id]);
      return {credential:metadata(row),replayed:false};
    });
  }

  async revoke(ownerUserId:string,credentialId:string){
    if(!uuid.safeParse(credentialId).success)invalid();
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      const row=(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",[credentialId,ownerUserId])).rows[0];
      if(!row)unavailable();
      if(!row.revoked_at)await tx.query("UPDATE cloud_agent_credentials SET revoked_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",[credentialId]);
      await tx.query("DELETE FROM cloud_agent_credential_versions WHERE credential_id=$1",[credentialId]);
      await tx.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=$1",[credentialId]);
      await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=$1 AND revoked_at IS NULL",[credentialId]);
      return {revoked:true};
    });
  }

  async delegate(ownerUserId:string,value:unknown){
    const parsed=CloudAgentDelegationSchema.safeParse(value);if(!parsed.success)invalid();
    const input=parsed.data,models=[...new Set(input.models)].sort();
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId,true);
      if(!(await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE SKIP LOCKED",[input.granteeUserId])).rowCount)unavailable();
      const workspace=(await tx.query<{org_id:string}>("SELECT org_id FROM cloud_workspaces WHERE id=$1 AND deleted_at IS NULL",[input.workspaceId])).rows[0];
      if(!workspace)unavailable();
      const scope={workspaceId:input.workspaceId,organizationId:workspace.org_id};
      await lockCloudWorkspaceScope(tx,{...scope,workspaceLock:"update"});
      const owner=await authorizeCloudWorkspaceActor(tx,{...scope,actorUserId:ownerUserId,capability:"run"});
      const grantee=await authorizeCloudWorkspaceActor(tx,{...scope,actorUserId:input.granteeUserId,capability:"run"});
      const compute=await readCloudAgentComputeTrust(tx,input.workspaceId);if(!compute)unavailable();
      if((compute.trust==="compute-administrator"&&!input.computeConsent)||
        (input.computeConsent&&(input.computeConsent.fingerprint!==compute.fingerprint||input.computeConsent.trust!==compute.trust)))invalid();
      const credential=(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL FOR UPDATE",[input.credentialId,ownerUserId])).rows[0];
      if(!credential)unavailable();
      if(Number(credential.revision)!==input.expectedRevision)throw new HttpError(409,"agent_credential_conflict","Agent credential changed");
      const existing=(await tx.query<Delegation>("SELECT * FROM cloud_agent_credential_delegations WHERE id=$1",[input.id])).rows[0];
      if(existing){
        if(existing.owner_user_id!==ownerUserId||existing.credential_id!==input.credentialId||existing.workspace_id!==input.workspaceId||
          existing.grantee_user_id!==input.granteeUserId||Number(existing.credential_revision)!==input.expectedRevision||
          existing.owner_fingerprint!==owner.fingerprint||existing.grantee_fingerprint!==grantee.fingerprint||existing.revoked_at||
          existing.compute_fingerprint!==compute.fingerprint||existing.compute_trust!==compute.trust||
          existing.expires_at.toISOString()!==new Date(input.expiresAt).toISOString()||JSON.stringify(existing.models)!==JSON.stringify(models))
          throw new HttpError(409,"agent_delegation_conflict","Agent delegation changed");
        return {delegation:grantMetadata(existing),replayed:true};
      }
      const valid=await tx.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '30 days'",[input.expiresAt]);
      if(!valid.rowCount)invalid();
      const count=(await tx.query<{n:number}>("SELECT count(*)::int AS n FROM cloud_agent_credential_delegations WHERE credential_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[credential.id])).rows[0]!.n;
      if(count>=100)throw new HttpError(429,"agent_delegation_limit","Agent delegation limit reached");
      const row=(await tx.query<Delegation>(`INSERT INTO cloud_agent_credential_delegations(id,credential_id,owner_user_id,credential_revision,workspace_id,org_id,
        grantee_user_id,owner_fingerprint,grantee_fingerprint,models,expires_at,compute_fingerprint,compute_trust) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [input.id,credential.id,ownerUserId,input.expectedRevision,input.workspaceId,scope.organizationId,input.granteeUserId,owner.fingerprint,grantee.fingerprint,models,input.expiresAt,compute.fingerprint,compute.trust])).rows[0]!;
      return {delegation:grantMetadata(row),replayed:false};
    });
  }

  async revokeDelegation(ownerUserId:string,delegationId:string){
    if(!uuid.safeParse(delegationId).success)invalid();
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      const row=await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_user_id=$2 RETURNING id",[delegationId,ownerUserId]);
      if(!row.rowCount)unavailable();return {revoked:true};
    });
  }

  async listDelegations(ownerUserId:string,credentialId:string){
    if(!uuid.safeParse(credentialId).success)invalid();
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      if(!(await tx.query("SELECT id FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2",[credentialId,ownerUserId])).rowCount)unavailable();
      return {delegations:(await tx.query<Delegation>(`SELECT * FROM cloud_agent_credential_delegations
        WHERE credential_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC,id LIMIT 100`,[credentialId,ownerUserId])).rows.map(grantMetadata)};
    });
  }

  async forWorkspace(actorUserId:string,workspaceId:string){
    if(!uuid.safeParse(workspaceId).success)invalid();
    return withSystemTx(this.pool,async tx=>{
      const workspace=(await tx.query<{org_id:string}>("SELECT org_id FROM cloud_workspaces WHERE id=$1",[workspaceId])).rows[0];if(!workspace)unavailable();
      const actor=await authorizeCloudWorkspaceActor(tx,{workspaceId,organizationId:workspace.org_id,actorUserId,capability:"run"});
      const compute=await readCloudAgentComputeTrust(tx,workspaceId);if(!compute)unavailable();
      const rows=await tx.query<{id:string;kind:CloudAgentCredentialKind;owner_user_id:string;models:string[];expires_at:Date}>(`SELECT delegation.id,credential.kind,credential.owner_user_id,delegation.models,delegation.expires_at
        FROM cloud_agent_credential_delegations delegation JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id
        WHERE delegation.workspace_id=$1 AND delegation.org_id=$2 AND delegation.grantee_user_id=$3
          AND delegation.revoked_at IS NULL AND delegation.expires_at>clock_timestamp() AND credential.revoked_at IS NULL
          AND credential.revision=delegation.credential_revision AND delegation.grantee_fingerprint=$4
          AND delegation.compute_fingerprint=$5 AND delegation.compute_trust=$6
          AND delegation.owner_fingerprint=cloud_workspace_actor_fingerprint($1,credential.owner_user_id)
          AND cloud_workspace_actor_role($1,credential.owner_user_id) IN ('prompter','developer','manager','owner')
        ORDER BY delegation.created_at DESC,delegation.id LIMIT 100`,[workspaceId,workspace.org_id,actorUserId,actor.fingerprint,compute.fingerprint,compute.trust]);
      return {compute,delegations:rows.rows.map(row=>({id:row.id,kind:row.kind,ownerUserId:row.owner_user_id,models:row.models,expiresAt:row.expires_at.toISOString()}))};
    });
  }
}
