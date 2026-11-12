import type pg from "pg";
import { z } from "zod";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { isGithubAccessRevoked, isGithubTemporary } from "../../github-availability.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { securityStreamAuthority } from "../../security-events.js";
import type { CloudGithubConnectionStore } from "../github-connections-store.js";
import { CLOUD_SOURCE_ADMISSION_MS, CLOUD_SOURCE_REFRESH_MS, CLOUD_SOURCE_GRACE_MS, CloudSourceTargetSchema, type CloudViewerSourceProof, type CloudV2SourceAuthority } from "../source-authority.js";
import { teamConnectionRevisionSql } from "../team-sharing/authority.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { executionSignatures, matchesExecutionSignature, type ExecutionSignatures, type VersionedExecutionAuthority } from "./signatures.js";
import { actorChanged, executionUnavailable, executionWorkerRequired, memberAccessRevoked } from "./errors.js";

export type ExecutionPerson = ExecutionSignatures & {
  workspaceId: string; organizationId: string; userId: string; creatorUserId: string; repository: string; state: string;
  accessEpoch: string; stopGeneration: string; bootId: string | null; workerTokenHash: string | null;
  signature: string; personSignature: string; permissionSignature: string; accountRevision: string; memberRevision: string; organizationRevision: string;
  targets: Array<{ repository: string; repositoryId: string }>;
  role: string; databaseNow: number; verifications: Verification[];
};
type Verification = { repositoryId: string; verifiedAt: number | null; failureCode: string | null; failureStatus: number | null };
export type ExecutionAdmission = { person: ExecutionPerson; source: CloudViewerSourceProof; until: number; user?: AuthedUser | undefined; runBound?: false };
export type ExecutionIntentAuthority = VersionedExecutionAuthority & { permissionSignature: string; sourceFingerprint: string };
export const executionIntentAuthority = (proof: ExecutionAdmission): ExecutionIntentAuthority => ({
  signatureVersion: 2, permissionSignature: proof.person.permissionSignature, sourceFingerprint: proof.source.fingerprint,
});
export function assertExecutionIntent(expected: ExecutionIntentAuthority | null | undefined, proof: ExecutionAdmission) {
  if (!expected || !matchesExecutionSignature(expected, expected.permissionSignature, proof.person, "permissionSignature"))
    throw actorChanged();
}

/** Durable turns have a human identity, not a fabricated desktop session or a
 * rewritten Creator. Source proofs use that human's own repository scope. */
export class CloudExecutionAuthority {
  constructor(readonly pool: pg.Pool, readonly source: CloudV2SourceAuthority, readonly connections: CloudGithubConnectionStore) {}

  async snapshot(tx: Tx, workspaceId: string, userId: string, fingerprint?: string, contextId?: string): Promise<ExecutionPerson> {
    type Row = { id: string; org_id: string; creator_user_id: string; repository: string; state: string; execution_mode: string;
      access_epoch: string; stop_generation: string; worker_boot_id: string | null; worker_token_hash: string | null;
      account_revision: string; member_revision: string; member_created_at: string; organization_revision: string; role: string; sources: unknown;
      organization_policy: [boolean, boolean, boolean]; source_repositories: string[]; source_pending: boolean; connection_revision: unknown; database_now: string; verifications: Verification[]; context_current: boolean };
    const row = (await tx.query<Row>(`SELECT w.id,w.org_id,w.creator_user_id,w.repository,w.state,w.execution_mode,
      w.access_epoch::text,w.stop_generation::text,w.worker_boot_id,encode(w.worker_token_hash,'hex') AS worker_token_hash,
      u.auth_revision::text AS account_revision,m.authorization_revision::text AS member_revision,m.created_at::text AS member_created_at,
      o.authorization_revision::text AS organization_revision,m.role,
      jsonb_build_array(o.is_personal,o.cloud_workspaces_allowed,o.deleted_at IS NULL) AS organization_policy,
      w.source_pending,w.source_repositories,
      coalesce((SELECT jsonb_agg(jsonb_build_object('repository',s.source_repository,'repositoryId',s.repository_id::text) ORDER BY s.source_repository)
        FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id),'[]'::jsonb) AS sources,
      ${teamConnectionRevisionSql("w.org_id", "$2")} AS connection_revision,
      extract(epoch FROM clock_timestamp())*1000 AS database_now,
      ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM cloud_v2_execution_contexts c WHERE c.id=$4 AND c.workspace_id=w.id AND c.user_id=$2
        AND c.state='active' AND c.expires_at>clock_timestamp()
        AND w.state IN ('creating','starting','running') AND w.archived_at IS NULL
        AND c.access_epoch=w.access_epoch AND c.stop_generation=w.stop_generation
        AND c.worker_boot_id=w.worker_boot_id AND c.worker_token_hash=w.worker_token_hash AND c.worker_boot_id=ANY(w.acting_user_boot_ids)
        AND (c.client_token_expires_at IS NULL OR c.client_token_expires_at>clock_timestamp())
        AND (c.sync_device_id IS NULL OR (c.worker_boot_id=ANY(w.sync_context_boot_ids) AND EXISTS (
          SELECT 1 FROM local_command_devices d JOIN cloud_v2_connected_macs cm
            ON cm.workspace_id=w.id AND cm.user_id=d.user_id AND cm.device_id=d.device_id
          WHERE d.user_id=c.user_id AND d.device_id=c.sync_device_id AND d.revoked_at IS NULL
            AND d.provider_session_id=c.provider_session_id AND d.registration_id=c.sync_registration_id AND d.instance_id=c.sync_instance_id
            AND cm.registration_id=c.sync_registration_id AND cm.connected_at=c.sync_connected_at AND cm.disconnected_at IS NULL
            AND (cm.is_latest_sender OR greatest(cm.connected_at,cm.last_used_at)>clock_timestamp()-interval '12 hours'))))
        AND (c.parent_context_id IS NULL OR EXISTS(SELECT 1 FROM cloud_v2_execution_contexts parent WHERE parent.id=c.parent_context_id
          AND parent.workspace_id=w.id AND parent.user_id=$2 AND parent.state='active' AND parent.expires_at>clock_timestamp()
          AND (parent.client_token_expires_at IS NULL OR parent.client_token_expires_at>clock_timestamp())))
        AND (c.provider_session_id IS NULL OR EXISTS(SELECT 1 FROM auth_sessions s WHERE s.provider='workos' AND s.provider_session_id=c.provider_session_id
          AND s.user_id=$2 AND s.status='active' AND s.revoked_at IS NULL AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())))
        AND (c.kind<>'bootstrap' OR (w.execution_intent_id=c.intent_id AND w.execution_initiator_user_id=c.user_id))
        AND (c.kind<>'turn' OR EXISTS(SELECT 1 FROM cloud_v2_prompt_chats chat JOIN cloud_v2_prompt_outbox p
          ON p.workspace_id=chat.workspace_id AND p.user_message_id=c.user_message_id WHERE chat.workspace_id=w.id
          AND chat.chat_id=c.chat_id AND chat.active_context_id=c.id AND chat.epoch=c.chat_epoch
          AND p.dispatch_id=c.dispatch_id AND p.state IN ('dispatching','accepted') AND NOT p.cancel_requested)))) AS context_current,
      coalesce((SELECT jsonb_agg(jsonb_build_object('repositoryId',v.repository_id::text,'verifiedAt',extract(epoch FROM v.verified_at)*1000,
        'failureCode',v.failure_code,'failureStatus',v.failure_status)) FROM cloud_github_source_verifications v
        WHERE v.org_id=w.org_id AND v.owner_user_id=$2 AND v.fingerprint=$3
          AND v.repository_id IN (SELECT repository_id FROM cloud_v2_github_sources WHERE workspace_id=w.id)),'[]'::jsonb) AS verifications
      FROM cloud_v2_workspaces w JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$2
      JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=w.org_id
      WHERE w.id=$1 AND w.state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS}
        AND u.auth_status='active' AND u.deleted_at IS NULL AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")}`,
    [workspaceId, userId, fingerprint ?? null, contextId ?? null])).rows[0];
    if (!row) throw memberAccessRevoked();
    if (!row.context_current) throw actorChanged();
    if (row.execution_mode !== "active") throw executionWorkerRequired();
    const parsed = z.array(CloudSourceTargetSchema).min(1).max(100).safeParse(row.sources);
    const names = row.source_repositories?.map(name => name.toLowerCase()).sort() ?? [];
    if (row.source_pending || !parsed.success || names.length !== parsed.data.length || !names.includes(row.repository.toLowerCase()) ||
        parsed.data.some((target, index) => target.repository !== names[index])) throw executionUnavailable();
    const signatures = executionSignatures({ permission: [row.id,row.org_id,userId,row.creator_user_id,
      row.account_revision,row.member_revision,row.member_created_at,row.organization_revision,row.role,row.repository,parsed.data,row.connection_revision],
      policy: row.organization_policy, accessEpoch: row.access_epoch, stopGeneration: row.stop_generation,
      bootId: row.worker_boot_id, workerTokenHash: row.worker_token_hash });
    return { workspaceId, organizationId: row.org_id, userId, creatorUserId: row.creator_user_id, repository: row.repository, state: row.state,
      accessEpoch: row.access_epoch, stopGeneration: row.stop_generation, bootId: row.worker_boot_id, workerTokenHash: row.worker_token_hash,
      accountRevision: row.account_revision, memberRevision: row.member_revision, organizationRevision: row.organization_revision,
      ...signatures, targets: parsed.data, role: row.role, databaseNow: Number(row.database_now), verifications: row.verifications };
  }

  async admit(workspaceId: string, userId: string, options: { continuation?: boolean; user?: AuthedUser | undefined; sourceError?: "github_access_required"; minimumSourceMs?: number } = {}): Promise<ExecutionAdmission> {
    const started = Date.now();
    const person = await withSystemTx(this.pool, async tx => {
      if (options.user) await this.session(tx, options.user, userId);
      return this.snapshot(tx, workspaceId, userId);
    });
    let source: CloudViewerSourceProof;
    try { source = await this.source.viewer(person.organizationId, userId, person.targets, options.continuation === true, options.minimumSourceMs ?? 0); }
    catch (error) {
      await withSystemTx(this.pool, async tx => {
        if (options.user) await this.session(tx, options.user, userId);
        if ((await this.snapshot(tx, workspaceId, userId)).signature !== person.signature) throw actorChanged();
      });
      if (isGithubAccessRevoked(error)) {
        if (options.sourceError) throw new HttpError(403, options.sourceError, "The workspace initiator needs access to its repository");
        throw memberAccessRevoked();
      }
      throw executionUnavailable();
    }
    const proof = { person, source, until: Math.min(started + 30_000, source.until), user: options.user };
    await this.assert(proof);
    return proof;
  }

  async session(tx: Tx, user: AuthedUser, userId: string) {
    if (user.id !== userId || !await securityStreamAuthority(tx, user))
      throw new HttpError(401, "session_revoked", "Authentication is no longer current");
  }

  async cached(tx: Tx, workspaceId: string, userId: string) {
    const initial = await this.snapshot(tx, workspaceId, userId);
    const fingerprint = (await this.connections.fingerprintsForPeople(tx, initial.organizationId, [userId])).get(userId);
    if (!fingerprint) throw executionUnavailable();
    const current = await this.snapshot(tx, workspaceId, userId, fingerprint);
    if (current.signature !== initial.signature) throw actorChanged();
    const observed = new Map(current.verifications.map(row => [row.repositoryId, row]));
    for (const target of current.targets) {
      const row = observed.get(target.repositoryId);
      if (!row) throw executionUnavailable();
      const error = row.failureCode && row.failureStatus ? new HttpError(row.failureStatus as HttpError["status"], row.failureCode, "Repository authority changed") : null;
      if (error && isGithubAccessRevoked(error)) throw memberAccessRevoked();
      const age = row.verifiedAt === null ? Infinity : current.databaseNow - row.verifiedAt;
      if (age < 0 || age >= (error && isGithubTemporary(error) ? CLOUD_SOURCE_GRACE_MS : CLOUD_SOURCE_REFRESH_MS)) throw executionUnavailable();
      if (error && !isGithubTemporary(error)) throw executionUnavailable();
    }
  }

  async assert(proof: ExecutionAdmission, transaction?: Tx, afterIntent = false, contextId?: string): Promise<ExecutionPerson> {
    const read = async (tx: Tx) => {
      if (proof.user) await this.session(tx, proof.user, proof.person.userId);
      const fingerprints = await this.connections.fingerprintsForPeople(tx, proof.person.organizationId, [proof.person.userId]);
      // Person and execution are one final database snapshot: an outcome can
      // retire a context without changing any account or membership revision.
      const current = await this.snapshot(tx, proof.person.workspaceId, proof.person.userId, proof.source.fingerprint, contextId);
      if ((afterIntent ? current.permissionSignature !== proof.person.permissionSignature : proof.runBound === false ? current.personSignature !== proof.person.personSignature : current.signature !== proof.person.signature) || fingerprints.get(current.userId) !== proof.source.fingerprint) throw actorChanged();
      const verifications = new Map(current.verifications.map(row => [row.repositoryId, row]));
      for (const target of current.targets) {
        const row = verifications.get(target.repositoryId);
        if (!row) throw executionUnavailable();
        const error = row.failureCode && row.failureStatus ? new HttpError(row.failureStatus as HttpError["status"], row.failureCode, "Repository authority changed") : null;
        if (error && isGithubAccessRevoked(error)) throw memberAccessRevoked();
        if (error && (!proof.source.continuation || !isGithubTemporary(error))) throw executionUnavailable();
        const age = row.verifiedAt === null ? Infinity : current.databaseNow - row.verifiedAt;
        if (age < 0 || age >= (proof.source.continuation ? CLOUD_SOURCE_GRACE_MS : CLOUD_SOURCE_ADMISSION_MS)) throw executionUnavailable();
      }
      if (proof.until <= Date.now()) throw executionUnavailable();
      return current;
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }
}
