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
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";

const MAX_LOG_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 60_000;
/** A build whose server stopped (a deploy, a crash) is failed after this. */
const INTERRUPTED_AFTER = "5 minutes";
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
export const CloudV2RecipeSchema = z.object({
  repositories: z.array(z.object({
    repository,
    /** Branch or tag to clone; a rebuild pins `commit` instead. */
    ref: z.string().min(1).max(255).optional(),
    commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    /** Verified remote branch observed after cloning, or origin's default for a tag. */
    branch: z.string().min(1).max(255).optional(),
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
type Resources = Row & {
  cleanup_requested_at: Date | null; builder_create_pending: boolean; builder_deleted_at: Date | null;
  snapshot_deleted_at: Date | null; operation_until: Date | null; active: boolean;
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
      const owner = await tx.query(`SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL AND lifecycle_status='active' FOR UPDATE`, [organizationId]);
      if (!owner.rowCount) throw new HttpError(404, "not_found", "Organization not found");
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
   * transaction or block the deletion request; cleanup tries again next tick. */
  async withBuildLock(id: string, work: (assertHeld: () => void) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    let lost = false, held = false;
    const onLost = () => { lost = true; };
    client.on("error", onLost); client.on("end", onLost);
    try {
      held = (await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held", [`cloud-v2-build:${id}`])).rows[0]!.held;
      if (held) await work(() => { if (lost) throw new Error("Computer resource lock was lost"); });
    } finally {
      if (held && !lost) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`cloud-v2-build:${id}`]).catch(() => { lost = true; });
      client.off("error", onLost); client.off("end", onLost); client.release(lost);
    }
  }

  async resources(id: string): Promise<Resources | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Resources>(`SELECT b.*,
      EXISTS (SELECT 1 FROM cloud_v2_computers c WHERE c.active_build_id=b.id) AS active
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

/** Runs one queued build at a time on Boat. */
export class CloudV2ComputerBuilder {
  constructor(private readonly deps: {
    computers: CloudV2Computers;
    compute: CloudV2Compute;
    channel: string;
    /** The worker runtime cached into every build. */
    runtime: CloudV2Runtime;
    /** A short-lived GitHub token able to clone one repository. */
    cloneToken(organizationId: string, userId: string, repository: string): Promise<string>;
    logger?: Pick<Console, "warn">;
  }) {}

  async tick(): Promise<void> {
    const { computers } = this.deps;
    await this.cleanup();
    const job = await computers.claim();
    if (!job) return;
    await computers.withBuildLock(job.id, async assertHeld => {
      const beat = setInterval(() => { void computers.heartbeat(job.id).catch(() => {}); }, HEARTBEAT_MS);
      beat.unref();
      try { await this.run(job, assertHeld); }
      catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        await computers.append(job.id, `\n[zeros] build failed: ${typeof code === "string" ? code : "error"}\n`);
        await computers.fail(job.id, typeof code === "string" ? code : "computer_build_failed");
      } finally { clearInterval(beat); }
    });
    await this.cleanup();
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

  private builderInput(job: { id: string }) {
    return { key: job.id, name: `zeros-${this.deps.channel}-build-${job.id.slice(0, 8)}`, env: {} };
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
      ({ sandboxId } = await compute.create(this.builderInput(resource)));
      assertHeld(); await computers.update(id, { builderSandboxId: sandboxId });
    }
    if (sandboxId && !resource.builder_deleted_at) {
      assertHeld(); await compute.delete(sandboxId);
      assertHeld(); await computers.confirmDeleted(id, "builder");
    }
    if (!resource.active && !resource.snapshot_deleted_at) {
      // Older builds may have cleared snapshot_id before a failed delete. Their
      // deterministic names still let org erasure verify every named snapshot.
      const name = resource.snapshot_id ?? (resource.cleanup_requested_at ? cloudV2SnapshotName(this.deps.channel, resource.org_id, resource.version) : null);
      if (name) {
        assertHeld(); await compute.deleteSnapshot(name);
        assertHeld(); await computers.confirmDeleted(id, "snapshot");
      }
    }
  }

  private async run(job: CloudV2Build, assertHeld: () => void): Promise<void> {
    const { compute, computers } = this.deps;
    const log = (text: string) => computers.append(job.id, text);
    await log(`[zeros] building Cloud Computer v${job.version}\n`);
    // Boat's stock image plus the current runtime; repositories go on top.
    assertHeld();
    if (!await computers.prepareResource(job.id)) return;
    const { sandboxId } = await compute.create(this.builderInput(job));
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
    await log(`[zeros] runtime ${runtime.sha256.slice(0, 12)} installed\n`);
    const pinned: CloudV2Recipe["repositories"] = [];
    for (const entry of job.recipe.repositories) {
      assertHeld();
      if (!await computers.running(job.id)) return;
      if (!job.createdBy) throw Object.assign(new Error("no creator"), { code: "computer_build_creator_missing" });
      const token = await this.deps.cloneToken(job.organizationId, job.createdBy, entry.repository);
      const dir = `/home/user/${entry.repository}`;
      const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
      // The token stays in a per-command header; the saved remote URL carries none.
      const clone = await compute.execLong(sandboxId, asZeros([
        "set -e",
        `mkdir -p ${shellQuote(dir.slice(0, dir.lastIndexOf("/")))}`,
        `git -c ${shellQuote(`http.extraHeader=Authorization: Basic ${auth}`)} clone ${entry.ref ? `--branch ${shellQuote(entry.ref)} ` : ""}` +
          `${shellQuote(`https://github.com/${entry.repository}.git`)} ${shellQuote(dir)}`,
        `zeros_build_branch=$(git -C ${shellQuote(dir)} symbolic-ref --quiet --short HEAD || true)`,
        // A tag clone detaches HEAD. origin/HEAD still names the repository's
        // default branch; verify its remote ref before recording that fallback.
        `if [ -z "$zeros_build_branch" ]; then`,
        `  zeros_build_remote=$(git -C ${shellQuote(dir)} symbolic-ref --quiet refs/remotes/origin/HEAD || true)`,
        '  case "$zeros_build_remote" in refs/remotes/origin/*) zeros_build_branch=${zeros_build_remote#refs/remotes/origin/};; esac',
        "fi",
        `if [ -n "$zeros_build_branch" ] && ! git -C ${shellQuote(dir)} rev-parse --verify --quiet "refs/remotes/origin/$zeros_build_branch^{commit}" >/dev/null; then zeros_build_branch=; fi`,
        ...(entry.commit ? [`git -C ${shellQuote(dir)} checkout --detach ${shellQuote(entry.commit)}`] : []),
        `printf '\\nzeros-build-branch=%s\\n' "$zeros_build_branch"`,
        `git -C ${shellQuote(dir)} rev-parse HEAD`,
      ]), 900);
      await log(`[zeros] clone ${entry.repository}: exit ${clone.exitCode}\n`);
      if (clone.exitCode !== 0) throw Object.assign(new Error("clone failed"), { code: "computer_clone_failed" });
      const commit = clone.stdout.trim().split("\n").pop() ?? "";
      const branch = /(?:^|\n)zeros-build-branch=([^\r\n]*)/.exec(clone.stdout)?.[1];
      assertHeld();
      if (!await computers.running(job.id)) return;
      if (entry.setup) {
        const setup = await compute.execLong(sandboxId, `${asZeros([`cd ${shellQuote(dir)}`, entry.setup])} 2>&1`, 3600);
        await log(setup.stdout.slice(-64 * 1024) + `\n[zeros] setup ${entry.repository}: exit ${setup.exitCode}\n`);
        if (setup.exitCode !== 0) throw Object.assign(new Error("setup failed"), { code: "computer_setup_failed" });
      }
      const { branch: _previousBranch, ...recipe } = entry;
      pinned.push({ ...recipe, ...(branch ? { branch } : {}), ...(/^[0-9a-f]{40}$/.test(commit) ? { commit } : {}) });
    }
    assertHeld();
    if (!await computers.running(job.id)) return;
    await computers.update(job.id, { recipe: { ...job.recipe, repositories: pinned } });
    // Boat captures a running sandbox's disk; flush it first.
    await compute.exec(sandboxId, "sync", 120);
    const name = cloudV2SnapshotName(this.deps.channel, job.organizationId, job.version);
    assertHeld();
    if (!await computers.prepareResource(job.id, name)) return;
    await compute.saveSnapshot(sandboxId, name);
    assertHeld(); await computers.snapshotSettled(job.id);
    await computers.activate(job.id, name);
    await log(`[zeros] Cloud Computer v${job.version} is live as ${name}\n`);
  }
}
