// GitHub at two levels (CLOUD_V2_READY_COPIES_ENABLED). An organization
// connection is a GitHub App installation an owner or admin added; everyone
// uses it, and shared ready copies are built through it. A personal connection
// is one member's link, which nobody else sees: not other members, not admins,
// not any admin route or audit entry. A repository is added inside a
// connection and takes its level. Shared wins: a repository already shared
// cannot be added privately, and sharing folds every member's private entry
// for it into the shared one.
//
// Token model (unchanged): a member's personal sign-in is a GitHub App
// user-to-server token (refreshed under its refresh lease) or a personal
// access token, used for that member's workspaces and to prove what they may
// read. An organization connection holds no token: each use mints a GitHub App
// installation token scoped to one repository and expiring within the hour.
// Revoking either is today's path: disconnecting a sign-in deletes its
// credential; uninstalling the App ends every installation token.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";

export const PRIVATE_REPOSITORY_LIMIT = 20;

export type CloudGithubConnectionLevel = "organization" | "personal";
export type CloudGithubInstallationState = "active" | "suspended" | "uninstalled";
export type CloudGithubInstallation = {
  id: string; installationId: number | null; accountLogin: string; level: CloudGithubConnectionLevel;
  state: CloudGithubInstallationState; mine: boolean;
};
export type CloudRepositoryLevel = "shared" | "private";
export type CloudRepositoryEntry = {
  id: string; repository: string; repositoryId: string; level: CloudRepositoryLevel; connectionId: string | null; createdAt: string;
};

type InstallationRow = { id: string; org_id: string; installation_id: string | null; account_login: string; level: CloudGithubConnectionLevel;
  owner_user_id: string | null; state: CloudGithubInstallationState };
type RepositoryRow = { id: string; repository: string; repository_id: string; level: CloudRepositoryLevel; installation: string | null; created_at: Date };
const repositoryName = z.string().max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const repositoryId = z.string().regex(/^[1-9][0-9]{0,19}$/);

const installation = (row: InstallationRow, userId: string): CloudGithubInstallation => ({
  id: row.id, installationId: row.installation_id === null ? null : Number(row.installation_id), accountLogin: row.account_login,
  level: row.level, state: row.state, mine: row.owner_user_id === userId,
});
const entry = (row: RepositoryRow): CloudRepositoryEntry => ({
  id: row.id, repository: row.repository, repositoryId: row.repository_id, level: row.level, connectionId: row.installation,
  createdAt: row.created_at.toISOString(),
});
const owner = (repository: string) => repository.split("/")[0]!.toLowerCase();

export const repositoryAlreadyShared = (organization: string) =>
  new HttpError(409, "repository_already_shared", `This repository is already available to everyone in ${organization}.`);
export const organizationConnectionRequired = (account: string) =>
  new HttpError(409, "organization_connection_required", `Connect ${account} on GitHub for the organization first.`);
export const personalRepositoriesForbidden = () =>
  new HttpError(403, "personal_repositories_forbidden", "This organization does not allow repositories for one member.");
export const privateRepositoryLimit = () =>
  new HttpError(409, "private_repository_limit", `You can keep up to ${PRIVATE_REPOSITORY_LIMIT} repositories for yourself.`);
export const privateWorkspaceRefused = () =>
  new HttpError(409, "private_workspace", "Workspaces of a repository only you can use can't be shared or reassigned.");

export class CloudRepositoryLevels {
  constructor(private readonly pool: pg.Pool) {}

  private tx<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return withSystemTx(this.pool, work); }

  /** The caller's role, locking the organization when `lock` (writes). Removed
   * and held members, deleted organizations and ones without cloud are refused. */
  private async role(tx: Tx, organizationId: string, userId: string, lock = false): Promise<{ role: string; name: string; personalAllowed: boolean }> {
    const row = (await tx.query<{ role: string; name: string; personal: boolean }>(
      `SELECT m.role, o.name, o.cloud_personal_repositories_allowed AS personal FROM organization_members m
       JOIN users u ON u.id=m.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
       JOIN organizations o ON o.id=m.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
       WHERE m.org_id=$1 AND m.user_id=$2 ${lock ? "FOR UPDATE OF o" : ""}`, [organizationId, userId])).rows[0];
    if (!row) throw new HttpError(404, "not_found", "Organization not found");
    return { role: row.role, name: row.name, personalAllowed: row.personal };
  }
  private async admin(tx: Tx, organizationId: string, userId: string, lock = false) {
    const member = await this.role(tx, organizationId, userId, lock);
    if (!["owner", "admin"].includes(member.role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
    return member;
  }

  // ── Connections ─────────────────────────────────────────

  /** The organization's connections, and the caller's own personal ones only. */
  async connections(organizationId: string, userId: string): Promise<CloudGithubInstallation[]> {
    return this.tx(async tx => {
      await this.role(tx, organizationId, userId);
      const { rows } = await tx.query<InstallationRow>(
        `SELECT * FROM cloud_github_installations WHERE org_id=$1 AND (level='organization' OR owner_user_id=$2)
         ORDER BY level, lower(account_login), id`, [organizationId, userId]);
      return rows.map(row => installation(row, userId));
    });
  }

  /** Records an installation the caller's GitHub sign-in can see. At the
   * organization level (owners and admins) it is recorded once: a matching
   * migrated connection is bound, and members' personal links to it move up,
   * their private repositories staying private. */
  async connect(organizationId: string, userId: string, input: { installationId: number; accountLogin: string; level: CloudGithubConnectionLevel }):
    Promise<CloudGithubInstallation> {
    if (!Number.isSafeInteger(input.installationId) || input.installationId < 1 || !/^[A-Za-z0-9_.-]{1,100}$/.test(input.accountLogin))
      throw new HttpError(422, "invalid_input", "Invalid GitHub installation.");
    return this.tx(async tx => {
      if (input.level === "personal") {
        await this.role(tx, organizationId, userId, true);
        const shared = (await tx.query<InstallationRow>(
          "SELECT * FROM cloud_github_installations WHERE org_id=$1 AND level='organization' AND installation_id=$2", [organizationId, input.installationId])).rows[0];
        if (shared) return installation(shared, userId);
        const row = (await tx.query<InstallationRow>(
          `INSERT INTO cloud_github_installations (id, org_id, installation_id, account_login, level, owner_user_id, added_by)
           VALUES ($1,$2,$3,$4,'personal',$5,$5)
           ON CONFLICT (org_id, owner_user_id, installation_id) WHERE level='personal' DO UPDATE SET account_login=EXCLUDED.account_login, updated_at=clock_timestamp()
           RETURNING *`, [randomUUID(), organizationId, input.installationId, input.accountLogin, userId])).rows[0]!;
        return installation(row, userId);
      }
      await this.admin(tx, organizationId, userId, true);
      let row = (await tx.query<InstallationRow>(
        "SELECT * FROM cloud_github_installations WHERE org_id=$1 AND level='organization' AND installation_id=$2", [organizationId, input.installationId])).rows[0];
      row ??= (await tx.query<InstallationRow>(`UPDATE cloud_github_installations SET installation_id=$2, state='active', added_by=$4, updated_at=clock_timestamp()
        WHERE org_id=$1 AND level='organization' AND installation_id IS NULL AND lower(account_login)=lower($3) RETURNING *`,
        [organizationId, input.installationId, input.accountLogin, userId])).rows[0];
      row ??= (await tx.query<InstallationRow>(`INSERT INTO cloud_github_installations (id, org_id, installation_id, account_login, level, added_by)
        VALUES ($1,$2,$3,$4,'organization',$5) RETURNING *`, [randomUUID(), organizationId, input.installationId, input.accountLogin, userId])).rows[0]!;
      // Move up: personal links to this installation become the organization's.
      await tx.query(`UPDATE cloud_repositories SET installation=$2 WHERE org_id=$1 AND installation IN
        (SELECT id FROM cloud_github_installations WHERE org_id=$1 AND level='personal' AND installation_id=$3)`, [organizationId, row.id, input.installationId]);
      await tx.query("DELETE FROM cloud_github_installations WHERE org_id=$1 AND level='personal' AND installation_id=$2", [organizationId, input.installationId]);
      return installation(row, userId);
    });
  }

  /** Owners and admins remove organization connections; a member, their own. */
  async disconnect(organizationId: string, userId: string, connectionId: string): Promise<void> {
    await this.tx(async tx => {
      const member = await this.role(tx, organizationId, userId, true);
      const row = (await tx.query<InstallationRow>("SELECT * FROM cloud_github_installations WHERE id=$1 AND org_id=$2 FOR UPDATE", [connectionId, organizationId])).rows[0];
      // Another member's personal link does not exist for the caller.
      if (!row || (row.level === "personal" && row.owner_user_id !== userId)) throw new HttpError(404, "not_found", "Connection not found");
      if (row.level === "organization" && !["owner", "admin"].includes(member.role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
      await tx.query("DELETE FROM cloud_github_installations WHERE id=$1", [row.id]);
    });
  }

  /** Whether the organization has one member: its two GitHub levels show as one page. */
  async solo(organizationId: string): Promise<boolean> {
    const { rows } = await this.tx(tx => tx.query<{ n: string }>("SELECT count(*) AS n FROM organization_members WHERE org_id=$1", [organizationId]));
    return Number(rows[0]?.n ?? 0) <= 1;
  }

  /** GitHub reported an installation's state (suspended, uninstalled, or active again). */
  async installationState(installationId: number, state: CloudGithubInstallationState): Promise<number> {
    const { rowCount } = await this.tx(tx => tx.query(
      "UPDATE cloud_github_installations SET state=$2, updated_at=clock_timestamp() WHERE installation_id=$1 AND state<>$2", [installationId, state]));
    return rowCount ?? 0;
  }

  /** The organization connection shared copies of `repository` are built
   * through: active, bound, for the repository's owner. */
  async organizationInstallation(organizationId: string, repository: string): Promise<CloudGithubInstallation | null> {
    const row = (await this.tx(tx => tx.query<InstallationRow>(
      `SELECT * FROM cloud_github_installations WHERE org_id=$1 AND level='organization' AND lower(account_login)=$2
       ORDER BY (state='active') DESC, (installation_id IS NOT NULL) DESC LIMIT 1`, [organizationId, owner(repository)]))).rows[0];
    return row ? installation(row, "") : null;
  }

  async bindInstallation(organizationId: string, accountLogin: string, installationId: number): Promise<void> {
    await this.tx(tx => tx.query(`UPDATE cloud_github_installations SET installation_id=$3, updated_at=clock_timestamp()
      WHERE org_id=$1 AND level='organization' AND installation_id IS NULL AND lower(account_login)=lower($2)
        AND NOT EXISTS (SELECT 1 FROM cloud_github_installations o WHERE o.org_id=$1 AND o.level='organization' AND o.installation_id=$3)`,
      [organizationId, accountLogin, installationId]));
  }

  // ── Repositories ────────────────────────────────────────

  /** The organization's shared repositories, and the caller's own private ones. */
  async repositories(organizationId: string, userId: string): Promise<{ shared: CloudRepositoryEntry[]; private: CloudRepositoryEntry[]; personalAllowed: boolean }> {
    return this.tx(async tx => {
      const member = await this.role(tx, organizationId, userId);
      const { rows } = await tx.query<RepositoryRow>(
        `SELECT id, repository, repository_id, level, installation, created_at FROM cloud_repositories
         WHERE org_id=$1 AND (level='shared' OR (owner_user_id=$2 AND folded_at IS NULL)) ORDER BY repository, id`, [organizationId, userId]);
      return { shared: rows.filter(row => row.level === "shared").map(entry), private: rows.filter(row => row.level === "private").map(entry),
        personalAllowed: member.personalAllowed };
    });
  }

  /** Shared wins: a shared entry, else the caller's own private one, else none. */
  async levelFor(organizationId: string, userId: string, repository: string):
    Promise<{ level: "shared"; entry: CloudRepositoryEntry } | { level: "private"; entry: CloudRepositoryEntry; allowed: boolean } | null> {
    const { rows } = await this.tx(tx => tx.query<RepositoryRow & { personal: boolean }>(
      `SELECT r.id, r.repository, r.repository_id, r.level, r.installation, r.created_at, o.cloud_personal_repositories_allowed AS personal
       FROM cloud_repositories r JOIN organizations o ON o.id=r.org_id
       WHERE r.org_id=$1 AND r.repository=lower($3) AND (r.level='shared' OR (r.owner_user_id=$2 AND r.folded_at IS NULL))
       ORDER BY (r.level='shared') DESC LIMIT 1`, [organizationId, userId, repository]));
    const row = rows[0];
    if (!row) return null;
    return row.level === "shared" ? { level: "shared", entry: entry(row) } : { level: "private", entry: entry(row), allowed: row.personal };
  }

  /** Adds a repository at a connection's level. The identity is the one the
   * caller's GitHub access just resolved. */
  async add(organizationId: string, userId: string, input: { repository: string; repositoryId: string; level: CloudRepositoryLevel; connectionId?: string | null }):
    Promise<CloudRepositoryEntry> {
    const repository = repositoryName.parse(input.repository).toLowerCase(), id = repositoryId.parse(input.repositoryId);
    return this.tx(async tx => {
      if (input.level === "shared") {
        await this.admin(tx, organizationId, userId, true);
        const connection = await this.sharedConnection(tx, organizationId, repository, input.connectionId ?? null);
        const row = await this.insertShared(tx, organizationId, userId, repository, id, connection);
        await this.fold(tx, organizationId, id);
        return entry(row);
      }
      const member = await this.role(tx, organizationId, userId, true);
      if (!member.personalAllowed) throw personalRepositoriesForbidden();
      if ((await tx.query("SELECT 1 FROM cloud_repositories WHERE org_id=$1 AND level='shared' AND repository_id=$2", [organizationId, id])).rowCount)
        throw repositoryAlreadyShared(member.name);
      const existing = (await tx.query<RepositoryRow>(`SELECT id, repository, repository_id, level, installation, created_at FROM cloud_repositories
        WHERE org_id=$1 AND level='private' AND owner_user_id=$2 AND repository_id=$3 AND folded_at IS NULL`, [organizationId, userId, id])).rows[0];
      if (existing) return entry(existing);
      const count = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM cloud_repositories
        WHERE org_id=$1 AND level='private' AND owner_user_id=$2 AND folded_at IS NULL`, [organizationId, userId])).rows[0]!.n);
      if (count >= PRIVATE_REPOSITORY_LIMIT) throw privateRepositoryLimit();
      const connection = input.connectionId ? (await tx.query<InstallationRow>(`SELECT * FROM cloud_github_installations WHERE id=$1 AND org_id=$2
        AND (level='organization' OR owner_user_id=$3)`, [input.connectionId, organizationId, userId])).rows[0] : undefined;
      if (input.connectionId && !connection) throw new HttpError(404, "not_found", "Connection not found");
      return entry((await tx.query<RepositoryRow>(`INSERT INTO cloud_repositories (id, org_id, repository, repository_id, level, owner_user_id, installation, added_by)
        VALUES ($1,$2,$3,$4,'private',$5,$6,$5) RETURNING id, repository, repository_id, level, installation, created_at`,
        [randomUUID(), organizationId, repository, id, userId, connection?.id ?? null])).rows[0]!);
    });
  }

  /** "Share with <organization>": an admin moves their own private repository
   * to the organization level, through an organization connection that can read it. */
  async share(organizationId: string, userId: string, repositoryEntryId: string): Promise<CloudRepositoryEntry> {
    return this.tx(async tx => {
      await this.admin(tx, organizationId, userId, true);
      const own = (await tx.query<RepositoryRow>(`SELECT id, repository, repository_id, level, installation, created_at FROM cloud_repositories
        WHERE id=$1 AND org_id=$2 AND level='private' AND owner_user_id=$3 AND folded_at IS NULL`, [repositoryEntryId, organizationId, userId])).rows[0];
      if (!own) throw new HttpError(404, "not_found", "Repository not found");
      const connection = await this.sharedConnection(tx, organizationId, own.repository, null);
      const shared = await this.insertShared(tx, organizationId, userId, own.repository, own.repository_id, connection);
      await this.fold(tx, organizationId, own.repository_id);
      return entry(shared);
    });
  }

  async remove(organizationId: string, userId: string, repositoryEntryId: string): Promise<void> {
    await this.tx(async tx => {
      const member = await this.role(tx, organizationId, userId, true);
      const row = (await tx.query<{ level: CloudRepositoryLevel; owner_user_id: string | null }>(
        "SELECT level, owner_user_id FROM cloud_repositories WHERE id=$1 AND org_id=$2 AND folded_at IS NULL FOR UPDATE", [repositoryEntryId, organizationId])).rows[0];
      if (!row || (row.level === "private" && row.owner_user_id !== userId)) throw new HttpError(404, "not_found", "Repository not found");
      if (row.level === "shared" && !["owner", "admin"].includes(member.role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
      await tx.query("DELETE FROM cloud_repositories WHERE id=$1", [repositoryEntryId]);
    });
  }

  /** A released desktop's admin edits the Cloud Computer's repositories: each
   * becomes a shared repository, under the organization connection for its
   * owner when there is one, and folds members' private entries. */
  async syncFromRecipe(organizationId: string, userId: string, targets: readonly { repository: string; repositoryId: string }[]): Promise<number> {
    return this.tx(async tx => {
      await this.admin(tx, organizationId, userId, true);
      let added = 0;
      for (const target of targets) {
        const repository = repositoryName.parse(target.repository).toLowerCase(), id = repositoryId.parse(target.repositoryId);
        const connection = (await tx.query<{ id: string }>(`SELECT id FROM cloud_github_installations WHERE org_id=$1 AND level='organization'
          AND lower(account_login)=$2 ORDER BY (installation_id IS NOT NULL) DESC LIMIT 1`, [organizationId, owner(repository)])).rows[0];
        const inserted = await tx.query(`INSERT INTO cloud_repositories (id, org_id, repository, repository_id, level, installation, added_by)
          VALUES ($1,$2,$3,$4,'shared',$5,$6) ON CONFLICT (org_id, repository_id) WHERE level='shared' DO NOTHING`,
          [randomUUID(), organizationId, repository, id, connection?.id ?? null, userId]);
        added += inserted.rowCount ?? 0;
        await this.fold(tx, organizationId, id);
      }
      return added;
    });
  }

  async setPersonalAllowed(organizationId: string, userId: string, allowed: boolean): Promise<boolean> {
    return this.tx(async tx => {
      await this.admin(tx, organizationId, userId, true);
      await tx.query("UPDATE organizations SET cloud_personal_repositories_allowed=$2 WHERE id=$1", [organizationId, allowed]);
      return allowed;
    });
  }

  private async sharedConnection(tx: Tx, organizationId: string, repository: string, connectionId: string | null): Promise<InstallationRow> {
    const { rows } = await tx.query<InstallationRow>(
      `SELECT * FROM cloud_github_installations WHERE org_id=$1 AND level='organization' AND state='active'
         AND ($3::uuid IS NULL OR id=$3) AND lower(account_login)=$2 ORDER BY (installation_id IS NOT NULL) DESC LIMIT 1`,
      [organizationId, owner(repository), connectionId]);
    if (!rows[0]) throw organizationConnectionRequired(owner(repository));
    return rows[0];
  }

  private async insertShared(tx: Tx, organizationId: string, userId: string, repository: string, id: string, connection: InstallationRow): Promise<RepositoryRow> {
    await tx.query(`INSERT INTO cloud_repositories (id, org_id, repository, repository_id, level, installation, added_by)
      VALUES ($1,$2,$3,$4,'shared',$5,$6) ON CONFLICT (org_id, repository_id) WHERE level='shared' DO NOTHING`,
      [randomUUID(), organizationId, repository, id, connection.id, userId]);
    return (await tx.query<RepositoryRow>(`SELECT id, repository, repository_id, level, installation, created_at FROM cloud_repositories
      WHERE org_id=$1 AND level='shared' AND repository_id=$2`, [organizationId, id])).rows[0]!;
  }

  /** Shared wins: every member's private entry folds in. Their workspaces stay
   * theirs and private; their private copies are retired by ready copy maintenance. */
  private async fold(tx: Tx, organizationId: string, id: string): Promise<void> {
    await tx.query(`UPDATE cloud_repositories SET folded_at=clock_timestamp() WHERE id IN (SELECT id FROM cloud_repositories
      WHERE org_id=$1 AND level='private' AND repository_id=$2 AND folded_at IS NULL ORDER BY id FOR UPDATE)`, [organizationId, id]);
  }
}

// ── Data migration (4.13) ──────────────────────────────────

export type RepositoryLevelsMigration = { organizations: number; connections: number; repositories: number };

/** Each organization's live Cloud Computer repositories become shared
 * repositories under an organization connection for each repository owner,
 * waiting for its installation ID. Members' cloud GitHub sign-ins are not
 * touched: they already are each member's personal sign-in. Idempotent, data
 * only, and safe with ready copies off; every row it adds is marked migrated,
 * so revertRepositoryLevelsMigration can undo it until ready copies are on. */
export async function migrateRepositoryLevels(pool: pg.Pool, options: { dryRun?: boolean } = {}): Promise<RepositoryLevelsMigration> {
  return withSystemTx(pool, async tx => {
    const { rows } = await tx.query<{ org_id: string; created_by: string | null; targets: unknown }>(
      `SELECT c.org_id, b.created_by, b.source_targets AS targets FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id AND b.state='succeeded' AND b.source_targets IS NOT NULL
       JOIN organizations o ON o.id=c.org_id AND o.deleted_at IS NULL ORDER BY c.org_id`);
    const result: RepositoryLevelsMigration = { organizations: 0, connections: 0, repositories: 0 };
    for (const row of rows) {
      const targets = z.array(z.object({ repository: repositoryName, repositoryId })).safeParse(row.targets);
      if (!targets.success || !targets.data.length) continue;
      result.organizations++;
      for (const account of [...new Set(targets.data.map(target => owner(target.repository)))]) {
        const existing = (await tx.query<{ id: string }>(`SELECT id FROM cloud_github_installations WHERE org_id=$1 AND level='organization'
          AND lower(account_login)=$2 ORDER BY (installation_id IS NOT NULL) DESC LIMIT 1`, [row.org_id, account])).rows[0];
        if (!existing) result.connections++;
        if (options.dryRun) continue;
        if (!existing) await tx.query(`INSERT INTO cloud_github_installations (id, org_id, account_login, level, added_by, migrated)
          VALUES ($1,$2,$3,'organization',$4,true) ON CONFLICT DO NOTHING`, [randomUUID(), row.org_id, account, row.created_by]);
      }
      for (const target of targets.data) {
        const present = (await tx.query("SELECT 1 FROM cloud_repositories WHERE org_id=$1 AND level='shared' AND repository_id=$2",
          [row.org_id, target.repositoryId])).rowCount;
        if (present) continue;
        result.repositories++;
        if (options.dryRun) continue;
        const connection = (await tx.query<{ id: string }>(`SELECT id FROM cloud_github_installations WHERE org_id=$1 AND level='organization'
          AND lower(account_login)=$2 ORDER BY (installation_id IS NOT NULL) DESC LIMIT 1`, [row.org_id, owner(target.repository)])).rows[0];
        await tx.query(`INSERT INTO cloud_repositories (id, org_id, repository, repository_id, level, installation, added_by, migrated)
          VALUES ($1,$2,$3,$4,'shared',$5,$6,true) ON CONFLICT DO NOTHING`,
          [randomUUID(), row.org_id, target.repository.toLowerCase(), target.repositoryId, connection?.id ?? null, row.created_by]);
      }
    }
    return result;
  });
}

/** Removes only what migrateRepositoryLevels added and nobody changed since. */
export async function revertRepositoryLevelsMigration(pool: pg.Pool): Promise<{ connections: number; repositories: number }> {
  return withSystemTx(pool, async tx => {
    const repositories = await tx.query("DELETE FROM cloud_repositories WHERE migrated AND level='shared'");
    const connections = await tx.query(`DELETE FROM cloud_github_installations i WHERE migrated AND installation_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM cloud_repositories r WHERE r.installation=i.id)`);
    return { connections: connections.rowCount ?? 0, repositories: repositories.rowCount ?? 0 };
  });
}
