import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { configureCloudTeamOwnership } from "../../db-context.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { securityStreamAuthority } from "../../security-events.js";
import type { createCloudGithubServices } from "../github-composition.js";
import type { CloudV2Store } from "../store.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { CloudTeamAuthority, TEAM_MEMBER, type TeamAdmission } from "./authority.js";
import { readTeamCursor, writeTeamCursor, teamCursorKey, teamNotFound, teamManagementDenied, teamOwnershipRequired, teamOwnershipDenied, teamUnavailable, type TeamList } from "./contract.js";
import { CloudTeamSignals } from "./signals.js";
import { CloudTeamEvents } from "./events.js";
import { CloudTeamOwnership } from "./ownership.js";

type Github = Pick<ReturnType<typeof createCloudGithubServices>,"source" | "connections" | "metadata">;

/** Read and management admission cannot grant execution credentials;
 * activated writes require the separate per-person execution authority. */
export class CloudTeamSharing {
  readonly authority: CloudTeamAuthority;
  readonly signals: CloudTeamSignals;
  readonly events: CloudTeamEvents;
  readonly ownership: CloudTeamOwnership;
  constructor(readonly pool: pg.Pool, readonly workspaces: CloudV2Store, readonly github: Github, listenerPool = pool, now?: () => number,
    options: { ownership?: boolean } = {}) {
    configureCloudTeamOwnership(pool, options.ownership === true);
    this.authority = new CloudTeamAuthority(pool,github.source,github.connections.store);
    this.signals = new CloudTeamSignals(listenerPool);
    this.events = new CloudTeamEvents(this,this.signals,now);
    this.ownership = new CloudTeamOwnership(this, options.ownership === true);
  }

  async organization(tx: Tx, org: string, user: AuthedUser): Promise<void> {
    if (!await securityStreamAuthority(tx,user)) throw new HttpError(401,"session_revoked","Authentication is no longer current");
    const found = await tx.query(`SELECT 1 FROM organization_members m JOIN organizations o ON o.id=m.org_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND o.deleted_at IS NULL AND NOT o.is_personal AND o.cloud_workspaces_allowed
        AND NOT ${memberOnHoldSql("m.org_id","m.user_id")}`,[org,user.id]);
    if (!found.rowCount) throw teamNotFound();
  }

  async documents(proofs: readonly TeamAdmission[], omitDenied = false, ownership = false, transaction?: Tx) {
    if (!proofs.length) return [];
    const read = async (tx: Tx) => {
      const current = proofs.filter(proof => !proof.view.workspace.sourcePending);
      const metadata = new Map((await this.github.metadata.documents(current.map(proof => proof.view.workspace),undefined,tx)).map(row => [row.id,row]));
      const rows = (await tx.query<{ id: string; creator_revision: string; following: boolean; pinned: boolean; follower_ids: string[]; follower_count: string; execution_mode: string; can_execute: boolean }>(`SELECT w.id,w.creator_revision::text,w.execution_mode,coalesce(w.execution_mode='active' AND (w.state IN ('stopped','starting','creating') OR w.worker_boot_id=ANY(w.acting_user_boot_ids)),false) AS can_execute,
        EXISTS(SELECT 1 FROM cloud_v2_workspace_followers WHERE workspace_id=w.id AND user_id=$2) AS following,
        EXISTS(SELECT 1 FROM cloud_v2_workspace_pins WHERE workspace_id=w.id AND user_id=$2) AS pinned,
        ARRAY(SELECT user_id FROM cloud_v2_workspace_followers WHERE workspace_id=w.id ORDER BY user_id LIMIT 200) AS follower_ids,
        (SELECT count(*) FROM cloud_v2_workspace_followers WHERE workspace_id=w.id)::text AS follower_count
        FROM cloud_v2_workspaces w WHERE w.id=ANY($1::uuid[])`,[proofs.map(proof => proof.view.workspace.id),proofs[0]!.user.id])).rows;
      const allowed = await this.authority.assertMany(proofs,tx,omitDenied);
      for (const row of rows) {
        const view = allowed.get(row.id);
        if (view && (view.creatorRevision !== row.creator_revision || view.executionMode !== row.execution_mode)) throw teamUnavailable();
      }
      const flags = new Map(rows.filter(row => allowed.has(row.id) && (ownership || allowed.get(row.id)!.workspace.creatorUserId !== null))
          .map(row => [row.id,{ row,view: allowed.get(row.id)! }]));
      return proofs.filter(proof => flags.has(proof.view.workspace.id)).map(proof => {
        const id = proof.view.workspace.id, { row,view } = flags.get(id)!, enriched = metadata.get(id);
        return { ...view.workspace,...(enriched ? { repository: enriched.repository, checkoutPath: enriched.checkoutPath,
          updatedAt: Date.parse(enriched.updatedAt) > Date.parse(view.workspace.updatedAt) ? enriched.updatedAt : view.workspace.updatedAt,
          ...(enriched.github ? { github: enriched.github } : {}) } : {}),
          teamSharing: 1 as const,createdByUserId: view.createdByUserId,viewerRole: view.role,
          ...(ownership ? { teamOwnership: 1 as const,creatorRevision: view.creatorRevision,noCreatorReason: view.noCreatorReason,
            canReassign: this.ownership.enabled && view.executionMode === "active" && view.role !== "member" } : {}),
          ...(row.execution_mode === "active" ? { teamWriting: 1 as const, canExecute: row.can_execute } : {}),
          readOnly: row.execution_mode === "active" ? !row.can_execute : view.role !== "creator",canManage: view.role !== "member",
          following: row.following,pinned: row.pinned,followerIds: row.follower_ids,followerCount: Number(row.follower_count) };
      });
    };
    return transaction ? read(transaction) : withSystemTx(this.pool,read);
  }

  async document(proof: TeamAdmission, ownership = false) {
    const result = (await this.documents([proof],false,ownership))[0];
    if (!result) throw teamOwnershipRequired();
    return result;
  }

  async get(id: string, user: AuthedUser, ownership = false) { return this.document(await this.authority.admit(id,user),ownership); }

  async lifecycleDocument(id: string, user: AuthedUser) {
    const view = await withSystemTx(this.pool, tx => this.authority.snapshot(tx,id,user));
    if (view.executionMode !== "active") throw teamUnavailable();
    // Stop needs no repository check; its reply contains only local metadata.
    return this.document({ user,view,source: null },true);
  }

  async requireOwnershipAfterHiddenRead(user: AuthedUser, target: { id: string } | { organization: string; number: number }) {
    const id = (await withSystemTx(this.pool, tx => "id" in target
      ? tx.query<{ id: string }>("SELECT id FROM cloud_v2_workspaces WHERE id=$1 AND creator_user_id IS NULL", [target.id])
      : tx.query<{ id: string }>(`SELECT w.id FROM cloud_v2_workspaces w JOIN organizations o ON o.id=w.org_id
        WHERE o.slug=$1 AND w.number=$2 AND w.creator_user_id IS NULL`, [target.organization,target.number]))).rows[0]?.id;
    if (!id) return;
    const proof = await this.authority.admit(id,user);
    if ((await this.authority.assert(proof)).workspace.creatorUserId === null) throw teamOwnershipRequired();
  }

  async byNumber(organization: string, number: number, user: AuthedUser, ownership = false) {
    const row = (await withSystemTx(this.pool,tx => tx.query<{ id: string }>(`SELECT w.id FROM cloud_v2_workspaces w
      JOIN organizations o ON o.id=w.org_id JOIN organization_members m ON ${TEAM_MEMBER}
      WHERE o.slug=$1 AND w.number=$3 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}`, [organization,user.id,number]))).rows[0];
    if (!row) throw teamNotFound();
    return this.get(row.id,user,ownership);
  }

  async list(user: AuthedUser, query: TeamList, ownership = false) {
    if (query.creator === "none" && !ownership) throw teamOwnershipRequired();
    const key = teamCursorKey([user.id,query.organizationId,query.creator ?? null,!!query.mine,!!query.following,!!query.pinned,query.repositoryId ?? null,query.archived,
      ...(ownership ? [true] : [])]);
    const cursor = readTeamCursor(query.cursor,key);
    const { rows,proofs } = await withSystemTx(this.pool,async tx => {
      await this.organization(tx,query.organizationId,user);
      if (query.creator === "none" && !(await tx.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [query.organizationId,user.id])).rowCount)
        throw teamOwnershipDenied();
      const rows = (await tx.query<{ id: string; at: string }>(`SELECT w.id,to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM cloud_v2_workspaces w JOIN organization_members m ON ${TEAM_MEMBER}
        WHERE w.org_id=$1 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}
          AND (NOT w.source_pending OR w.creator_user_id=$2)
          AND ($11::boolean OR w.creator_user_id IS NOT NULL)
          AND (NOT $12::boolean OR w.creator_user_id IS NULL)
          AND ($3::uuid IS NULL OR w.creator_user_id=$3)
          AND (NOT $4::boolean OR EXISTS(SELECT 1 FROM cloud_v2_workspace_followers f WHERE f.workspace_id=w.id AND f.user_id=$2))
          AND (NOT $5::boolean OR EXISTS(SELECT 1 FROM cloud_v2_workspace_pins p WHERE p.workspace_id=w.id AND p.user_id=$2))
          AND ($6::bigint IS NULL OR EXISTS(SELECT 1 FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id AND s.repository_id=$6
            AND s.source_repository=lower(w.repository)))
          AND ($7='include' OR ($7='only')=(w.archived_at IS NOT NULL))
          AND ($8::timestamptz IS NULL OR w.created_at<$8 OR (w.created_at=$8 AND w.id>$9::uuid))
        ORDER BY w.created_at DESC,w.id LIMIT $10`,[query.organizationId,user.id,query.mine ? user.id : query.creator === "none" ? null : query.creator ?? null,
        !!query.following,!!query.pinned,query.repositoryId ?? null,query.archived,cursor?.at ?? null,cursor?.id ?? null,query.limit+1,ownership,query.creator === "none"])).rows;
      return { rows,proofs: await this.authority.admitMany(rows.slice(0,query.limit).map(row => row.id),user,false,tx) };
    });
    const selected = rows.slice(0,query.limit);
    // Keep page order independent of the batched SQL's plan and row order.
    const positions = new Map(selected.map((row,index) => [row.id,index]));
    proofs.sort((a,b) => positions.get(a.view.workspace.id)!-positions.get(b.view.workspace.id)!);
    const workspaces = await withSystemTx(this.pool,async tx => {
      const documents = await this.documents(proofs,true,ownership,tx);
      // Empty pages also need a final session, membership and Hold check.
      await this.organization(tx,query.organizationId,user);
      return documents;
    });
    const last = selected.at(-1);
    return { workspaces,teamSharing: 1 as const,...(ownership ? { teamOwnership: 1 as const } : {}),nextCursor: rows.length>query.limit && last ? writeTeamCursor(key,last.at,last.id) : null };
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
