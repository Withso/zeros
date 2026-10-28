import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { GithubBackendConfig } from "./config.js";
import { withSystemTx } from "./db.js";
import { HttpError } from "./authz.js";
import { githubHeaders, githubJson, mintGithubInstallationToken, revokeGithubInstallationToken } from "./github-installation-tokens.js";

const permission = z.object({
  permission: z.enum(["admin", "write", "read", "none"]),
  user: z.object({ id: z.number().int().safe().positive(), login: z.string().min(1).max(100) }),
});
export type GithubRepositoryScope = { userId: string; organizationId?: string; installationId?: number; owner?: string };
export type GithubRepositoryActor = {
  id: string; installation: string; owner: string; login: string; user: string; generation: string;
  connection: string | null; account: string; organization: string | null; membership: string | null;
};
export type RepositoryRequest = GithubRepositoryScope & { repositories: readonly string[]; repositoryIds?: readonly string[]; access: "read" | "write" | "user" };
const denied = () => new HttpError(403, "github_cloud_access_denied", "Your connected GitHub account no longer has the required repository access.");

/** Every operation intersects the installation with the exact human's live
 * repository permission. A row's existence or matching login is not a grant. */
export class GithubRepositoryAuthority {
  constructor(private readonly pool: pg.Pool, private readonly config: GithubBackendConfig, private readonly fetchImpl: typeof fetch = fetch,
    private readonly actorSnapshot?: (scope: GithubRepositoryScope) => Promise<GithubRepositoryActor>) {}

  private async snapshot(scope: GithubRepositoryScope): Promise<GithubRepositoryActor> {
    if (this.actorSnapshot) return this.actorSnapshot(scope);
    const { rows } = await withSystemTx(this.pool, tx => tx.query<GithubRepositoryActor>(`
      SELECT i.id, i.github_installation_id::text AS installation, i.account_login AS owner,
        a.github_login AS login, a.github_user_id AS "user", a.grant_generation::text AS generation,
        c.authority_revision::text AS connection, u.auth_revision::text AS account,
        o.authorization_revision::text AS organization, m.authorization_revision::text AS membership
      FROM github_installations i
      JOIN github_authorizations a ON a.owner_user_id=i.owner_user_id AND a.app_variant=i.app_variant
      JOIN users u ON u.id=i.owner_user_id AND u.auth_status='active' AND u.deleted_at IS NULL
      LEFT JOIN cloud_github_connections c ON c.installation_id=i.id AND c.owner_user_id=i.owner_user_id AND c.org_id=$4::uuid
      LEFT JOIN organization_members m ON m.org_id=c.org_id AND m.user_id=c.owner_user_id
      LEFT JOIN organizations o ON o.id=m.org_id AND o.deleted_at IS NULL AND NOT o.is_personal
      WHERE i.owner_user_id=$1 AND i.app_variant=$2 AND i.suspended_at IS NULL
        AND ($3::bigint IS NULL OR i.github_installation_id=$3)
        AND ($5::text IS NULL OR lower(i.account_login)=lower($5))
        AND ($4::uuid IS NULL OR o.id IS NOT NULL)
      ORDER BY i.id LIMIT 1`,
    [scope.userId, this.config.variantKey, scope.installationId ?? null, scope.organizationId ?? null, scope.owner ?? null]));
    const row = rows[0];
    if (!row?.user || !row.generation) throw new HttpError(404, "github_connection_required", "Connect GitHub for this repository first.");
    return row;
  }

  private async permissions(token: string, actor: GithubRepositoryActor, repositories: readonly string[], repositoryIds?: readonly string[]): Promise<boolean> {
    let write = true;
    for (const [index, repository] of repositories.entries()) {
      if (repositoryIds) {
        // A path can be reused even by a public repository. Bind the response
        // itself to the ID as well as restricting the installation credential.
        const identity = z.object({ id: z.number().int().safe().positive(), full_name: z.string() }).safeParse(await githubJson(this.fetchImpl,
          `${this.config.apiBaseUrl}/repos/${encodeURIComponent(actor.owner)}/${encodeURIComponent(repository)}`, { headers: githubHeaders(token) }));
        if (!identity.success || String(identity.data.id) !== repositoryIds[index] ||
          identity.data.full_name.toLowerCase() !== `${actor.owner}/${repository}`.toLowerCase()) throw denied();
      }
      const value = permission.safeParse(await githubJson(this.fetchImpl,
        `${this.config.apiBaseUrl}/repos/${encodeURIComponent(actor.owner)}/${encodeURIComponent(repository)}/collaborators/${encodeURIComponent(actor.login)}/permission`,
        { headers: githubHeaders(token) }));
      if (!value.success || String(value.data.user.id) !== actor.user || value.data.user.login.toLowerCase() !== actor.login.toLowerCase() || value.data.permission === "none") throw denied();
      write &&= value.data.permission === "admin" || value.data.permission === "write";
    }
    return write;
  }

  private fingerprint(value: GithubRepositoryActor): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  /** Fingerprint is for a bounded source-access lease; it contains no credential. */
  async fingerprintFor(scope: GithubRepositoryScope): Promise<string> { return this.fingerprint(await this.snapshot(scope)); }

  async mint(input: RepositoryRequest): Promise<{ token: string; expiresAtMs: number }> {
    return (await this.run(input, true)).credential!;
  }

  async check(input: RepositoryRequest): Promise<string> { return (await this.run(input, false)).fingerprint; }

  private async run(input: RepositoryRequest, issue: boolean) {
    if (!input.repositories.length || input.repositories.length > 10 || input.repositories.some(name => !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..")) throw denied();
    if (input.repositoryIds && (input.repositoryIds.length !== input.repositories.length || input.repositoryIds.some(id =>
      !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))))) throw denied();
    const actor = await this.snapshot(input), fingerprint = this.fingerprint(actor);
    const probe = await mintGithubInstallationToken(this.fetchImpl, this.config, {
      installationId: Number(actor.installation), repositories: input.repositories, ...(input.repositoryIds ? { repositoryIds: input.repositoryIds } : {}), permissions: { metadata: "read" }, nowMs: Date.now(),
    });
    let credential: { token: string; expiresAtMs: number } | undefined;
    try {
      let canWrite = false;
      try {
        canWrite = await this.permissions(probe.token, actor, input.repositories, input.repositoryIds);
        if (input.access === "write" && !canWrite) throw denied();
        if (issue) {
          const level = input.access === "read" || !canWrite ? "read" : "write";
          credential = await mintGithubInstallationToken(this.fetchImpl, this.config, {
            installationId: Number(actor.installation), repositories: input.repositories,
            ...(input.repositoryIds ? { repositoryIds: input.repositoryIds } : {}),
            permissions: { metadata: "read", contents: level, pull_requests: level }, nowMs: Date.now(),
          });
        }
      } finally {
        await revokeGithubInstallationToken(this.fetchImpl, this.config, probe.token).catch(() => {});
      }
      // Cleanup is remote I/O, too. Final checks must follow it, otherwise a
      // slow revoke can release a credential after the human lost authority.
      // The scoped credential includes metadata access for this last check.
      if (credential && await this.permissions(credential.token, actor, input.repositories, input.repositoryIds) !== canWrite) throw denied();
      if (await this.fingerprintFor(input) !== fingerprint) throw denied();
      return { credential, fingerprint };
    } catch (error) {
      if (credential) await revokeGithubInstallationToken(this.fetchImpl, this.config, credential.token).catch(() => {});
      throw error;
    }
  }
}
