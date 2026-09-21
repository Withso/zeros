import {randomUUID} from "node:crypto";
import type pg from "pg";
import {withSystemTx} from "../db.js";
import {HttpError} from "../authz.js";
import {EmailDeliveryError,sendEmailStrict,type EmailConfig} from "../email.js";
import {authorizeCloudWorkspaceActor,type WorkspaceInvitationDeliveryConfig} from "./actors.js";
import {lockCloudWorkspaceScope} from "./authorization.js";
import {openWorkspaceInvitation,type WorkspaceInvitationEnvelope} from "./invitation-envelope.js";
import type {CloudWorkspaceBackendConfig} from "../config.js";

export function workspaceInvitationDeliveryConfig(cloud:CloudWorkspaceBackendConfig|null,inviteLinkBase:string,email:EmailConfig|undefined):WorkspaceInvitationDeliveryConfig|null {
  if(!cloud||!email?.apiKey||!email.from)return null;
  const currentKeyVersion=cloud.currentSettingsSecretEncryptionKeyVersion??(cloud.settingsSecretKeyV1?1:null);
  const keys=cloud.settingsSecretEncryptionKeys??(cloud.settingsSecretKeyV1?{1:cloud.settingsSecretKeyV1}:{});
  if(!currentKeyVersion||!keys[currentKeyVersion])return null;
  const url=new URL(inviteLinkBase);if(url.protocol!=="https:"||url.username||url.password)return null;
  return {keys,currentKeyVersion,webOrigin:url.origin};
}

type Delivery={invitation_id:string;workspace_id:string;org_id:string;key_version:number;nonce:Buffer;ciphertext:Buffer;auth_tag:Buffer;
  lease_id:string;attempt_count:number;invited_by:string;inviter_fingerprint:string};
export type WorkspaceInvitationSender=(message:{to:string;subject:string;html:string;idempotencyKey:string})=>Promise<{messageId:string}>;

export function workspaceInvitationSender(config:EmailConfig):WorkspaceInvitationSender {
  return message=>sendEmailStrict(config,message.to,message.subject,message.html,{idempotencyKey:message.idempotencyKey});
}

/** At-least-once outbox with a stable provider key and bounded retry window.
 * A lease UUID fences every attempt, including attempts in the same process.
 * Network calls never hold a database connection. Revocation can race a send,
 * but the resulting email contains a revoked, unusable invitation. */
export class CloudWorkspaceInvitationDeliveryWorker {
  constructor(private readonly pool:pg.Pool,private readonly config:WorkspaceInvitationDeliveryConfig,
    private readonly send:WorkspaceInvitationSender,private readonly logger:Pick<Console,"error">=console) {}

  private async claim():Promise<Delivery|null> {
    return withSystemTx(this.pool,async tx=>{
      await tx.query(`WITH expired AS (
        SELECT delivery.invitation_id FROM cloud_workspace_invitation_deliveries delivery
        JOIN cloud_workspace_invitations invitation ON invitation.id=delivery.invitation_id
        WHERE (delivery.state='queued' OR (delivery.state='sending' AND delivery.lease_expires_at<=now()))
          AND (invitation.revoked_at IS NOT NULL OR invitation.accepted_at IS NOT NULL OR invitation.expires_at<=now()
            OR delivery.attempt_count>=12 OR delivery.first_attempt_at<=now()-interval '23 hours')
        ORDER BY delivery.next_attempt_at,delivery.invitation_id LIMIT 100 FOR UPDATE OF delivery SKIP LOCKED
      ) UPDATE cloud_workspace_invitation_deliveries delivery
        SET state='dead',last_error_code='delivery_window_closed',nonce=NULL,ciphertext=NULL,auth_tag=NULL,lease_id=NULL,lease_expires_at=NULL
        FROM expired WHERE delivery.invitation_id=expired.invitation_id`);
      return (await tx.query<Delivery>(`WITH candidate AS (
        SELECT delivery.invitation_id FROM cloud_workspace_invitation_deliveries delivery
        JOIN cloud_workspace_invitations invitation ON invitation.id=delivery.invitation_id
        WHERE ((delivery.state='queued' AND delivery.next_attempt_at<=now()) OR (delivery.state='sending' AND delivery.lease_expires_at<=now()))
          AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL AND invitation.expires_at>now()
          AND delivery.attempt_count<12 AND (delivery.first_attempt_at IS NULL OR delivery.first_attempt_at>now()-interval '23 hours')
        ORDER BY delivery.next_attempt_at,delivery.invitation_id LIMIT 1 FOR UPDATE OF delivery SKIP LOCKED
      ), claimed AS (
        UPDATE cloud_workspace_invitation_deliveries delivery SET state='sending',lease_id=$1,lease_expires_at=now()+interval '60 seconds',
          attempt_count=attempt_count+1,first_attempt_at=coalesce(first_attempt_at,now()),last_error_code=NULL
        FROM candidate WHERE delivery.invitation_id=candidate.invitation_id RETURNING delivery.*
      ) SELECT claimed.*,invitation.workspace_id,invitation.org_id,invitation.invited_by,invitation.inviter_fingerprint
        FROM claimed JOIN cloud_workspace_invitations invitation ON invitation.id=claimed.invitation_id`,[randomUUID()])).rows[0]??null;
    });
  }

  private async current(delivery:Delivery):Promise<boolean> {
    return withSystemTx(this.pool,async tx=>{
      await lockCloudWorkspaceScope(tx,{organizationId:delivery.org_id,workspaceId:delivery.workspace_id,workspaceLock:"share"});
      const current=await tx.query(`SELECT 1 FROM cloud_workspace_invitation_deliveries delivery
        JOIN cloud_workspace_invitations invitation ON invitation.id=delivery.invitation_id
        WHERE delivery.invitation_id=$1 AND delivery.lease_id=$2 AND delivery.state='sending' AND delivery.lease_expires_at>now()
          AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL AND invitation.expires_at>now()`,[delivery.invitation_id,delivery.lease_id]);
      if(!current.rowCount||!delivery.invited_by) return false;
      try {
        const authority=await authorizeCloudWorkspaceActor(tx,{organizationId:delivery.org_id,workspaceId:delivery.workspace_id,
          actorUserId:delivery.invited_by,capability:"manage"});
        return authority.fingerprint===delivery.inviter_fingerprint;
      } catch(error) {if(error instanceof HttpError&&(error.status===403||error.status===404))return false;throw error;}
    });
  }

  private async finish(delivery:Delivery,state:"sent"|"dead"|"cancelled"|"queued",code:string|null,messageId:string|null=null):Promise<void> {
    const delayMs=Math.min(3_600_000,5_000*2**Math.min(delivery.attempt_count,10));
    await withSystemTx(this.pool,tx=>tx.query(`UPDATE cloud_workspace_invitation_deliveries SET state=$3,
      last_error_code=$4,provider_message_id=$5,lease_id=NULL,lease_expires_at=NULL,
      next_attempt_at=CASE WHEN $3='queued' THEN now()+($6::bigint*interval '1 millisecond') ELSE next_attempt_at END,
      sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END,
      nonce=CASE WHEN $3='queued' THEN nonce ELSE NULL END,
      ciphertext=CASE WHEN $3='queued' THEN ciphertext ELSE NULL END,
      auth_tag=CASE WHEN $3='queued' THEN auth_tag ELSE NULL END
      WHERE invitation_id=$1 AND state='sending' AND lease_id=$2`,
    [delivery.invitation_id,delivery.lease_id,state,code,messageId,delayMs]));
  }

  async runOnce():Promise<boolean> {
    const delivery=await this.claim();if(!delivery)return false;
    if(!await this.current(delivery)) {await this.finish(delivery,"cancelled","authority_changed");return true;}
    let message;
    try {
      const envelope:WorkspaceInvitationEnvelope={nonce:delivery.nonce,ciphertext:delivery.ciphertext,authTag:delivery.auth_tag};
      message=openWorkspaceInvitation(envelope,{invitationId:delivery.invitation_id,workspaceId:delivery.workspace_id,
        organizationId:delivery.org_id,keyVersion:delivery.key_version},this.config.keys);
      // Never redirect an already queued capability to a different deployment.
      if(message.webOrigin!==this.config.webOrigin)throw new Error("origin changed");
    } catch {await this.finish(delivery,"dead","invitation_envelope_invalid");return true;}
    // Fragment keeps the one-use bearer out of HTTP access logs and referrers.
    const link=`${message.webOrigin}/workspace/${delivery.workspace_id}/invite#token=${message.token}`;
    try {
      const receipt=await this.send({to:message.email,subject:"You are invited to a Zeros cloud workspace",
        html:`<p>You have been invited to collaborate in a Zeros cloud workspace.</p><p><a href="${link}">Open invitation</a></p><p>Sign in using this email address. This invitation expires after seven days.</p>`,
        idempotencyKey:`zeros-workspace-invitation:${delivery.invitation_id}`});
      if(!receipt.messageId||receipt.messageId.length>256) throw new EmailDeliveryError("invalid_delivery_receipt",true);
      await this.finish(delivery,"sent",null,receipt.messageId);
    } catch(error) {
      const known=error instanceof EmailDeliveryError;
      const retry=(!known||error.retryable)&&delivery.attempt_count<12;
      const code=known?error.code.replace(/[^a-zA-Z0-9_.-]/g,"_").slice(0,128):"delivery_unavailable";
      await this.finish(delivery,retry?"queued":"dead",code);
    }
    return true;
  }

  start():()=>Promise<void> {
    let stopped=false,active:Promise<void>|null=null,timer:NodeJS.Timeout|undefined;
    const tick=()=>{
      if(stopped)return;
      active=(async()=>{for(let i=0;i<20&&!stopped;i++)if(!await this.runOnce())break;})()
        .catch(()=>this.logger.error("[cloud-workspace] invitation delivery tick failed"))
        .finally(()=>{active=null;if(!stopped){timer=setTimeout(tick,1000);timer.unref();}});
    };
    tick();return async()=>{stopped=true;clearTimeout(timer);await active;};
  }
}
