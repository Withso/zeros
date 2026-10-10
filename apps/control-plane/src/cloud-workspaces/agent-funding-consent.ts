import {createHash} from "node:crypto";
import {HttpError} from "../authz.js";
import type {Tx} from "../db.js";
import type {CloudAgentBootScope,CloudActorProvenance} from "./agent-boot-contract.js";
import {authorizeCloudWorkspaceActor} from "./actors.js";
import {hasProSharing} from "./pro-sharing.js";

type FundingGrant=CloudActorProvenance["fundingGrant"];
type Policy={owner_user_id:string;agent_funding_owner_epoch:string;access_revision:string;sharing_mode:string;single_member_mode:boolean};
type Source={kind:"guest"|"member"|"owner"|"general";key:string;userId:string|null;role:string;issuer:string|null;descriptor:unknown};
function denied():never{throw new HttpError(403,"cloud_validation_access_denied","cloud_validation_access_denied");}
function digest(value:unknown):Buffer{return createHash("sha256").update(JSON.stringify(value)).digest();}
async function policy(tx:Tx,workspaceId:string,organizationId:string):Promise<Policy>{
 const row=(await tx.query<Policy>("SELECT owner_user_id,agent_funding_owner_epoch,access_revision,sharing_mode,single_member_mode FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR SHARE",[workspaceId,organizationId])).rows[0];
 if(!row||!Number.isSafeInteger(Number(row.agent_funding_owner_epoch))||Number(row.agent_funding_owner_epoch)<1)denied();return row;
}
async function sources(tx:Tx,workspaceId:string,organizationId:string,p:Policy):Promise<Source[]>{
 const result:Source[]=[{kind:"owner",key:p.owner_user_id,userId:p.owner_user_id,role:"owner",issuer:p.owner_user_id,descriptor:["owner",p.owner_user_id,p.agent_funding_owner_epoch]}];
 const members=(await tx.query<{user_id:string;role:string;updated_at:Date}>("SELECT user_id,role,updated_at FROM cloud_workspace_members WHERE workspace_id=$1 AND org_id=$2 ORDER BY user_id FOR SHARE",[workspaceId,organizationId])).rows;
 for(const row of members)if(row.user_id!==p.owner_user_id)result.push({kind:"member",key:row.user_id,userId:row.user_id,role:row.role,issuer:null,descriptor:["member",row.user_id,row.role,row.updated_at.toISOString()]});
 const guests=(await tx.query<{id:string;user_id:string;role:string;revision:string;created_by:string|null;expires_at:Date}>("SELECT id,user_id,role,revision,created_by,expires_at FROM cloud_workspace_guest_grants WHERE workspace_id=$1 AND org_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY id FOR SHARE",[workspaceId,organizationId])).rows;
 for(const row of guests)result.push({kind:"guest",key:row.id,userId:row.user_id,role:row.role,issuer:row.created_by,descriptor:["guest",row.id,row.user_id,row.role,row.revision,row.created_by,row.expires_at.toISOString()]});
 if(p.sharing_mode==="organization"&&!p.single_member_mode&&!await hasProSharing(tx,workspaceId))result.push({kind:"general",key:workspaceId,userId:null,role:"developer",issuer:null,descriptor:["general",p.sharing_mode,p.access_revision,p.owner_user_id,p.agent_funding_owner_epoch]});
 return result;
}
/** Called by real role/policy writers, or authenticated owner-bound boot policy
 * admission. Caller authorization is rechecked; invitation text is not consent. */
export async function recordCloudAgentFundingConsents(tx:Tx,input:{workspaceId:string;organizationId:string;issuerUserId:string;subjectUserId?:string}):Promise<void>{
 await authorizeCloudWorkspaceActor(tx,{...input,actorUserId:input.issuerUserId,capability:"manage"});
 if((await tx.query("SELECT 1 FROM cloud_agent_boot_bindings WHERE workspace_id=$1 AND org_id=$2 AND retired_at IS NULL LIMIT 1",[input.workspaceId,input.organizationId])).rowCount!==1)return;
 const p=await policy(tx,input.workspaceId,input.organizationId),all=await sources(tx,input.workspaceId,input.organizationId,p);
 const selected=all.filter(source=>input.subjectUserId===undefined||source.userId===input.subjectUserId);
 for(const source of selected){
  const run=source.role!=="viewer";
  const issuer=source.kind==="guest"?source.issuer:input.issuerUserId;
  if(!issuer)continue;
  try{await authorizeCloudWorkspaceActor(tx,{...input,actorUserId:issuer,capability:"manage"});}catch(error){if(error instanceof HttpError)continue;throw error;}
  const fingerprint=digest([source.descriptor,p.owner_user_id,p.agent_funding_owner_epoch]);
  await tx.query(`INSERT INTO cloud_agent_funding_consents(workspace_id,org_id,source_kind,source_key,subject_user_id,issuer_user_id,owner_user_id,owner_epoch,source_sha256,role,revoked_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $11::boolean THEN NULL ELSE clock_timestamp() END)
   ON CONFLICT(workspace_id,source_kind,source_key) DO UPDATE SET issuer_user_id=EXCLUDED.issuer_user_id,owner_user_id=EXCLUDED.owner_user_id,
   owner_epoch=EXCLUDED.owner_epoch,source_sha256=EXCLUDED.source_sha256,role=EXCLUDED.role,revoked_at=EXCLUDED.revoked_at,
   revision=cloud_agent_funding_consents.revision+1 WHERE cloud_agent_funding_consents.source_sha256<>EXCLUDED.source_sha256
     OR cloud_agent_funding_consents.issuer_user_id IS DISTINCT FROM EXCLUDED.issuer_user_id
     OR (cloud_agent_funding_consents.revoked_at IS NULL) IS DISTINCT FROM $11::boolean`,
   [input.workspaceId,input.organizationId,source.kind,source.key,source.userId,issuer,p.owner_user_id,p.agent_funding_owner_epoch,fingerprint,source.role,run]);
 }
 const live=new Set(selected.map(source=>`${source.kind}:${source.key}`));
 const previous=(await tx.query<{id:string;source_kind:string;source_key:string}>(`SELECT id,source_kind,source_key FROM cloud_agent_funding_consents WHERE workspace_id=$1 AND org_id=$2
  AND ($3::uuid IS NULL OR subject_user_id=$3) AND revoked_at IS NULL FOR UPDATE`,[input.workspaceId,input.organizationId,input.subjectUserId??null])).rows;
 for(const source of previous)if(!live.has(`${source.source_kind}:${source.source_key}`))await tx.query("UPDATE cloud_agent_funding_consents SET revoked_at=clock_timestamp(),revision=revision+1 WHERE id=$1",[source.id]);
}
export async function readCloudAgentFundingConsent(tx:Tx,scope:CloudAgentBootScope,actor:{userId:string;role:string}):Promise<FundingGrant>{
 const current=await authorizeCloudWorkspaceActor(tx,{...scope,actorUserId:actor.userId,capability:"read"});
 if(current.role!==actor.role)denied();if(actor.role==="viewer")return null;
 const p=await policy(tx,scope.workspaceId,scope.organizationId);
 if(actor.role==="owner"&&actor.userId===scope.fundingOwnerUserId&&p.owner_user_id===actor.userId)return {kind:"owner"};
 const all=await sources(tx,scope.workspaceId,scope.organizationId,p);
 const source=all.find(value=>value.kind==="owner"&&value.userId===actor.userId)??all.find(value=>value.kind==="member"&&value.userId===actor.userId)
  ??all.find(value=>value.kind==="guest"&&value.userId===actor.userId)??all.find(value=>value.kind==="general");
 if(!source||source.role!==actor.role&&!(source.kind==="general"&&actor.role==="manager"))denied();
 const row=(await tx.query<{id:string;revision:string;issuer_user_id:string;owner_user_id:string;owner_epoch:string;source_sha256:Buffer}>(`SELECT id,revision,issuer_user_id,owner_user_id,owner_epoch,source_sha256
  FROM cloud_agent_funding_consents WHERE workspace_id=$1 AND org_id=$2 AND source_kind=$3 AND source_key=$4 AND revoked_at IS NULL FOR SHARE`,[scope.workspaceId,scope.organizationId,source.kind,source.key])).rows[0];
 if(!row||row.owner_user_id!==p.owner_user_id||row.owner_epoch!==p.agent_funding_owner_epoch||!row.source_sha256.equals(digest([source.descriptor,p.owner_user_id,p.agent_funding_owner_epoch])))denied();
 await authorizeCloudWorkspaceActor(tx,{...scope,actorUserId:row.issuer_user_id,capability:"manage"});
 const grantRevision=Number(row.revision);if(!Number.isSafeInteger(grantRevision)||grantRevision<1)denied();
 return {kind:source.kind==="general"?"general-access":"share",grantId:row.id,grantRevision};
}
