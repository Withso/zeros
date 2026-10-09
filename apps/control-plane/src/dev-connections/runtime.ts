import { hkdfSync, randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../cloud-workspaces/agent-credential-envelope.js";
import { DevConnectionClient, devConnectionClientFromEnvironment, ReferenceSchema, type RestoreMapping } from "./client.js";
import { devConnectionsEnabled } from "./config.js";
import { DatabaseDevConnectionRestore, currentMapping, invalidateReferences } from "./restore.js";
import { denied, parseMaterial, uuid, type ConnectionReference, type GithubMaterial, type GrantScope } from "./types.js";
import {serializeCloudAgentCredentialSourceMutation,assertLegacyCloudAgentCredentialMutationAllowed} from "../cloud-workspaces/agent-credential-mutations.js";

type Stored = {owner_user_id:string;org_id:string;issuer:string;subject:string;workos_org_id:string;generation_id:string;reference:ConnectionReference;fingerprint:string};
const mapping=(r:Stored):RestoreMapping=>({issuer:r.issuer,subject:r.subject,workosOrganizationId:r.workos_org_id,
  localUserId:r.owner_user_id,localOrganizationId:r.org_id,fingerprint:r.fingerprint});
const purpose="zeros-dev-member-session-v1";
function key(keys:CloudAgentCredentialKeys,version:number) {
  const encoded=keys.keys[version]; if(!encoded)denied();
  const root=Buffer.from(encoded,"base64url"); if(root.length!==32)denied();
  try{return Buffer.from(hkdfSync("sha256",root,Buffer.alloc(0),purpose,32));}finally{root.fill(0);}
}
const aad=(user:string,org:string,generation:string,fingerprint:string,expiry:Date)=>Buffer.from(JSON.stringify([purpose,user,org,generation,fingerprint,expiry.toISOString()]));
export class DevConnectionRuntime {
  readonly restore:DatabaseDevConnectionRestore;
  constructor(private readonly pool:pg.Pool,readonly client:DevConnectionClient,private readonly keys:CloudAgentCredentialKeys){this.restore=new DatabaseDevConnectionRestore(pool);}
  async signedIn(input:{userId:string;issuer:string;subject:string;token:string;expiresAt:number}) {
    await this.consumeInvalidations();
    const orgs=await withSystemTx(this.pool,async tx=>(await tx.query<{workos_organization_id:string}>(`SELECT l.workos_organization_id
      FROM workos_organization_links l JOIN organization_members m ON m.org_id=l.organization_id
      WHERE m.user_id=$1 AND l.state='active'`,[input.userId])).rows);
    const owners:RestoreMapping[]=[];
    for(const org of orgs){const owner=await this.restore.mapping(input.userId,input.issuer,input.subject,org.workos_organization_id);if(owner)owners.push(owner);}
    const refs=await this.client.references(input.token);
    for(const owner of owners){
      await this.restore.replace(owner,this.client.generationId,refs.filter(r=>r.organization===owner.workosOrganizationId));
      await withSystemTx(this.pool,async tx=>{
        const fingerprint=await currentMapping(tx,owner),expiry=new Date(input.expiresAt*1000),version=this.keys.currentKeyVersion,derived=key(this.keys,version);
        let sealed; try{sealed=sealCredentialBytes(Buffer.from(input.token),aad(input.userId,owner.localOrganizationId,this.client.generationId,fingerprint,expiry),derived);}finally{derived.fill(0);}
        await tx.query(`INSERT INTO dev_connection_sessions(owner_user_id,org_id,generation_id,fingerprint,expires_at,key_version,nonce,ciphertext,auth_tag)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_user_id,org_id,generation_id) DO UPDATE SET
          fingerprint=EXCLUDED.fingerprint,expires_at=EXCLUDED.expires_at,key_version=EXCLUDED.key_version,nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag`,
        [input.userId,owner.localOrganizationId,this.client.generationId,fingerprint,expiry,version,sealed.nonce,sealed.ciphertext,sealed.authTag]);
      });
    }
  }
  async token(tx:Tx,row:Stored) {
    await currentMapping(tx,mapping(row));
    const session=(await tx.query(`SELECT * FROM dev_connection_sessions WHERE owner_user_id=$1 AND org_id=$2 AND generation_id=$3
      AND fingerprint=$4 AND expires_at>clock_timestamp()+interval '5 seconds'`,[row.owner_user_id,row.org_id,this.client.generationId,row.fingerprint])).rows[0];
    if(!session)denied();
    const derived=key(this.keys,session.key_version);
    let bytes:Buffer|undefined;
    try{bytes=openCredentialBytes({nonce:session.nonce,ciphertext:session.ciphertext,authTag:session.auth_tag},
      aad(row.owner_user_id,row.org_id,this.client.generationId,row.fingerprint,session.expires_at),derived);return bytes.toString('utf8');}
    finally{derived.fill(0);bytes?.fill(0);}
  }
  async reference(tx:Tx,id:string,user:string,org?:string) {
    const row=(await tx.query<Stored>(`SELECT * FROM dev_connection_references WHERE binding_id=$1 AND owner_user_id=$2 AND generation_id=$3
      AND ($4::uuid IS NULL OR org_id=$4) AND invalidated_at IS NULL AND removed_at IS NULL FOR SHARE`,[id,user,this.client.generationId,org??null])).rows[0];
    if(!row)denied(); ReferenceSchema.parse(row.reference);return row;
  }
  async issue(tx:Tx,id:string,user:string,org:string,scope:GrantScope,qualification?:{expectedVersion:number}) {
    const row=await this.reference(tx,id,user,org),token=await this.token(tx,row);
    const grant=await this.client.grant(token,id,scope,qualification);
    await currentMapping(tx,mapping(row));
    if(grant.material.kind!==row.reference.kind)denied();
    return grant;
  }
  /** Each new issue/lease renewal synchronously drains the durable outbox.
   * An outage cannot extend a lease; already delivered access stops at its lease. */
  async consumeInvalidations() {
    const generation=this.client.generationId;
    try{
      for(let page=0;page<20;page++){
        const cursor=await withSystemTx(this.pool,async tx=>(await tx.query<{sequence:string}>("SELECT sequence::text FROM dev_connection_cursors WHERE generation_id=$1",[generation])).rows[0]?.sequence??'0');
        const events=await this.client.revocations(cursor);
        await withSystemTx(this.pool,async tx=>{
          await tx.query("INSERT INTO dev_connection_cursors(generation_id) VALUES($1) ON CONFLICT DO NOTHING",[generation]);
          const current=(await tx.query<{sequence:string}>("SELECT sequence::text FROM dev_connection_cursors WHERE generation_id=$1 FOR UPDATE",[generation])).rows[0]!;
          if(current.sequence!==cursor)return;
          if(events.some((e,index)=>BigInt(e.sequence)<=BigInt(index?events[index-1]!.sequence:cursor)))denied();
          if(events.length)await invalidateReferences(tx,generation,events.some(e=>e.binding_id===null)?null:events.map(e=>e.binding_id!));
          await tx.query("UPDATE dev_connection_cursors SET sequence=$2,checked_at=clock_timestamp() WHERE generation_id=$1",[generation,events.at(-1)?.sequence??cursor]);
        });
        if(events.length<100)return;
      }
      throw new Error("Dev invalidation backlog requires retry");
    }catch(error){
      if(error instanceof HttpError&&error.code==='dev_connection_denied')await withSystemTx(this.pool,tx=>invalidateReferences(tx,generation,null));
      throw error;
    }
  }
  private async ownerSession(user:string,org:string) {
    return withSystemTx(this.pool,async tx=>{
      const row=(await tx.query<Stored>(`SELECT s.*,i.provider_sub AS subject,l.workos_organization_id AS workos_org_id,
        $4::text AS issuer FROM dev_connection_sessions s JOIN user_identities i ON i.user_id=s.owner_user_id AND i.provider='workos'
        JOIN workos_organization_links l ON l.organization_id=s.org_id WHERE s.owner_user_id=$1 AND s.org_id=$2 AND s.generation_id=$3`,
      [user,org,this.client.generationId,process.env.AUTH_ISSUER??''])).rows[0];
      if(!row)denied(); return {row,token:await this.token(tx,row)};
    });
  }
  async connectAgent(input:{ownerUserId:string;organizationId:string;credentialId:string;operationId?:string;expectedRevision:number;material:unknown}) {
    const {row,token}=await this.ownerSession(input.ownerUserId,input.organizationId),material=parseMaterial(input.material);
    if(material.kind==='github-app')denied();
    const member=await this.client.member(token);
    if(member.organization!==row.workos_org_id||member.subject!==row.subject||member.issuer!==row.issuer)denied();
    let id=input.credentialId,accountId=material.kind==='codex-chatgpt'?material.nativeCache.tokens.account_id:input.credentialId;
    if(input.expectedRevision!==0){
      // Fresh, explicit authorization can replace a broker reference. Legacy
      // local material never enters this path, and the operation ID fences retry.
      id=uuid.parse(input.operationId);
      const previous=await withSystemTx(this.pool,async tx=>(await tx.query<Stored & {revision:string}>(`SELECT r.*,c.revision::text FROM dev_connection_references r
        JOIN cloud_agent_credentials c ON c.id=r.binding_id WHERE r.binding_id=$1 AND r.owner_user_id=$2 AND r.org_id=$3 AND r.generation_id=$4`,
      [input.credentialId,input.ownerUserId,input.organizationId,this.client.generationId])).rows[0]);
      if(!previous||Number(previous.revision)!==input.expectedRevision||previous.reference.kind!==material.kind)denied();
      if(material.kind!=='codex-chatgpt')accountId=previous.reference.accountId;
    }
    await this.client.connect(token,{id,accountId,appScope:material.kind==='codex-chatgpt'?'chatgpt':'api',material,replaceExisting:true,
      consent:{models:[],repositories:[],scopes:['agent']}});
    await this.consumeInvalidations();
    const refs=await this.client.restoreAfterSignIn(token,mapping(row),this.restore);
    const ref=refs.find(r=>r.connectionId===id);if(!ref)denied();
    return {credential:{id:ref.bindingId,kind:ref.kind,displayName:`Dev ${ref.kind}`,revision:ref.revision,revoked:false,connectionMethod:ref.connectionMethod},replayed:false};
  }
  async connectGithub(user:string,material:GithubMaterial) {
    const org=(await withSystemTx(this.pool,tx=>tx.query<{org_id:string}>("SELECT org_id FROM dev_connection_sessions WHERE owner_user_id=$1 AND generation_id=$2 AND expires_at>clock_timestamp() ORDER BY org_id LIMIT 1",[user,this.client.generationId]))).rows[0];
    if(!org)denied();
    const {row,token}=await this.ownerSession(user,org.org_id),member=await this.client.member(token);
    const owner=await this.restore.mapping(user,member.issuer,member.subject,member.organization);if(!owner||row.subject!==member.subject)denied();
    const id=randomUUID();
    await this.client.connect(token,{id,accountId:material.accountId,appScope:`${material.appId}:${material.clientId}`,material,replaceExisting:true,
      consent:{models:[],repositories:[],scopes:['github:read','github:write']}});
    await this.consumeInvalidations();
    const refs=await this.client.restoreAfterSignIn(token,owner,this.restore),ref=refs.find(r=>r.connectionId===id);if(!ref)denied();return ref;
  }
  async assertGithub(tx:Tx,user:string,org:string){
    const row=(await tx.query<Stored>(`SELECT * FROM dev_connection_references WHERE owner_user_id=$1 AND org_id=$2 AND generation_id=$3
      AND reference->>'kind'='github-app' AND invalidated_at IS NULL AND removed_at IS NULL
      AND (reference->>'expiresAt')::timestamptz>clock_timestamp() FOR SHARE`,[user,org,this.client.generationId])).rows[0];
    if(!row)denied();await currentMapping(tx,mapping(row));
  }
  async githubReference(user:string,org?:string,id?:string) {
    return withSystemTx(this.pool,async tx=>{
      const row=(await tx.query<Stored & {binding_id:string}>(`SELECT * FROM dev_connection_references WHERE owner_user_id=$1 AND generation_id=$2
        AND ($3::uuid IS NULL OR org_id=$3) AND ($4::uuid IS NULL OR binding_id=$4) AND reference->>'kind'='github-app'
        AND invalidated_at IS NULL AND removed_at IS NULL ORDER BY updated_at DESC,binding_id LIMIT 1`,[user,this.client.generationId,org??null,id??null])).rows[0];
      if(!row)denied();await currentMapping(tx,mapping(row));return row;
    });
  }
  async githubGrant(user:string,org:string,scope:GrantScope,id?:string) {
    await this.consumeInvalidations();
    const row=await this.githubReference(user,org,id);
    return withSystemTx(this.pool,async tx=>{
      const grant=await this.issue(tx,row.binding_id,user,org,scope);
      if(grant.material.kind!=='github-app')denied();return {row,material:grant.material,expiresAt:grant.expiresAt};
    });
  }
  async consentGithubRepository(user:string,org:string,id:string,repository:string,write:boolean) {
    const row=await this.githubReference(user,org,id),token=await withSystemTx(this.pool,tx=>this.token(tx,row));
    const consent={...row.reference.consent,repositories:[...new Set([...row.reference.consent.repositories,repository.toLowerCase()])],
      scopes:[...new Set([...row.reference.consent.scopes,...(write?['github:write' as const]:[])])]};
    if(JSON.stringify(consent)===JSON.stringify(row.reference.consent))return;
    await this.client.consent(token,row.reference.connectionId,consent);
    await this.client.restoreAfterSignIn(token,mapping(row),this.restore);
    // Consume the old binding's event, then publish the confirmed new revision.
    await this.consumeInvalidations();
    await this.client.restoreAfterSignIn(token,mapping(row),this.restore);
  }
  async selectAgent(user:string,org:string,id:string,models:string[],expectedRevision:number,credentialRevision:number,allModels=false) {
    const row=await withSystemTx(this.pool,tx=>this.reference(tx,id,user,org)),token=await withSystemTx(this.pool,tx=>this.token(tx,row));
    await withSystemTx(this.pool,async tx=>{
      const selected=(await tx.query<{revision:string}>("SELECT revision FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3",[org,user,row.reference.kind.split('-')[0]])).rows[0];
      const credential=(await tx.query<{revision:string}>("SELECT revision FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL",[id,user])).rows[0];
      if(Number(selected?.revision??0)!==expectedRevision||Number(credential?.revision)!==credentialRevision)throw new HttpError(409,'agent_connection_conflict','Agent connection changed');
    });
    const {allModels:_previousAllModels,...consent}=row.reference.consent;
    await this.client.consent(token,row.reference.connectionId,{...consent,models,...(allModels?{allModels:true}:{}),scopes:['agent']});
    await this.consumeInvalidations();
    await this.client.restoreAfterSignIn(token,mapping(row),this.restore);
    return withSystemTx(this.pool,async tx=>({revision:Number((await tx.query<{revision:string}>("SELECT revision FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3",[org,user,row.reference.kind.split('-')[0]])).rows[0]!.revision),replayed:false}));
  }
  async remove(user:string,org:string,id:string,scope:"local"|"organization"|"global") {
    await withSystemTx(this.pool,async tx=>{
      await serializeCloudAgentCredentialSourceMutation(tx,user);
      const row=await this.reference(tx,id,user,org);
      const aliases=scope==="local"?[{binding_id:id}]:(await tx.query<{binding_id:string}>(`SELECT binding_id FROM dev_connection_references
        WHERE owner_user_id=$1 AND generation_id=$2 AND reference->>'connectionId'=$3 AND ($4::uuid IS NULL OR org_id=$4)`,
        [user,this.client.generationId,row.reference.connectionId,scope==="global"?null:org])).rows;
      for(const alias of aliases)await assertLegacyCloudAgentCredentialMutationAllowed(tx,user,{credentialId:alias.binding_id,...(scope==="global"?{}:{organizationId:org})});
      // Keep the first-holder lock through this legacy remote write. New mode
      // holders require the separate durable conditional removal API below.
      if(scope!=="local")await this.client.revoke(await this.token(tx,row),row.reference.connectionId,scope);
      await currentMapping(tx,mapping(row));
      await invalidateReferences(tx,this.client.generationId,[id]);
      if(scope==='local')await tx.query("UPDATE dev_connection_references SET removed_at=now() WHERE binding_id=$1",[id]);
      await tx.query("UPDATE cloud_agent_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1",[id]);
      await tx.query(`UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',revision=revision+1,
        request_sha256=digest(request_sha256,'sha256'),updated_at=now() WHERE org_id=$1 AND owner_user_id=$2 AND credential_id=$3`,[org,user,id]);
    });
    return {removed:true};
  }
  async requestConditionalRemoval(user:string,operationId:string,source:{referenceId:string;organizationId:string;connectionId:string;generationId:string;
    referenceRevision:number;consentRevision:number;fingerprint:string;scope:"organization"|"global"}){
    if(source.generationId!==this.client.generationId)denied();
    // A durable accepted removal uses current member authority, not a newly
    // usable credential. Its own outbox may have retired the original binding.
    const {token}=await this.ownerSession(user,source.organizationId);
    return this.client.removeConditionally(token,{version:1,operationId,connectionId:source.connectionId,bindingId:source.referenceId,
      expectedRevision:source.referenceRevision,expectedConsentRevision:source.consentRevision,scope:source.scope});
  }
  async reattach(user:string,org:string,id:string) {
    uuid.parse(id);
    const {row,token}=await this.ownerSession(user,org);
    await this.consumeInvalidations();
    const refs=await this.client.references(token);
    await this.restore.reattach(mapping(row),this.client.generationId,id,refs.filter(ref=>ref.organization===row.workos_org_id));
    return {reattached:true};
  }
}
const runtimes=new WeakMap<pg.Pool,DevConnectionRuntime>();
export function devConnectionRuntime(pool:pg.Pool,keys?:CloudAgentCredentialKeys,env:NodeJS.ProcessEnv=process.env) {
  if(!devConnectionsEnabled(env))return null;
  let runtime=runtimes.get(pool);if(runtime)return runtime;
  const client=devConnectionClientFromEnvironment(env)!;
  const encryption=keys??{keys:{1:env.CLOUD_WORKSPACE_SECRET_KEY_V1!},currentKeyVersion:1};
  runtime=new DevConnectionRuntime(pool,client,encryption);runtimes.set(pool,runtime);return runtime;
}
