import type { Tx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudGithubNativeSource } from "./github-native-schema.js";
import { assertCloudActorSession, assertRecordedCloudActor, confirmDetachedCloudActor, type CloudActorEngineScope } from "./actor-sessions.js";
import {isDeepStrictEqual} from "node:util";
import {CloudBootCustomizationBindingSchema} from "./mcp-contract.js";
import {lockCustomization,readCustomizationRows} from "./customization-store.js";
import {readCloudAgentFundingConsent} from "./agent-funding-consent.js";
import {assertCloudEngineAuthorityDeadline} from "./engine-authority.js";
const denied = () => new HttpError(403, "github_cloud_write_denied", "Current repository write authority is required.");

/** A connected desktop may courier authority only for this live native source.
 * Agent execution authority and terminal session authority remain separate. */
export async function assertNativeGithubActor(tx: Tx, scope: Omit<CloudActorEngineScope, "heartbeatToken">,
  source: CloudGithubNativeSource, workosEnabled: boolean) {
  const current = (await tx.query<{live:boolean;fenced:boolean;authority_epoch:string}>(
    "SELECT live,fenced,authority_epoch FROM cloud_workspace_engine_authority_current($1,$2,$3,$4,$5,true)",
    [scope.workspaceId,scope.organizationId,scope.generation,scope.engineInstanceId,workosEnabled])).rows[0];
  if (!current?.live || current.fenced) throw denied();
    let actor;
    if (source.kind === "terminal")
      actor = await assertCloudActorSession(
        tx,
        scope,
        source.actorSessionId,
        "edit",
      );
    else if(source.kind==="boot-agent"){
      try {
      const row=(await tx.query<{binding:unknown;organization_revision:string;member_revision:string;actor_session_id:string}>(`SELECT context.binding,
        context.organization_revision,context.member_revision,context.actor_session_id
        FROM cloud_agent_boot_contexts context JOIN cloud_agent_boot_bindings boot ON boot.id=context.binding_id
        JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=boot.workspace_id AND writer.org_id=boot.org_id
          AND writer.writer_epoch=boot.writer_epoch AND writer.engine_instance_id=boot.engine_instance_id AND writer.boot_id=boot.boot_id
          AND writer.generation=boot.generation AND writer.funding_owner_user_id=boot.funding_owner_user_id AND writer.funding_owner_epoch=boot.funding_owner_epoch
        JOIN cloud_workspaces workspace ON workspace.id=boot.workspace_id AND workspace.org_id=boot.org_id
          AND workspace.agent_command_mode='boot-owner-v1' AND workspace.agent_boot_id=boot.id
        WHERE context.context_id=$1 AND boot.workspace_id=$2 AND boot.org_id=$3 AND boot.generation=$4 AND boot.engine_instance_id=$5
          AND context.retired_at IS NULL AND context.expires_at>clock_timestamp() AND boot.retired_at IS NULL AND writer.state='active'
          AND context.binding->>'contextId'=context.context_id::text AND context.binding->>'actorSessionId'=context.actor_session_id::text
          AND context.binding->>'organizationId'=boot.org_id::text AND context.binding->>'workspaceId'=boot.workspace_id::text
          AND context.binding->>'generation'=boot.generation::text AND context.binding->>'engineInstanceId'=boot.engine_instance_id::text
          AND context.binding->>'bootId'=boot.boot_id::text AND context.binding->>'writerEpoch'=boot.writer_epoch::text
          AND context.binding->>'fundingOwnerUserId'=boot.funding_owner_user_id::text AND context.binding->>'fundingOwnerEpoch'=boot.funding_owner_epoch::text
          AND context.binding->>'provider'=context.provider AND context.binding->>'conversationId'=context.conversation_id
          AND context.binding->>'model'=context.model AND context.binding->>'cwd'=context.cwd FOR SHARE OF context,boot,writer`,
        [source.contextId,scope.workspaceId,scope.organizationId,scope.generation,scope.engineInstanceId])).rows[0];
      const parsed=CloudBootCustomizationBindingSchema.safeParse(row?.binding);
      if(!row||!parsed.success)throw denied();
      const binding=parsed.data;
      const sender=await confirmDetachedCloudActor(tx,scope,row.actor_session_id);
      if(sender.actorUserId!==binding.actorUserId||sender.deviceId!==binding.actorDeviceId||sender.deviceKeyVersion!==binding.actorDeviceKeyVersion||
        sender.fingerprint!==binding.actorFingerprint||Number(current.authority_epoch)!==binding.authorityEpoch)throw denied();
      await assertRecordedCloudActor(tx,{...scope,actorUserId:sender.actorUserId,actor:sender,capability:"edit"});
      const grant=await readCloudAgentFundingConsent(tx,binding,{userId:sender.actorUserId,role:sender.role});
      if(!isDeepStrictEqual(grant,binding.fundingGrant))throw denied();
      await lockCustomization(tx,scope.organizationId);
      const customization=await readCustomizationRows(tx,scope.organizationId,sender.actorUserId);
      if(Number(row.organization_revision)!==Number(customization.find(value=>value.owner_user_id===null)?.revision??0)||
        Number(row.member_revision)!==Number(customization.find(value=>value.owner_user_id===sender.actorUserId)?.revision??0))throw denied();
      await confirmDetachedCloudActor(tx,scope,row.actor_session_id);
      await assertCloudEngineAuthorityDeadline(tx,scope.engineInstanceId,workosEnabled);
      if((await tx.query("SELECT 1 FROM cloud_agent_boot_contexts WHERE context_id=$1 AND retired_at IS NULL AND expires_at>clock_timestamp()",[source.contextId])).rowCount!==1)throw denied();
      actor=sender;
      }catch{throw denied();}
    }
    else {
      const row = (
        await tx.query<{
          actorUserId: string;
          deviceId: string;
          deviceKeyVersion: number;
          fingerprint: string;
          sourceSessionId: string;
        }>(
          `SELECT
        session.actor_user_id AS "actorUserId",session.device_id AS "deviceId",session.device_key_version::int AS "deviceKeyVersion",
        session.actor_fingerprint AS fingerprint,session.id AS "sourceSessionId"
        FROM cloud_agent_execution_leases lease
        JOIN cloud_workspace_actor_sessions session ON session.id=lease.actor_source_session_id
        JOIN cloud_agent_credentials credential ON credential.id=lease.credential_id AND credential.revision=lease.credential_revision AND credential.revoked_at IS NULL
        JOIN cloud_agent_credential_delegations delegation ON delegation.id=lease.delegation_id AND delegation.credential_id=credential.id
          AND delegation.credential_revision=credential.revision AND delegation.revoked_at IS NULL AND delegation.expires_at>clock_timestamp()
          AND delegation.grantee_user_id=session.actor_user_id
        WHERE lease.id=$1 AND lease.workspace_id=$2 AND lease.org_id=$3 AND lease.generation=$4 AND lease.engine_instance_id=$5
          AND lease.released_at IS NULL AND lease.expires_at>clock_timestamp()`,
          [
            source.leaseId,
            scope.workspaceId,
            scope.organizationId,
            scope.generation,
            scope.engineInstanceId,
          ],
        )
      ).rows[0];
      if (!row) throw denied();
      await assertRecordedCloudActor(tx, {
        ...scope,
        actorUserId: row.actorUserId,
        actor: row,
        capability: "edit",
      });
      actor = row;
    }
    return actor;
}
