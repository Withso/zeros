import {createHash,randomUUID} from "node:crypto";
import type pg from "pg";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {withSystemTx,type Tx} from "../db.js";
import {authorizeCloudWorkspaceActor} from "./actors.js";
import {lockCloudWorkspaceScope} from "./authorization.js";
import {parseCloudAgentCredential,sealCloudAgentCredential,type CloudAgentCredentialKeys,type CloudAgentCredentialKind,type CloudAgentCredentialMaterial} from "./agent-credential-envelope.js";
import type {CloudAgentCredentialConfig} from "./agent-credential-config.js";
import {readCloudAgentComputeTrust} from "./agent-compute-trust.js";
import {CODEX_AUTH_RUNTIME_VERSION,parseCodexNativeCache,sealCodexNativeCache,type CodexNativeAuthCache} from "./codex-auth-cache.js";
import {rememberCodexRefreshSeed} from "./codex-auth-renewal.js";
import {cloudRuntimeQualificationMode} from "./runtime-config.js";
import {runtimeCredentialQualificationJoin} from "./runtime-selection.js";

// Keep the shared schema/projection import acyclic; disabled paths do not load
// the Dev adapter or read its authority configuration.
async function devConnectionRuntime(pool:pg.Pool,keys:CloudAgentCredentialKeys){
  if(process.env.ZEROS_DEPLOY_ENV!=="dev"||process.env.ZEROS_DEV_CONNECTIONS_ENABLED!=="true")return null;
  return (await import("../dev-connections/runtime.js")).devConnectionRuntime(pool,keys);
}

const uuid=z.string().uuid().transform(value=>value.toLowerCase()),revision=z.number().int().positive().safe();
// Native context suffixes are part of the exact model identity, not a label.
export const CloudAgentModelSchema=z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/);
export const CloudAgentDelegationSchema=z.object({id:uuid,credentialId:uuid,expectedRevision:revision,workspaceId:uuid,
  granteeUserId:uuid,models:z.array(CloudAgentModelSchema).min(1).max(32),expiresAt:z.string().datetime(),
  computeConsent:z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),trust:z.enum(["zeros-managed","compute-administrator"])}).strict().optional()}).strict();
type Credential={id:string;owner_user_id:string;kind:CloudAgentCredentialKind;display_name:string;revision:string;current_version:number;
  revoked_at:Date|null;last_operation_id:string;last_request_sha256:Buffer;connection_method:"api"|"account";usable?:boolean};
type Delegation={id:string;credential_id:string;owner_user_id:string;credential_revision:string;workspace_id:string;org_id:string;
  grantee_user_id:string;owner_fingerprint:string;grantee_fingerprint:string;compute_fingerprint:string;compute_trust:"zeros-managed"|"compute-administrator";models:string[];expires_at:Date;revoked_at:Date|null};
type OrganizationConnection={provider:string;revision:string;credential_id:string|null;credential_revision:string|null;models:string[];consent_fingerprint:string;request_sha256:Buffer};
const organizationConnectionInput=z.union([
  z.object({expectedRevision:z.number().int().nonnegative().safe(),credentialId:uuid,credentialRevision:revision,
    models:z.array(CloudAgentModelSchema).min(1).max(32),consent:z.literal("zeros-managed")}).strict(),
  z.object({expectedRevision:z.number().int().nonnegative().safe(),credentialId:z.null()}).strict(),
]);
function invalid():never{throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");}
function unavailable():never{throw new HttpError(404,"agent_credential_unavailable","Agent credential access is unavailable");}
const metadata=(row:Credential)=>({id:row.id,kind:row.kind,displayName:row.display_name,revision:Number(row.revision),revoked:row.revoked_at!==null,connectionMethod:row.connection_method});
const grantMetadata=(row:Delegation)=>({id:row.id,credentialId:row.credential_id,credentialRevision:Number(row.credential_revision),
  workspaceId:row.workspace_id,granteeUserId:row.grantee_user_id,models:row.models,expiresAt:row.expires_at.toISOString(),revoked:row.revoked_at!==null,
  computeConsent:{fingerprint:row.compute_fingerprint,trust:row.compute_trust}});

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

/** Only the credential's verified account may create, replace or delegate it.
 * Workspace managers can withdraw workspace access but cannot consent for a
 * provider account owner. Personal credentials never enter workspace settings. */
export class DatabaseCloudAgentCredentialService {
  constructor(private readonly pool:pg.Pool,private readonly encryption:CloudAgentCredentialKeys){}

  private async owner(tx:Tx,userId:string,requirePro=false):Promise<void>{
    if(!uuid.safeParse(userId).success)unavailable();
    const account=await tx.query(`SELECT account.id FROM users account WHERE account.id=$1 AND account.auth_status='active' AND account.deleted_at IS NULL
      AND (NOT $2::boolean OR cloud_workspace_pro_user_live(account.id))
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

  /** Released writers have no organization column. Reconcile only their
   * explicit workspace delegations and actual membership, never consent. */
  private async reconcileLegacyOrganizations(tx:Tx,ownerUserId:string,organizationId:string){
    await tx.query(`INSERT INTO cloud_agent_credential_organizations(credential_id,org_id,owner_user_id)
      SELECT DISTINCT credential.id,delegation.org_id,credential.owner_user_id
      FROM cloud_agent_credential_delegations delegation
      JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id AND credential.owner_user_id=delegation.owner_user_id
      JOIN organization_members member ON member.org_id=delegation.org_id AND member.user_id=credential.owner_user_id
      JOIN organizations organization ON organization.id=member.org_id AND NOT organization.is_personal AND organization.deleted_at IS NULL
      WHERE delegation.org_id=$1 AND credential.owner_user_id=$2 AND credential.revoked_at IS NULL AND delegation.revoked_at IS NULL
      ON CONFLICT DO NOTHING`,[organizationId,ownerUserId]);
    await tx.query(`UPDATE cloud_agent_credentials credential SET connection_method=CASE
      WHEN credential.kind IN ('claude-setup-token','codex-chatgpt') OR
        (credential.kind='cursor-api-key' AND material.material_expires_at IS NOT NULL) THEN 'account' ELSE 'api' END
      FROM cloud_agent_credential_versions material
      WHERE credential.owner_user_id=$1 AND material.credential_id=credential.id AND material.version=credential.current_version
        AND material.material_mode='local' AND credential.connection_method IS DISTINCT FROM CASE WHEN credential.kind IN ('claude-setup-token','codex-chatgpt') OR
          (credential.kind='cursor-api-key' AND material.material_expires_at IS NOT NULL) THEN 'account' ELSE 'api' END`,[ownerUserId]);
  }

  async organizationConnections(ownerUserId:string,organizationId:string){
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      const fingerprint=await this.organizationConsent(tx,ownerUserId,organizationId);
      await this.reconcileLegacyOrganizations(tx,ownerUserId,organizationId);
      const credentials=(await tx.query<Credential>(`SELECT credential.*,
        (credential.kind<>'cursor-api-key' OR material.material_expires_at IS NULL OR material.material_expires_at>clock_timestamp()+interval '1 minute') AS usable
        FROM cloud_agent_credential_organizations association
        JOIN cloud_agent_credentials credential ON credential.id=association.credential_id AND credential.owner_user_id=association.owner_user_id
        JOIN cloud_agent_credential_versions material ON material.credential_id=credential.id AND material.version=credential.current_version
        WHERE association.org_id=$1 AND association.owner_user_id=$2 AND credential.revoked_at IS NULL
        ORDER BY credential.created_at DESC,credential.id LIMIT 100`,[organizationId,ownerUserId])).rows;
      const connections=(await tx.query<OrganizationConnection>(`SELECT * FROM cloud_agent_organization_connections
        WHERE org_id=$1 AND owner_user_id=$2 ORDER BY provider`,[organizationId,ownerUserId])).rows;
      return {credentials:credentials.map(metadata),connections:connections.map(row=>({provider:row.provider,revision:Number(row.revision),
        credentialId:row.credential_id,models:row.models,connected:row.consent_fingerprint===fingerprint&&credentials.some(
          credential=>credential.id===row.credential_id&&credential.revision===row.credential_revision&&credential.usable)}))};
    });
  }

  /** Consent applies only to this member's sessions on Zeros-managed compute.
   * Every workspace still receives an exact actor/model/compute-bound grant. */
  async setOrganizationConnection(ownerUserId:string,organizationId:string,provider:string,value:unknown){
    const parsed=organizationConnectionInput.safeParse(value);
    if(!parsed.success||!["claude","codex","cursor"].includes(provider))invalid();
    const input=parsed.data;
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(dev&&input.credentialId) {
      const reference=await withSystemTx(this.pool,tx=>tx.query("SELECT 1 FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2 AND org_id=$3 AND reference->>'kind' LIKE $4",[input.credentialId,ownerUserId,organizationId,`${provider}-%`]));
      if(reference.rowCount)return dev.selectAgent(ownerUserId,organizationId,input.credentialId,input.models,input.expectedRevision,input.credentialRevision);
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
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId,input.credentialId!==null);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412))",[ownerUserId]);
      const fingerprint=await this.organizationConsent(tx,ownerUserId,organizationId);
      await this.reconcileLegacyOrganizations(tx,ownerUserId,organizationId);
      const models=input.credentialId?[...new Set(input.models)].sort():[];
      const hash=createHash("sha256").update(JSON.stringify([input.credentialId,input.credentialId?input.credentialRevision:null,models,fingerprint])).digest();
      const previous=(await tx.query<OrganizationConnection>(`SELECT * FROM cloud_agent_organization_connections
        WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3 FOR UPDATE`,[organizationId,ownerUserId,provider])).rows[0];
      if(previous&&Number(previous.revision)===input.expectedRevision+1&&previous.request_sha256.equals(hash))
        return {revision:Number(previous.revision),replayed:true};
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
      await tx.query(`INSERT INTO cloud_agent_organization_connections(org_id,owner_user_id,provider,revision,credential_id,credential_revision,models,consent_fingerprint,request_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(org_id,owner_user_id,provider) DO UPDATE SET
        revision=EXCLUDED.revision,credential_id=EXCLUDED.credential_id,credential_revision=EXCLUDED.credential_revision,models=EXCLUDED.models,
        consent_fingerprint=EXCLUDED.consent_fingerprint,request_sha256=EXCLUDED.request_sha256,updated_at=now()`,
      [organizationId,ownerUserId,provider,next,input.credentialId,input.credentialId?input.credentialRevision:null,models,fingerprint,hash]);
      await tx.query(`UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now())
        WHERE org_id=$1 AND owner_user_id=$2 AND organization_provider=$3 AND revoked_at IS NULL`,[organizationId,ownerUserId,provider]);
      return {revision:next,replayed:false};
    });
  }

  async removeOrganizationCredential(ownerUserId:string,organizationId:string,credentialId:string){
    if(!uuid.safeParse(credentialId).success)invalid();
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(dev){
      const reference=await withSystemTx(this.pool,tx=>tx.query("SELECT 1 FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2 AND org_id=$3",[credentialId,ownerUserId,organizationId]));
      if(reference.rowCount)return dev.remove(ownerUserId,organizationId,credentialId,'local');
    }
    return withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412))",[ownerUserId]);
      await this.organizationConsent(tx,ownerUserId,organizationId);
      await tx.query(`UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now())
        WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3 AND revoked_at IS NULL`,[organizationId,ownerUserId,credentialId]);
      await tx.query(`UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',revision=revision+1,request_sha256=digest(request_sha256,'sha256'),updated_at=now()
        WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3`,[organizationId,ownerUserId,credentialId]);
      await tx.query("DELETE FROM cloud_agent_credential_organizations WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3",[organizationId,ownerUserId,credentialId]);
      return {removed:true};
    });
  }

  async authorizeOrganizationForWorkspace(ownerUserId:string,workspaceId:string){
    if(!uuid.safeParse(workspaceId).success)invalid();
    await withSystemTx(this.pool,async tx=>{
      await this.owner(tx,ownerUserId,true);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412))",[ownerUserId]);
      const workspace=(await tx.query<{org_id:string}>("SELECT org_id FROM cloud_workspaces WHERE id=$1 AND deleted_at IS NULL",[workspaceId])).rows[0];
      if(!workspace)unavailable();
      // Guests may have explicit workspace grants but cannot inherit a member's
      // organization connection. Their existing grants remain readable below.
      const member=await tx.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2",[workspace.org_id,ownerUserId]);
      if(!member.rowCount)return;
      const fingerprint=await this.organizationConsent(tx,ownerUserId,workspace.org_id);
      await lockCloudWorkspaceScope(tx,{workspaceId,organizationId:workspace.org_id,workspaceLock:"update"});
      const actor=await authorizeCloudWorkspaceActor(tx,{workspaceId,organizationId:workspace.org_id,actorUserId:ownerUserId,capability:"run"});
      const compute=await readCloudAgentComputeTrust(tx,workspaceId);
      if(compute?.trust!=="zeros-managed")return;
      const connections=(await tx.query<OrganizationConnection>(`SELECT connection.* FROM cloud_agent_organization_connections connection
        JOIN cloud_agent_credentials credential ON credential.id=connection.credential_id AND credential.owner_user_id=connection.owner_user_id
        JOIN cloud_agent_credential_versions material ON material.credential_id=credential.id AND material.version=credential.current_version
        JOIN cloud_agent_credential_organizations association ON association.credential_id=credential.id AND association.owner_user_id=credential.owner_user_id AND association.org_id=connection.org_id
        WHERE connection.org_id=$1 AND connection.owner_user_id=$2 AND connection.consent_fingerprint=$3
          AND credential.revoked_at IS NULL AND credential.revision=connection.credential_revision
          AND (credential.kind<>'cursor-api-key' OR material.material_expires_at IS NULL OR material.material_expires_at>clock_timestamp()+interval '1 minute')
        ORDER BY connection.provider FOR UPDATE OF connection`,[workspace.org_id,ownerUserId,fingerprint])).rows;
      for(const connection of connections){
        const existing=await tx.query(`SELECT id FROM cloud_agent_credential_delegations WHERE workspace_id=$1 AND owner_user_id=$2 AND grantee_user_id=$2
          AND organization_provider=$3 AND organization_connection_revision=$4 AND credential_id=$5 AND credential_revision=$6
          AND owner_fingerprint=$7 AND grantee_fingerprint=$7 AND compute_fingerprint=$8 AND compute_trust='zeros-managed'
          AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval '1 minute' LIMIT 1`,
        [workspaceId,ownerUserId,connection.provider,connection.revision,connection.credential_id,connection.credential_revision,actor.fingerprint,compute.fingerprint]);
        if(existing.rowCount)continue;
        await tx.query(`UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now())
          WHERE workspace_id=$1 AND owner_user_id=$2 AND organization_provider=$3 AND revoked_at IS NULL`,[workspaceId,ownerUserId,connection.provider]);
        const id=randomUUID();
        await this.delegateInTransaction(tx,ownerUserId,{id,workspaceId,credentialId:connection.credential_id!,expectedRevision:Number(connection.credential_revision),
          granteeUserId:ownerUserId,models:connection.models,expiresAt:new Date(Date.now()+86400_000).toISOString(),computeConsent:compute});
        await tx.query("UPDATE cloud_agent_credential_delegations SET organization_provider=$2,organization_connection_revision=$3 WHERE id=$1",[id,connection.provider,connection.revision]);
      }
    });
    return this.forWorkspace(ownerUserId,workspaceId);
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
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,837412))",[input.ownerUserId]);
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
      await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=$1 AND revoked_at IS NULL",[row.id]);
      if(input.organizationId)await this.associateOrganization(tx,input.ownerUserId,input.organizationId,row.id);
      return {credential:metadata(row),replayed:false};
    });
  }

  async removeDevConnection(ownerUserId:string,organizationId:string,id:string,scope:"local"|"organization"|"global") {
    const dev=await devConnectionRuntime(this.pool,this.encryption);if(!dev)unavailable();
    return dev.remove(ownerUserId,organizationId,id,scope);
  }
  async reattachDevConnection(ownerUserId:string,organizationId:string,id:string) {
    const dev=await devConnectionRuntime(this.pool,this.encryption);if(!dev)unavailable();
    return dev.reattach(ownerUserId,organizationId,id);
  }
  async revoke(ownerUserId:string,credentialId:string){
    if(!uuid.safeParse(credentialId).success)invalid();
    const dev=await devConnectionRuntime(this.pool,this.encryption);
    if(dev){
      const reference=await withSystemTx(this.pool,async tx=>(await tx.query<{org_id:string}>("SELECT org_id FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2",[credentialId,ownerUserId])).rows[0]);
      if(reference){await dev.remove(ownerUserId,reference.org_id,credentialId,'local');return {revoked:true};}
    }
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
    return withSystemTx(this.pool,tx=>this.delegateInTransaction(tx,ownerUserId,parsed.data));
  }

  private async delegateInTransaction(tx:Tx,ownerUserId:string,input:z.infer<typeof CloudAgentDelegationSchema>){
      const models=[...new Set(input.models)].sort();
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
      await this.reconcileLegacyOrganizations(tx,ownerUserId,scope.organizationId);
      return {delegation:grantMetadata(row),replayed:false};
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
      const rows=await tx.query<{id:string;kind:CloudAgentCredentialKind;owner_user_id:string;models:string[];expires_at:Date;runtime_qualified:boolean}>(`SELECT delegation.id,credential.kind,credential.owner_user_id,delegation.models,delegation.expires_at,
        EXISTS(SELECT 1 FROM cloud_workspaces workspace
          JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.generation=workspace.current_generation
          JOIN cloud_workspace_engine_instances engine ON engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=generation.generation
            AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.lease_expires_at>clock_timestamp() AND engine.actor_protocol_version=2
          ${runtimeCredentialQualificationJoin("$7", "true")}
          WHERE workspace.id=delegation.workspace_id) AS runtime_qualified
        FROM cloud_agent_credential_delegations delegation JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id
        WHERE delegation.workspace_id=$1 AND delegation.org_id=$2 AND delegation.grantee_user_id=$3
          AND delegation.revoked_at IS NULL AND delegation.expires_at>clock_timestamp() AND credential.revoked_at IS NULL
          AND credential.revision=delegation.credential_revision AND delegation.grantee_fingerprint=$4
          AND delegation.compute_fingerprint=$5 AND delegation.compute_trust=$6
          AND delegation.owner_fingerprint=cloud_workspace_actor_fingerprint($1,credential.owner_user_id)
          AND cloud_workspace_actor_role($1,credential.owner_user_id) IN ('prompter','developer','manager','owner')
        ORDER BY delegation.created_at DESC,delegation.id LIMIT 100`,[workspaceId,workspace.org_id,actorUserId,actor.fingerprint,compute.fingerprint,compute.trust,cloudRuntimeQualificationMode()]);
      return {compute,delegations:rows.rows.map(row=>({id:row.id,kind:row.kind,ownerUserId:row.owner_user_id,models:row.models,expiresAt:row.expires_at.toISOString(),runtimeQualified:row.runtime_qualified}))};
    });
  }
}
