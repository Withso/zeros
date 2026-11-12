import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { isGithubTemporary } from "../github-availability.js";
import type { CloudGithubConnections } from "./github-connections.js";
import type { CloudGithubCredentialSnapshot } from "./github-connections-store.js";
import type { CloudGithubPrStore } from "./github-pr-store.js";
import type { CloudGithubPrContext } from "./github-pr-service.js";
import { CLOUD_SOURCE_ADMISSION_MS, CLOUD_SOURCE_GRACE_MS, CloudSourceTargetSchema, type CloudSourceContinuation, type CloudSourceProof } from "./source-authority.js";
import type { CloudV2Workspace } from "./store.js";
import { CLOUD_V2_LIVE_ACCESS, requireWorkspaceCreator } from "./workspace-access.js";

type Binding = { repositoryId: string; repository: string; previousRepositories: string[] };
type SourceRow = {
  repository: string; state: CloudV2Workspace["state"]; worker_boot_id: string | null;
  access_epoch: string; login_revision: string; source: string; source_count: number; repository_id: string | null;
  canonical_repository: string | null; verified_at: Date | null; database_now: Date;
  failure_code: string | null; failure_status: HttpError["status"] | null;
  repository_aliases: string[] | null; repository_observed_at: Date | null;
};
type Snapshot = {
  context: CloudGithubPrContext; credential: CloudGithubCredentialSnapshot; proof: CloudSourceProof;
  bootId: string | null; state: CloudV2Workspace["state"]; sources: string; until: number;
  primary: SourceRow; aliases: string[];
};
const changed = () => new HttpError(409, "github_authorization_changed", "Worker configuration authority changed. Try again.");
const expired = () => new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
const credentialExpired = () => new HttpError(409, "github_authorization_expired", "Refresh the selected GitHub connection.");

export function createCloudGithubWorkerConfig(deps: {
  pool: pg.Pool; connections: CloudGithubConnections; metadata: CloudGithubPrStore;
  authorizeSource(workspace: CloudV2Workspace): Promise<void>;
  continueSource(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation>;
  binding(workspace: CloudV2Workspace, mode: "admission" | "continuation"): Promise<Binding>;
  retireRevoked(workspace: CloudV2Workspace, error: unknown): Promise<void>;
}) {
  return async (workspace: CloudV2Workspace, mode: "admission" | "continuation", proof?: CloudSourceProof) => {
    requireWorkspaceCreator(workspace);
    const scope = { organizationId: workspace.organizationId, userId: workspace.creatorUserId };
    const continuation = mode === "continuation" && workspace.state === "running";
    const read = (expected?: Snapshot): Promise<Snapshot> => {
      const started = Date.now();
      let sourceFailure: HttpError | undefined;
      return withSystemTx(deps.pool, async tx => {
        const context = await deps.metadata.context(workspace.id, workspace.creatorUserId, tx);
        const credential = expected?.credential ?? await deps.connections.store.currentCredential(tx, scope);
        if (!credential || credential.material.expiresAt !== null && credential.material.expiresAt <= Date.now()) throw credentialExpired();
        if (expected) await deps.connections.store.assertCurrent(scope, credential.generation, tx);
        const { rows } = await tx.query<SourceRow>(`SELECT w.repository,w.state,w.worker_boot_id,w.access_epoch::text,w.login_revision::text,
            src.name AS source,cardinality(w.source_repositories) AS source_count,s.repository_id::text,
            v.canonical_repository,v.verified_at,v.failure_code,v.failure_status,clock_timestamp() AS database_now,
            g.repository_aliases,g.repository_observed_at
          FROM cloud_v2_workspaces w CROSS JOIN LATERAL unnest(w.source_repositories) src(name)
          LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower(src.name)
          LEFT JOIN cloud_github_source_verifications v ON v.org_id=w.org_id AND v.owner_user_id=w.creator_user_id
            AND v.repository_id=s.repository_id AND v.fingerprint=$4
          LEFT JOIN cloud_v2_github_workspaces g ON g.workspace_id=w.id
          WHERE w.id=$1 AND w.org_id=$2 AND w.creator_user_id=$3 AND w.state NOT IN ('deleted','deleting') AND ${CLOUD_V2_LIVE_ACCESS}
          LIMIT 101`, [workspace.id, scope.organizationId, scope.userId, credential.generation]);
        const primary = rows.find(row => row.source.toLowerCase() === row.repository.toLowerCase());
        if (!primary || rows.length > 100 || rows.length !== primary.source_count || rows.some(row =>
          !CloudSourceTargetSchema.safeParse({ repository: row.source, repositoryId: row.repository_id }).success))
          throw new HttpError(409, "cloud_source_review_required", "This workspace needs its original repository identities verified.");
        if (primary.repository !== workspace.repository || primary.state !== workspace.state ||
            context.repositoryId && context.repositoryId !== primary.repository_id) throw changed();
        let until = Infinity;
        for (const row of rows) {
          if (row.failure_code) {
            const failure = new HttpError(row.failure_status ?? 503, row.failure_code, "GitHub repository access could not be verified.");
            if (!continuation || !isGithubTemporary(failure)) { sourceFailure = failure; throw failure; }
          }
          const age = row.verified_at ? row.database_now.getTime() - row.verified_at.getTime() : -1;
          const freshness = continuation ? CLOUD_SOURCE_GRACE_MS : CLOUD_SOURCE_ADMISSION_MS;
          if (age < 0 || age >= freshness) throw expired();
          until = Math.min(until, started + freshness - age);
        }
        const current: Snapshot = { context, credential, primary, until,
          proof: { accessEpoch: primary.access_epoch, loginRevision: primary.login_revision },
          bootId: primary.worker_boot_id, state: primary.state,
          sources: JSON.stringify(rows.map(row => [row.source.toLowerCase(), row.repository_id]).sort()),
          aliases: [...new Set([workspace.repository, ...(primary.repository_aliases ?? []), context.repository])],
        };
        if (expected && (current.sources !== expected.sources || current.bootId !== expected.bootId || current.state !== expected.state ||
            current.proof.accessEpoch !== expected.proof.accessEpoch || current.proof.loginRevision !== expected.proof.loginRevision ||
            current.context.revision !== expected.context.revision || current.context.branch !== expected.context.branch ||
            current.context.baseBranch !== expected.context.baseBranch)) throw changed();
        if (Date.now() >= Math.min(until, expected?.until ?? Infinity)) throw expired();
        return current;
      }, { consistentRead: true }).catch(async error => {
        if (error === sourceFailure) await deps.retireRevoked(workspace, error);
        throw error;
      });
    };

    let initial: Snapshot;
    try { initial = await read(); }
    catch (error) {
      if (!(error instanceof HttpError) || !["github_authorization_expired", "github_verification_expired"].includes(error.code) && !isGithubTemporary(error)) throw error;
      if (error.code === "github_authorization_expired") await deps.connections.access(scope);
      if (continuation) await deps.continueSource(workspace, proof); else await deps.authorizeSource(workspace);
      initial = await read();
    }
    if (continuation) {
      const lease = await deps.continueSource(workspace, initial.proof);
      initial.until = Math.min(initial.until, lease.recheckAt, lease.graceUntil ?? Infinity);
    }
    let repositoryBinding: Binding;
    const canonical = initial.primary.canonical_repository;
    if (!canonical) {
      repositoryBinding = await deps.binding(workspace, mode);
      initial = await read(initial);
    } else {
      const observedAt = initial.primary.verified_at!;
      if (!initial.context.repositoryBound || !initial.primary.repository_observed_at || observedAt > initial.primary.repository_observed_at) {
        await deps.metadata.repository(initial.context, { repositoryId: initial.primary.repository_id!, repository: canonical }, {
          at: observedAt, assertCurrent: (tx: Tx) => deps.connections.store.lockCurrent(tx, scope, initial.credential.generation),
        });
        if (initial.context.repository !== canonical) {
          const previous = initial, current = await read();
          if (current.credential.generation !== previous.credential.generation || current.sources !== previous.sources ||
              current.bootId !== previous.bootId || current.proof.accessEpoch !== previous.proof.accessEpoch) throw changed();
          current.until = Math.min(current.until, previous.until); initial = current;
        }
        repositoryBinding = { repositoryId: initial.primary.repository_id!, repository: canonical,
          previousRepositories: [...new Set([...initial.aliases, canonical])] };
      } else repositoryBinding = { repositoryId: initial.primary.repository_id!, repository: initial.context.repository,
        previousRepositories: initial.aliases };
    }
    let failedFence: unknown;
    const assertCurrent = async () => {
      try {
        if (Date.now() >= initial.until) throw expired();
        const current = await read(initial);
        if (current.context.repository !== repositoryBinding.repository || current.context.repositoryId !== repositoryBinding.repositoryId) throw changed();
      } catch (error) { failedFence = error; throw error; }
    };
    return {
      repositoryBinding,
      loginRevision: initial.proof.loginRevision,
      // This is the last awaited config phase. The profile's post-I/O fence
      // also covers the credential, environment and tool reads that precede it.
      gitIdentity: async () => {
        try {
          const identity = await deps.connections.workerProfile(initial.credential, assertCurrent);
          return { name: identity.name ?? identity.login, email: `${identity.id}+${identity.login}@users.noreply.github.com` };
        } catch (error) {
          if (error === failedFence) throw error;
          await assertCurrent();
          if (isGithubTemporary(error)) return { name: initial.credential.identity.login,
            email: `${initial.credential.identity.id}+${initial.credential.identity.login}@users.noreply.github.com` };
          if (error instanceof HttpError && error.code === "github_authorization_expired") {
            await deps.connections.access(scope);
            throw changed();
          }
          throw error;
        }
      },
    };
  };
}
