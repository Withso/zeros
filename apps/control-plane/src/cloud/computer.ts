// Cloud Computer builds. Each organization has exactly one live Boat named
// snapshot: its active build, with the org's repositories cloned to
// /home/user/<owner>/<name> and their setup run. Every build is kept here as
// a recipe; activating an older one rebuilds it at the same commits.
//
// Admins edit a configured recipe; a build turns it into the live snapshot,
// and the two differ while changes are unbuilt. A build refreshes the
// previous snapshot in place when there is one: existing checkouts fetch and
// keep their installed dependencies, new repositories are cloned and removed
// ones deleted. The snapshot is refreshed by itself when the worker runtime
// changes, and once a day while the organization uses cloud workspaces.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudV2Compute } from "./boat.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import { cloudV2SandboxName, cloudV2SnapshotName } from "./resource-names.js";
export { cloudV2SnapshotName } from "./resource-names.js";

const MAX_LOG_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 60_000;
/** A build whose server stopped (a deploy, a crash) is failed after this. */
const INTERRUPTED_AFTER = "5 minutes";
/** One build per process: each holds a dedicated advisory-lock connection for
 * its whole run, and the worker pool has only two connections. A second
 * concurrent build would starve the lifecycle and its own queries. */
const BUILD_CONCURRENCY = 1;
/** How often the builder looks for snapshots to refresh by themselves. */
const REFRESH_SCAN_MS = 10 * 60_000;

const repository = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  // Each part names a directory under /home/user; "." and ".." would leave it.
  .refine(value => value.split("/").every(part => part !== "." && part !== ".."), "Invalid repository");
const unique = (rows: readonly { repository: string }[]) =>
  new Set(rows.map(row => row.repository.toLowerCase())).size === rows.length;
const editable = {
  repository,
  /** Branch or tag to clone; a rebuild pins `commit` instead. Never an option. */
  ref: z.string().min(1).max(255).refine(value => !value.startsWith("-"), "Invalid branch or tag").optional(),
  /** Non-interactive bash run in the checkout as the workspace user, e.g. "pnpm install". */
  setup: z.string().max(8_000).optional(),
};
export const CloudV2RecipeSchema = z.object({
  repositories: z.array(z.object({
    ...editable,
    commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    /** Verified remote branch observed after cloning, or origin's default for a tag. */
    branch: z.string().min(1).max(255).optional(),
  }).strict()).min(1).max(10).refine(unique, "Each repository can be installed once"),
  rebuiltFrom: z.number().int().positive().optional(),
}).strict();
export type CloudV2Recipe = z.infer<typeof CloudV2RecipeSchema>;
type RecipeEntry = CloudV2Recipe["repositories"][number];

/** What an admin edits: repositories and how to set them up, never build outputs. */
export const CloudV2RepositoryDraftSchema = z.object(editable).strict();
export type CloudV2RepositoryDraft = z.infer<typeof CloudV2RepositoryDraftSchema>;
export const CloudV2DraftSchema = z.array(CloudV2RepositoryDraftSchema).max(10).refine(unique, "Each repository can be installed once");

/** The editable part of a recipe, in its order. */
export function editableRepositories(recipe: { repositories?: readonly Partial<RecipeEntry>[] } | null | undefined): CloudV2RepositoryDraft[] {
  return (recipe?.repositories ?? []).flatMap(({ repository, ref, setup }) =>
    typeof repository === "string" ? [{ repository, ...(ref ? { ref } : {}), ...(setup ? { setup } : {}) }] : []);
}

export type CloudV2BuildReason = "manual" | "reactivate" | "runtime" | "refresh";
export type CloudV2Build = {
  id: string; organizationId: string; version: number; recipe: CloudV2Recipe;
  state: "queued" | "building" | "succeeded" | "failed" | "cancelled";
  builderSandboxId: string | null; snapshotId: string | null; errorCode: string | null; createdBy: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  reason: CloudV2BuildReason; baseSnapshot: string | null; runtimeSha256: string | null;
};
export type CloudV2ComputerOverview = {
  activeBuildId: string | null; snapshotName: string | null; builds: CloudV2Build[];
  /** The configured repositories; equal to the active build's until an admin edits them. */
  recipe: { repositories: CloudV2RepositoryDraft[] };
  recipeRevision: number;
};
export type CloudV2RefreshCandidate = {
  organizationId: string; createdBy: string; recipe: CloudV2Recipe;
  /** The live build this candidate was read from; a newer one makes it stale. */
  activeBuildId: string;
  /** The live snapshot caches a runtime other than the one workspaces need. */
  runtimeStale: boolean;
  /** A daily refresh is due: an older build, recent cloud use, nothing built today. */
  refreshDue: boolean;
};

type Row = {
  id: string; org_id: string; version: number; recipe: CloudV2Recipe; state: CloudV2Build["state"];
  builder_sandbox_id: string | null; snapshot_id: string | null; error_code: string | null; created_by: string | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
  reason: CloudV2BuildReason; base_snapshot: string | null; runtime_sha256: string | null;
};
type Resources = Row & {
  cleanup_requested_at: Date | null; builder_create_pending: boolean; builder_deleted_at: Date | null;
  snapshot_deleted_at: Date | null; operation_until: Date | null; active: boolean; pinned: boolean;
};
const COLUMNS = "id, org_id, version, recipe, state, builder_sandbox_id, snapshot_id, error_code, created_by, created_at, started_at, finished_at, reason, base_snapshot, runtime_sha256";
const build = (row: Row): CloudV2Build => ({
  id: row.id, organizationId: row.org_id, version: row.version, recipe: row.recipe, state: row.state,
  builderSandboxId: row.builder_sandbox_id, snapshotId: row.snapshot_id, errorCode: row.error_code, createdBy: row.created_by,
  createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null,
  reason: row.reason, baseSnapshot: row.base_snapshot, runtimeSha256: row.runtime_sha256,
});

const recipeChanged = () => new HttpError(409, "computer_recipe_changed", "The Cloud Computer changed. Review the latest version and try again.");

function notFound(error: unknown): boolean {
  const value = error as { code?: unknown; httpStatus?: unknown } | null;
  return typeof value === "object" && value !== null && (value.httpStatus === 404 || value.code === "provider_not_found");
}

export class CloudV2Computers {
  constructor(private readonly pool: pg.Pool) {}

  private async memberRole(organizationId: string, userId: string): Promise<string> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ role: string }>(
      `SELECT m.role FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.user_id = $2 AND NOT o.is_personal AND o.cloud_workspaces_allowed`, [organizationId, userId]));
    if (!rows[0]) throw new HttpError(404, "not_found", "Organization not found");
    return rows[0].role;
  }

  async requireMember(organizationId: string, userId: string): Promise<void> {
    await this.memberRole(organizationId, userId);
  }

  async requireAdmin(organizationId: string, userId: string): Promise<void> {
    const role = await this.memberRole(organizationId, userId);
    if (role !== "owner" && role !== "admin") throw new HttpError(403, "forbidden", "Requires an owner or admin");
  }

  async overview(organizationId: string): Promise<CloudV2ComputerOverview> {
    return withSystemTx(this.pool, async tx => {
      const computer = (await tx.query<{ active_build_id: string | null; snapshot_name: string | null; recipe: { repositories?: unknown } | null; recipe_revision: string }>(
        `SELECT active_build_id, snapshot_name, recipe, recipe_revision::text FROM cloud_v2_computers WHERE org_id = $1`, [organizationId])).rows[0];
      const builds = (await tx.query<Row>(
        `SELECT ${COLUMNS} FROM cloud_v2_computer_builds WHERE org_id = $1 ORDER BY version DESC LIMIT 50`, [organizationId])).rows;
      return {
        activeBuildId: computer?.active_build_id ?? null, snapshotName: computer?.snapshot_name ?? null, builds: builds.map(build),
        recipe: { repositories: await this.configured(tx, organizationId, computer?.recipe ?? null, computer?.active_build_id ?? null) },
        recipeRevision: Number(computer?.recipe_revision ?? 0),
      };
    });
  }

  /** The configured repositories: the stored edit, else the active build's. */
  private async configured(tx: Tx, organizationId: string, stored: { repositories?: unknown } | null, activeBuildId: string | null): Promise<CloudV2RepositoryDraft[]> {
    if (stored) {
      const parsed = CloudV2DraftSchema.safeParse(stored.repositories);
      if (parsed.success) return parsed.data;
    }
    if (!activeBuildId) return [];
    const { rows } = await tx.query<{ recipe: CloudV2Recipe }>(
      `SELECT recipe FROM cloud_v2_computer_builds WHERE id = $1 AND org_id = $2`, [activeBuildId, organizationId]);
    return editableRepositories(rows[0]?.recipe);
  }

  private async lockOrganization(tx: Tx, organizationId: string): Promise<void> {
    const owner = await tx.query(`SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL AND lifecycle_status='active' FOR UPDATE`, [organizationId]);
    if (!owner.rowCount) throw new HttpError(404, "not_found", "Organization not found");
  }

  private async writeConfigured(tx: Tx, organizationId: string, userId: string | null, repositories: CloudV2RepositoryDraft[] | null, revision: number): Promise<void> {
    await tx.query(
      `INSERT INTO cloud_v2_computers (org_id, recipe, recipe_revision, recipe_updated_by, recipe_updated_at)
       VALUES ($1, $2, $3, $4, clock_timestamp())
       ON CONFLICT (org_id) DO UPDATE SET recipe = EXCLUDED.recipe, recipe_revision = EXCLUDED.recipe_revision,
         recipe_updated_by = EXCLUDED.recipe_updated_by, recipe_updated_at = EXCLUDED.recipe_updated_at`,
      [organizationId, repositories ? JSON.stringify({ repositories }) : null, revision, userId]);
  }

  /** Saves the configured repositories. `revision` is the one the editor saw. */
  async saveRecipe(organizationId: string, userId: string, repositories: readonly CloudV2RepositoryDraft[], revision: number):
    Promise<{ recipe: { repositories: CloudV2RepositoryDraft[] }; recipeRevision: number }> {
    const parsed = CloudV2DraftSchema.parse(repositories);
    return withSystemTx(this.pool, async tx => {
      await this.lockOrganization(tx, organizationId);
      const current = Number((await tx.query<{ recipe_revision: string }>(
        `SELECT recipe_revision::text FROM cloud_v2_computers WHERE org_id = $1 FOR UPDATE`, [organizationId])).rows[0]?.recipe_revision ?? 0);
      if (current !== revision) throw recipeChanged();
      await this.writeConfigured(tx, organizationId, userId, parsed, current + 1);
      return { recipe: { repositories: parsed }, recipeRevision: current + 1 };
    });
  }

  /** Returns the configured repositories to the active build's. */
  async discardRecipe(organizationId: string, userId: string, revision: number):
    Promise<{ recipe: { repositories: CloudV2RepositoryDraft[] }; recipeRevision: number }> {
    return withSystemTx(this.pool, async tx => {
      await this.lockOrganization(tx, organizationId);
      const computer = (await tx.query<{ recipe_revision: string; active_build_id: string | null }>(
        `SELECT recipe_revision::text, active_build_id FROM cloud_v2_computers WHERE org_id = $1 FOR UPDATE`, [organizationId])).rows[0];
      const current = Number(computer?.recipe_revision ?? 0);
      if (current !== revision) throw recipeChanged();
      await this.writeConfigured(tx, organizationId, userId, null, current + 1);
      return { recipe: { repositories: await this.configured(tx, organizationId, null, computer?.active_build_id ?? null) }, recipeRevision: current + 1 };
    });
  }

  /** Queues a build; one build at a time per organization. It refreshes the
   * live snapshot when there is one. `configure` also makes this recipe the
   * configured one, for older apps and for activating an earlier build. */
  async enqueue(organizationId: string, userId: string, recipe: CloudV2Recipe,
    options: { reason?: CloudV2BuildReason; configure?: boolean; runtimeSha256?: string } = {}): Promise<CloudV2Build> {
    const parsed = CloudV2RecipeSchema.parse(recipe);
    return withSystemTx(this.pool, tx => this.insertBuild(tx, organizationId, userId, parsed, options));
  }

  private async insertBuild(tx: Tx, organizationId: string, userId: string, recipe: CloudV2Recipe,
    options: { reason?: CloudV2BuildReason; configure?: boolean; runtimeSha256?: string; revision?: number }): Promise<CloudV2Build> {
    await this.lockOrganization(tx, organizationId);
    const busy = await tx.query(`SELECT 1 FROM cloud_v2_computer_builds WHERE org_id = $1 AND state IN ('queued','building')`, [organizationId]);
    if (busy.rowCount) throw new HttpError(409, "computer_build_in_progress", "A Cloud Computer build is already running");
    const computer = (await tx.query<{ snapshot_name: string | null; recipe_revision: string; active_build_id: string | null }>(
      `SELECT snapshot_name, recipe_revision::text, active_build_id FROM cloud_v2_computers WHERE org_id = $1 FOR UPDATE`, [organizationId])).rows[0];
    return this.insertLocked(tx, organizationId, userId, recipe, computer, options);
  }

  private async insertLocked(tx: Tx, organizationId: string, userId: string, recipe: CloudV2Recipe,
    computer: { snapshot_name: string | null; recipe_revision: string } | undefined,
    options: { reason?: CloudV2BuildReason; configure?: boolean; runtimeSha256?: string; revision?: number }): Promise<CloudV2Build> {
    const revision = Number(computer?.recipe_revision ?? 0);
    if (options.revision !== undefined && options.revision !== revision) throw recipeChanged();
    const { rows } = await tx.query<Row>(
      `INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, base_snapshot, runtime_sha256)
       VALUES ($1, $2, coalesce((SELECT max(version) FROM cloud_v2_computer_builds WHERE org_id = $2), 0) + 1, $3, 'queued', $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [randomUUID(), organizationId, JSON.stringify(recipe), userId, options.reason ?? "manual", computer?.snapshot_name ?? null, options.runtimeSha256 ?? null],
    );
    if (options.configure) await this.writeConfigured(tx, organizationId, userId, editableRepositories(recipe), revision + 1);
    return build(rows[0]!);
  }

  /** Builds the configured repositories as the editor saw them at `revision`. */
  async buildConfigured(organizationId: string, userId: string, revision: number): Promise<CloudV2Build> {
    return withSystemTx(this.pool, async tx => {
      await this.lockOrganization(tx, organizationId);
      const computer = (await tx.query<{ recipe: { repositories?: unknown } | null; active_build_id: string | null }>(
        `SELECT recipe, active_build_id FROM cloud_v2_computers WHERE org_id = $1 FOR UPDATE`, [organizationId])).rows[0];
      const repositories = await this.configured(tx, organizationId, computer?.recipe ?? null, computer?.active_build_id ?? null);
      if (!repositories.length) throw new HttpError(409, "computer_recipe_empty", "Add a repository to the Cloud Computer first");
      return this.insertBuild(tx, organizationId, userId, CloudV2RecipeSchema.parse({ repositories }), { revision });
    });
  }

  /** Re-activating an older build rebuilds its recipe at the commits it used. */
  async reactivate(organizationId: string, userId: string, buildId: string): Promise<CloudV2Build> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_computer_builds WHERE id = $1 AND org_id = $2 AND state = 'succeeded'`, [buildId, organizationId]));
    const source = rows[0];
    if (!source) throw new HttpError(404, "not_found", "Cloud Computer build not found");
    return this.enqueue(organizationId, userId, { ...source.recipe, rebuiltFrom: source.version }, { reason: "reactivate", configure: true });
  }

  /** Queues a refresh nobody asked for, of exactly the live build it was
   * scheduled from: its recipe is read under the same lock as the base, so a
   * build that became live meanwhile is never relabelled or rolled back. Null
   * when the organization is busy, gone, or its live build changed. */
  async enqueueAutomatic(organizationId: string, expectedActiveBuildId: string, reason: "runtime" | "refresh", runtimeSha256?: string): Promise<CloudV2Build | null> {
    try {
      return await withSystemTx(this.pool, async tx => {
        await this.lockOrganization(tx, organizationId);
        const busy = await tx.query(`SELECT 1 FROM cloud_v2_computer_builds WHERE org_id = $1 AND state IN ('queued','building')`, [organizationId]);
        if (busy.rowCount) return null;
        const live = (await tx.query<{ snapshot_name: string | null; recipe_revision: string; recipe: CloudV2Recipe; created_by: string | null }>(
          `SELECT c.snapshot_name, c.recipe_revision::text, b.recipe, b.created_by FROM cloud_v2_computers c
           JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id AND b.state = 'succeeded'
           WHERE c.org_id = $1 AND c.active_build_id = $2 AND c.snapshot_name IS NOT NULL
           FOR UPDATE OF c`, [organizationId, expectedActiveBuildId])).rows[0];
        if (!live?.created_by) return null;
        // A runtime refresh keeps the live commits; a daily one moves to the refs' tips.
        const recipe = CloudV2RecipeSchema.parse(reason === "runtime" ? live.recipe : unpinned(live.recipe));
        return this.insertLocked(tx, organizationId, live.created_by, recipe, live, { reason, ...(runtimeSha256 ? { runtimeSha256 } : {}) });
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** Defers the daily refresh check: a day when nothing moved, an hour when
   * GitHub could not answer, so unreadable organizations rotate too. */
  async deferRefresh(organizationId: string, activeBuildId: string, outcome: "unchanged" | "unknown"): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computers SET refresh_next_at = clock_timestamp() + CASE WHEN $3 = 'unchanged' THEN interval '24 hours' ELSE interval '1 hour' END
       WHERE org_id = $1 AND active_build_id = $2`, [organizationId, activeBuildId, outcome]));
  }

  /** Live snapshots due a refresh by themselves, oldest first. Eligibility is
   * decided before the limit, so computers with nothing due never crowd out
   * one that is; a deferred computer waits until its next check. */
  async refreshCandidates(runtimeSha256: string, limit = 25): Promise<CloudV2RefreshCandidate[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ org_id: string; active_build_id: string; created_by: string; recipe: CloudV2Recipe; runtime_stale: boolean; refresh_due: boolean }>(
      `SELECT * FROM (SELECT c.org_id, c.active_build_id, b.created_by, b.recipe, b.finished_at, c.refresh_next_at,
         (b.runtime_sha256 IS NOT NULL AND b.runtime_sha256 <> $1
           AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds f WHERE f.org_id = c.org_id AND f.reason = 'runtime'
             AND f.runtime_sha256 = $1 AND f.state IN ('failed','cancelled') AND f.created_at > clock_timestamp() - interval '6 hours')
           AND (SELECT count(*) FROM cloud_v2_computer_builds f WHERE f.org_id = c.org_id AND f.reason = 'runtime'
             AND f.runtime_sha256 = $1 AND f.state IN ('failed','cancelled')) < 3) AS runtime_stale,
         (b.finished_at < clock_timestamp() - interval '24 hours'
           AND (b.recipe->>'rebuiltFrom') IS NULL
           AND coalesce(c.refresh_next_at, '-infinity') <= clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds r WHERE r.org_id = c.org_id AND r.created_at > clock_timestamp() - interval '24 hours')
           AND EXISTS (SELECT 1 FROM cloud_v2_workspaces w WHERE w.org_id = c.org_id AND w.state <> 'deleted'
             AND coalesce(w.active_at, w.created_at) > clock_timestamp() - interval '7 days')) AS refresh_due
       FROM cloud_v2_computers c
       JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id AND b.state = 'succeeded'
       JOIN organizations o ON o.id = c.org_id AND o.deleted_at IS NULL AND o.lifecycle_status = 'active'
         AND NOT o.is_personal AND o.cloud_workspaces_allowed
       WHERE c.snapshot_name IS NOT NULL AND b.created_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds q WHERE q.org_id = c.org_id AND q.state IN ('queued','building'))
       ) due WHERE runtime_stale OR refresh_due
       ORDER BY runtime_stale DESC, coalesce(refresh_next_at, finished_at) NULLS FIRST, org_id LIMIT $2`, [runtimeSha256, limit]));
    return rows.map(row => ({ organizationId: row.org_id, activeBuildId: row.active_build_id, createdBy: row.created_by, recipe: row.recipe,
      runtimeStale: row.runtime_stale, refreshDue: row.refresh_due }));
  }

  /** The recipe of the build whose snapshot this build started from. */
  async baseRecipe(buildId: string): Promise<CloudV2Recipe | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ recipe: CloudV2Recipe }>(
      `SELECT base.recipe FROM cloud_v2_computer_builds b
       JOIN cloud_v2_computer_builds base ON base.org_id = b.org_id AND base.snapshot_id = b.base_snapshot
       WHERE b.id = $1 LIMIT 1`, [buildId]));
    return rows[0]?.recipe ?? null;
  }

  async setRuntime(buildId: string, runtimeSha256: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET runtime_sha256 = $2 WHERE id = $1`, [buildId, runtimeSha256]));
  }

  /** Boat no longer has the snapshot this build started from. Nothing was
   * created; the organization has no live snapshot, so the next build is clean. */
  async baseMissing(buildId: string, organizationId: string, snapshotName: string): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_v2_computer_builds SET builder_create_pending = false, operation_until = NULL WHERE id = $1`, [buildId]);
      // "As live" would become empty once the live pointer is gone: keep the
      // configured repositories by writing them out first, same revision.
      const computer = (await tx.query<{ recipe: unknown; active_build_id: string | null }>(
        `SELECT recipe, active_build_id FROM cloud_v2_computers WHERE org_id = $1 AND snapshot_name = $2 FOR UPDATE`, [organizationId, snapshotName])).rows[0];
      if (computer && computer.recipe === null && computer.active_build_id) {
        const live = await this.configured(tx, organizationId, null, computer.active_build_id);
        await tx.query(`UPDATE cloud_v2_computers SET recipe = $2 WHERE org_id = $1`, [organizationId, JSON.stringify({ repositories: live })]);
      }
      await tx.query(`UPDATE cloud_v2_computers SET active_build_id = NULL, snapshot_name = NULL, updated_at = clock_timestamp()
        WHERE org_id = $1 AND snapshot_name = $2`, [organizationId, snapshotName]);
      await tx.query(`UPDATE cloud_v2_computer_builds SET snapshot_id = NULL, snapshot_deleted_at = clock_timestamp()
        WHERE org_id = $1 AND snapshot_id = $2`, [organizationId, snapshotName]);
    });
  }

  async log(organizationId: string, buildId: string): Promise<string> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ log: string }>(
      `SELECT log FROM cloud_v2_computer_builds WHERE id = $1 AND org_id = $2`, [buildId, organizationId]));
    if (!rows[0]) throw new HttpError(404, "not_found", "Cloud Computer build not found");
    return rows[0].log;
  }

  async claim(): Promise<CloudV2Build | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `UPDATE cloud_v2_computer_builds SET state = 'building', started_at = clock_timestamp(), heartbeat_at = clock_timestamp()
       WHERE id = (SELECT b.id FROM cloud_v2_computer_builds b JOIN organizations o ON o.id=b.org_id
         WHERE b.state='queued' AND b.cleanup_requested_at IS NULL AND o.deleted_at IS NULL
         ORDER BY b.created_at LIMIT 1 FOR UPDATE OF b SKIP LOCKED)
       RETURNING ${COLUMNS}`));
    return rows[0] ? build(rows[0]) : null;
  }

  async heartbeat(buildId: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET heartbeat_at = clock_timestamp() WHERE id = $1 AND state = 'building'`, [buildId]));
  }

  /** Fails builds whose server stopped beating and returns their builders. */
  async failInterrupted(): Promise<string[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ builder_sandbox_id: string | null }>(
      `UPDATE cloud_v2_computer_builds SET state = 'failed', error_code = 'computer_build_interrupted', finished_at = clock_timestamp(),
         log = right(log || E'\\n[zeros] build interrupted; start it again\\n', ${MAX_LOG_BYTES})
       WHERE state = 'building' AND coalesce(heartbeat_at, started_at) < clock_timestamp() - interval '${INTERRUPTED_AFTER}'
       RETURNING builder_sandbox_id`));
    return rows.flatMap(row => row.builder_sandbox_id ? [row.builder_sandbox_id] : []);
  }

  async append(buildId: string, text: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET log = right(log || $2, $3) WHERE id = $1`, [buildId, text, MAX_LOG_BYTES]));
  }

  async update(buildId: string, patch: { builderSandboxId?: string; recipe?: CloudV2Recipe }): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET builder_sandbox_id = coalesce($2, builder_sandbox_id), recipe = coalesce($3::jsonb, recipe),
       builder_create_pending=CASE WHEN $2::text IS NOT NULL THEN false ELSE builder_create_pending END,
       operation_until=CASE WHEN $2::text IS NOT NULL THEN NULL ELSE operation_until END WHERE id = $1`,
      [buildId, patch.builderSandboxId ?? null, patch.recipe ? JSON.stringify(patch.recipe) : null]));
  }

  async fail(buildId: string, code: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET state = 'failed', error_code = $2, finished_at = clock_timestamp() WHERE id = $1 AND state = 'building'`,
      [buildId, code.slice(0, 64)]));
  }

  /** Makes the build live and returns the snapshot it replaced. */
  async activate(buildId: string, snapshotName: string): Promise<{ previousSnapshot: string | null }> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ org_id: string }>(
        `UPDATE cloud_v2_computer_builds SET state = 'succeeded', snapshot_id = $2, finished_at = clock_timestamp()
         WHERE id = $1 AND state = 'building' AND cleanup_requested_at IS NULL
           AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=org_id AND o.deleted_at IS NULL)
         RETURNING org_id`, [buildId, snapshotName]);
      if (!rows[0]) throw new Error("build is not running");
      const previous = (await tx.query<{ snapshot_name: string | null }>(
        `SELECT snapshot_name FROM cloud_v2_computers WHERE org_id = $1 FOR UPDATE`, [rows[0].org_id])).rows[0];
      await tx.query(
        `INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1, $2, $3)
         ON CONFLICT (org_id) DO UPDATE SET active_build_id = EXCLUDED.active_build_id, snapshot_name = EXCLUDED.snapshot_name,
           updated_at = clock_timestamp()`, [rows[0].org_id, buildId, snapshotName]);
      // The old snapshot identity stays until the provider confirms deletion.
      return { previousSnapshot: previous?.snapshot_name ?? null };
    });
  }

  /** One provider operation owner per build. Session locks do not hold a long
   * transaction or block the deletion request; cleanup tries again next tick.
   * This connection issues advisory SQL only. Every table access during work
   * uses its own withSystemTx connection and RLS context. */
  async withBuildLock(id: string, work: (assertHeld: () => void) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    let lost = false, held = false;
    const onLost = () => { lost = true; };
    client.on("error", onLost); client.on("end", onLost);
    try {
      held = (await client.query<{ held: boolean }>("/* lock_purpose='cloud-v2-computer-build' */ SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held", [`cloud-v2-build:${id}`])).rows[0]!.held;
      if (held) await work(() => { if (lost) throw new Error("Computer resource lock was lost"); });
    } finally {
      if (held && !lost) await client.query("/* lock_purpose='cloud-v2-computer-build' */ SELECT pg_advisory_unlock(hashtextextended($1,0))", [`cloud-v2-build:${id}`]).catch(() => { lost = true; });
      client.off("error", onLost); client.off("end", onLost); client.release(lost);
    }
  }

  async resources(id: string): Promise<Resources | null> {
    // A workspace created, or being restored from its checkpoint, while this
    // build was live may not have its VM yet; it creates that VM from this
    // snapshot. New pins need an active build.
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Resources>(`SELECT b.*,
      EXISTS (SELECT 1 FROM cloud_v2_computers c WHERE c.active_build_id=b.id) AS active,
      EXISTS (SELECT 1 FROM cloud_v2_workspaces w WHERE w.computer_build_id=b.id AND w.org_id=b.org_id AND w.boat_sandbox_id IS NULL
        AND (w.state='creating' OR (w.restore_pending AND w.state<>'deleted'))) AS pinned
      FROM cloud_v2_computer_builds b WHERE b.id=$1`, [id]));
    return rows[0] ?? null;
  }

  async cleanupCandidates(): Promise<string[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ id: string }>(`SELECT b.id FROM cloud_v2_computer_builds b WHERE
      b.builder_create_pending OR (b.builder_sandbox_id IS NOT NULL AND b.builder_deleted_at IS NULL)
      OR (b.cleanup_requested_at IS NOT NULL AND b.snapshot_deleted_at IS NULL)
      OR (b.snapshot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cloud_v2_computers c WHERE c.active_build_id=b.id))
      ORDER BY b.created_at LIMIT 50`));
    return rows.map(row => row.id);
  }

  async running(id: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(`SELECT 1 FROM cloud_v2_computer_builds b
      JOIN organizations o ON o.id=b.org_id WHERE b.id=$1 AND b.state='building'
      AND b.cleanup_requested_at IS NULL AND o.deleted_at IS NULL`, [id]));
    return !!rowCount;
  }

  /** Persist intent BEFORE a provider call. After a lost connection, cleanup
   * waits past its maximum request duration before resolving that intent. */
  async prepareResource(id: string, snapshotName?: string): Promise<boolean> {
    const { rowCount } = await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_computer_builds b SET
      builder_create_pending=CASE WHEN $2::text IS NULL THEN true ELSE builder_create_pending END,
      snapshot_id=coalesce($2,snapshot_id),
      operation_until=clock_timestamp()+CASE WHEN $2::text IS NULL THEN interval '5 minutes' ELSE interval '35 minutes' END
      WHERE id=$1 AND state='building' AND cleanup_requested_at IS NULL
        AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=b.org_id AND o.deleted_at IS NULL)`, [id, snapshotName ?? null]));
    return !!rowCount;
  }

  async snapshotSettled(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("UPDATE cloud_v2_computer_builds SET operation_until=NULL WHERE id=$1", [id]));
  }

  async retryCreate(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_computer_builds
      SET operation_until=clock_timestamp()+interval '5 minutes' WHERE id=$1 AND builder_create_pending`, [id]));
  }

  /** A create that Boat refused outright left nothing to delete. */
  async createRefused(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET builder_create_pending = false, operation_until = NULL WHERE id = $1`, [id]));
  }

  async confirmDeleted(id: string, kind: "builder" | "snapshot"): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(kind === "builder"
      ? "UPDATE cloud_v2_computer_builds SET builder_deleted_at=clock_timestamp(),builder_create_pending=false WHERE id=$1"
      : "UPDATE cloud_v2_computer_builds SET snapshot_deleted_at=clock_timestamp(),snapshot_id=NULL,operation_until=NULL WHERE id=$1", [id]));
  }
}

/** POSIX single-quote quoting: the shell never expands anything inside. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A non-interactive login bash script, like Conductor's setup. Boat runs
 * commands as the stock image's user, the same user the worker runs as. */
function asZeros(lines: readonly string[]): string {
  return `bash -lc ${shellQuote(lines.join("\n"))}`;
}

/** Brings one repository to the recipe's ref. A checkout the previous build
 * left is fetched and moved in place, so ignored files such as installed
 * dependencies stay; a missing one is cloned. Prints the verified branch and
 * the commit. The token stays in a per-command header; no saved remote URL
 * carries it. */
function checkoutScript(entry: RecipeEntry, dir: string, auth: string): string[] {
  const q = shellQuote, d = q(dir);
  const header = q(`http.extraHeader=Authorization: Basic ${auth}`);
  // A pinned commit (activating an earlier build) is checked out directly: its
  // branch or tag may have moved or been deleted since. Fetch it by id when
  // the branches no longer reach it.
  const pinned = entry.commit ? [
    `if ! git -C ${d} cat-file -e ${q(`${entry.commit}^{commit}`)} 2>/dev/null; then git -C ${d} -c ${header} fetch --quiet origin ${q(entry.commit)} || true; fi`,
  ] : [];
  const target = entry.commit ? [] : entry.ref ? [
    `  if git -C ${d} rev-parse --verify --quiet ${q(`refs/remotes/origin/${entry.ref}^{commit}`)} >/dev/null; then`,
    `    git -C ${d} checkout --quiet --force -B ${q(entry.ref)} ${q(`refs/remotes/origin/${entry.ref}`)}`,
    "  else",
    `    git -C ${d} checkout --quiet --force --detach ${q(`refs/tags/${entry.ref}`)}`,
    "  fi",
  ] : [
    `  zeros_build_default=$(git -C ${d} symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)`,
    "  zeros_build_default=${zeros_build_default#origin/}",
    `  if [ -z "$zeros_build_default" ]; then echo "[zeros] origin has no default branch" >&2; exit 1; fi`,
    `  git -C ${d} checkout --quiet --force -B "$zeros_build_default" "refs/remotes/origin/$zeros_build_default"`,
  ];
  return [
    "set -e",
    `if [ -d ${q(`${dir}/.git`)} ]; then`,
    // Always prune, so a deleted branch is never recorded as a workspace base.
    `  git -C ${d} -c ${header} fetch --quiet --prune --force --tags origin`,
    `  git -C ${d} -c ${header} remote set-head origin --auto >/dev/null 2>&1 || true`,
    ...target,
    "else",
    `  mkdir -p ${q(dir.slice(0, dir.lastIndexOf("/")))}`,
    `  git -c ${header} clone ${entry.ref && !entry.commit ? `--branch ${q(entry.ref)} ` : ""}${q(`https://github.com/${entry.repository}.git`)} ${d}`,
    "fi",
    ...pinned,
    // A pinned build's branch hint: its ref while that branch still exists,
    // else the default branch below. Otherwise HEAD's branch after checkout.
    entry.commit
      ? (entry.ref ? `zeros_build_branch=${q(entry.ref)}` : "zeros_build_branch=")
      : `zeros_build_branch=$(git -C ${d} symbolic-ref --quiet --short HEAD || true)`,
    `if [ -n "$zeros_build_branch" ] && ! git -C ${d} rev-parse --verify --quiet "refs/remotes/origin/$zeros_build_branch^{commit}" >/dev/null; then zeros_build_branch=; fi`,
    // A tag checkout detaches HEAD. origin/HEAD still names the repository's
    // default branch; verify its remote ref before recording that fallback.
    `if [ -z "$zeros_build_branch" ]; then`,
    `  zeros_build_remote=$(git -C ${d} symbolic-ref --quiet refs/remotes/origin/HEAD || true)`,
    '  case "$zeros_build_remote" in refs/remotes/origin/*) zeros_build_branch=${zeros_build_remote#refs/remotes/origin/};; esac',
    "fi",
    `if [ -n "$zeros_build_branch" ] && ! git -C ${d} rev-parse --verify --quiet "refs/remotes/origin/$zeros_build_branch^{commit}" >/dev/null; then zeros_build_branch=; fi`,
    ...(entry.commit ? [`git -C ${d} checkout --detach --quiet --force ${q(entry.commit)}`] : []),
    `printf '\\nzeros-build-branch=%s\\n' "$zeros_build_branch"`,
    `git -C ${d} rev-parse HEAD`,
  ];
}

/** The recipe without the commits and branches a build recorded. */
function unpinned(recipe: CloudV2Recipe): CloudV2Recipe {
  return { repositories: recipe.repositories.map(({ commit: _commit, branch: _branch, ...entry }) => entry) };
}

const REASON_LABEL: Record<CloudV2BuildReason, string> = {
  manual: "", reactivate: " (activating an earlier build)", runtime: " (runtime update)", refresh: " (daily refresh)",
};

/** Runs queued builds on Boat, a few organizations at a time. */
export class CloudV2ComputerBuilder {
  private lastRefreshScan = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: {
    computers: CloudV2Computers;
    compute: CloudV2Compute;
    channel: string;
    localOwner?: string | undefined;
    /** The worker runtime cached into every build. */
    runtime: CloudV2Runtime;
    /** A short-lived GitHub token able to clone one repository. */
    cloneToken(organizationId: string, userId: string, repository: string): Promise<string>;
    /** The commit at the tip of a remote branch, or null when it cannot be read
     * now. Without it every daily refresh is assumed to have new commits. */
    remoteHead?(organizationId: string, userId: string, repository: string, branch: string): Promise<string | null>;
    /** Candidates visited per refresh scan. */
    refreshPage?: number;
    now?: () => number;
    logger?: Pick<Console, "warn">;
  }) {}

  async tick(): Promise<void> {
    const { computers } = this.deps;
    await this.cleanup();
    // GitHub reads can be slow; a scan runs beside admission, never before it.
    this.refreshing ??= this.scheduleRefreshes()
      .catch(() => this.deps.logger?.warn("[cloud-v2] Computer refresh scan will retry"))
      .finally(() => { this.refreshing = null; });
    const jobs: CloudV2Build[] = [];
    for (let index = 0; index < BUILD_CONCURRENCY; index++) {
      const job = await computers.claim();
      if (!job) break;
      jobs.push(job);
    }
    if (!jobs.length) return;
    await Promise.all(jobs.map(job => this.runLocked(job)));
    await this.cleanup();
  }

  private async runLocked(job: CloudV2Build): Promise<void> {
    const { computers } = this.deps;
    await computers.withBuildLock(job.id, async assertHeld => {
      const beat = setInterval(() => { void computers.heartbeat(job.id).catch(() => {}); }, HEARTBEAT_MS);
      beat.unref();
      try { await this.run(job, assertHeld); }
      catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        await computers.append(job.id, `\n[zeros] build failed: ${typeof code === "string" ? code : "error"}\n`);
        await computers.fail(job.id, typeof code === "string" ? code : "computer_build_failed");
      } finally { clearInterval(beat); }
    }).catch(() => this.deps.logger?.warn("[cloud-v2] Computer build will retry"));
  }

  /** Queues the refreshes nobody asked for: a new runtime right away, and new
   * commits once a day while the organization uses cloud workspaces. */
  async scheduleRefreshes(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    if (now - this.lastRefreshScan < REFRESH_SCAN_MS) return;
    this.lastRefreshScan = now;
    const { computers, runtime } = this.deps;
    for (const candidate of await computers.refreshCandidates(runtime.sha256, this.deps.refreshPage)) {
      if (candidate.runtimeStale) {
        await computers.enqueueAutomatic(candidate.organizationId, candidate.activeBuildId, "runtime", runtime.sha256);
        continue;
      }
      // A build an admin activated again stays at its commits until they build.
      if (!candidate.refreshDue || candidate.recipe.rebuiltFrom !== undefined) continue;
      const moved = await this.repositoriesMoved(candidate);
      if (moved !== true) { await computers.deferRefresh(candidate.organizationId, candidate.activeBuildId, moved === null ? "unknown" : "unchanged"); continue; }
      await computers.enqueueAutomatic(candidate.organizationId, candidate.activeBuildId, "refresh");
    }
  }

  /** Whether any installed branch has new commits; null when GitHub cannot say. */
  private async repositoriesMoved(candidate: CloudV2RefreshCandidate): Promise<boolean | null> {
    const { remoteHead } = this.deps;
    if (!remoteHead) return true;
    for (const entry of candidate.recipe.repositories) {
      if (!entry.commit || (!entry.ref && !entry.branch)) return true;
      // A tag does not move; an explicit or default branch does.
      const branch = entry.ref ? (entry.ref === entry.branch ? entry.ref : null) : entry.branch!;
      if (!branch) continue;
      const head = await remoteHead(candidate.organizationId, candidate.createdBy, entry.repository, branch).catch(() => null);
      if (head === null) return null;
      if (head !== entry.commit) return true;
    }
    return false;
  }

  /** Runs independently of a long build, including after process restart. */
  async cleanup(): Promise<void> {
    const { computers } = this.deps;
    await computers.failInterrupted();
    for (const id of await computers.cleanupCandidates()) {
      await computers.withBuildLock(id, async assertHeld => { await this.cleanupBuild(id, assertHeld); })
        .catch(() => this.deps.logger?.warn("[cloud-v2] Computer cleanup will retry"));
    }
  }

  /** The same key and body replay an uncertain create. */
  private builderInput(job: { id: string; baseSnapshot: string | null }) {
    return {
      key: job.id, ...(job.baseSnapshot ? { from: job.baseSnapshot } : {}),
      name: cloudV2SandboxName(this.deps.channel, "build", job.id, this.deps.localOwner), env: {},
    };
  }

  private async cleanupBuild(id: string, assertHeld: () => void, finishing = false): Promise<void> {
    const { computers, compute } = this.deps;
    const resource = await computers.resources(id);
    if (!resource || (resource.state === "building" && !resource.cleanup_requested_at && !finishing)) return;
    // A lost reply can still be creating a resource at Boat. Do not confirm its
    // erasure until the bounded remote operation has finished or timed out.
    if (resource.operation_until && resource.operation_until.getTime() > Date.now()) return;
    let sandboxId = resource.builder_sandbox_id;
    if (resource.builder_create_pending) {
      assertHeld();
      // Same key resolves an uncertain create; its response is never discarded.
      await computers.retryCreate(id);
      assertHeld();
      try {
        ({ sandboxId } = await compute.create(this.builderInput({ id: resource.id, baseSnapshot: resource.base_snapshot })));
      } catch (error) {
        if (!notFound(error)) throw error;
        // Boat refuses the replay outright (its source is gone): nothing exists.
        assertHeld(); await computers.createRefused(id);
        sandboxId = null;
      }
      if (sandboxId) { assertHeld(); await computers.update(id, { builderSandboxId: sandboxId }); }
    }
    if (sandboxId && !resource.builder_deleted_at) {
      assertHeld(); await compute.delete(sandboxId);
      assertHeld(); await computers.confirmDeleted(id, "builder");
    }
    if (!resource.active && !resource.pinned && !resource.snapshot_deleted_at) {
      // Older builds may have cleared snapshot_id before a failed delete. Their
      // deterministic names still let org erasure verify every named snapshot.
      const name = resource.snapshot_id ?? (resource.cleanup_requested_at ? cloudV2SnapshotName(this.deps.channel, resource.org_id, resource.version, this.deps.localOwner) : null);
      if (name) {
        assertHeld(); await compute.deleteSnapshot(name);
        assertHeld(); await computers.confirmDeleted(id, "snapshot");
      }
    }
  }

  private async run(job: CloudV2Build, assertHeld: () => void): Promise<void> {
    const { compute, computers } = this.deps;
    const log = (text: string) => computers.append(job.id, text);
    await log(`[zeros] building Cloud Computer v${job.version}${REASON_LABEL[job.reason]}\n`);
    await log(job.baseSnapshot ? "[zeros] starting from the live computer\n" : "[zeros] starting from Boat's stock image\n");
    assertHeld();
    if (!await computers.prepareResource(job.id)) return;
    let sandboxId: string;
    try {
      ({ sandboxId } = await compute.create(this.builderInput(job)));
    } catch (error) {
      if (!job.baseSnapshot || !notFound(error)) throw error;
      // The live snapshot is gone at Boat. Workspaces cannot start from it
      // either; forget it so the next build starts clean.
      await computers.baseMissing(job.id, job.organizationId, job.baseSnapshot);
      throw Object.assign(new Error("base snapshot missing"), { code: "computer_base_missing" });
    }
    assertHeld();
    await computers.update(job.id, { builderSandboxId: sandboxId });
    // The named snapshot is an independent copy of the disk, so the builder
    // goes as soon as the build ends, whether it succeeded or not.
    try {
      if (await computers.running(job.id)) await this.install(job, sandboxId, assertHeld);
    } finally {
      await this.cleanupBuild(job.id, assertHeld, true).catch(() => {});
    }
  }

  private async install(job: CloudV2Build, sandboxId: string, assertHeld: () => void): Promise<void> {
    const { compute, computers } = this.deps;
    const log = (text: string) => computers.append(job.id, text);
    const { runtime } = this.deps;
    const installed = await compute.exec(sandboxId, installRuntimeCommand({ sha256: runtime.sha256, url: await runtime.url() }), 300);
    if (installed.exitCode !== 0 || installed.timedOut) throw Object.assign(new Error("runtime install failed"), { code: "worker_runtime_install_failed" });
    await computers.setRuntime(job.id, runtime.sha256);
    await log(`[zeros] runtime ${runtime.sha256.slice(0, 12)} installed\n`);
    let pinned: CloudV2Recipe["repositories"];
    if (job.reason === "runtime" && job.baseSnapshot) {
      // The live computer already has these commits and their setup.
      pinned = job.recipe.repositories;
      await log("[zeros] repositories unchanged\n");
    } else pinned = await this.installRepositories(job, sandboxId, assertHeld);
    if (!pinned.length) return;
    assertHeld();
    if (!await computers.running(job.id)) return;
    await computers.update(job.id, { recipe: { ...job.recipe, repositories: pinned } });
    // Boat captures a running sandbox's disk; flush it first.
    await compute.exec(sandboxId, "sync", 120);
    const name = cloudV2SnapshotName(this.deps.channel, job.organizationId, job.version, this.deps.localOwner);
    assertHeld();
    if (!await computers.prepareResource(job.id, name)) return;
    await compute.saveSnapshot(sandboxId, name);
    assertHeld(); await computers.snapshotSettled(job.id);
    await computers.activate(job.id, name);
    await log(`[zeros] Cloud Computer v${job.version} is live as ${name}\n`);
  }

  /** Returns the recipe pinned to what was installed, or [] when the build stopped. */
  private async installRepositories(job: CloudV2Build, sandboxId: string, assertHeld: () => void): Promise<CloudV2Recipe["repositories"]> {
    const { compute, computers } = this.deps;
    const log = (text: string) => computers.append(job.id, text);
    if (job.baseSnapshot) {
      const kept = new Set(job.recipe.repositories.map(entry => entry.repository.toLowerCase()));
      // Only names that are safe directory parts; never a path that leaves /home/user.
      const removed = ((await computers.baseRecipe(job.id))?.repositories ?? [])
        .map(entry => entry.repository).filter(name => !kept.has(name.toLowerCase()) && repository.safeParse(name).success);
      if (removed.length) {
        const lines = removed.flatMap(name => {
          const dir = `/home/user/${name}`;
          return [`rm -rf -- ${shellQuote(dir)}`, `rmdir -- ${shellQuote(dir.slice(0, dir.lastIndexOf("/")))} 2>/dev/null || true`];
        });
        const removal = await compute.exec(sandboxId, asZeros(["set -e", ...lines]), 300);
        if (removal.exitCode !== 0 || removal.timedOut) throw Object.assign(new Error("removal failed"), { code: "computer_remove_failed" });
        for (const name of removed) await log(`[zeros] removed ${name}\n`);
      }
    }
    const pinned: CloudV2Recipe["repositories"] = [];
    for (const entry of job.recipe.repositories) {
      assertHeld();
      if (!await computers.running(job.id)) return [];
      if (!job.createdBy) throw Object.assign(new Error("no creator"), { code: "computer_build_creator_missing" });
      const token = await this.deps.cloneToken(job.organizationId, job.createdBy, entry.repository);
      const dir = `/home/user/${entry.repository}`;
      const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
      const clone = await compute.execLong(sandboxId, asZeros(checkoutScript(entry, dir, auth)), 900);
      await log(`[zeros] clone ${entry.repository}: exit ${clone.exitCode}\n`);
      if (clone.exitCode !== 0) throw Object.assign(new Error("clone failed"), { code: "computer_clone_failed" });
      const commit = clone.stdout.trim().split("\n").pop() ?? "";
      const branch = /(?:^|\n)zeros-build-branch=([^\r\n]*)/.exec(clone.stdout)?.[1];
      assertHeld();
      if (!await computers.running(job.id)) return [];
      if (entry.setup) {
        const setup = await compute.execLong(sandboxId, `${asZeros([`cd ${shellQuote(dir)}`, entry.setup])} 2>&1`, 3600);
        await log(setup.stdout.slice(-64 * 1024) + `\n[zeros] setup ${entry.repository}: exit ${setup.exitCode}\n`);
        if (setup.exitCode !== 0) throw Object.assign(new Error("setup failed"), { code: "computer_setup_failed" });
      }
      const { branch: _previousBranch, ...recipe } = entry;
      pinned.push({ ...recipe, ...(branch ? { branch } : {}), ...(/^[0-9a-f]{40}$/.test(commit) ? { commit } : {}) });
    }
    return pinned;
  }
}
