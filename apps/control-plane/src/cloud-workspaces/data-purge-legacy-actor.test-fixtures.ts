// Historical actor data for the populated schema-0141 upgrade. Keep these
// INSERT shapes frozen: current admission/command services require migrations
// that this fixture intentionally has not applied. After upgrade the migration
// test uses the ordinary service-backed deletion fixture again.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

export async function seedPrePurgeActorGraph(pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture): Promise<void> {
  await withSystemTx(pool, async tx => {
    const providerSessionId = `session_${randomUUID()}`, deviceId = randomUUID(), actorId = randomUUID();
    const publicKey = randomBytes(32), fingerprint = "a".repeat(64), userMessageId = randomUUID();
    await tx.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      SELECT $1,provider_sub,user_id,'desktop',now()+interval '1 hour'
      FROM user_identities WHERE user_id=$2 AND provider='workos'`,
    [providerSessionId, fixture.userId]);
    await tx.query(`INSERT INTO devices(id,user_id,label,platform,public_key,key_fingerprint)
      VALUES($1,$2,'Historical deletion actor','macos',$3,$4)`,
    [deviceId, fixture.userId, publicKey, createHash("sha256").update(publicKey).digest()]);
    await tx.query(`INSERT INTO cloud_workspace_actor_sessions
      (id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,
       authority_epoch,actor_fingerprint,actor_role,token_hash,admission_expires_at,session_expires_at,
       consumed_at,last_renewed_at,auth_provider,auth_subject,auth_session_id,auth_session_created_at)
      SELECT $1,$2,$3,1,$4,$5,$6,1,workspace.authority_epoch,$7,'owner',$8,
        now()+interval '2 minutes',now()+interval '24 hours',now(),now(),
        source.provider,source.provider_sub,source.provider_session_id,source.created_at
      FROM cloud_workspaces workspace JOIN auth_sessions source
        ON source.provider_session_id=$9 AND source.provider='workos' AND source.user_id=workspace.owner_user_id
      WHERE workspace.id=$2 AND workspace.org_id=$3`,
    [actorId, fixture.workspaceId, fixture.organizationId, fixture.engineInstanceId, fixture.userId,
      deviceId, fingerprint, randomBytes(32), providerSessionId]);
    await tx.query(`INSERT INTO cloud_workspace_conversation_controls
      (workspace_id,org_id,conversation_id,revision,next_position) VALUES($1,$2,'deletion-chat',2,2)`,
    [fixture.workspaceId, fixture.organizationId]);
    await tx.query(`INSERT INTO cloud_workspace_commands
      (workspace_id,org_id,id,conversation_id,user_message_id,position,state,payload,generation,
       engine_instance_id,execution_id,claim_id,actor_user_id,actor_device_id,actor_device_key_version,
       actor_fingerprint,actor_source_session_id)
      VALUES($1,$2,$3,'deletion-chat',$4,1,'dispatching',$5,1,$6,'deletion-execution',$7,$8,$9,1,$10,$11)`,
    [fixture.workspaceId, fixture.organizationId, randomUUID(), userMessageId,
      { agentId: "claude", modeRevision: 0, userMessageId, prompt: [{ type: "text", text: "synthetic deletion prompt" }] },
      fixture.engineInstanceId, randomUUID(), fixture.userId, deviceId, fingerprint, actorId]);
    await tx.query(`INSERT INTO cloud_workspace_command_operations
      (workspace_id,org_id,operation_id,conversation_id,request_sha256,revision,actor_user_id,actor_device_id)
      VALUES($1,$2,$3,'deletion-chat',$4,1,$5,$6)`,
    [fixture.workspaceId, fixture.organizationId, randomUUID(), randomBytes(32), fixture.userId, deviceId]);
    await tx.query(`INSERT INTO cloud_workspace_event_streams
      (workspace_id,org_id,generation,engine_instance_id,head,last_batch_id,last_batch_sha256)
      VALUES($1,$2,1,$3,1,$4,$5)`,
    [fixture.workspaceId, fixture.organizationId, fixture.engineInstanceId, randomUUID(), randomBytes(32)]);
    const frame = { id: randomUUID(), source: "engine", timestamp: 0, type: "AGENT_SESSION_UPDATE",
      content: "synthetic deletion event", cloudStream: { streamId: fixture.engineInstanceId, sequence: 1 } };
    await tx.query(`INSERT INTO cloud_workspace_stream_events(workspace_id,org_id,sequence,frame,encoded_bytes)
      VALUES($1,$2,1,$3,$4)`,
    [fixture.workspaceId, fixture.organizationId, frame, Buffer.byteLength(JSON.stringify(frame))]);
    await tx.query(`INSERT INTO cloud_workspace_action_receipts
      (workspace_id,org_id,operation_id,conversation_id,execution_id,kind,request_id,request_sha256,
       generation,engine_instance_id,claim_id,state,actor_user_id,actor_device_id)
      VALUES($1,$2,$3,'deletion-chat','deletion-execution','permission',$4,$5,1,$6,$7,'dispatching',$8,$9)`,
    [fixture.workspaceId, fixture.organizationId, randomUUID(), randomUUID(), randomBytes(32),
      fixture.engineInstanceId, randomUUID(), fixture.userId, deviceId]);
  });
}
