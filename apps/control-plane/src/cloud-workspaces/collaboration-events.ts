import type {Tx} from "../db.js";

/** Call after locking and changing the exact workspace authority. Broadcast
 * events are visible only to current readers; a removed guest gets a separate
 * targeted event. Discovery invalidation contains no private workspace ID. */
export async function emitCloudWorkspaceAccessChange(tx:Tx,input:{workspaceId:string;organizationId:string;
  reason:"sharing_changed"|"guests_changed"|"invitations_changed";
  target?:{userId:string;reason:"access_granted"|"access_revoked"};discoveryChanged?:boolean}):Promise<void> {
  await tx.query(`INSERT INTO security_events(kind,workspace_id,org_id,authorization_revision,payload)
    SELECT 'workspace.authorization_changed',id,org_id,access_revision,jsonb_build_object('reason',$3::text)
    FROM cloud_workspaces WHERE id=$1 AND org_id=$2`,[input.workspaceId,input.organizationId,input.reason]);
  if(input.target) await tx.query(`INSERT INTO security_events(kind,workspace_id,org_id,user_id,payload)
    VALUES ('workspace.authorization_changed',$1,$2,$3,jsonb_build_object('reason',$4::text))`,
  [input.workspaceId,input.organizationId,input.target.userId,input.target.reason]);
  if(input.discoveryChanged) await tx.query(`WITH revised AS (
      UPDATE organizations SET data_revision=data_revision+1 WHERE id=$1 RETURNING id,data_revision
    ) INSERT INTO security_events(kind,org_id,data_revision,payload)
      SELECT 'organization.data_changed',id,data_revision,'{"reason":"workspace_access_changed"}' FROM revised`,[input.organizationId]);
}
