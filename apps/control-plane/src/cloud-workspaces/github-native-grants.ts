import type { Tx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudGithubNativeSource } from "./github-native-schema.js";
import { assertCloudActorSession, assertRecordedCloudActor, type CloudActorEngineScope } from "./actor-sessions.js";
const denied = () => new HttpError(403, "github_cloud_write_denied", "Current repository write authority is required.");

/** A connected desktop may courier authority only for this live native source.
 * Agent execution authority and terminal session authority remain separate. */
export async function assertNativeGithubActor(tx: Tx, scope: Omit<CloudActorEngineScope, "heartbeatToken">,
  source: CloudGithubNativeSource, workosEnabled: boolean) {
  const current = (await tx.query<{live:boolean;fenced:boolean}>(
    "SELECT live,fenced FROM cloud_workspace_engine_authority_current($1,$2,$3,$4,$5,true)",
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
