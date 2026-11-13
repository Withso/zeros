import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import type { CloudGithubConnectionStore, CloudGithubConnectionScope } from "./github-connections-store.js";
import type { CloudGithubPrStore } from "./github-pr-store.js";
import type { CloudGithubCatalogAuthority, PostgresGithubVerificationStore } from "./github-verification-store.js";
import type { CloudSourceContinuation, CloudSourceProof } from "./source-authority.js";
import type { CloudV2Workspace } from "./store.js";
import type { CloudGithubWorkspaceDocument } from "./routes.js";
import type { CloudGithubUnavailableReason } from "./github-connection-contract.js";
import { cloudGithubUnavailableReason } from "./github-failure.js";

const changed = () => new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
const expired = () => new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
type ScopeRead = {
  scope: CloudGithubConnectionScope; rows: CloudV2Workspace[]; generation?: string;
  authority: Map<string, CloudGithubCatalogAuthority | HttpError>;
};

export function createCloudGithubCatalog(deps: {
  pool: pg.Pool; connections: CloudGithubConnectionStore; metadata: CloudGithubPrStore;
  verifications: PostgresGithubVerificationStore;
  authorizeSource(workspace: CloudV2Workspace): Promise<void>;
  continueSource(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation>;
  retireRevoked(workspace: CloudV2Workspace, error: unknown): Promise<void>;
}) {
  return async (rows: readonly CloudV2Workspace[]): Promise<CloudGithubWorkspaceDocument[]> => {
    if (!rows.length) return [];
    const groups = new Map<string, ScopeRead>(), allowed = new Map<string, string>();
    const deadlines = new Map<string, number>(), freshAdmissions = new Set<string>();
    const unavailable = new Map<string, CloudGithubUnavailableReason>();
    for (const row of rows) {
      if (row.creatorUserId === null) continue;
      // A pending create has no source or GitHub metadata yet; the lifecycle
      // verifies it before any exists. It reads as a plain creating row.
      if (row.sourcePending) continue;
      const key = JSON.stringify([row.organizationId, row.creatorUserId]);
      const group: ScopeRead = groups.get(key) ?? { scope: { organizationId: row.organizationId, userId: row.creatorUserId }, rows: [], authority: new Map() };
      group.rows.push(row); groups.set(key, group);
    }
    await Promise.all([...groups.values()].map(async group => {
      try {
        const initial = await withSystemTx(deps.pool, async tx => {
          const generation = await deps.connections.fingerprint(group.scope, tx);
          const authority = await deps.verifications.catalogAuthority(tx, group.rows.map(row => row.id), group.scope, generation);
          return { generation, authority };
        });
        group.generation = initial.generation; group.authority = initial.authority;
      } catch (error) {
        for (const row of group.rows) unavailable.set(row.id, cloudGithubUnavailableReason(error));
        return;
      }
      await Promise.all(group.rows.map(async row => {
        try {
          const authority = group.authority.get(row.id);
          if (!authority || authority instanceof HttpError) {
            const error = authority ?? changed();
            if (error.code !== "not_found") await deps.retireRevoked(row, error);
            throw error;
          }
          if (authority.repository !== row.repository) throw changed();
          if (row.state === "running" && authority.state === "running") {
            const lease = await deps.continueSource(row, authority.proof);
            deadlines.set(row.id, lease.recheckAt);
          } else {
            let admission = authority.admission;
            if (!admission || admission.until <= Date.now() || admission.refreshAt <= Date.now()) {
              await deps.authorizeSource(row);
              admission = await withSystemTx(deps.pool, tx => deps.verifications.workspaceAdmission(tx, row.id, group.scope, group.generation!,true));
            }
            if (!admission || admission.until <= Date.now()) throw expired();
            deadlines.set(row.id, admission.until); freshAdmissions.add(row.id);
          }
          allowed.set(row.id, group.generation!);
        } catch (error) { unavailable.set(row.id, cloudGithubUnavailableReason(error)); }
      }));
    }));
    const enriched = new Map((await deps.metadata.documents(rows, allowed)).map(row => [row.id, row]));
    await Promise.all([...groups.values()].map(async group => {
      const admitted = group.rows.filter(row => allowed.has(row.id));
      if (!admitted.length) return;
      try {
        const current = await withSystemTx(deps.pool, async tx => {
          const authority = await deps.verifications.catalogAuthority(tx, admitted.map(row => row.id), group.scope, group.generation!);
          await deps.connections.assertCurrent(group.scope, group.generation!, tx);
          return authority;
        });
        for (const row of admitted) {
          const before = group.authority.get(row.id), after = current.get(row.id);
          try {
            if (after instanceof HttpError) throw after;
            if (!before || before instanceof HttpError || !after || before.repository !== after.repository ||
                before.state !== after.state || before.sources !== after.sources ||
                before.proof.accessEpoch !== after.proof.accessEpoch || before.proof.loginRevision !== after.proof.loginRevision)
              throw changed();
            if (freshAdmissions.has(row.id) && (!after.admission || after.admission.until <= Date.now())) throw expired();
          } catch (error) { allowed.delete(row.id); unavailable.set(row.id, cloudGithubUnavailableReason(error)); }
        }
      } catch (error) {
        for (const row of admitted) { allowed.delete(row.id); unavailable.set(row.id, cloudGithubUnavailableReason(error)); }
      }
    }));
    return rows.map(row => {
      if (row.sourcePending) return row;
      if (allowed.has(row.id) && Date.now() < deadlines.get(row.id)!) return enriched.get(row.id) ?? row;
      // Only the newer timestamp survives a withdrawal. Rolling its version
      // back would make clients retain the protected snapshot as newer data.
      return { ...row, updatedAt: enriched.get(row.id)?.updatedAt ?? row.updatedAt,
        githubUnavailableReason: unavailable.get(row.id) ?? "unavailable" };
    });
  };
}
