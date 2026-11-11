import { randomUUID } from "node:crypto";
import { HttpError } from "../../authz.js";
import { withSystemTx } from "../../db.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { teamConnectionRevisionSql, type CloudTeamAuthority, type TeamAdmission } from "./authority.js";
import { teamNotFound } from "./contract.js";

export const TEAM_PRESENCE_TTL_MS = 65_000, TEAM_PRESENCE_RENEW_MS = 30_000;
const presentPeople = `SELECT DISTINCT p.user_id,jsonb_build_array(u.auth_revision,m.authorization_revision,m.created_at,
    (SELECT authorization_revision FROM organizations WHERE id=p.org_id),${teamConnectionRevisionSql("p.org_id","p.user_id")}) AS signature
  FROM cloud_v2_workspace_presence p
  JOIN cloud_v2_workspaces w ON w.id=p.workspace_id AND w.org_id=p.org_id AND w.access_epoch=p.access_epoch
  JOIN organization_members m ON m.org_id=p.org_id AND m.user_id=p.user_id
  JOIN users u ON u.id=p.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
  JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=p.provider_session_id AND s.user_id=p.user_id
  WHERE p.workspace_id=$1 AND p.expires_at>clock_timestamp() AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}
    AND NOT ${memberOnHoldSql("m.org_id","m.user_id")} AND s.status='active' AND s.revoked_at IS NULL
    AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
    AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=u.id AND i.provider=s.provider AND i.provider_sub=s.provider_sub AND i.status='active')`;

export class CloudTeamPresence {
  constructor(readonly authority: CloudTeamAuthority) {}

  async open(proof: TeamAdmission): Promise<string> {
    const user = proof.user, id = randomUUID();
    if (!user.authentication.sessionId) throw new HttpError(401,"session_revoked","A current device session is required");
    return withSystemTx(this.authority.pool,async tx => {
      // Only stream registration takes this short per-person lock. Passive
      // authority and transcript reads never acquire a workspace mutation lock.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0)) /* lock_purpose='cloud-team-presence-cap' */",[`team-presence:${user.id}`]);
      const view = await this.authority.assert(proof,tx);
      await tx.query(`WITH expired AS (SELECT connection_id FROM cloud_v2_workspace_presence WHERE expires_at<=clock_timestamp()
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM cloud_v2_workspace_presence p USING expired e WHERE p.connection_id=e.connection_id`);
      const counts = (await tx.query<{ total: string; workspace: string }>(`SELECT count(*)::text AS total,
        count(*) FILTER(WHERE workspace_id=$2)::text AS workspace FROM cloud_v2_workspace_presence
        WHERE user_id=$1 AND expires_at>clock_timestamp()`,[user.id,view.workspace.id])).rows[0]!;
      if (Number(counts.total)>=16 || Number(counts.workspace)>=2) throw new HttpError(429,"rate_limited","Too many workspace streams");
      await tx.query(`INSERT INTO cloud_v2_workspace_presence(connection_id,workspace_id,org_id,user_id,provider_session_id,access_epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '65 seconds')`,
      [id,view.workspace.id,view.workspace.organizationId,user.id,user.authentication.sessionId,view.epoch]);
      await this.authority.assert(proof,tx);
      return id;
    });
  }

  async renew(id: string, proof: TeamAdmission): Promise<void> {
    await withSystemTx(this.authority.pool,async tx => {
      const view = await this.authority.assert(proof,tx);
      const result = await tx.query(`UPDATE cloud_v2_workspace_presence SET expires_at=clock_timestamp()+interval '65 seconds'
        WHERE connection_id=$1 AND workspace_id=$2 AND user_id=$3 AND provider_session_id=$4 AND access_epoch=$5
          AND expires_at>clock_timestamp()`,[id,view.workspace.id,proof.user.id,proof.user.authentication.sessionId,view.epoch]);
      if (!result.rowCount) throw teamNotFound();
      await this.authority.assert(proof,tx);
    });
  }

  async close(connectionId: string): Promise<void> {
    await withSystemTx(this.authority.pool,tx => tx.query("DELETE FROM cloud_v2_workspace_presence WHERE connection_id=$1",[connectionId]));
  }

  async snapshot(proof: TeamAdmission): Promise<{ workspaceId: string; userIds: string[]; total: number }> {
    return withSystemTx(this.authority.pool,async tx => {
      const view = await this.authority.assert(proof,tx);
      const candidates = (await tx.query<{ user_id: string; signature: unknown }>(`${presentPeople} ORDER BY p.user_id`,[view.workspace.id])).rows;
      const admitted: { user_id: string; fingerprint: string; signature: unknown }[] = [];
      for (let offset=0;offset<candidates.length;offset+=200) {
        const page = candidates.slice(offset,offset+200);
        const generations = await this.authority.connections.fingerprintsForPeople(tx,view.workspace.organizationId,page.map(row => row.user_id));
        for (const row of page) {
          const fingerprint = generations.get(row.user_id);
          if (fingerprint) admitted.push({ ...row,fingerprint });
        }
      }
      const rows = (await tx.query<{ user_id: string }>(`WITH people AS (${presentPeople})
        SELECT admitted.user_id FROM jsonb_to_recordset($2::jsonb) admitted(user_id uuid,fingerprint text,signature jsonb)
        JOIN people ON people.user_id=admitted.user_id AND people.signature=admitted.signature
        WHERE EXISTS(SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND source_pending AND creator_user_id=admitted.user_id)
        OR (EXISTS(SELECT 1 FROM cloud_v2_github_sources WHERE workspace_id=$1)
        AND NOT EXISTS(SELECT 1 FROM cloud_v2_github_sources src LEFT JOIN cloud_github_source_verifications v
          ON v.org_id=$3 AND v.owner_user_id=admitted.user_id AND v.repository_id=src.repository_id AND v.fingerprint=admitted.fingerprint
          WHERE src.workspace_id=$1 AND (v.verified_at IS NULL OR v.verified_at<=clock_timestamp()-interval '60 minutes'
            OR v.verified_at>clock_timestamp() OR (v.failure_code IS NOT NULL AND NOT (
              (v.failure_status=429 AND v.failure_code='github_rate_limited') OR (v.failure_status=503 AND v.failure_code IN
                ('github_unavailable','github_verification_busy','github_verification_expired','github_refresh_pending','github_refresh_uncertain','github_oauth_failed','github_bad_response')))))))
        ORDER BY admitted.user_id`,[view.workspace.id,JSON.stringify(admitted),view.workspace.organizationId])).rows;
      await this.authority.assert(proof,tx);
      return { workspaceId: view.workspace.id,userIds: rows.slice(0,200).map(row => row.user_id),total: rows.length };
    });
  }
}
