// GitHub connections at two levels (CLOUD_V2_READY_COPIES_ENABLED). An
// organization connection is a GitHub App installation an owner or admin added;
// everyone uses it, and organization projects are built through it. A personal
// connection is one member's link, which nobody else sees: not other members,
// not admins, not any admin route or audit entry. A connection lists what it
// can read; projects (projects.ts) pick their repositories from those.
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
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";

export type CloudGithubConnectionLevel = "organization" | "personal";
export type CloudGithubInstallationState = "active" | "suspended" | "uninstalled";
export type CloudGithubInstallation = {
  id: string; installationId: number | null; accountLogin: string; level: CloudGithubConnectionLevel;
  state: CloudGithubInstallationState; mine: boolean;
};

type InstallationRow = { id: string; org_id: string; installation_id: string | null; account_login: string; level: CloudGithubConnectionLevel;
  owner_user_id: string | null; state: CloudGithubInstallationState };

const installation = (row: InstallationRow, userId: string): CloudGithubInstallation => ({
  id: row.id, installationId: row.installation_id === null ? null : Number(row.installation_id), accountLogin: row.account_login,
  level: row.level, state: row.state, mine: row.owner_user_id === userId,
});
const owner = (repository: string) => repository.split("/")[0]!.toLowerCase();

export const organizationConnectionRequired = (account: string) =>
  new HttpError(409, "organization_connection_required", `Connect ${account} on GitHub for the organization first.`);
export const privateWorkspaceRefused = () =>
  new HttpError(409, "private_workspace", "Workspaces of a project only you can use can't be shared or reassigned.");

export class CloudRepositoryLevels {
  constructor(private readonly pool: pg.Pool) {}

  private tx<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return withSystemTx(this.pool, work); }

  /** The caller's role, locking the organization when `lock` (writes). Removed
   * and held members, deleted organizations and ones without cloud are refused. */
  private async role(tx: Tx, organizationId: string, userId: string, lock = false): Promise<{ role: string; name: string; personalAllowed: boolean }> {
    const row = (await tx.query<{ role: string; name: string; personal: boolean }>(
      `SELECT m.role, o.name, o.cloud_personal_projects_allowed AS personal FROM organization_members m
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
      // Move up: personal links to this installation become the organization's; projects that used them keep them.
      await tx.query(`UPDATE cloud_project_repositories SET connection=$2 WHERE connection IN
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

  /** The caller's role; not found once they have left. */
  /** Whether the caller is an owner or admin, and whether members may keep projects of their own. */
  async access(organizationId: string, userId: string): Promise<{ admin: boolean; personalAllowed: boolean }> {
    return this.tx(async tx => {
      const member = await this.role(tx, organizationId, userId);
      return { admin: ["owner", "admin"].includes(member.role), personalAllowed: member.personalAllowed };
    });
  }

  async memberRole(organizationId: string, userId: string): Promise<string> {
    return this.tx(async tx => (await this.role(tx, organizationId, userId)).role);
  }

  /** Display names for history rows, of the organization's members only. */
  async people(organizationId: string, userIds: readonly string[]): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const { rows } = await this.tx(tx => tx.query<{ id: string; name: string }>(
      `SELECT u.id, coalesce(nullif(u.display_name,''), u.email) AS name FROM users u JOIN organization_members m ON m.user_id=u.id AND m.org_id=$1
       WHERE u.id = ANY($2::uuid[])`, [organizationId, [...new Set(userIds)]]));
    return new Map(rows.map(row => [row.id, row.name]));
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

  async setPersonalAllowed(organizationId: string, userId: string, allowed: boolean): Promise<boolean> {
    return this.tx(async tx => {
      await this.admin(tx, organizationId, userId, true);
      await tx.query("UPDATE organizations SET cloud_personal_projects_allowed=$2 WHERE id=$1", [organizationId, allowed]);
      return allowed;
    });
  }
}
