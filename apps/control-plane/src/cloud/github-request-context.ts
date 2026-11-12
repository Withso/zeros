import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { CloudGithubApi } from "./github-api.js";
import type { CloudGithubConnections } from "./github-connections.js";
import type { CloudGithubCredentialSnapshot } from "./github-connections-store.js";
import type { CloudGithubPrStore } from "./github-pr-store.js";
import { assertCloudGithubPrContext, type CloudGithubPrContext } from "./github-pr-service.js";
import type { CloudGithubActions } from "./github-actions.js";
import type { PostgresGithubVerificationStore } from "./github-verification-store.js";

const expired = () => new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");

/** Every boundary observes live database authority. Only the decrypted user
 * credential and its admitted source deadline belong to this one request. */
export function cloudGithubRequestContext(deps: {
  pool: pg.Pool;
  connections: CloudGithubConnections;
  metadata: CloudGithubPrStore;
  actions: CloudGithubActions;
  verifications: PostgresGithubVerificationStore;
  authorize(workspaceId: string, userId: string): Promise<void>;
  fetch: typeof fetch;
}) {
  return async (workspaceId: string, userId: string, options = { checkout: true }) => {
    const read = async (tx: Tx, expected?: { context: CloudGithubPrContext; generation: string }) => {
      // Credential callers retain the source-retirement refusal even when a
      // deleted checkout no longer has readable PR metadata.
      const tokenAdmission = expected && !options.checkout
        ? await deps.verifications.workspaceAdmission(tx, workspaceId,
          { organizationId: expected.context.organizationId, userId: expected.context.actorUserId ?? expected.context.creatorUserId }, expected.generation) : undefined;
      const context = await deps.metadata.context(workspaceId, userId, tx);
      const scope = { organizationId: context.organizationId, userId: context.actorUserId ?? context.creatorUserId };
      let credential: CloudGithubCredentialSnapshot | null = null;
      if (expected) await deps.connections.store.assertCurrent(scope, expected.generation, tx);
      else credential = await deps.connections.store.currentCredential(tx, scope);
      if (!expected && !credential) return { context, scope, credential, admission: null };
      const admission = tokenAdmission !== undefined ? tokenAdmission
        : await deps.verifications.workspaceAdmission(tx, workspaceId, scope, expected?.generation ?? credential!.generation);
      if (admission) {
        if (context.repositoryId && context.repositoryId !== admission.repositoryId)
          throw new HttpError(409, "github_repository_changed", "The workspace's saved repository identity changed.");
        context.repositoryId = admission.repositoryId;
      }
      if (expected) assertCloudGithubPrContext(expected.context, context, options.checkout);
      await deps.actions.assertCurrent(workspaceId, tx);
      return { context, scope, credential, admission };
    };

    let initial = await withSystemTx(deps.pool, tx => read(tx));
    if (!initial.credential) {
      await deps.connections.access(initial.scope);
      initial = await withSystemTx(deps.pool, tx => read(tx));
    }
    if (!initial.admission) {
      await deps.authorize(workspaceId, userId);
      initial = await withSystemTx(deps.pool, tx => read(tx));
    }
    if (!initial.credential || !initial.admission || Date.now() >= initial.admission.until) throw expired();
    const { context, credential, admission } = initial;
    const assertCurrent = async (transaction?: Tx) => {
      if (Date.now() >= admission.until) throw expired();
      const check = (tx: Tx) => read(tx, { context, generation: credential.generation });
      const current = await (transaction ? check(transaction) : withSystemTx(deps.pool, check));
      if (!current.admission || Date.now() >= Math.min(admission.until, current.admission.until)) throw expired();
    };
    // Connection save/refresh verified this immutable account ID. The exact
    // fingerprint's source observation supplies permission, not another /user.
    const access = {
      ...credential,
      login: credential.identity.login,
      assertCurrent,
      api: new CloudGithubApi({ apiBaseUrl: deps.connections.config?.apiBaseUrl ?? "https://api.github.com",
        token: credential.material.accessToken, assertCurrent, fetch: deps.fetch,
        cacheScope: JSON.stringify([context.organizationId, context.actorUserId ?? context.creatorUserId, workspaceId, context.revision, credential.generation]) }),
    };
    return { context, access };
  };
}
