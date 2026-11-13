import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx } from "../../db.js";
import { isGithubAccessRevoked } from "../../github-availability.js";
import { SECURITY_STREAM_AUTHORITY, securityStreamParameters } from "../../security-events.js";
import type { createSelectedCloudGithubTokens } from "../github-selected-tokens.js";
import type { LocalDeviceBinding } from "../local-commands/contract.js";
import { CloudLocalDevices, notFound } from "../local-commands/devices.js";
import { teamConnectionRevisionSql } from "../team-sharing/authority.js";
import { CLOUD_V2_LIVE_ACCESS, cloudV2ActorAccess } from "../workspace-access.js";

type Snapshot = {
  organizationId: string; repository: string; repositoryId: string; executionMode: string; accessEpoch: string;
  connectedAt: string; connected: boolean; wanted: boolean; sourcePending: boolean;
  memberRevision: string; memberCreatedAt: string; role: string; organizationRevision: string;
  connectionRevision: unknown; sessionCurrent: boolean; deviceCurrent: boolean;
};
const changed = () => new HttpError(409, "github_authorization_changed", "Workspace sync authority changed. Try again.");

export class CloudWorkspaceGithubReadTokens {
  constructor(private readonly pool: pg.Pool, private readonly devices: CloudLocalDevices,
    private readonly mint: ReturnType<typeof createSelectedCloudGithubTokens>) {}

  private snapshot(workspaceId: string, user: AuthedUser, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      await this.devices.verify(tx, user, binding);
      // Device verification can wait. Every admission field, including the
      // current session and selected connection, is re-read in this statement.
      const row = (await tx.query<Snapshot>(`SELECT w.org_id AS "organizationId",w.repository,s.repository_id::text AS "repositoryId",
        w.execution_mode AS "executionMode",w.access_epoch::text AS "accessEpoch",w.source_pending AS "sourcePending",
        m.authorization_revision::text AS "memberRevision",m.created_at::text AS "memberCreatedAt",m.role,
        o.authorization_revision::text AS "organizationRevision",${teamConnectionRevisionSql("w.org_id", "$1")} AS "connectionRevision",
        (${SECURITY_STREAM_AUTHORITY} AND (a.provider_session_expires_at IS NULL OR a.provider_session_expires_at>clock_timestamp())) AS "sessionCurrent",
        EXISTS (SELECT 1 FROM local_command_devices d WHERE d.user_id=$1 AND d.device_id=$8 AND d.registration_id=$9
          AND d.instance_id=$10 AND d.provider_session_id=$5 AND d.revoked_at IS NULL) AS "deviceCurrent",
        c.connected_at::text AS "connectedAt",coalesce(c.sync_wanted,false) AS wanted,
        coalesce(c.disconnected_at IS NULL AND c.registration_id=$9
          AND (c.is_latest_sender OR greatest(c.connected_at,c.last_used_at)>clock_timestamp()-interval '12 hours'),false) AS connected
        FROM cloud_v2_workspaces w JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$1
        JOIN organizations o ON o.id=w.org_id
        LEFT JOIN auth_sessions a ON a.user_id=$1 AND a.provider='workos' AND a.provider_session_id=$5
        LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower(w.repository)
        LEFT JOIN cloud_v2_connected_macs c ON c.workspace_id=w.id AND c.user_id=$1 AND c.device_id=$8
        WHERE w.id=$7 AND w.state NOT IN ('deleting','deleted') AND ${cloudV2ActorAccess("$1")} AND ${CLOUD_V2_LIVE_ACCESS}`,
      [...securityStreamParameters(user), workspaceId, binding.deviceId, binding.registrationId, binding.instanceId])).rows[0];
      if (!row) throw notFound();
      if (!row.sessionCurrent) throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      if (!row.deviceCurrent) throw new HttpError(409, "device_registration_changed", "This desktop registration is no longer current");
      if (!row.connected) throw new HttpError(403, "mac_not_connected", "Connect this Mac to the workspace before syncing");
      if (!row.wanted) throw new HttpError(403, "sync_not_wanted", "Turn on sync for this Mac before requesting repository access");
      if (row.sourcePending || !row.repositoryId)
        throw new HttpError(409, "cloud_source_review_required", "The workspace's original repository identity is unavailable");
      return row;
    });
  }

  async issue(workspaceId: string, user: AuthedUser, binding: LocalDeviceBinding) {
    workspaceId = workspaceId.toLowerCase();
    const before = await this.snapshot(workspaceId, user, binding);
    const assertCurrent = async () => {
      const after = await this.snapshot(workspaceId, user, binding);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw changed();
    };
    try {
      const value = await this.mint({ organizationId: before.organizationId, userId: user.id },
        { repository: before.repository, repositoryId: before.repositoryId }, "read", "sync", assertCurrent);
      return { token: value.token, expiresAt: new Date(value.expiresAt).toISOString(), repository: value.repository ?? before.repository };
    } catch (error) {
      await assertCurrent();
      if (error instanceof HttpError && error.code.startsWith("github_") && isGithubAccessRevoked(error))
        throw new HttpError(403, "github_access_required", "Your GitHub account needs access to this repository.");
      throw error;
    }
  }
}
