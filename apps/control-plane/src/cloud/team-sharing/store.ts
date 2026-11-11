import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { securityStreamAuthority } from "../../security-events.js";
import type { createCloudGithubServices } from "../github-composition.js";
import type { CloudV2Store } from "../store.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { CloudTeamAuthority, TEAM_MEMBER, type TeamAdmission } from "./authority.js";
import { readTeamCursor, writeTeamCursor, teamCursorKey, teamNotFound, teamManagementDenied, type TeamList } from "./contract.js";
import { CloudTeamSignals } from "./signals.js";
import { CloudTeamEvents } from "./events.js";

type Github = Pick<ReturnType<typeof createCloudGithubServices>,"source" | "connections" | "metadata">;

/** Read and management admission cannot grant execution credentials;
 * activated writes require the separate per-person execution authority. */
export class CloudTeamSharing {
  readonly authority: CloudTeamAuthority;
  readonly signals: CloudTeamSignals;
  readonly events: CloudTeamEvents;
  constructor(readonly pool: pg.Pool, readonly workspaces: CloudV2Store, readonly github: Github, listenerPool = pool, now?: () => number) {
    this.authority = new CloudTeamAuthority(pool,github.source,github.connections.store);
    this.signals = new CloudTeamSignals(listenerPool);
    this.events = new CloudTeamEvents(this,this.signals,now);
  }

  async organization(tx: Tx, org: string, user: AuthedUser): Promise<void> {
    if (!await securityStreamAuthority(tx,user)) throw new HttpError(401,"session_revoked","Authentication is no longer current");
    const found = await tx.query(`SELECT 1 FROM organization_members m JOIN organizations o ON o.id=m.org_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND o.deleted_at IS NULL AND NOT o.is_personal AND o.cloud_workspaces_allowed
        AND NOT ${memberOnHoldSql("m.org_id","m.user_id")}`,[org,user.id]);
    if (!found.rowCount) throw teamNotFound();
  }

  async documents(proofs: readonly TeamAdmission[], omitDenied = false) {
    if (!proofs.length) return [];
    const current = proofs.filter(proof => !proof.view.workspace.sourcePending);
    const metadata = new Map((await this.github.metadata.documents(current.map(proof => proof.view.workspace),
      new Map(current.map(proof => [proof.view.workspace.id,proof.source!.fingerprint])))).map(row => [row.id,row]));
    const flags = await withSystemTx(this.pool,async tx => {
      const rows = (await tx.query<{ id: string; following: boolean; pinned: boolean; follower_ids: string[]; follower_count: string; execution_mode: string; can_execute: boolean }>(`SELECT w.id,w.execution_mode,coalesce(w.execution_mode='active' AND (w.state IN ('stopped','starting','creating') OR w.worker_boot_id=ANY(w.acting_user_boot_ids)),false) AS can_execute,
        EXISTS(SELECT 1 FROM cloud_v2_workspace_followers WHERE workspace_id=w.id AND user_id=$2) AS following,
        EXISTS(SELECT 1 FROM cloud_v2_workspace_pins WHERE workspace_id=w.id AND user_id=$2) AS pinned,
        ARRAY(SELECT user_id FROM cloud_v2_workspace_followers WHERE workspace_id=w.id ORDER BY user_id LIMIT 200) AS follower_ids,
        (SELECT count(*) FROM cloud_v2_workspace_followers WHERE workspace_id=w.id)::text AS follower_count
        FROM cloud_v2_workspaces w WHERE w.id=ANY($1::uuid[])`,[proofs.map(proof => proof.view.workspace.id),proofs[0]!.user.id])).rows;
      const allowed = await this.authority.assertMany(proofs,tx,omitDenied);
      return new Map(rows.filter(row => allowed.has(row.id)).map(row => [row.id,row]));
    });
    return proofs.filter(proof => flags.has(proof.view.workspace.id)).map(proof => {
      const id = proof.view.workspace.id, row = flags.get(id)!;
      return { ...(metadata.get(id) ?? proof.view.workspace),teamSharing: 1 as const,createdByUserId: proof.view.createdByUserId,viewerRole: proof.view.role,
        ...(row.execution_mode === "active" ? { teamWriting: 1 as const, canExecute: row.can_execute } : {}),
        readOnly: row.execution_mode === "active" ? !row.can_execute : proof.view.role !== "creator",canManage: proof.view.role !== "member",
        following: row.following,pinned: row.pinned,followerIds: row.follower_ids,followerCount: Number(row.follower_count) };
    });
  }

  async document(proof: TeamAdmission) { return (await this.documents([proof]))[0]!; }

  async get(id: string, user: AuthedUser) { return this.document(await this.authority.admit(id,user)); }

  async byNumber(organization: string, number: number, user: AuthedUser) {
    const row = (await withSystemTx(this.pool,tx => tx.query<{ id: string }>(`SELECT w.id FROM cloud_v2_workspaces w
      JOIN organizations o ON o.id=w.org_id JOIN organization_members m ON ${TEAM_MEMBER}
      WHERE o.slug=$1 AND w.number=$3 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}`, [organization,user.id,number]))).rows[0];
    if (!row) throw teamNotFound();
    return this.get(row.id,user);
  }

  async list(user: AuthedUser, query: TeamList) {
    const key = teamCursorKey([user.id,query.organizationId,query.creator ?? null,!!query.mine,!!query.following,!!query.pinned,query.repositoryId ?? null,query.archived]);
    const cursor = readTeamCursor(query.cursor,key);
    const rows = await withSystemTx(this.pool,async tx => {
      await this.organization(tx,query.organizationId,user);
      return (await tx.query<{ id: string; at: string }>(`SELECT w.id,to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM cloud_v2_workspaces w JOIN organization_members m ON ${TEAM_MEMBER}
        WHERE w.org_id=$1 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}
          AND (NOT w.source_pending OR w.creator_user_id=$2)
          AND ($3::uuid IS NULL OR w.creator_user_id=$3)
          AND (NOT $4::boolean OR EXISTS(SELECT 1 FROM cloud_v2_workspace_followers f WHERE f.workspace_id=w.id AND f.user_id=$2))
          AND (NOT $5::boolean OR EXISTS(SELECT 1 FROM cloud_v2_workspace_pins p WHERE p.workspace_id=w.id AND p.user_id=$2))
          AND ($6::bigint IS NULL OR EXISTS(SELECT 1 FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id AND s.repository_id=$6
            AND s.source_repository=lower(w.repository)))
          AND ($7='include' OR ($7='only')=(w.archived_at IS NOT NULL))
          AND ($8::timestamptz IS NULL OR w.created_at<$8 OR (w.created_at=$8 AND w.id>$9::uuid))
        ORDER BY w.created_at DESC,w.id LIMIT $10`,[query.organizationId,user.id,query.mine ? user.id : query.creator ?? null,
        !!query.following,!!query.pinned,query.repositoryId ?? null,query.archived,cursor?.at ?? null,cursor?.id ?? null,query.limit+1])).rows;
    });
    const selected = rows.slice(0,query.limit), proofs = await this.authority.admitMany(selected.map(row => row.id),user);
    // Keep page order independent of the batched SQL's plan and row order.
    const positions = new Map(selected.map((row,index) => [row.id,index]));
    proofs.sort((a,b) => positions.get(a.view.workspace.id)!-positions.get(b.view.workspace.id)!);
    await withSystemTx(this.pool,tx => this.organization(tx,query.organizationId,user));
    const workspaces = await this.documents(proofs,true);
    const last = selected.at(-1);
    return { workspaces,teamSharing: 1 as const,nextCursor: rows.length>query.limit && last ? writeTeamCursor(key,last.at,last.id) : null };
  }

  async read<T>(id: string, user: AuthedUser, operation: (proof: TeamAdmission) => Promise<T>): Promise<T> {
    const proof = await this.authority.admit(id,user);
    const value = await operation(proof);
    await this.authority.assert(proof);
    return value;
  }

  async manager(proof: TeamAdmission, tx: Tx) {
    const view = await this.authority.assert(proof,tx);
    if (view.role === "member") throw teamManagementDenied();
  }

  async activity(id: string, user: AuthedUser): Promise<{ running: boolean }> {
    const proof = await this.authority.admit(id,user);
    return withSystemTx(this.pool,async tx => {
      const view = await this.authority.assert(proof,tx);
      if (view.workspace.state !== "running") return { running: false };
      await tx.query(`UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()
        WHERE id=$1 AND state='running' AND access_epoch=$2
          AND (active_at IS NULL OR active_at<clock_timestamp()-interval '30 seconds')`,[id,view.epoch]);
      const current = await this.authority.assert(proof,tx);
      return { running: current.workspace.state === "running" };
    });
  }

  async manage(id: string, user: AuthedUser, action: "stop" | "archive" | "delete" | "rename", name?: string) {
    const proof = await this.authority.admit(id,user);
    if (proof.view.role === "member") throw teamManagementDenied();
    return this.workspaces.manage(id,action,tx => this.manager(proof,tx),name);
  }

  async mark(id: string, user: AuthedUser, kind: "follow" | "pin", enabled: boolean) {
    const proof = await this.authority.admit(id,user);
    await withSystemTx(this.pool,async tx => {
      const view = await this.authority.assert(proof,tx);
      if (kind === "follow" && enabled && view.role === "creator") throw new HttpError(409,"own_workspace","You cannot follow your own workspace");
      const table = kind === "follow" ? "cloud_v2_workspace_followers" : "cloud_v2_workspace_pins";
      if (enabled) await tx.query(`INSERT INTO ${table}(workspace_id,org_id,user_id) VALUES($1,$2,$3)
        ON CONFLICT(workspace_id,user_id) DO NOTHING`,[id,view.workspace.organizationId,user.id]);
      else await tx.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND user_id=$2`,[id,user.id]);
      await this.authority.assert(proof,tx);
    });
    return kind === "follow" ? { following: enabled } : { pinned: enabled };
  }

  async followers(id: string, user: AuthedUser, page: { limit: number; cursor?: string | undefined }) {
    const key = teamCursorKey(["followers",id,user.id]), cursor = readTeamCursor(page.cursor,key);
    return this.read(id,user,async () => {
      const rows = (await withSystemTx(this.pool,tx => tx.query<{ user_id: string; at: string }>(`SELECT user_id,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM cloud_v2_workspace_followers
        WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR created_at<$2 OR (created_at=$2 AND user_id>$3::uuid))
        ORDER BY created_at DESC,user_id LIMIT $4`,[id,cursor?.at ?? null,cursor?.id ?? null,page.limit+1]))).rows;
      const values = rows.slice(0,page.limit), last = values.at(-1);
      return { userIds: values.map(row => row.user_id),nextCursor: rows.length>page.limit && last ? writeTeamCursor(key,last.at,last.user_id) : null };
    });
  }
}
