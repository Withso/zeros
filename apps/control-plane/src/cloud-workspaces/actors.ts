import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { audit } from "../audit.js";
import {authorizeCloudWorkspaceDataAccess} from "./authorization.js";
import type { AuthedUser } from "../auth.js";
import { withSystemTx, type Tx } from "../db.js";
import {emitCloudWorkspaceAccessChange} from "./collaboration-events.js";
import {sealWorkspaceInvitation} from "./invitation-envelope.js";

export type WorkspaceInvitationDeliveryConfig={keys:Readonly<Record<number,string>>;currentKeyVersion:number;webOrigin:string};

export type CloudWorkspaceActorRole = "viewer" | "prompter" | "developer" | "manager" | "owner";
export type CloudWorkspaceCapability = "read" | "run" | "edit" | "manage" | "credentials" | "delete";
export type CloudWorkspaceActorScope = {workspaceId:string;organizationId:string;actorUserId:string};
export type CloudWorkspaceActorAuthority = CloudWorkspaceActorScope & {
  sponsorUserId:string;role:CloudWorkspaceActorRole;accessRevision:number;fingerprint:string;
};
const roles: Record<CloudWorkspaceActorRole,number> = {viewer:0,prompter:1,developer:2,manager:3,owner:4};
const capabilities: Record<CloudWorkspaceCapability,number> = {read:0,run:1,edit:2,manage:3,credentials:3,delete:3};
const id = z.string().uuid();
const guestRole = z.enum(["viewer","prompter","developer"]);
const digest = (value:string) => createHash("sha256").update(value).digest();
function unavailable(): never { throw new HttpError(404,"cloud_workspace_not_found","Cloud workspace access is unavailable"); }
function validateScope(scope:CloudWorkspaceActorScope): void {
  if (![scope.workspaceId,scope.organizationId,scope.actorUserId].every(value=>id.safeParse(value).success)) unavailable();
}

/** Exact workspace authority. Never broaden organization RLS for a guest. */
export async function authorizeCloudWorkspaceActor(
  tx:Tx,input:CloudWorkspaceActorScope & {capability:CloudWorkspaceCapability;allowOwnerDataRecovery?:boolean},
):Promise<CloudWorkspaceActorAuthority> {
  validateScope(input);
  if (!Object.hasOwn(capabilities,input.capability)) throw new HttpError(422,"invalid_input","Unknown workspace capability");
  const row = (await tx.query<{
    owner_user_id:string;team_id:string;access_revision:string;role:CloudWorkspaceActorRole|null;fingerprint:string;
  }>(`SELECT workspace.owner_user_id,workspace.team_id,workspace.access_revision,
      cloud_workspace_actor_role(workspace.id,$3) AS role,
      cloud_workspace_actor_fingerprint(workspace.id,$3) AS fingerprint
    FROM cloud_workspaces workspace
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL AND app_is_system()`,
  [input.workspaceId,input.organizationId,input.actorUserId])).rows[0];
  if (!row) unavailable();
  let role = row.role;
  // Explicit opt-in for already-owned durable data. This path retains the
  // active owner/tenant/team fence but does not require new compute eligibility.
  if (!role && input.allowOwnerDataRecovery && input.capability === "read" && row.owner_user_id === input.actorUserId) {
    await authorizeCloudWorkspaceDataAccess(tx, {organizationId:input.organizationId,teamId:row.team_id,
      actorUserId:input.actorUserId,ownerUserId:row.owner_user_id,requireWorkspaceOwner:true});
    role = "owner";
  }
  if (!role || !Object.hasOwn(roles,role)) unavailable();
  if (roles[role] < capabilities[input.capability]) throw new HttpError(403,"cloud_workspace_capability_required","This workspace role cannot perform the operation");
  const accessRevision = Number(row.access_revision);
  if (!Number.isSafeInteger(accessRevision) || accessRevision<1) throw new Error("Workspace access revision is invalid");
  return {workspaceId:input.workspaceId,organizationId:input.organizationId,actorUserId:input.actorUserId,
    sponsorUserId:row.owner_user_id,role,accessRevision,fingerprint:row.fingerprint};
}

/** Resource withdrawal never requires purchasing compute. This narrow authority
 * cannot mint runtime, repository, data-export or agent credentials. An org
 * admin may clean up shared resources even after their sponsor is disabled. */
export async function authorizeCloudWorkspaceCleanup(tx:Tx,input:CloudWorkspaceActorScope):Promise<void> {
  validateScope(input);
  const row=(await tx.query<{owner_user_id:string;team_id:string;manager:boolean}>(`SELECT workspace.owner_user_id,workspace.team_id,
      (NOT workspace.single_member_mode AND
        ((workspace.sharing_mode='organization' AND membership.role IN ('owner','admin'))
          OR explicit_member.role='manager')) AS manager
    FROM cloud_workspaces workspace
    JOIN organizations organization ON organization.id=workspace.org_id
      AND organization.deleted_at IS NULL AND NOT organization.is_personal
    JOIN organization_members membership ON membership.org_id=workspace.org_id AND membership.user_id=$3
    JOIN users actor ON actor.id=membership.user_id AND actor.deleted_at IS NULL AND actor.auth_status='active'
    LEFT JOIN cloud_workspace_members explicit_member ON explicit_member.workspace_id=workspace.id
      AND explicit_member.org_id=workspace.org_id AND explicit_member.user_id=$3
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND app_is_system()`,
    [input.workspaceId,input.organizationId,input.actorUserId])).rows[0];
  if(!row)throw new HttpError(404,"not_found","Cloud workspace not found");
  if(row.owner_user_id===input.actorUserId){
    await authorizeCloudWorkspaceDataAccess(tx,{organizationId:input.organizationId,teamId:row.team_id,
      actorUserId:input.actorUserId,ownerUserId:row.owner_user_id,requireWorkspaceOwner:true});return;
  }
  if(!row.manager)throw new HttpError(404,"not_found","Cloud workspace not found");
}

/** Account purge anonymizes users instead of deleting their row. Erase hashed
 * recipient addresses while identity history still exists for exact matching. */
export async function eraseCloudWorkspaceCollaborationIdentity(tx:Tx,userId:string):Promise<void> {
  await tx.query(`DELETE FROM cloud_workspace_invitations WHERE accepted_by=$1 OR invited_by=$1
    OR recipient_email_sha256 IN (
      SELECT digest(lower(btrim(email_at_link)),'sha256') FROM user_identities WHERE user_id=$1
      UNION SELECT digest(lower(btrim(email)),'sha256') FROM users WHERE id=$1
    )`,[userId]);
  // Reciprocal consent can cross account boundaries. Lock the complete set of
  // credential parents in one stable order before either FK cascade reaches a
  // lease. Session-first or owner-only ordering can lock the other's lease and
  // deadlock with its credential/delegation cascade during simultaneous purge.
  await tx.query(`SELECT credential.id FROM cloud_agent_credentials credential
    WHERE credential.owner_user_id=$1 OR EXISTS(SELECT 1 FROM cloud_agent_credential_delegations delegation
      WHERE delegation.credential_id=credential.id AND delegation.grantee_user_id=$1)
    ORDER BY credential.id FOR UPDATE OF credential`,[userId]);
  await tx.query("DELETE FROM cloud_agent_credentials WHERE owner_user_id=$1",[userId]);
  await tx.query("DELETE FROM cloud_agent_credential_delegations WHERE grantee_user_id=$1",[userId]);
  await tx.query("DELETE FROM cloud_workspace_actor_sessions WHERE actor_user_id=$1",[userId]);
  await tx.query("DELETE FROM cloud_workspace_guest_grants WHERE user_id=$1",[userId]);
  await tx.query("UPDATE cloud_workspace_guest_grants SET created_by=NULL WHERE created_by=$1",[userId]);
  await tx.query(`UPDATE cloud_workspace_directory_outbox SET
    owner_user_id=CASE WHEN owner_user_id=$1 THEN NULL ELSE owner_user_id END,
    guest_user_ids=array_remove(guest_user_ids,$1::uuid)
    WHERE owner_user_id=$1 OR $1::uuid=ANY(guest_user_ids)`,[userId]);
}

async function lockWorkspace(tx:Tx,scope:CloudWorkspaceActorScope):Promise<void> {
  validateScope(scope);
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
  const row = await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE",[scope.workspaceId,scope.organizationId]);
  if (row.rowCount!==1) unavailable();
}

/** Invitations convey a bounded workspace grant, not tenant membership. Tokens
 * are one-use, stored only as hashes and tied to a verified identity email. */
export class DatabaseCloudWorkspaceCollaborationService {
  constructor(private readonly pool:pg.Pool,private readonly delivery?:WorkspaceInvitationDeliveryConfig) {}

  async setSharing(input:CloudWorkspaceActorScope & {sharingMode:"private"|"organization";expectedRevision:number}) {
    if (!["private","organization"].includes(input.sharingMode) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1)
      throw new HttpError(422,"invalid_input","Invalid workspace sharing policy");
    return withSystemTx(this.pool,async tx=>{
      await lockWorkspace(tx,input);
      const authority = await authorizeCloudWorkspaceActor(tx,{...input,capability:"manage"});
      if (authority.accessRevision!==input.expectedRevision) throw new HttpError(409,"cloud_workspace_access_conflict","Workspace sharing changed");
      const row = (await tx.query<{access_revision:string}>(`UPDATE cloud_workspaces
        SET sharing_mode=$3,single_member_mode=false,access_revision=access_revision+1,version=version+1,updated_at=now()
        WHERE id=$1 AND org_id=$2 RETURNING access_revision`,[input.workspaceId,input.organizationId,input.sharingMode])).rows[0]!;
      await audit(tx,input.organizationId,input.actorUserId,"cloud_workspace.sharing_changed",{workspaceId:input.workspaceId,sharingMode:input.sharingMode});
      await emitCloudWorkspaceAccessChange(tx,{...input,reason:"sharing_changed",discoveryChanged:true});
      return {accessRevision:Number(row.access_revision),sharingMode:input.sharingMode};
    });
  }

  async invite(input:CloudWorkspaceActorScope & {email:string;role:"viewer"|"prompter"|"developer";idempotencyKey?:string}) {
    const email = z.string().trim().toLowerCase().email().max(254).safeParse(input.email);
    if (!email.success || !guestRole.safeParse(input.role).success) throw new HttpError(422,"invalid_input","Invalid workspace invitation");
    if(input.idempotencyKey!==undefined&&!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new HttpError(422,"invalid_input","Invalid invitation idempotency key");
    const token = `zwi_${randomBytes(32).toString("base64url")}`;
    const invitationId = randomUUID();
    const requestHash=digest(JSON.stringify([email.data,input.role]));
    return withSystemTx(this.pool,async tx=>{
      await lockWorkspace(tx,input);
      const inviter = await authorizeCloudWorkspaceActor(tx,{...input,capability:"manage"});
      if(input.idempotencyKey) {
        const replay=(await tx.query<{id:string;request_sha256:Buffer;expires_at:Date;revoked_at:Date|null;inviter_fingerprint:string;live:boolean}>(
          `SELECT id,request_sha256,expires_at,revoked_at,inviter_fingerprint,expires_at>clock_timestamp() AS live FROM cloud_workspace_invitations
          WHERE workspace_id=$1 AND invited_by=$2 AND idempotency_key=$3`,[input.workspaceId,input.actorUserId,input.idempotencyKey])).rows[0];
        if(replay) {
          if(!replay.request_sha256.equals(requestHash)||replay.revoked_at||!replay.live||replay.inviter_fingerprint!==inviter.fingerprint)
            throw new HttpError(409,"cloud_workspace_invitation_conflict","Invitation request is no longer reusable");
          return {id:replay.id,token:null,expiresAt:replay.expires_at.toISOString(),replayed:true};
        }
      }
      const current = (await tx.query<{single_member_mode:boolean}>("SELECT single_member_mode FROM cloud_workspaces WHERE id=$1",[input.workspaceId])).rows[0]!;
      if (current.single_member_mode) throw new HttpError(409,"cloud_workspace_sharing_required","Enable workspace collaboration before inviting guests");
      await tx.query(`UPDATE cloud_workspace_invitations SET revoked_at=now()
        WHERE workspace_id=$1 AND recipient_email_sha256=$2 AND revoked_at IS NULL AND accepted_at IS NULL`,[input.workspaceId,digest(email.data)]);
      await tx.query(`UPDATE cloud_workspace_invitation_deliveries delivery SET state='cancelled',nonce=NULL,ciphertext=NULL,auth_tag=NULL,lease_id=NULL,lease_expires_at=NULL
        FROM cloud_workspace_invitations invitation WHERE invitation.id=delivery.invitation_id AND invitation.workspace_id=$1
          AND invitation.revoked_at IS NOT NULL AND delivery.state IN ('queued','sending')`,[input.workspaceId]);
      const pending = (await tx.query<{count:string}>(`SELECT count(*) FROM cloud_workspace_invitations
        WHERE workspace_id=$1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>clock_timestamp()`,[input.workspaceId])).rows[0]!;
      if (Number(pending.count)>=100) throw new HttpError(409,"cloud_workspace_invitation_limit","Workspace invitation limit reached");
      const row = (await tx.query<{expires_at:Date}>(`INSERT INTO cloud_workspace_invitations
        (id,workspace_id,org_id,recipient_email_sha256,token_hash,role,invited_by,expires_at,inviter_fingerprint,idempotency_key,request_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '7 days',$8,$9,$10) RETURNING expires_at`,
      [invitationId,input.workspaceId,input.organizationId,digest(email.data),digest(token),input.role,input.actorUserId,inviter.fingerprint,input.idempotencyKey??null,input.idempotencyKey?requestHash:null])).rows[0]!;
      if(this.delivery) {
        const encoded=this.delivery.keys[this.delivery.currentKeyVersion];
        if(!encoded) throw new HttpError(503,"cloud_workspace_invitation_delivery_unavailable","Workspace invitation delivery is not configured");
        const sealed=sealWorkspaceInvitation({email:email.data,token,webOrigin:this.delivery.webOrigin},
          {invitationId,workspaceId:input.workspaceId,organizationId:input.organizationId,keyVersion:this.delivery.currentKeyVersion},encoded);
        await tx.query(`INSERT INTO cloud_workspace_invitation_deliveries(invitation_id,key_version,nonce,ciphertext,auth_tag)
          VALUES ($1,$2,$3,$4,$5)`,[invitationId,this.delivery.currentKeyVersion,sealed.nonce,sealed.ciphertext,sealed.authTag]);
      }
      await audit(tx,input.organizationId,input.actorUserId,"cloud_workspace.invited",{workspaceId:input.workspaceId,invitationId,role:input.role});
      await emitCloudWorkspaceAccessChange(tx,{...input,reason:"invitations_changed"});
      return {id:invitationId,token,expiresAt:row.expires_at.toISOString(),replayed:false};
    });
  }

  async accept(input:{actorUserId:string;identity:AuthedUser["identity"];token:string;expectedWorkspaceId?:string}) {
    if (!id.safeParse(input.actorUserId).success || !/^zwi_[A-Za-z0-9_-]{43}$/.test(input.token)) unavailable();
    const verifiedEmail = z.string().trim().toLowerCase().email().max(254).safeParse(input.identity.verifiedEmail);
    if (!verifiedEmail.success) unavailable();
    return withSystemTx(this.pool,async tx=>{
      // Discover immutable scope without a row lock, then use the same
      // organization → workspace → invitation order as invite/revoke.
      const scope = (await tx.query<{workspace_id:string;org_id:string}>("SELECT workspace_id,org_id FROM cloud_workspace_invitations WHERE token_hash=$1",[digest(input.token)])).rows[0];
      if (!scope) unavailable();
      if(input.expectedWorkspaceId!==undefined&&input.expectedWorkspaceId!==scope.workspace_id)unavailable();
      const binding = {workspaceId:scope.workspace_id,organizationId:scope.org_id,actorUserId:input.actorUserId};
      await lockWorkspace(tx,binding);
      const invitation = (await tx.query<{id:string;role:"viewer"|"prompter"|"developer";accepted_at:Date|null;accepted_by:string|null;guest_grant_id:string|null;invited_by:string|null;inviter_fingerprint:string}>(`SELECT invitation.id,invitation.role,invitation.accepted_at,invitation.accepted_by,invitation.guest_grant_id,invitation.invited_by,invitation.inviter_fingerprint
        FROM cloud_workspace_invitations invitation
        JOIN cloud_workspaces workspace ON workspace.id=invitation.workspace_id AND NOT workspace.single_member_mode
        WHERE invitation.token_hash=$1 AND invitation.revoked_at IS NULL AND invitation.expires_at>clock_timestamp()
          AND cloud_workspace_pro_user_live($2)
          AND EXISTS (SELECT 1 FROM user_identities identity WHERE identity.user_id=$2 AND identity.status='active' AND identity.email_verified_at IS NOT NULL
            AND identity.provider=$3 AND identity.provider_sub=$4)
          AND digest($5::text,'sha256')=invitation.recipient_email_sha256
        FOR UPDATE OF invitation`,[digest(input.token),input.actorUserId,input.identity.provider,input.identity.subject,verifiedEmail.data])).rows[0];
      if (!invitation) unavailable();
      if (invitation.accepted_at) {
        if (invitation.accepted_by!==input.actorUserId) unavailable();
        const live = await tx.query(`SELECT 1 FROM cloud_workspace_guest_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[invitation.guest_grant_id,input.actorUserId]);
        if (live.rowCount!==1) unavailable();
        return {...binding,grantId:invitation.guest_grant_id!,replayed:true};
      }
      // An invitation issued by someone who has since lost management authority
      // cannot create fresh access after their revocation.
      if (!invitation.invited_by) unavailable();
      const inviter = await authorizeCloudWorkspaceActor(tx,{...binding,actorUserId:invitation.invited_by,capability:"manage"});
      if (inviter.fingerprint!==invitation.inviter_fingerprint) unavailable();
      await tx.query(`UPDATE cloud_workspace_guest_grants SET revoked_at=now(),revision=revision+1 WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`,[scope.workspace_id,input.actorUserId]);
      const count = (await tx.query<{count:string}>(`SELECT count(*) FROM cloud_workspace_guest_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[scope.workspace_id])).rows[0]!;
      if (Number(count.count)>=100) throw new HttpError(409,"cloud_workspace_guest_limit","Workspace guest limit reached");
      const grantId = randomUUID();
      await tx.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,created_by,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,now()+interval '90 days')`,[grantId,scope.workspace_id,scope.org_id,input.actorUserId,invitation.role,invitation.invited_by]);
      await tx.query(`UPDATE cloud_workspace_invitations SET accepted_at=now(),accepted_by=$2,guest_grant_id=$3 WHERE id=$1`,[invitation.id,input.actorUserId,grantId]);
      await this.cancelInvalidDeliveries(tx,binding.workspaceId);
      await audit(tx,scope.org_id,input.actorUserId,"cloud_workspace.invitation_accepted",{workspaceId:scope.workspace_id,invitationId:invitation.id,grantId});
      await emitCloudWorkspaceAccessChange(tx,{...binding,reason:"guests_changed",target:{userId:input.actorUserId,reason:"access_granted"}});
      return {...binding,grantId,replayed:false};
    });
  }

  async revokeInvitation(input:CloudWorkspaceActorScope & {invitationId:string}) {
    if (!id.safeParse(input.invitationId).success) unavailable();
    return withSystemTx(this.pool,async tx=>{
      await lockWorkspace(tx,input);
      await authorizeCloudWorkspaceActor(tx,{...input,capability:"manage"});
      await tx.query(`UPDATE cloud_workspace_invitations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND org_id=$3`,[input.invitationId,input.workspaceId,input.organizationId]);
      await this.cancelInvalidDeliveries(tx,input.workspaceId);
      await audit(tx,input.organizationId,input.actorUserId,"cloud_workspace.invitation_revoked",{workspaceId:input.workspaceId,invitationId:input.invitationId});
      await emitCloudWorkspaceAccessChange(tx,{...input,reason:"invitations_changed"});
      return {revoked:true};
    });
  }

  async revokeGuest(input:CloudWorkspaceActorScope & {guestUserId:string}) {
    if (!id.safeParse(input.guestUserId).success) unavailable();
    return withSystemTx(this.pool,async tx=>{
      await lockWorkspace(tx,input);
      await authorizeCloudWorkspaceActor(tx,{...input,capability:"manage"});
      await tx.query(`UPDATE cloud_workspace_guest_grants SET revoked_at=now(),revision=revision+1
        WHERE workspace_id=$1 AND org_id=$2 AND user_id=$3 AND revoked_at IS NULL`,[input.workspaceId,input.organizationId,input.guestUserId]);
      await tx.query(`UPDATE cloud_workspace_invitations SET revoked_at=coalesce(revoked_at,now())
        WHERE workspace_id=$1 AND org_id=$2 AND (accepted_by=$3 OR recipient_email_sha256 IN (
          SELECT digest(lower(btrim(email_at_link)),'sha256') FROM user_identities WHERE user_id=$3
          UNION SELECT digest(lower(btrim(email)),'sha256') FROM users WHERE id=$3
        ))`,[input.workspaceId,input.organizationId,input.guestUserId]);
      await this.cancelInvalidDeliveries(tx,input.workspaceId);
      await audit(tx,input.organizationId,input.actorUserId,"cloud_workspace.guest_revoked",{workspaceId:input.workspaceId,guestUserId:input.guestUserId});
      await emitCloudWorkspaceAccessChange(tx,{...input,reason:"guests_changed",target:{userId:input.guestUserId,reason:"access_revoked"}});
      return {revoked:true};
    });
  }

  private async cancelInvalidDeliveries(tx:Tx,workspaceId:string):Promise<void> {
    await tx.query(`UPDATE cloud_workspace_invitation_deliveries delivery
      SET state='cancelled',nonce=NULL,ciphertext=NULL,auth_tag=NULL,lease_id=NULL,lease_expires_at=NULL
      FROM cloud_workspace_invitations invitation WHERE invitation.id=delivery.invitation_id AND invitation.workspace_id=$1
        AND (invitation.revoked_at IS NOT NULL OR invitation.accepted_at IS NOT NULL OR invitation.expires_at<=clock_timestamp())
        AND delivery.state IN ('queued','sending')`,[workspaceId]);
  }

  async list(input:CloudWorkspaceActorScope) {
    return withSystemTx(this.pool,async tx=>{
      await lockWorkspace(tx,input);
      const authority=await authorizeCloudWorkspaceActor(tx,{...input,capability:"manage"});
      const guests=await tx.query<{id:string;user_id:string;role:string;revision:string;expires_at:Date}>(`SELECT id,user_id,role,revision,expires_at
        FROM cloud_workspace_guest_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 100`,[input.workspaceId]);
      const invitations=await tx.query<{id:string;role:string;expires_at:Date;state:string|null}>(`SELECT invitation.id,invitation.role,invitation.expires_at,delivery.state
        FROM cloud_workspace_invitations invitation LEFT JOIN cloud_workspace_invitation_deliveries delivery ON delivery.invitation_id=invitation.id
        WHERE invitation.workspace_id=$1 AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL AND invitation.expires_at>clock_timestamp()
        ORDER BY invitation.created_at,invitation.id LIMIT 100`,[input.workspaceId]);
      return {accessRevision:authority.accessRevision,guests:guests.rows.map(row=>({id:row.id,userId:row.user_id,role:row.role,revision:Number(row.revision),expiresAt:row.expires_at.toISOString()})),
        invitations:invitations.rows.map(row=>({id:row.id,role:row.role,expiresAt:row.expires_at.toISOString(),deliveryState:row.state??"unavailable"}))};
    });
  }
}
