import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { CloudExecutionAuthority, type ExecutionAdmission } from "../execution/authority.js";
import { selectedAgentLoginAvailability } from "../execution/logins.js";
import type { TeamView } from "./authority.js";
import { CreatorRevisionSchema, teamCreatorChanged, teamCursorKey, teamNotFound, teamOwnershipDenied,
  teamOwnershipRequired, teamUnavailable, type TeamCandidatesQuery, type TeamReassign } from "./contract.js";
import type { CloudTeamSharing } from "./store.js";

type CandidateReason = "on_hold" | "account_inactive";
type Candidate = { userId: string; eligible: true; agentLogins: Awaited<ReturnType<typeof selectedAgentLoginAvailability>> } |
  { userId: string; eligible: false; reason: CandidateReason };
type Receipt = { requestId: string; fromUserId: string | null; toUserId: string; creatorRevision: string };
const cursorSchema = z.object({ key: z.string().length(64), revision: CreatorRevisionSchema, id: z.string().uuid() }).strict();
const ineligible = () => new HttpError(422, "assignee_ineligible", "This member cannot be the workspace Creator right now");

export class CloudTeamOwnership {
  readonly people: CloudExecutionAuthority;
  constructor(readonly sharing: CloudTeamSharing, readonly enabled: boolean) {
    this.people = new CloudExecutionAuthority(sharing.pool, sharing.github.source, sharing.github.connections.store);
  }

  requireEnabled(view: TeamView) {
    if (!this.enabled) throw teamOwnershipRequired();
    if (view.executionMode !== "active") throw new HttpError(409, "team_activation_required", "Activate this workspace before reassigning it");
  }

  private manager(view: TeamView) { if (view.role === "member") throw teamOwnershipDenied(); }
  private compare(view: TeamView, body: TeamReassign) {
    if (view.workspace.creatorUserId !== body.expectedCreatorUserId || view.creatorRevision !== body.expectedCreatorRevision) throw teamCreatorChanged();
  }

  private async localCandidate(tx: Tx, id: string, userId: string): Promise<CandidateReason | null | undefined> {
    const row = (await tx.query<{ active: boolean; held: boolean }>(`SELECT u.auth_status='active' AND u.deleted_at IS NULL AS active,
      ${memberOnHoldSql("m.org_id", "m.user_id")} AS held
      FROM cloud_v2_workspaces w JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$2
      JOIN users u ON u.id=m.user_id WHERE w.id=$1`, [id, userId])).rows[0];
    return !row ? undefined : !row.active ? "account_inactive" : row.held ? "on_hold" : null;
  }

  private async candidate(id: string, userId: string): Promise<{ reason?: CandidateReason; proof?: ExecutionAdmission }> {
    const local = await withSystemTx(this.sharing.pool, tx => this.localCandidate(tx, id, userId));
    if (local !== null) return { reason: local ?? "account_inactive" };
    try {
      const proof = await this.people.admit(id, userId);
      return { proof: { ...proof, runBound: false } };
    } catch (error) {
      const current = await withSystemTx(this.sharing.pool, tx => this.localCandidate(tx, id, userId));
      if (current !== null) return { reason: current ?? "account_inactive" };
      throw teamUnavailable();
    }
  }

  private async repositoryHint(tx: Tx, view: TeamView, userId: string): Promise<boolean> {
    const fingerprint = (await this.sharing.github.connections.store.fingerprintsForPeople(tx, view.workspace.organizationId, [userId])).get(userId);
    const row = (await tx.query<{ unavailable: boolean }>(`SELECT NOT EXISTS (
        SELECT 1 FROM cloud_github_selections s JOIN cloud_github_credentials c
          ON c.org_id=s.org_id AND c.owner_user_id=s.owner_user_id AND c.method=s.selected_method
        WHERE s.org_id=$1 AND s.owner_user_id=$2 AND (c.method<>'pat' OR c.expires_at IS NULL OR c.expires_at>clock_timestamp()))
      OR EXISTS(SELECT 1 FROM cloud_github_source_verifications v JOIN cloud_v2_github_sources src
        ON src.repository_id=v.repository_id AND src.workspace_id=$4
        WHERE v.org_id=$1 AND v.owner_user_id=$2 AND v.fingerprint=$3 AND v.failure_status IN (401,403,404)) AS unavailable`,
    [view.workspace.organizationId, userId, fingerprint ?? null, view.workspace.id])).rows[0];
    return row?.unavailable === true;
  }

  async candidates(id: string, user: AuthedUser, page: TeamCandidatesQuery) {
    const proof = await this.sharing.authority.admit(id, user);
    this.requireEnabled(proof.view); this.manager(proof.view);
    const key = teamCursorKey(["reassign", id, user.id]), revision = proof.view.creatorRevision;
    const self = "self" in page, limit = self ? 1 : page.limit;
    let after: string | null = null;
    if (!self && page.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(page.cursor)) throw new Error();
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")));
        if (cursor.key !== key) throw new Error();
      } catch { throw new HttpError(400, "invalid_request", "Invalid candidates cursor"); }
      if (cursor.revision !== revision) throw teamCreatorChanged();
      after = cursor.id;
    }
    const rows = await withSystemTx(this.sharing.pool, async tx => {
      const current = await this.sharing.authority.assert(proof, tx);
      this.manager(current);
      if (current.creatorRevision !== revision) throw teamCreatorChanged();
      if (self) return (await tx.query<{ user_id: string }>("SELECT user_id FROM organization_members WHERE org_id=$1 AND user_id=$2",
        [current.workspace.organizationId, user.id])).rows;
      return (await tx.query<{ user_id: string }>(`SELECT user_id FROM organization_members
        WHERE org_id=$1 AND user_id IS DISTINCT FROM $2::uuid AND ($3::uuid IS NULL OR user_id>$3)
        ORDER BY user_id LIMIT $4`, [current.workspace.organizationId, current.workspace.creatorUserId, after, limit+1])).rows;
    });
    const selected = rows.slice(0, limit), candidates = new Map<string, Awaited<ReturnType<CloudTeamOwnership["candidate"]>>>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const person = selected[next++]!.user_id;
        candidates.set(person, await this.candidate(id, person));
      }
    }));
    const result = await withSystemTx(this.sharing.pool, async tx => {
      const values: Candidate[] = [];
      const candidateHints: Record<string, ["repository_access"]> = {};
      for (const { user_id: userId } of selected) {
        const local = await this.localCandidate(tx, id, userId);
        if (local === undefined) continue;
        const candidate = candidates.get(userId)!;
        let reason = local ?? candidate.reason;
        if (!reason && candidate.proof) {
          try { await this.people.assert(candidate.proof, tx); }
          catch (error) {
            if (!(error instanceof HttpError) || error.status >= 500) throw teamUnavailable();
            const latest = await this.localCandidate(tx, id, userId);
            if (latest === null) throw teamUnavailable();
            reason = latest ?? "account_inactive";
          }
        }
        values.push(reason ? { userId, eligible: false, reason } : { userId, eligible: true,
          agentLogins: await selectedAgentLoginAvailability(tx, proof.view.workspace.organizationId, userId) });
        if (!reason && await this.repositoryHint(tx, proof.view, userId)) candidateHints[userId] = ["repository_access"];
      }
      const current = await this.sharing.authority.assert(proof, tx);
      this.manager(current);
      if (current.creatorRevision !== revision) throw teamCreatorChanged();
      return { candidates: values, candidateHints };
    });
    const last = selected.at(-1);
    return { ...result, creatorRevision: revision, nextCursor: !self && rows.length>limit && last
      ? Buffer.from(JSON.stringify({ key, revision, id: last.user_id })).toString("base64url") : null };
  }

  private async receipt(tx: Tx, id: string, userId: string, requestId: string, hash: string): Promise<Receipt | undefined> {
    const row = (await tx.query<Receipt & { hash: string }>(`SELECT request_id AS "requestId",request_hash AS hash,
      from_user_id AS "fromUserId",to_user_id AS "toUserId",creator_revision::text AS "creatorRevision"
      FROM cloud_v2_reassignments WHERE workspace_id=$1 AND caller_user_id=$2 AND request_id=$3 AND expires_at>clock_timestamp()`,
    [id, userId, requestId])).rows[0];
    if (!row) return undefined;
    if (row.hash !== hash) throw new HttpError(409, "reassign_conflict", "This request id was used for a different reassignment");
    return { requestId: row.requestId, fromUserId: row.fromUserId, toUserId: row.toUserId, creatorRevision: row.creatorRevision };
  }

  private async assertCandidate(proof: ExecutionAdmission, tx: Tx) {
    try { await this.people.assert(proof, tx); }
    catch (error) { if (error instanceof HttpError && error.status < 500) throw ineligible(); throw teamUnavailable(); }
  }

  async reassign(id: string, user: AuthedUser, body: TeamReassign) {
    const proof = await this.sharing.authority.admit(id, user);
    this.requireEnabled(proof.view);
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const previous = await withSystemTx(this.sharing.pool, async tx => {
      await this.sharing.authority.assert(proof, tx);
      return this.receipt(tx, id, user.id, body.requestId, hash);
    });
    const reply = async (reassignment: Receipt) => ({ workspace: await this.sharing.get(id, user, true),
      teamSharing: 1 as const, teamOwnership: 1 as const, reassignment });
    if (previous) return reply(previous);
    this.manager(proof.view); this.compare(proof.view, body);
    const target = await this.candidate(id, body.toUserId);
    if (!target.proof) throw ineligible();
    const reassignment = await withSystemTx(this.sharing.pool, async tx => {
      if (!(await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id])).rowCount) throw teamNotFound();
      const current = await this.sharing.authority.assert(proof, tx);
      const replay = await this.receipt(tx, id, user.id, body.requestId, hash);
      if (replay) return replay;
      this.requireEnabled(current); this.manager(current); this.compare(current, body);
      await this.assertCandidate(target.proof!, tx);
      let revision = current.creatorRevision;
      if (body.toUserId !== current.workspace.creatorUserId) {
        const changed = await tx.query<{ revision: string }>(`UPDATE cloud_v2_workspaces SET creator_user_id=$2
          WHERE id=$1 AND creator_user_id IS NOT DISTINCT FROM $3::uuid AND creator_revision=$4
          RETURNING creator_revision::text AS revision`, [id, body.toUserId, body.expectedCreatorUserId, body.expectedCreatorRevision]);
        if (!changed.rowCount) throw teamCreatorChanged();
        revision = changed.rows[0]!.revision;
        if (current.workspace.creatorUserId) await tx.query(`INSERT INTO cloud_v2_workspace_followers(workspace_id,org_id,user_id)
          SELECT $1,m.org_id,m.user_id FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=$2 AND m.user_id=$3 AND u.auth_status='active' AND u.deleted_at IS NULL
            AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")} ON CONFLICT(workspace_id,user_id) DO NOTHING`,
        [id, current.workspace.organizationId, current.workspace.creatorUserId]);
        await tx.query("DELETE FROM cloud_v2_workspace_followers WHERE workspace_id=$1 AND user_id=$2", [id, body.toUserId]);
      }
      await tx.query("DELETE FROM cloud_v2_reassignments WHERE workspace_id=$1 AND caller_user_id=$2 AND request_id=$3 AND expires_at<=clock_timestamp()", [id, user.id, body.requestId]);
      await tx.query(`INSERT INTO cloud_v2_reassignments(workspace_id,org_id,caller_user_id,request_id,request_hash,from_user_id,to_user_id,creator_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, current.workspace.organizationId, user.id, body.requestId, hash,
        current.workspace.creatorUserId, body.toUserId, revision]);
      await this.sharing.authority.assert(proof, tx);
      await this.assertCandidate(target.proof!, tx);
      return { requestId: body.requestId, fromUserId: current.workspace.creatorUserId, toUserId: body.toUserId, creatorRevision: revision };
    });
    return reply(reassignment);
  }
}
