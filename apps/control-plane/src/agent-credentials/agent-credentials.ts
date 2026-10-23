import {createHash} from "node:crypto";
import type pg from "pg";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {withSystemTx,type Tx} from "../db.js";
import {parseCloudAgentCredential,sealCloudAgentCredential,type CloudAgentCredentialKeys,type CloudAgentCredentialKind,type CloudAgentCredentialMaterial} from "./agent-credential-envelope.js";
import type {CloudAgentCredentialConfig} from "./agent-credential-config.js";
import {CODEX_AUTH_RUNTIME_VERSION,parseCodexNativeCache,sealCodexNativeCache,type CodexNativeAuthCache} from "./codex-auth-cache.js";
import {rememberCodexRefreshSeed} from "./codex-auth-renewal.js";
import {cloudAgentModels} from "./agent-models.js";
import {cloudAgentConnectionHealth,type CloudAgentConnectionHealthRow} from "./agent-connection-health.js";
import { prepareCloudAgentCredentialRemoval, readCloudAgentCredentialRemoval, decideCloudAgentCredentialRemoval,
  assertCloudAgentCredentialMutationAllowed, serializeCloudAgentCredentialSourceMutation,
  pendingCloudAgentCredentialRemoteRemoval, acknowledgeCloudAgentCredentialRemoteRemoval,
  type CloudAgentCredentialRemovalOutcome } from "./agent-credential-mutations.js";

// Keep the shared schema/projection import acyclic; disabled paths do not load
// the Dev adapter or read its authority configuration.
async function devConnectionRuntime(pool:pg.Pool,keys:CloudAgentCredentialKeys){
  if(process.env.ZEROS_DEPLOY_ENV!=="dev"||process.env.ZEROS_DEV_CONNECTIONS_ENABLED!=="true")return null;
  return (await import("../dev-connections/runtime.js")).devConnectionRuntime(pool,keys);
}

const uuid=z.string().uuid().transform(value=>value.toLowerCase()),revision=z.number().int().positive().safe();
// Native context suffixes are part of the exact model identity, not a label.
export const CloudAgentModelSchema=z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/);
type Credential={id:string;owner_user_id:string;kind:CloudAgentCredentialKind;display_name:string;revision:string;current_version:number;
  revoked_at:Date|null;last_operation_id:string;last_request_sha256:Buffer;connection_method:"api"|"account"};
type OrganizationConnection={provider:string;revision:string;credential_id:string|null;credential_revision:string|null;models:string[];all_models:boolean;consent_fingerprint:string;request_sha256:Buffer};
const organizationConnectionInput=z.union([
  z.object({expectedRevision:z.number().int().nonnegative().safe(),credentialId:uuid,credentialRevision:revision,
    models:z.array(CloudAgentModelSchema).min(1).max(32),allModels:z.boolean().optional(),consent:z.literal("zeros-managed")}).strict(),
  z.object({expectedRevision:z.number().int().nonnegative().safe(),credentialId:z.null()}).strict(),
]);
function invalid():never{throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");}
function unavailable():never{throw new HttpError(404,"agent_credential_unavailable","Agent credential access is unavailable");}
const metadata=(row:Credential)=>({id:row.id,kind:row.kind,displayName:row.display_name,revision:Number(row.revision),revoked:row.revoked_at!==null,connectionMethod:row.connection_method});
/** Pure metadata port shared by credential stores; authorization stays with each store. */
export function cloudAgentCredentialConnectionMethod(material:CloudAgentCredentialMaterial):"account"|"api" {
  return material.kind==="claude-setup-token"||material.kind==="codex-chatgpt"||(material.kind==="cursor-api-key"&&material.expiresAt)?"account":"api";
}

export function cloudAgentCredentialKeys(config:CloudAgentCredentialConfig|null):CloudAgentCredentialKeys|null{
  if(!config)return null;
  const currentKeyVersion=config.currentSettingsSecretEncryptionKeyVersion??(config.settingsSecretKeyV1?1:null);
  const keys:Record<number,string>={};
  if(config.settingsSecretKeyV1)keys[1]=config.settingsSecretKeyV1;
  Object.assign(keys,config.settingsSecretEncryptionKeys);
  return currentKeyVersion&&keys[currentKeyVersion]?{keys,currentKeyVersion,...(config.codexRefreshFingerprints?{refreshFingerprints:config.codexRefreshFingerprints}:{})}:null;
}

/** Only the credential's verified account may create or replace it.
 * Organization membership never grants access to another member's provider material. */
export class DatabaseCloudAgentCredentialService {
  constructor(private readonly pool:pg.Pool,private readonly encryption:CloudAgentCredentialKeys){}

  async prepareRemoval(userId:string,value:unknown) {
    return this.drainRemoteRemoval(userId,await withSystemTx(this.pool,tx=>prepareCloudAgentCredentialRemoval(tx,userId,value)));
  }
  async readRemoval(userId:string,operationId:string) {
    return this.drainRemoteRemoval(userId,await withSystemTx(this.pool,tx=>readCloudAgentCredentialRemoval(tx,userId,operationId)));
  }
  async decideRemoval(userId:string,operationId:string,action:"confirm"|"cancel",value:unknown) {
    return this.drainRemoteRemoval(userId,await withSystemTx(this.pool,tx=>decideCloudAgentCredentialRemoval(tx,userId,operationId,action,value)));
  }
  private async drainRemoteRemoval(userId:string,outcome:CloudAgentCredentialRemovalOutcome){
    if(outcome.state!=="pending"||outcome.phase!=="removing")return outcome;
    const source=await withSystemTx(this.pool,tx=>pendingCloudAgentCredentialRemoteRemoval(tx,userId,outcome.operationId));
    if(!source)return outcome;
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(!dev)throw new HttpError(503,"cloud_agent_credential_busy","cloud_agent_credential_busy");
    let receipt;
    try {receipt=await dev.requestConditionalRemoval(userId,outcome.operationId,source);}
    catch(error){if((error instanceof HttpError)&&error.status<500)throw error;
      throw new HttpError(503,"cloud_agent_credential_busy","cloud_agent_credential_busy");}
    return withSystemTx(this.pool,tx=>acknowledgeCloudAgentCredentialRemoteRemoval(tx,userId,outcome.operationId,receipt));
  }

  private async owner(tx:Tx,userId:string,requirePro=false):Promise<void>{
    if(!uuid.safeParse(userId).success)unavailable();
    const account=await tx.query(`SELECT account.id FROM users account WHERE account.id=$1 AND account.auth_status='active' AND account.deleted_at IS NULL
      AND (NOT $2::boolean OR account_pro_user_live(account.id))
      AND EXISTS(SELECT 1 FROM user_identities identity WHERE identity.user_id=account.id AND identity.provider='workos'
        AND identity.status='active' AND identity.email_verified_at IS NOT NULL) FOR KEY SHARE OF account SKIP LOCKED`,[userId,requirePro]);
    if(account.rowCount!==1)unavailable();
  }

  async list(ownerUserId:string){
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      return {credentials:(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE owner_user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 100",[ownerUserId])).rows.map(metadata)};
    });
  }

  private async organizationConsent(tx:Tx,ownerUserId:string,organizationId:string):Promise<string>{
    if(!uuid.safeParse(organizationId).success)invalid();
    const row=(await tx.query<{fingerprint:string}>(`SELECT encode(digest(jsonb_build_array(
      organization.id,organization.authorization_revision,account.id,account.auth_revision,
      member.authorization_revision,member.role,member.created_at)::text,'sha256'),'hex') AS fingerprint
      FROM organization_members member JOIN organizations organization ON organization.id=member.org_id
      JOIN users account ON account.id=member.user_id
      WHERE member.org_id=$1 AND member.user_id=$2 AND organization.deleted_at IS NULL AND NOT organization.is_personal
      FOR SHARE OF organization,member`,[organizationId,ownerUserId])).rows[0];
    if(!row)unavailable();return row.fingerprint;
  }

  private async associateOrganization(tx:Tx,ownerUserId:string,organizationId:string,credentialId:string){
    await tx.query(`INSERT INTO cloud_agent_credential_organizations(org_id,owner_user_id,credential_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[organizationId,ownerUserId,credentialId]);
  }

  async organizationConnections(ownerUserId:string,organizationId:string){
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      await serializeCloudAgentCredentialSourceMutation(tx,ownerUserId);
      const fingerprint=await this.organizationConsent(tx,ownerUserId,organizationId);
      const credentials=(await tx.query<Credential>(`SELECT credential.*
        FROM cloud_agent_credential_organizations association
        JOIN cloud_agent_credentials credential ON credential.id=association.credential_id AND credential.owner_user_id=association.owner_user_id
        JOIN cloud_agent_credential_versions material ON material.credential_id=credential.id AND material.version=credential.current_version
        WHERE association.org_id=$1 AND association.owner_user_id=$2 AND credential.revoked_at IS NULL
        ORDER BY credential.created_at DESC,credential.id LIMIT 100`,[organizationId,ownerUserId])).rows;
      // Join the selected source and refresh metadata in one snapshot. A new
      // unselected import must not make an expired selection look connected.
      const connections=(await tx.query<OrganizationConnection&CloudAgentConnectionHealthRow>(`SELECT connection.*,
        credential.revision AS live_credential_revision,credential.kind AS credential_kind,
        material.version AS material_version,material.material_expires_at,
        cache.credential_revision AS refresh_revision,cache.material_version AS refresh_material_version,
        cache.runtime_version AS refresh_runtime_version,cache.state AS refresh_state,
        cache.attempt_started_at AS refresh_attempt_started_at,clock_timestamp() AS observed_at
        FROM cloud_agent_organization_connections connection
        LEFT JOIN cloud_agent_credential_organizations association ON association.org_id=connection.org_id
          AND association.owner_user_id=connection.owner_user_id AND association.credential_id=connection.credential_id
        LEFT JOIN cloud_agent_credentials credential ON credential.id=association.credential_id
          AND credential.owner_user_id=association.owner_user_id AND credential.revoked_at IS NULL
        LEFT JOIN cloud_agent_credential_versions material ON material.credential_id=credential.id AND material.version=credential.current_version
        LEFT JOIN cloud_codex_auth_caches cache ON cache.credential_id=credential.id AND credential.kind='codex-chatgpt'
        WHERE connection.org_id=$1 AND connection.owner_user_id=$2 ORDER BY connection.provider`,[organizationId,ownerUserId])).rows;
      return {credentials:credentials.map(metadata),connections:connections.map(row=>{
        const health=cloudAgentConnectionHealth(row,fingerprint);
        return {provider:row.provider,revision:Number(row.revision),credentialId:row.credential_id,
          models:[...cloudAgentModels(row.provider)],allModels:row.all_models,connected:health.status==="ready",health};
      })};
    });
  }

  /** Each organization selection belongs to the authenticated credential owner. */
  async setOrganizationConnection(ownerUserId:string,organizationId:string,provider:string,value:unknown){
    const parsed=organizationConnectionInput.safeParse(value);
    if(!parsed.success||!["claude","codex","cursor"].includes(provider))invalid();
    const input=parsed.data;
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(dev&&input.credentialId) {
      const reference=await withSystemTx(this.pool,tx=>tx.query("SELECT 1 FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2 AND org_id=$3 AND reference->>'kind' LIKE $4",[input.credentialId,ownerUserId,organizationId,`${provider}-%`]));
      if(reference.rowCount)return dev.selectAgent(ownerUserId,organizationId,input.credentialId,input.models,input.expectedRevision,input.credentialRevision,input.allModels===true);
    }
    if(dev&&!input.credentialId){
      const selected=await withSystemTx(this.pool,async tx=>(await tx.query<{credential_id:string;revision:string}>(`SELECT c.credential_id,c.revision FROM cloud_agent_organization_connections c
        JOIN dev_connection_references r ON r.binding_id=c.credential_id WHERE c.owner_user_id=$1 AND c.org_id=$2 AND c.provider=$3`,[ownerUserId,organizationId,provider])).rows[0]);
      if(selected){
        if(Number(selected.revision)!==input.expectedRevision)throw new HttpError(409,"agent_connection_conflict","Agent connection changed");
        await dev.remove(ownerUserId,organizationId,selected.credential_id,'organization');
        return {revision:input.expectedRevision+1,replayed:false};
      }
    }
    const models=input.credentialId?[...new Set(input.models)].sort():[];
    const allModels=input.credentialId!==null&&input.allModels===true;
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId,input.credentialId!==null);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412)) /*lock_purpose='agent-credential-owner'*/",[ownerUserId]);
      const fingerprint=await this.organizationConsent(tx,ownerUserId,organizationId);
      if (input.credentialId) await assertCloudAgentCredentialMutationAllowed(tx,ownerUserId,{credentialId:input.credentialId,organizationId});
      // Preserve released request hashes when the additive flag is absent/false.
      const hash=createHash("sha256").update(JSON.stringify([input.credentialId,input.credentialId?input.credentialRevision:null,models,fingerprint,...(allModels?["all-models"]:[])])).digest();
      const previous=(await tx.query<OrganizationConnection>(`SELECT * FROM cloud_agent_organization_connections
        WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3 FOR UPDATE`,[organizationId,ownerUserId,provider])).rows[0];
      if(previous&&Number(previous.revision)===input.expectedRevision+1&&previous.request_sha256.equals(hash)){

        return {revision:Number(previous.revision),replayed:true};
      }
      if((Number(previous?.revision) || 0)!==input.expectedRevision||input.expectedRevision>=Number.MAX_SAFE_INTEGER-1)
        throw new HttpError(409,"agent_connection_conflict","Agent connection changed. Refresh and try again.");
      if(input.credentialId){
        const credential=(await tx.query<Credential>(`SELECT credential.* FROM cloud_agent_credentials credential
          JOIN cloud_agent_credential_organizations association ON association.credential_id=credential.id AND association.owner_user_id=credential.owner_user_id
          WHERE credential.id=$1 AND credential.owner_user_id=$2 AND association.org_id=$3 AND credential.revoked_at IS NULL
          FOR UPDATE OF credential`,[input.credentialId,ownerUserId,organizationId])).rows[0];
        if(!credential||!credential.kind.startsWith(`${provider}-`))unavailable();
        if(Number(credential.revision)!==input.credentialRevision)throw new HttpError(409,"agent_credential_conflict","Agent credential changed");
      }
      const next=input.expectedRevision+1;
      await tx.query(`INSERT INTO cloud_agent_organization_connections(org_id,owner_user_id,provider,revision,credential_id,credential_revision,models,consent_fingerprint,request_sha256,all_models)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(org_id,owner_user_id,provider) DO UPDATE SET
        revision=EXCLUDED.revision,credential_id=EXCLUDED.credential_id,credential_revision=EXCLUDED.credential_revision,models=EXCLUDED.models,all_models=EXCLUDED.all_models,
        consent_fingerprint=EXCLUDED.consent_fingerprint,request_sha256=EXCLUDED.request_sha256,updated_at=now()`,
      [organizationId,ownerUserId,provider,next,input.credentialId,input.credentialId?input.credentialRevision:null,models,fingerprint,hash,allModels]);

      return {revision:next,replayed:false};
    });
  }

  async removeOrganizationCredential(ownerUserId:string,organizationId:string,credentialId:string){
    if(!uuid.safeParse(credentialId).success)invalid();
    await withSystemTx(this.pool,tx=>assertCloudAgentCredentialMutationAllowed(tx,ownerUserId,{credentialId,organizationId}));
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(dev){
      const reference=await withSystemTx(this.pool,tx=>tx.query("SELECT 1 FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2 AND org_id=$3",[credentialId,ownerUserId,organizationId]));
      if(reference.rowCount)return dev.remove(ownerUserId,organizationId,credentialId,'local');
    }
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412)) /*lock_purpose='agent-credential-owner'*/",[ownerUserId]);
      await this.organizationConsent(tx,ownerUserId,organizationId);
      await assertCloudAgentCredentialMutationAllowed(tx,ownerUserId,{credentialId,organizationId});
      await tx.query(`UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',revision=revision+1,request_sha256=digest(request_sha256,'sha256'),updated_at=now()
        WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3`,[organizationId,ownerUserId,credentialId]);
      await tx.query("DELETE FROM cloud_agent_credential_organizations WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3",[organizationId,ownerUserId,credentialId]);
      return {removed:true};
    });
  }

  async importCodex(input:{ownerUserId:string;organizationId?:string|undefined;credentialId:string;operationId:string;expectedRevision:number;displayName:string;nativeCache:unknown}){
    let parsed;try{parsed=parseCodexNativeCache(input.nativeCache);}catch{invalid();}
    const dev=input.organizationId?await devConnectionRuntime(this.pool,this.encryption):null;
    if(dev)return dev.connectAgent({...input,organizationId:input.organizationId!,material:{kind:"codex-chatgpt",nativeCache:parsed.cache}});
    return this.put({...input,material:parsed.material},parsed.cache);
  }

  async put(input:{ownerUserId:string;organizationId?:string|undefined;credentialId:string;operationId:string;expectedRevision:number;displayName:string;material:unknown},nativeCache?:CodexNativeAuthCache){
    if(![input.credentialId,input.operationId].every(value=>uuid.safeParse(value).success)||
      !z.number().int().nonnegative().safe().safeParse(input.expectedRevision).success||
      !z.string().trim().min(1).max(80).safeParse(input.displayName).success)invalid();
    const dev=input.organizationId?await devConnectionRuntime(this.pool,this.encryption):null;
    if(dev)return dev.connectAgent({...input,organizationId:input.organizationId!});
    input={...input,credentialId:input.credentialId.toLowerCase(),operationId:input.operationId.toLowerCase(),ownerUserId:input.ownerUserId.toLowerCase()};
    let material:CloudAgentCredentialMaterial;try{material=parseCloudAgentCredential(input.material);}catch{invalid();}
    const displayName=input.displayName.trim(),hashValues:unknown[]=nativeCache?[displayName,material,nativeCache]:[displayName,material];
    if(input.organizationId)hashValues.push(input.organizationId.toLowerCase());
    const hash=createHash("sha256").update(JSON.stringify(hashValues)).digest();
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,input.ownerUserId,true);
      if(input.organizationId)await this.organizationConsent(tx,input.ownerUserId,input.organizationId);
      // A per-owner transaction lock bounds concurrent creation without taking
      // mutable user authorization locks or allowing duplicate count checks.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412)) /*lock_purpose='agent-credential-owner'*/",[input.ownerUserId]);
      await assertCloudAgentCredentialMutationAllowed(tx,input.ownerUserId,{credentialId:input.credentialId});
      const previous=(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE id=$1 FOR UPDATE",[input.credentialId])).rows[0];
      if(previous){
        if(previous.owner_user_id!==input.ownerUserId)unavailable();
        if(previous.last_operation_id===input.operationId){
          if(!previous.last_request_sha256.equals(hash)||Number(previous.revision)!==input.expectedRevision+1||previous.revoked_at)
            throw new HttpError(409,"agent_credential_conflict","Agent credential changed");
          if(input.organizationId)await this.associateOrganization(tx,input.ownerUserId,input.organizationId,previous.id);

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
      if((material.kind==="codex-chatgpt"&&!nativeCache)||(material.kind==="cursor-api-key"&&material.expiresAt)){
        const live=await tx.query("SELECT 1 WHERE to_timestamp($1::bigint)>clock_timestamp()+interval '1 minute'",[material.expiresAt]);
        if(!live.rowCount)invalid();
      }
      const connectionMethod=cloudAgentCredentialConnectionMethod(material);
      const row=previous?(await tx.query<Credential>(`UPDATE cloud_agent_credentials SET display_name=$2,revision=revision+1,current_version=$3,
        last_operation_id=$4,last_request_sha256=$5,updated_at=now() WHERE id=$1 RETURNING *`,[input.credentialId,displayName,version,input.operationId,hash])).rows[0]!:
        (await tx.query<Credential>(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[input.credentialId,input.ownerUserId,material.kind,displayName,input.operationId,hash])).rows[0]!;
      await tx.query("UPDATE cloud_agent_credentials SET connection_method=$2 WHERE id=$1",[row.id,connectionMethod]);
      row.connection_method=connectionMethod;
      await tx.query(`INSERT INTO cloud_agent_credential_versions(credential_id,version,key_version,nonce,ciphertext,auth_tag,material_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::bigint))`,[row.id,version,keyVersion,envelope.nonce,envelope.ciphertext,envelope.authTag,"expiresAt" in material?material.expiresAt??null:null]);
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

      if(input.organizationId)await this.associateOrganization(tx,input.ownerUserId,input.organizationId,row.id);

      return {credential:metadata(row),replayed:false};
    });
  }

  async removeDevConnection(ownerUserId:string,organizationId:string,id:string,scope:"local"|"organization"|"global") {
    await withSystemTx(this.pool,tx=>assertCloudAgentCredentialMutationAllowed(tx,ownerUserId,
      {credentialId:id,...(scope==="global"?{}:{organizationId})}));
    const dev=await devConnectionRuntime(this.pool,this.encryption);if(!dev)unavailable();
    return dev.remove(ownerUserId,organizationId,id,scope);
  }
  async reattachDevConnection(ownerUserId:string,organizationId:string,id:string) {
    const dev=await devConnectionRuntime(this.pool,this.encryption);if(!dev)unavailable();
    return dev.reattach(ownerUserId,organizationId,id);
  }
  async revoke(ownerUserId:string,credentialId:string){
    if(!uuid.safeParse(credentialId).success)invalid();
    await withSystemTx(this.pool,tx=>assertCloudAgentCredentialMutationAllowed(tx,ownerUserId,{credentialId}));
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(dev){
      const reference=await withSystemTx(this.pool,async tx=>(await tx.query<{org_id:string}>("SELECT org_id FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2",[credentialId,ownerUserId])).rows[0]);
      if(reference){await dev.remove(ownerUserId,reference.org_id,credentialId,'local');return {revoked:true};}
    }
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      await serializeCloudAgentCredentialSourceMutation(tx,ownerUserId);
      const row=(await tx.query<Credential>("SELECT * FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",[credentialId,ownerUserId])).rows[0];
      if(!row)unavailable();
      await assertCloudAgentCredentialMutationAllowed(tx,ownerUserId,{credentialId});
      if(!row.revoked_at)await tx.query("UPDATE cloud_agent_credentials SET revoked_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",[credentialId]);
      await tx.query("DELETE FROM cloud_agent_credential_versions WHERE credential_id=$1",[credentialId]);
      await tx.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=$1",[credentialId]);

      return {revoked:true};
    });
  }

}
