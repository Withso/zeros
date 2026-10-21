// Cloud Computer builds. Each organization has exactly one live Boat named
// snapshot: its active build, with the org's repositories cloned to
// /home/user/<owner>/<name> and their setup run. Every build is kept here as
// a recipe; activating an older one rebuilds it at the same commits.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudV2Compute } from "./boat.js";

const MAX_LOG_BYTES = 1024 * 1024;
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
export const CloudV2RecipeSchema = z.object({
  /** Boat named snapshot of the Zeros v2 base image. */
  base: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/),
  repositories: z.array(z.object({
    repository,
    /** Branch or tag to clone; a rebuild pins `commit` instead. */
    ref: z.string().min(1).max(255).optional(),
    commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    /** Non-interactive bash run in the checkout as the workspace user, e.g. "pnpm install". */
    setup: z.string().max(8_000).optional(),
  }).strict()).min(1).max(10),
  rebuiltFrom: z.number().int().positive().optional(),
}).strict();
export type CloudV2Recipe = z.infer<typeof CloudV2RecipeSchema>;

export type CloudV2Build = {
  id: string; organizationId: string; version: number; recipe: CloudV2Recipe;
  state: "queued" | "building" | "succeeded" | "failed" | "cancelled";
  builderSandboxId: string | null; snapshotId: string | null; errorCode: string | null; createdBy: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};

type Row = {
  id: string; org_id: string; version: number; recipe: CloudV2Recipe; state: CloudV2Build["state"];
  builder_sandbox_id: string | null; snapshot_id: string | null; error_code: string | null; created_by: string | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
};
const COLUMNS = "id, org_id, version, recipe, state, builder_sandbox_id, snapshot_id, error_code, created_by, created_at, started_at, finished_at";
const build = (row: Row): CloudV2Build => ({
  id: row.id, organizationId: row.org_id, version: row.version, recipe: row.recipe, state: row.state,
  builderSandboxId: row.builder_sandbox_id, snapshotId: row.snapshot_id, errorCode: row.error_code, createdBy: row.created_by,
  createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null,
});

export function cloudV2SnapshotName(channel: string, organizationId: string, version: number): string {
  return `zeros-${channel}-${organizationId.replace(/-/g, "").slice(0, 12)}-v${version}`;
}

export class CloudV2Computers {
  constructor(private readonly pool: pg.Pool) {}

  async requireAdmin(organizationId: string, userId: string): Promise<void> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ role: string }>(
      `SELECT m.role FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.user_id = $2 AND NOT o.is_personal AND o.cloud_workspaces_allowed`, [organizationId, userId]));
    if (!rows[0]) throw new HttpError(404, "not_found", "Organization not found");
    if (rows[0].role !== "owner" && rows[0].role !== "admin") throw new HttpError(403, "forbidden", "Requires an owner or admin");
  }

  async overview(organizationId: string): Promise<{ activeBuildId: string | null; snapshotName: string | null; builds: CloudV2Build[] }> {
    return withSystemTx(this.pool, async tx => {
      const active = (await tx.query<{ active_build_id: string | null; snapshot_name: string | null }>(
        `SELECT active_build_id, snapshot_name FROM cloud_v2_computers WHERE org_id = $1`, [organizationId])).rows[0];
      const builds = (await tx.query<Row>(
        `SELECT ${COLUMNS} FROM cloud_v2_computer_builds WHERE org_id = $1 ORDER BY version DESC LIMIT 50`, [organizationId])).rows;
      return { activeBuildId: active?.active_build_id ?? null, snapshotName: active?.snapshot_name ?? null, builds: builds.map(build) };
    });
  }

  /** Queues a build; one build at a time per organization. */
  async enqueue(organizationId: string, userId: string, recipe: CloudV2Recipe): Promise<CloudV2Build> {
    const parsed = CloudV2RecipeSchema.parse(recipe);
    return withSystemTx(this.pool, async tx => {
      await tx.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
      const busy = await tx.query(`SELECT 1 FROM cloud_v2_computer_builds WHERE org_id = $1 AND state IN ('queued','building')`, [organizationId]);
      if (busy.rowCount) throw new HttpError(409, "computer_build_in_progress", "A Cloud Computer build is already running");
      const { rows } = await tx.query<Row>(
        `INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by)
         VALUES ($1, $2, coalesce((SELECT max(version) FROM cloud_v2_computer_builds WHERE org_id = $2), 0) + 1, $3, 'queued', $4)
         RETURNING ${COLUMNS}`,
        [randomUUID(), organizationId, JSON.stringify(parsed), userId],
      );
      return build(rows[0]!);
    });
  }

  /** Re-activating an older build rebuilds its recipe at the commits it used. */
  async reactivate(organizationId: string, userId: string, buildId: string): Promise<CloudV2Build> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_computer_builds WHERE id = $1 AND org_id = $2 AND state = 'succeeded'`, [buildId, organizationId]));
    const source = rows[0];
    if (!source) throw new HttpError(404, "not_found", "Cloud Computer build not found");
    return this.enqueue(organizationId, userId, { ...source.recipe, rebuiltFrom: source.version });
  }

  async log(organizationId: string, buildId: string): Promise<string> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ log: string }>(
      `SELECT log FROM cloud_v2_computer_builds WHERE id = $1 AND org_id = $2`, [buildId, organizationId]));
    if (!rows[0]) throw new HttpError(404, "not_found", "Cloud Computer build not found");
    return rows[0].log;
  }

  async claim(): Promise<CloudV2Build | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `UPDATE cloud_v2_computer_builds SET state = 'building', started_at = clock_timestamp()
       WHERE id = (SELECT id FROM cloud_v2_computer_builds WHERE state = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING ${COLUMNS}`));
    return rows[0] ? build(rows[0]) : null;
  }

  async append(buildId: string, text: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET log = right(log || $2, $3) WHERE id = $1`, [buildId, text, MAX_LOG_BYTES]));
  }

  async update(buildId: string, patch: { builderSandboxId?: string; recipe?: CloudV2Recipe }): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET builder_sandbox_id = coalesce($2, builder_sandbox_id), recipe = coalesce($3::jsonb, recipe) WHERE id = $1`,
      [buildId, patch.builderSandboxId ?? null, patch.recipe ? JSON.stringify(patch.recipe) : null]));
  }

  async fail(buildId: string, code: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_computer_builds SET state = 'failed', error_code = $2, finished_at = clock_timestamp() WHERE id = $1 AND state = 'building'`,
      [buildId, code.slice(0, 64)]));
  }

  /** Makes the build live and returns the snapshot and builder it replaced. */
  async activate(buildId: string, snapshotName: string): Promise<{ previousSnapshot: string | null; previousBuilder: string | null }> {
    return withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<{ org_id: string }>(
        `UPDATE cloud_v2_computer_builds SET state = 'succeeded', snapshot_id = $2, finished_at = clock_timestamp()
         WHERE id = $1 AND state = 'building' RETURNING org_id`, [buildId, snapshotName]);
      if (!rows[0]) throw new Error("build is not running");
      const previous = (await tx.query<{ snapshot_name: string | null; builder_sandbox_id: string | null }>(
        `SELECT c.snapshot_name, b.builder_sandbox_id FROM cloud_v2_computers c
         LEFT JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id WHERE c.org_id = $1 FOR UPDATE OF c`, [rows[0].org_id])).rows[0];
      await tx.query(
        `INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1, $2, $3)
         ON CONFLICT (org_id) DO UPDATE SET active_build_id = EXCLUDED.active_build_id, snapshot_name = EXCLUDED.snapshot_name,
           updated_at = clock_timestamp()`, [rows[0].org_id, buildId, snapshotName]);
      // The replaced build keeps its recipe; only its Boat snapshot goes away.
      if (previous?.snapshot_name) await tx.query(
        `UPDATE cloud_v2_computer_builds SET snapshot_id = NULL WHERE org_id = $1 AND snapshot_id = $2`, [rows[0].org_id, previous.snapshot_name]);
      return { previousSnapshot: previous?.snapshot_name ?? null, previousBuilder: previous?.builder_sandbox_id ?? null };
    });
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

/** Runs one queued build at a time on Boat. */
export class CloudV2ComputerBuilder {
  constructor(private readonly deps: {
    computers: CloudV2Computers;
    compute: CloudV2Compute;
    channel: string;
    /** A short-lived GitHub token able to clone one repository. */
    cloneToken(organizationId: string, userId: string, repository: string): Promise<string>;
    logger?: Pick<Console, "warn">;
  }) {}

  async tick(): Promise<void> {
    const job = await this.deps.computers.claim();
    if (!job) return;
    try {
      await this.run(job);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      await this.deps.computers.append(job.id, `\n[zeros] build failed: ${typeof code === "string" ? code : "error"}\n`);
      await this.deps.computers.fail(job.id, typeof code === "string" ? code : "computer_build_failed");
    }
  }

  private async run(job: CloudV2Build): Promise<void> {
    const { compute, computers } = this.deps;
    const log = (text: string) => computers.append(job.id, text);
    await log(`[zeros] building Cloud Computer v${job.version} from ${job.recipe.base}\n`);
    const { sandboxId } = await compute.create({ key: job.id, from: job.recipe.base, name: `zeros-${this.deps.channel}-build-${job.id.slice(0, 8)}`, env: {} });
    await computers.update(job.id, { builderSandboxId: sandboxId });
    const pinned: CloudV2Recipe["repositories"] = [];
    for (const entry of job.recipe.repositories) {
      if (!job.createdBy) throw Object.assign(new Error("no creator"), { code: "computer_build_creator_missing" });
      const token = await this.deps.cloneToken(job.organizationId, job.createdBy, entry.repository);
      const dir = `/home/user/${entry.repository}`;
      const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
      // The token stays in a per-command header; the saved remote URL carries none.
      const clone = await compute.exec(sandboxId, asZeros([
        "set -e",
        `mkdir -p ${shellQuote(dir.slice(0, dir.lastIndexOf("/")))}`,
        `git -c ${shellQuote(`http.extraHeader=Authorization: Basic ${auth}`)} clone ${entry.ref ? `--branch ${shellQuote(entry.ref)} ` : ""}` +
          `${shellQuote(`https://github.com/${entry.repository}.git`)} ${shellQuote(dir)}`,
        ...(entry.commit ? [`git -C ${shellQuote(dir)} checkout --detach ${shellQuote(entry.commit)}`] : []),
        `git -C ${shellQuote(dir)} rev-parse HEAD`,
      ]), 900);
      await log(`[zeros] clone ${entry.repository}: exit ${clone.exitCode}\n`);
      if (clone.exitCode !== 0) throw Object.assign(new Error("clone failed"), { code: "computer_clone_failed" });
      const commit = clone.stdout.trim().split("\n").pop() ?? "";
      if (entry.setup) {
        const setup = await compute.exec(sandboxId, `${asZeros([`cd ${shellQuote(dir)}`, entry.setup])} 2>&1`, 1800);
        await log(setup.stdout.slice(-64 * 1024) + `\n[zeros] setup ${entry.repository}: exit ${setup.exitCode}\n`);
        if (setup.exitCode !== 0) throw Object.assign(new Error("setup failed"), { code: "computer_setup_failed" });
      }
      pinned.push({ ...entry, ...(/^[0-9a-f]{40}$/.test(commit) ? { commit } : {}) });
    }
    await computers.update(job.id, { recipe: { ...job.recipe, repositories: pinned } });
    await compute.stop(sandboxId);
    const name = cloudV2SnapshotName(this.deps.channel, job.organizationId, job.version);
    await compute.saveSnapshot(sandboxId, name);
    const replaced = await computers.activate(job.id, name);
    await log(`[zeros] Cloud Computer v${job.version} is live as ${name}\n`);
    if (replaced.previousSnapshot) await compute.deleteSnapshot(replaced.previousSnapshot).catch(() => {});
    if (replaced.previousBuilder && replaced.previousBuilder !== sandboxId) await compute.delete(replaced.previousBuilder).catch(() => {});
  }
}
