// Cloud projects (CLOUD_V2_READY_COPIES_ENABLED): a named set of one or more
// repositories, each with its own branch and setup in that project. An
// organization project is created and edited by owners and admins and used by
// every member; its repositories must be reachable through an organization
// GitHub connection, which builds its ready copy. A personal project is its
// member's alone: nobody else sees it, its copy or its workspaces, admins
// included, at any time. There is no step that adds a repository to the cloud:
// a project picks repositories from what its connections can read.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { RepositorySetupPathSchema } from "./repository-setup-contract.js";
import { recipeChanged } from "./computer.js";

/** Projects one member may keep for themselves; organization projects are unlimited. */
export const PERSONAL_PROJECT_LIMIT = 20;
/**
 * Repositories per project. A copy clones each in full and runs each setup in
 * turn inside one background build, and a create checks each repository's
 * access for the member (in parallel, a few at a time). Ten keeps a cold build
 * of typical repositories with dependencies (2-3 GB each) within a few hours
 * and a disk Boat's machines hold, and is the old Cloud Computer's own limit.
 */
export const PROJECT_REPOSITORY_LIMIT = 10;

export type CloudProjectLevel = "organization" | "personal";
export type CloudProjectRepository = {
  repository: string; repositoryId: string; connectionId: string | null; defaultBranch: string | null;
  setup: string | null; setupScript: string | null; position: number;
};
export type CloudProject = {
  id: string; organizationId: string; name: string; level: CloudProjectLevel; ownerUserId: string | null;
  repositories: CloudProjectRepository[]; createdAt: string; updatedAt: string;
};
export type CloudProjectView = CloudProject & { canEdit: boolean };
export type CloudProjectRepositoryInput = { repository: string; repositoryId: string; connectionId?: string | null | undefined;
  defaultBranch?: string | null | undefined; setup?: string | null | undefined; setupScript?: string | null | undefined };

const name = z.string().trim().min(1).max(100);
const repositoryName = z.string().max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const repositoryId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const branch = z.string().min(1).max(255).refine(value => !value.startsWith("-"), "Invalid branch or tag");
export const CloudProjectRepositoryInputSchema = z.object({
  repository: repositoryName, repositoryId, connectionId: z.string().uuid().nullable().optional(),
  defaultBranch: branch.nullable().optional(), setup: z.string().max(8_000).nullable().optional(),
  setupScript: RepositorySetupPathSchema.nullable().optional(),
}).strict();

type ProjectRow = { id: string; org_id: string; name: string; level: CloudProjectLevel; owner_user_id: string | null; created_at: Date; updated_at: Date };
type RepositoryRow = { project_id: string; position: number; repository: string; repository_id: string; connection: string | null;
  default_branch: string | null; setup: string | null; setup_script: string | null };
const owner = (repository: string) => repository.split("/")[0]!.toLowerCase();

export const personalProjectsForbidden = () =>
  new HttpError(403, "personal_projects_forbidden", "This organization does not allow projects for one member.");
export const personalProjectLimit = () =>
  new HttpError(409, "personal_project_limit", `You can keep up to ${PERSONAL_PROJECT_LIMIT} projects for yourself.`);
export const projectRepositoryLimit = () =>
  new HttpError(422, "project_repository_limit", `A project holds up to ${PROJECT_REPOSITORY_LIMIT} repositories.`);
export const projectNameTaken = () => new HttpError(409, "project_name_taken", "A project with this name already exists.");
const projectNotFound = () => new HttpError(404, "not_found", "Project not found");
const repositoryUnreachable = (repository: string) =>
  new HttpError(409, "organization_connection_required", `Connect ${owner(repository)} on GitHub for the organization to use ${repository}.`);

/** What changed in a project's repositories, so only that project's copy is rebuilt. */
export type CloudProjectChange = "project_created" | "repositories_changed" | "setup_changed" | "branch_changed" | null;

export class CloudProjects {
  constructor(private readonly pool: pg.Pool) {}

  private tx<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return withSystemTx(this.pool, work); }
  /** In the caller's transaction when given one (a recipe save is one transaction), else a new one. */
  private within<T>(tx: Tx | undefined, work: (tx: Tx) => Promise<T>): Promise<T> { return tx ? work(tx) : this.tx(work); }

  /** A released desktop saves its recipe against the Cloud Computer's revision, and that
   * recipe is the organization's one-repository projects. Every change to the
   * organization's projects moves the revision in the same transaction, under the
   * organization lock a save also holds, so a save made from an older list is refused
   * instead of undoing the change. Personal projects never reach that recipe: their
   * writes leave it alone, so a member's private edits never show to admins as conflicts. */
  private async moved(tx: Tx, organizationId: string): Promise<void> {
    await tx.query(`INSERT INTO cloud_v2_computers (org_id, recipe_revision, recipe_updated_at) VALUES ($1, 1, clock_timestamp())
      ON CONFLICT (org_id) DO UPDATE SET recipe_revision=cloud_v2_computers.recipe_revision+1`, [organizationId]);
  }

  /** The caller's role; not found once they have left, and for deleted organizations or ones without cloud. */
  private async member(tx: Tx, organizationId: string, userId: string, lock = false): Promise<{ role: string; name: string; personalAllowed: boolean }> {
    const row = (await tx.query<{ role: string; name: string; personal: boolean }>(
      `SELECT m.role, o.name, o.cloud_personal_projects_allowed AS personal FROM organization_members m
       JOIN users u ON u.id=m.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
       JOIN organizations o ON o.id=m.org_id AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND o.cloud_workspaces_allowed
       WHERE m.org_id=$1 AND m.user_id=$2 ${lock ? "FOR UPDATE OF o" : ""}`, [organizationId, userId])).rows[0];
    if (!row) throw new HttpError(404, "not_found", "Organization not found");
    return { role: row.role, name: row.name, personalAllowed: row.personal };
  }
  private admin(role: string) { return role === "owner" || role === "admin"; }

  private async read(tx: Tx, rows: ProjectRow[], userId: string, role: string): Promise<CloudProjectView[]> {
    if (!rows.length) return [];
    const repositories = (await tx.query<RepositoryRow>(
      "SELECT * FROM cloud_project_repositories WHERE project_id = ANY($1::uuid[]) ORDER BY project_id, position", [rows.map(row => row.id)])).rows;
    return rows.map(row => ({
      id: row.id, organizationId: row.org_id, name: row.name, level: row.level, ownerUserId: row.owner_user_id,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      canEdit: row.level === "personal" ? row.owner_user_id === userId : this.admin(role),
      repositories: repositories.filter(entry => entry.project_id === row.id).map(entry => ({
        repository: entry.repository, repositoryId: entry.repository_id, connectionId: entry.connection, defaultBranch: entry.default_branch,
        setup: entry.setup, setupScript: entry.setup_script, position: entry.position })),
    }));
  }

  /** The organization's projects, then the caller's own; nobody else's personal ones. */
  async list(organizationId: string, userId: string): Promise<CloudProjectView[]> {
    return this.tx(async tx => {
      const { role } = await this.member(tx, organizationId, userId);
      const { rows } = await tx.query<ProjectRow>(`SELECT * FROM cloud_projects WHERE org_id=$1 AND (level='organization' OR owner_user_id=$2)
        ORDER BY (level='personal'), lower(name), id`, [organizationId, userId]);
      return this.read(tx, rows, userId, role);
    });
  }

  /** One project as the caller may see it; not found for another member's personal project. */
  async get(organizationId: string, userId: string, projectId: string): Promise<CloudProjectView> {
    return this.tx(async tx => {
      const { role } = await this.member(tx, organizationId, userId);
      const rows = (await tx.query<ProjectRow>(`SELECT * FROM cloud_projects WHERE id=$1 AND org_id=$2 AND (level='organization' OR owner_user_id=$3)`,
        [projectId, organizationId, userId])).rows;
      const [project] = await this.read(tx, rows, userId, role);
      if (!project) throw projectNotFound();
      return project;
    });
  }

  /** Projects whose repositories include one of these, as the caller sees them (a connection's "used by"). */
  async usedBy(organizationId: string, userId: string, repositoryIds: readonly string[]): Promise<Map<string, { id: string; name: string }[]>> {
    return this.tx(async tx => {
      await this.member(tx, organizationId, userId);
      const { rows } = await tx.query<{ repository_id: string; id: string; name: string }>(
        `SELECT r.repository_id, p.id, p.name FROM cloud_project_repositories r JOIN cloud_projects p ON p.id=r.project_id
         WHERE p.org_id=$1 AND (p.level='organization' OR p.owner_user_id=$2) AND r.repository_id = ANY($3::text[]) ORDER BY lower(p.name)`,
        [organizationId, userId, [...repositoryIds]]);
      const used = new Map<string, { id: string; name: string }[]>();
      for (const row of rows) used.set(row.repository_id, [...used.get(row.repository_id) ?? [], { id: row.id, name: row.name }]);
      return used;
    });
  }

  async create(organizationId: string, userId: string, input: { name: string; level: CloudProjectLevel; repositories: CloudProjectRepositoryInput[] },
    inside?: Tx): Promise<CloudProjectView> {
    const projectName = name.parse(input.name), repositories = this.repositories(input.repositories);
    return this.within(inside, async tx => {
      const member = await this.member(tx, organizationId, userId, true);
      if (input.level === "organization") {
        if (!this.admin(member.role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
      } else {
        if (!member.personalAllowed) throw personalProjectsForbidden();
        const count = Number((await tx.query<{ n: string }>(
          "SELECT count(*) AS n FROM cloud_projects WHERE org_id=$1 AND level='personal' AND owner_user_id=$2", [organizationId, userId])).rows[0]!.n);
        if (count >= PERSONAL_PROJECT_LIMIT) throw personalProjectLimit();
      }
      const connections = await this.connections(tx, organizationId, userId, input.level, repositories);
      const id = randomUUID();
      try {
        await tx.query("SAVEPOINT project_name");
        await tx.query(`INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, organizationId, projectName, input.level, input.level === "personal" ? userId : null, userId]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw projectNameTaken();
        throw error;
      }
      await this.writeRepositories(tx, id, repositories, connections);
      if (input.level === "organization") await this.moved(tx, organizationId);
      return (await this.read(tx, [(await tx.query<ProjectRow>("SELECT * FROM cloud_projects WHERE id=$1", [id])).rows[0]!], userId, member.role))[0]!;
    });
  }

  /** Owners and admins edit an organization project; only its member edits a personal one. */
  async update(organizationId: string, userId: string, projectId: string, input: { name?: string; repositories?: CloudProjectRepositoryInput[] },
    inside?: Tx): Promise<{ project: CloudProjectView; change: CloudProjectChange }> {
    const projectName = input.name === undefined ? undefined : name.parse(input.name);
    const repositories = input.repositories === undefined ? undefined : this.repositories(input.repositories);
    return this.within(inside, async tx => {
      const member = await this.member(tx, organizationId, userId, true);
      const row = await this.editable(tx, organizationId, userId, projectId, member.role);
      let change: CloudProjectChange = null;
      if (projectName !== undefined && projectName !== row.name) {
        try {
          await tx.query("SAVEPOINT project_name");
          await tx.query("UPDATE cloud_projects SET name=$2, updated_at=clock_timestamp() WHERE id=$1", [projectId, projectName]);
        } catch (error) {
          if ((error as { code?: string }).code === "23505") throw projectNameTaken();
          throw error;
        }
      }
      if (repositories) {
        const before = (await tx.query<RepositoryRow>("SELECT * FROM cloud_project_repositories WHERE project_id=$1 ORDER BY position", [projectId])).rows;
        const connections = await this.connections(tx, organizationId, userId, row.level, repositories);
        const same = (a: RepositoryRow, b: CloudProjectRepositoryInput) => a.repository_id === b.repositoryId;
        if (before.length !== repositories.length || before.some((entry, index) => !same(entry, repositories[index]!))) change = "repositories_changed";
        else if (before.some((entry, index) => (entry.setup ?? null) !== (repositories[index]!.setup ?? null)
          || (entry.setup_script ?? null) !== (repositories[index]!.setupScript ?? null))) change = "setup_changed";
        else if (before.some((entry, index) => (entry.default_branch ?? null) !== (repositories[index]!.defaultBranch ?? null))) change = "branch_changed";
        await tx.query("DELETE FROM cloud_project_repositories WHERE project_id=$1", [projectId]);
        await this.writeRepositories(tx, projectId, repositories, connections);
        await tx.query("UPDATE cloud_projects SET updated_at=clock_timestamp() WHERE id=$1", [projectId]);
      }
      if (row.level === "organization") await this.moved(tx, organizationId);
      const fresh = (await tx.query<ProjectRow>("SELECT * FROM cloud_projects WHERE id=$1", [projectId])).rows[0]!;
      return { project: (await this.read(tx, [fresh], userId, member.role))[0]!, change };
    });
  }

  async remove(organizationId: string, userId: string, projectId: string, inside?: Tx): Promise<void> {
    await this.within(inside, async tx => {
      const member = await this.member(tx, organizationId, userId, true);
      const row = await this.editable(tx, organizationId, userId, projectId, member.role);
      // Its ready copies are provider receipts: retired, so cleanup deletes their machines.
      await tx.query(`UPDATE cloud_v2_ready_copies SET state=CASE WHEN state='building' THEN 'failed' ELSE 'retired' END,
        failure_reason=CASE WHEN state='building' THEN 'project_removed' ELSE failure_reason END, updated_at=clock_timestamp()
        WHERE id IN (SELECT id FROM cloud_v2_ready_copies WHERE project_id=$1 AND state IN ('building','ready') ORDER BY id FOR UPDATE)`, [projectId]);
      await tx.query("DELETE FROM cloud_projects WHERE id=$1", [projectId]);
      if (row.level === "organization") await this.moved(tx, organizationId);
    });
  }

  /** "Share with <organization>": an admin moves their own personal project to the
   * organization, once every repository is reachable through an organization connection.
   * Workspaces already created from it stay theirs and private. */
  async share(organizationId: string, userId: string, projectId: string): Promise<CloudProjectView> {
    return this.tx(async tx => {
      const member = await this.member(tx, organizationId, userId, true);
      if (!this.admin(member.role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
      const row = (await tx.query<ProjectRow>(`SELECT * FROM cloud_projects WHERE id=$1 AND org_id=$2 AND level='personal' AND owner_user_id=$3 FOR UPDATE`,
        [projectId, organizationId, userId])).rows[0];
      if (!row) throw projectNotFound();
      const repositories = (await tx.query<RepositoryRow>("SELECT * FROM cloud_project_repositories WHERE project_id=$1 ORDER BY position", [projectId])).rows;
      const connections = await this.connections(tx, organizationId, userId, "organization", repositories.map(entry => ({
        repository: entry.repository, repositoryId: entry.repository_id, connectionId: null })));
      try {
        await tx.query("SAVEPOINT project_name");
        await tx.query("UPDATE cloud_projects SET level='organization', owner_user_id=NULL, updated_at=clock_timestamp() WHERE id=$1", [projectId]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw projectNameTaken();
        throw error;
      }
      for (const [index, entry] of repositories.entries())
        await tx.query("UPDATE cloud_project_repositories SET connection=$3 WHERE project_id=$1 AND repository_id=$2", [projectId, entry.repository_id, connections[index]]);
      await this.moved(tx, organizationId);
      // Its copy was its member's: rebuilt through the organization's connection.
      await tx.query(`UPDATE cloud_v2_ready_copies SET stale=true, updated_at=clock_timestamp()
        WHERE id IN (SELECT id FROM cloud_v2_ready_copies WHERE project_id=$1 AND state='ready' ORDER BY id FOR UPDATE)`, [projectId]);
      return (await this.read(tx, [(await tx.query<ProjectRow>("SELECT * FROM cloud_projects WHERE id=$1", [projectId])).rows[0]!], userId, member.role))[0]!;
    });
  }

  /** Released desktops and one-repository creates: the project that is exactly
   * this repository, the organization's first, then the caller's own. */
  async forRepository(organizationId: string, userId: string, repository: string): Promise<CloudProjectView | null> {
    return this.tx(async tx => {
      const { role } = await this.member(tx, organizationId, userId);
      const rows = (await tx.query<ProjectRow>(`SELECT p.* FROM cloud_projects p JOIN cloud_project_repositories r ON r.project_id=p.id
        WHERE p.org_id=$1 AND (p.level='organization' OR p.owner_user_id=$2) AND r.repository=lower($3)
          AND (SELECT count(*) FROM cloud_project_repositories c WHERE c.project_id=p.id) = 1
        ORDER BY (p.level='personal'), p.created_at, p.id LIMIT 1`, [organizationId, userId, repository])).rows;
      return (await this.read(tx, rows, userId, role))[0] ?? null;
    });
  }

  /** One-repository projects as the old Cloud Computer recipe: organization ones
   * for the recipe, plus the caller's own for the repository list. Multi-repository
   * projects are never offered to released desktops. */
  async oneRepositoryProjects(organizationId: string, userId: string | null, inside?: Tx): Promise<CloudProject[]> {
    return this.within(inside, async tx => {
      const rows = (await tx.query<ProjectRow>(`SELECT p.* FROM cloud_projects p WHERE p.org_id=$1 AND (p.level='organization' OR p.owner_user_id=$2)
        AND (SELECT count(*) FROM cloud_project_repositories c WHERE c.project_id=p.id) = 1 ORDER BY (p.level='personal'), p.created_at, p.id`,
        [organizationId, userId])).rows;
      return this.read(tx, rows, userId ?? "", "member");
    });
  }

  /** A released desktop's admin saved the recipe: it is the set of one-repository
   * organization projects. Entries become or update such projects; ones no longer
   * listed are removed. One transaction under the organization lock: the save is
   * checked against the revision its editor was shown, then moves it. Without a
   * revision (the oldest clients' build request) nothing is removed. Returns the
   * projects whose copy must be rebuilt and the new revision. */
  async syncRecipe(organizationId: string, userId: string, entries: readonly { repository: string; repositoryId: string; ref?: string; setup?: string; setupScript?: string }[],
    revision: number | null): Promise<{ changed: { projectId: string; change: Exclude<CloudProjectChange, null> }[]; revision: number }> {
    return this.tx(async tx => {
      const member = await this.member(tx, organizationId, userId, true);
      if (!this.admin(member.role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
      const shown = async () => Number((await tx.query<{ revision: string }>(
        "SELECT recipe_revision::text AS revision FROM cloud_v2_computers WHERE org_id=$1 FOR UPDATE", [organizationId])).rows[0]?.revision ?? 0);
      if (revision !== null && await shown() !== revision) throw recipeChanged();
      const current = (await this.oneRepositoryProjects(organizationId, null, tx)).filter(project => project.level === "organization");
      const changed: { projectId: string; change: Exclude<CloudProjectChange, null> }[] = [];
      for (const entry of entries) {
        const repositories = [{ repository: entry.repository, repositoryId: entry.repositoryId, defaultBranch: entry.ref ?? null, setup: entry.setup ?? null,
          setupScript: entry.setupScript ?? null }];
        const existing = current.find(project => project.repositories[0]!.repositoryId === entry.repositoryId);
        if (existing) {
          const { change } = await this.update(organizationId, userId, existing.id, { repositories }, tx);
          if (change) changed.push({ projectId: existing.id, change });
        } else {
          const project = await this.create(organizationId, userId, { name: await this.freeName(tx, organizationId, entry.repository), level: "organization",
            repositories }, tx);
          changed.push({ projectId: project.id, change: "project_created" });
        }
      }
      if (revision !== null)
        for (const project of current)
          if (!entries.some(entry => entry.repositoryId === project.repositories[0]!.repositoryId)) await this.remove(organizationId, userId, project.id, tx);
      await this.moved(tx, organizationId);
      return { changed, revision: await shown() };
    });
  }

  /** A project name from a repository: its name, or owner/name when that is taken. */
  private async freeName(tx: Tx, organizationId: string, repository: string): Promise<string> {
    const [repoOwner, repoName] = repository.split("/") as [string, string];
    const taken = (await tx.query("SELECT 1 FROM cloud_projects WHERE org_id=$1 AND level='organization' AND lower(name)=lower($2)",
      [organizationId, repoName])).rowCount;
    return taken ? `${repoOwner}/${repoName}` : repoName;
  }

  private repositories(input: readonly CloudProjectRepositoryInput[]): CloudProjectRepositoryInput[] {
    const parsed = z.array(CloudProjectRepositoryInputSchema).min(1).parse(input);
    if (parsed.length > PROJECT_REPOSITORY_LIMIT) throw projectRepositoryLimit();
    if (new Set(parsed.map(entry => entry.repositoryId)).size !== parsed.length)
      throw new HttpError(422, "invalid_input", "Each repository can be in a project once.");
    return parsed.map(entry => ({ ...entry, repository: entry.repository.toLowerCase() }));
  }

  /** The connection each repository is built through. An organization project's
   * must be an active organization connection for the repository's owner. */
  private async connections(tx: Tx, organizationId: string, userId: string, level: CloudProjectLevel, repositories: readonly CloudProjectRepositoryInput[]): Promise<(string | null)[]> {
    const ids: (string | null)[] = [];
    for (const entry of repositories) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM cloud_github_installations WHERE org_id=$1 AND lower(account_login)=$2
           AND (level='organization' OR ($5 AND owner_user_id=$3::uuid)) AND ($4::uuid IS NULL OR id=$4)
           AND (level='personal' OR state='active')
         ORDER BY (level='organization') DESC, (installation_id IS NOT NULL) DESC LIMIT 1`,
        [organizationId, owner(entry.repository), userId, entry.connectionId ?? null, level === "personal"]);
      if (!rows[0] && level === "organization") throw repositoryUnreachable(entry.repository);
      ids.push(rows[0]?.id ?? null);
    }
    return ids;
  }

  private async writeRepositories(tx: Tx, projectId: string, repositories: readonly CloudProjectRepositoryInput[], connections: readonly (string | null)[]): Promise<void> {
    for (const [position, entry] of repositories.entries())
      await tx.query(`INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id, connection, default_branch, setup, setup_script)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [projectId, position, entry.repository, entry.repositoryId, connections[position] ?? null,
        entry.defaultBranch ?? null, entry.setup || null, entry.setupScript || null]);
  }

  private async editable(tx: Tx, organizationId: string, userId: string, projectId: string, role: string): Promise<ProjectRow> {
    const row = (await tx.query<ProjectRow>(`SELECT * FROM cloud_projects WHERE id=$1 AND org_id=$2 AND (level='organization' OR owner_user_id=$3) FOR UPDATE`,
      [projectId, organizationId, userId])).rows[0];
    if (!row) throw projectNotFound();
    if (row.level === "organization" && !this.admin(role)) throw new HttpError(403, "forbidden", "Requires an owner or admin");
    return row;
  }
}

// ── Data migration ─────────────────────────────────────────

export type CloudProjectsMigration = { organizations: number; connections: number; projects: number };

/** Each repository on an organization's live Cloud Computer becomes a
 * one-repository organization project named after it, with the recipe's branch
 * and setup, under an organization connection for its owner that waits for its
 * installation ID. Members' cloud GitHub sign-ins are untouched. Idempotent and
 * data only; every row is marked migrated, so revertProjectsMigration undoes it
 * until ready copies are on. (Task 4B's private repository entries never
 * reached a database, so there are none to carry over.) */
export async function migrateProjects(pool: pg.Pool, options: { dryRun?: boolean } = {}): Promise<CloudProjectsMigration> {
  return withSystemTx(pool, async tx => {
    const { rows } = await tx.query<{ org_id: string; created_by: string | null; recipe: { repositories?: { repository: string; ref?: string; setup?: string; setupScript?: string }[] };
      configured: { repositories?: { repository: string; ref?: string; setup?: string; setupScript?: string }[] } | null; targets: unknown }>(
      `SELECT c.org_id, b.created_by, b.recipe, c.recipe AS configured, b.source_targets AS targets FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id=c.active_build_id AND b.org_id=c.org_id AND b.state='succeeded' AND b.source_targets IS NOT NULL
       JOIN organizations o ON o.id=c.org_id AND o.deleted_at IS NULL ORDER BY c.org_id`);
    const result: CloudProjectsMigration = { organizations: 0, connections: 0, projects: 0 };
    for (const row of rows) {
      const targets = z.array(z.object({ repository: repositoryName, repositoryId })).safeParse(row.targets);
      if (!targets.success || !targets.data.length) continue;
      result.organizations++;
      for (const account of [...new Set(targets.data.map(target => owner(target.repository)))]) {
        const existing = (await tx.query("SELECT 1 FROM cloud_github_installations WHERE org_id=$1 AND level='organization' AND lower(account_login)=$2",
          [row.org_id, account])).rowCount;
        if (existing) continue;
        result.connections++;
        if (!options.dryRun) await tx.query(`INSERT INTO cloud_github_installations (id, org_id, account_login, level, added_by, migrated)
          VALUES ($1,$2,$3,'organization',$4,true) ON CONFLICT DO NOTHING`, [randomUUID(), row.org_id, account, row.created_by]);
      }
      const entries = row.recipe.repositories ?? [];
      for (const [index, target] of targets.data.entries()) {
        const present = (await tx.query(`SELECT 1 FROM cloud_projects p JOIN cloud_project_repositories r ON r.project_id=p.id
          WHERE p.org_id=$1 AND p.level='organization' AND r.repository_id=$2
            AND (SELECT count(*) FROM cloud_project_repositories c WHERE c.project_id=p.id)=1`, [row.org_id, target.repositoryId])).rowCount;
        if (present) continue;
        result.projects++;
        if (options.dryRun) continue;
        const configured = row.configured?.repositories?.find(entry => entry.repository.toLowerCase() === target.repository.toLowerCase());
        const entry = configured ?? entries[index];
        const [repoOwner, repoName] = target.repository.toLowerCase().split("/") as [string, string];
        const taken = (await tx.query("SELECT 1 FROM cloud_projects WHERE org_id=$1 AND level='organization' AND lower(name)=$2", [row.org_id, repoName])).rowCount;
        const id = randomUUID();
        // One timestamp for both: revertProjectsMigration reads updated_at=created_at as "nobody edited it".
        await tx.query(`INSERT INTO cloud_projects (id, org_id, name, level, created_by, migrated, created_at, updated_at)
          VALUES ($1,$2,$3,'organization',$4,true,now(),now())`,
          [id, row.org_id, taken ? `${repoOwner}/${repoName}` : repoName, row.created_by]);
        const connection = (await tx.query<{ id: string }>(`SELECT id FROM cloud_github_installations WHERE org_id=$1 AND level='organization'
          AND lower(account_login)=$2 ORDER BY (installation_id IS NOT NULL) DESC LIMIT 1`, [row.org_id, repoOwner])).rows[0];
        await tx.query(`INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id, connection, default_branch, setup, setup_script)
          VALUES ($1,0,$2,$3,$4,$5,$6,$7)`, [id, target.repository.toLowerCase(), target.repositoryId, connection?.id ?? null,
          entry?.ref ?? null, entry?.setup || null, entry?.setupScript || null]);
      }
    }
    return result;
  });
}

/** Removes only what migrateProjects added and nobody changed since. */
export async function revertProjectsMigration(pool: pg.Pool): Promise<{ connections: number; projects: number }> {
  return withSystemTx(pool, async tx => {
    const projects = await tx.query("DELETE FROM cloud_projects WHERE migrated AND updated_at=created_at");
    const connections = await tx.query(`DELETE FROM cloud_github_installations i WHERE migrated AND installation_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM cloud_project_repositories r WHERE r.connection=i.id)`);
    return { connections: connections.rowCount ?? 0, projects: projects.rowCount ?? 0 };
  });
}
