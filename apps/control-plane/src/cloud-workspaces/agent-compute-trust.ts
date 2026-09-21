import {createHash} from "node:crypto";
import type {Tx} from "../db.js";

export type CloudAgentComputeTrust={fingerprint:string;trust:"zeros-managed"|"compute-administrator"};

/** A VM owner can inspect guest memory regardless of the in-guest UID layout.
 * Consent must name this exact compute account/version, not just its vendor.
 * Hosted credentials are operator-managed; delegated credentials belong to a
 * customer administrator and require a separate explicit consent decision. */
export async function readCloudAgentComputeTrust(tx:Tx,workspaceId:string):Promise<CloudAgentComputeTrust|null>{
  const row=(await tx.query<{id:string;version:string;provider:string;source:"hosted"|"delegated";owner_kind:string;owner_user_id:string|null;
    org_id:string;authorization_revision:string;created_by:string|null;endpoint:string;credential_sha256:Buffer|null}>(`SELECT connection.id,version.version,connection.provider,
      version.credential_source AS source,connection.owner_kind,connection.owner_user_id,connection.org_id,organization.authorization_revision,version.created_by,version.endpoint,version.credential_sha256
    FROM cloud_workspaces workspace JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.generation=workspace.current_generation
    JOIN organizations organization ON organization.id=workspace.org_id
    JOIN provider_connections connection ON connection.id=generation.provider_connection_id AND connection.org_id=workspace.org_id
    JOIN provider_connection_versions version ON version.connection_id=connection.id AND version.org_id=connection.org_id AND version.version=generation.provider_connection_version
    WHERE workspace.id=$1 AND workspace.deleted_at IS NULL AND connection.state='active' AND connection.revoked_at IS NULL
      AND version.retired_at IS NULL AND connection.current_version=version.version AND connection.credential_source=version.credential_source`,[workspaceId])).rows[0];
  if(!row)return null;
  const fingerprint=createHash("sha256").update(JSON.stringify(["zeros-agent-compute-consent-v1",row.id,String(row.version),row.provider,row.source,
    row.owner_kind,row.owner_user_id,row.org_id,String(row.authorization_revision),row.created_by,row.endpoint,row.credential_sha256?.toString("hex")??null])).digest("hex");
  return {fingerprint,trust:row.source==="hosted"?"zeros-managed":"compute-administrator"};
}
