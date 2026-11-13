import type pg from "pg";
import { z } from "zod";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemStatement, withSystemTx, type Tx } from "../../db.js";
import { sql, SqlFragment } from "../../sql-fragment.js";
import { isGithubAccessRevoked, isGithubTemporary } from "../../github-availability.js";
import { SECURITY_STREAM_AUTHORITY, securityStreamParameters, securityStreamAuthority } from "../../security-events.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import type { CloudGithubConnectionStore } from "../github-connections-store.js";
import { CLOUD_V2_WORKSPACE_COLUMNS, cloudV2WorkspaceFromRow, type CloudV2Workspace, type CloudV2WorkspaceRow } from "../store.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { CLOUD_SOURCE_GRACE_MS, CloudSourceTargetSchema, type CloudSourceTarget, type CloudV2SourceAuthority, type CloudViewerSourceProof } from "../source-authority.js";
import { teamNotFound, teamUnavailable } from "./contract.js";

export type TeamView = {
  workspace: CloudV2Workspace; createdByUserId: string | null; role: "creator" | "admin" | "member";
  epoch: string; signature: string; signatureVersion?: 2; targets: readonly CloudSourceTarget[]; ongoing: boolean;
  verifications: VerificationRow[]; databaseNow: number;
  executionMode: string; creatorRevision: string; noCreatorReason: "left" | "hold" | "account_revoked" | null;
};
type VerificationRow = { repositoryId: string; fingerprint: string; verifiedAt: number | null; failureCode: string | null; failureStatus: HttpError["status"] | null };
export type TeamAdmission = { user: AuthedUser; view: TeamView; source: CloudViewerSourceProof | null };
export const TEAM_MEMBER = `m.org_id=w.org_id AND m.user_id=$2 AND NOT ${memberOnHoldSql("m.org_id","m.user_id")}`;
export const teamConnectionRevisionSql = (organization: string, person: string) => `jsonb_build_array(
  (SELECT jsonb_build_array(s.selected_method,s.generation) FROM cloud_github_selections s WHERE s.org_id=${organization} AND s.owner_user_id=${person}),
  (SELECT jsonb_agg(jsonb_build_array(c.id,c.method,c.generation,c.github_user_id) ORDER BY c.method)
    FROM cloud_github_credentials c WHERE c.org_id=${organization} AND c.owner_user_id=${person}))`;

/** Viewer proofs never authorize a worker, a bridge ticket or a Creator's
 * credentials. Every use rechecks the current session and immutable scope. */
export class CloudTeamAuthority {
  constructor(readonly pool: pg.Pool, readonly source: CloudV2SourceAuthority, readonly connections: CloudGithubConnectionStore) {}

  async isCreator(id: string, userId: string): Promise<boolean> {
    // A routing hint only: the Creator handler must authorize again after this read.
    const result = await withSystemStatement(this.pool,sql`SELECT 1 FROM cloud_v2_workspaces
      WHERE id=${SqlFragment.uuid(id.toLowerCase())} AND creator_user_id=${SqlFragment.uuid(userId.toLowerCase())}`);
    return result.rowCount === 1;
  }

  async snapshots(tx: Tx, ids: readonly string[], user: AuthedUser, proofs: readonly TeamAdmission[] = []): Promise<Map<string,TeamView>> {
    type Row = CloudV2WorkspaceRow & { execution_mode: string; created_by_user_id: string | null; role: string; access_epoch: string; login_revision: string;
      member_revision: string; member_created_at: string; org_revision: string; organization_policy: unknown; source_repositories: string[] | null; sources: unknown; ongoing: boolean; connection_revision: unknown;
      verifications: VerificationRow[]; database_now: string; creator_revision: string; creator_absent_reason: TeamView["noCreatorReason"] };
    const rows = (await tx.query<Row>(`SELECT ${CLOUD_V2_WORKSPACE_COLUMNS.map(name => `w.${name}`).join(",")},
      w.execution_mode,w.created_by_user_id,w.access_epoch::text,w.login_revision::text,m.role,m.authorization_revision::text AS member_revision,m.created_at::text AS member_created_at,w.source_repositories,
      w.creator_revision::text,w.creator_absent_reason,
      (SELECT jsonb_build_array(is_personal,cloud_workspaces_allowed,deleted_at IS NULL) FROM organizations WHERE id=w.org_id) AS organization_policy,
      (SELECT authorization_revision::text FROM organizations WHERE id=w.org_id) AS org_revision,
      coalesce((SELECT jsonb_agg(jsonb_build_object('repository',s.source_repository,'repositoryId',s.repository_id::text) ORDER BY s.source_repository)
        FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id),'[]'::jsonb) AS sources,
      EXISTS (SELECT 1 FROM cloud_v2_workspace_presence p WHERE p.workspace_id=w.id AND p.user_id=$1
        AND p.provider_session_id=$5 AND p.access_epoch=w.access_epoch AND p.expires_at>clock_timestamp()) AS ongoing,
      ${teamConnectionRevisionSql("w.org_id","$1")} AS connection_revision,
      extract(epoch FROM clock_timestamp())*1000 AS database_now,
      coalesce((SELECT jsonb_agg(jsonb_build_object('repositoryId',v.repository_id::text,'fingerprint',v.fingerprint,'verifiedAt',extract(epoch FROM v.verified_at)*1000,
        'failureCode',v.failure_code,'failureStatus',v.failure_status)) FROM cloud_github_source_verifications v
        WHERE v.org_id=w.org_id AND v.owner_user_id=$1
          AND v.repository_id IN (SELECT repository_id FROM cloud_v2_github_sources WHERE workspace_id=w.id)
          AND (w.execution_mode='active' OR v.fingerprint=(SELECT fingerprint FROM jsonb_to_recordset($8::jsonb) p(id uuid,fingerprint text) WHERE p.id=w.id))), '[]'::jsonb) AS verifications
      FROM cloud_v2_workspaces w JOIN organization_members m ON ${TEAM_MEMBER.replace("$2","$1")}
      WHERE w.id=ANY($7::uuid[]) AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS} AND ${SECURITY_STREAM_AUTHORITY}
        AND (NOT w.source_pending OR w.creator_user_id=$1)`, [...securityStreamParameters(user),ids,
      JSON.stringify(proofs.filter(proof => proof.source).map(proof => ({ id: proof.view.workspace.id,fingerprint: proof.source!.fingerprint })))])).rows;
    if (!rows.length && !await securityStreamAuthority(tx,user)) throw new HttpError(401,"session_revoked","Authentication is no longer current");
    return new Map(rows.map(row => {
      const targets = z.array(CloudSourceTargetSchema).max(100).safeParse(row.sources);
      const names = row.source_repositories?.map(name => name.toLowerCase()).sort() ?? [];
      if (!row.source_pending && (!targets.success || !targets.data.length || targets.data.length !== names.length ||
          targets.data.some((target,index) => target.repository !== names[index]) || !names.includes(row.repository.toLowerCase()))) throw teamUnavailable();
      return [row.id,{ workspace: cloudV2WorkspaceFromRow(row),createdByUserId: row.created_by_user_id,
        executionMode: row.execution_mode,creatorRevision: row.creator_revision,noCreatorReason: row.creator_absent_reason,
        role: row.creator_user_id === user.id ? "creator" : ["owner","admin"].includes(row.role) ? "admin" : "member",
        epoch: row.access_epoch,targets: targets.success ? targets.data : [],ongoing: row.ongoing,
        verifications: row.verifications,databaseNow: Number(row.database_now),
        ...(row.execution_mode === "active" ? { signatureVersion: 2 as const } : {}),
        signature: row.execution_mode === "active"
          ? JSON.stringify([2,row.id,row.org_id,user.id,row.access_epoch,row.role,row.member_revision,row.member_created_at,row.organization_policy,
            row.source_pending,row.repository,names,row.sources,row.connection_revision])
          : JSON.stringify([row.id,row.org_id,row.creator_user_id,row.access_epoch,row.login_revision,row.role,row.member_revision,row.org_revision,
            row.source_pending,row.repository,names,row.sources,row.connection_revision]) }];
    }));
  }

  async snapshot(tx: Tx, id: string, user: AuthedUser): Promise<TeamView> {
    const view = (await this.snapshots(tx,[id],user)).get(id);
    if (!view) throw teamNotFound();
    return view;
  }

  async admitMany(ids: readonly string[], user: AuthedUser, fresh = false): Promise<TeamAdmission[]> {
    const views = await withSystemTx(this.pool,tx => this.snapshots(tx,ids,user));
    const sources = new Map<string,CloudViewerSourceProof | null>(), proofs: TeamAdmission[] = [];
    for (const view of views.values()) {
      let source: CloudViewerSourceProof | null = null;
      if (!view.workspace.sourcePending) {
        const continuation = !fresh && view.ongoing, key = JSON.stringify([view.workspace.organizationId,view.targets,continuation]);
        if (!sources.has(key)) {
          try { sources.set(key,await this.source.viewer(view.workspace.organizationId,user.id,view.targets,continuation)); }
          catch (error) {
            await withSystemTx(this.pool,tx => this.snapshots(tx,ids,user));
            // A provider refusal belongs to this person, never to the VM's owner.
            if (!isGithubAccessRevoked(error)) throw teamUnavailable();
            sources.set(key,null);
          }
        }
        source = sources.get(key)!;
        if (!source) continue;
      }
      proofs.push({ user,view,source });
    }
    const current = await this.assertMany(proofs,undefined,true);
    return proofs.filter(proof => current.has(proof.view.workspace.id));
  }

  async admit(id: string, user: AuthedUser, fresh = false): Promise<TeamAdmission> {
    const proof = (await this.admitMany([id],user,fresh))[0];
    if (!proof) throw teamNotFound();
    return proof;
  }

  async assertMany(proofs: readonly TeamAdmission[], transaction?: Tx, omitDenied = false): Promise<Map<string,TeamView>> {
    if (!proofs.length) return new Map();
    const user = proofs[0]!.user, ids = proofs.map(proof => proof.view.workspace.id);
    if (proofs.some(proof => proof.user !== user)) throw new Error("mixed_team_readers");
    const check = async (tx: Tx) => {
      const fingerprints = new Map<string,string | undefined>();
      for (const proof of proofs) {
        if (!proof.source) continue;
        const org = proof.view.workspace.organizationId;
        if (!fingerprints.has(org)) fingerprints.set(org,(await this.connections.fingerprintsForPeople(tx,org,[user.id])).get(user.id));
      }
      // Session, connection revisions, immutable sources and their latest
      // verdicts share the final statement snapshot, without a mutation lock.
      const current = await this.snapshots(tx,ids,user,proofs);
      const deny = (id: string) => { if (!omitDenied) throw teamNotFound(); current.delete(id); };
      for (const proof of proofs) {
        const id = proof.view.workspace.id, view = current.get(id);
        if (!view || view.signature !== proof.view.signature) { deny(id); continue; }
        if (!proof.source) continue;
        const fingerprint = fingerprints.get(view.workspace.organizationId);
        if (view.signatureVersion !== 2 && fingerprint !== proof.source.fingerprint) { deny(id); continue; }
        const byRepository = new Map(view.verifications.map(row => [row.repositoryId,row]));
        for (const target of view.targets) {
          const row = byRepository.get(target.repositoryId);
          if (!row || view.signatureVersion === 2 && row.fingerprint !== fingerprint && row.fingerprint !== proof.source.fingerprint) throw teamUnavailable();
          const error = row.failureCode && row.failureStatus ? new HttpError(row.failureStatus,row.failureCode,"Repository access changed") : null;
          if (error && isGithubAccessRevoked(error)) { deny(id); break; }
          if (error && !isGithubTemporary(error)) throw teamUnavailable();
          const age = row.verifiedAt === null ? Infinity : view.databaseNow-row.verifiedAt;
          if (age<0 || age>=CLOUD_SOURCE_GRACE_MS) throw teamUnavailable();
        }
        if (current.has(id) && proof.source.until<=Date.now()) throw teamUnavailable();
      }
      return current;
    };
    return transaction ? check(transaction) : withSystemTx(this.pool,check);
  }

  async assert(proof: TeamAdmission, transaction?: Tx): Promise<TeamView> {
    return (await this.assertMany([proof],transaction)).get(proof.view.workspace.id)!;
  }
}
