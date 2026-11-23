// Every statement the rehearsal reads through its read role, exactly as its modules send them, with values from the
// seeded dataset in rehearsal/reads.integration.test.ts. A unit test (rehearsal.test.ts) checks that every statement the
// stages, cleanup and --plan send is listed here, so a new read cannot skip the read-role test.
export type ReadSeed = {
  user: string; owner: string; org: string; project: string; workspace: string; other: string; build: string; startedAt: string; prefix: string;
  runtime: string; probeSlug: string;
};
export type CatalogRead = { name: string; text: string; values: (seed: ReadSeed) => unknown[];
  /** What a row that exists must show, beyond the row itself (a count above 0, a flag true). */
  sees?: (rows: Record<string, unknown>[]) => boolean };

const positive = (column: string) => (rows: Record<string, unknown>[]) => Number(rows[0]?.[column]) > 0;

export const REHEARSAL_READS: CatalogRead[] = [
  // steps.ts
  { name: "recordRunBases", text: `SELECT id::text AS id, base_shared FROM cloud_v2_computer_builds WHERE org_id = $1::uuid AND automatic
    AND created_at >= $2::timestamptz ORDER BY version`, values: s => [s.org, s.startedAt] },
  { name: "copyMachines", text: "SELECT machine_id FROM cloud_v2_ready_copies WHERE project_id = $1::uuid AND machine_id IS NOT NULL", values: s => [s.project] },
  // stage-personal.ts
  { name: "personal workspace state", text: "SELECT state FROM cloud_v2_workspaces WHERE id = $1::uuid", values: s => [s.workspace] },
  // stage-projects.ts and stage-submodules.ts
  { name: "projects fork record", text: `SELECT count(*)::int AS forks FROM cloud_v2_ready_copy_forks
    WHERE workspace_id = $1::uuid AND completed_at IS NOT NULL`, values: s => [s.workspace], sees: positive("forks") },
  { name: "submodules copy result", text: `SELECT result FROM cloud_v2_ready_copies WHERE project_id = $1::uuid AND state = 'ready'
    ORDER BY generation DESC LIMIT 1`, values: s => [s.project] },
  { name: "submodules fork record", text: "SELECT count(*)::int AS forks FROM cloud_v2_ready_copy_forks WHERE workspace_id = $1::uuid AND completed_at IS NOT NULL",
    values: s => [s.workspace], sees: positive("forks") },
  { name: "submodules rows", text: "SELECT path, status, public FROM cloud_v2_workspace_submodules WHERE workspace_id = $1::uuid ORDER BY position, path",
    values: s => [s.workspace] },
  // stage-retention.ts
  { name: "retention probes", text: `SELECT id::text AS id, backup_probe, backup_probe_generation = stop_generation AS current_probe,
      worker_off_unverified_at IS NULL AS worker_off FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, values: s => [[s.workspace]] },
  { name: "retention backup forks", text: `SELECT count(*)::int AS forks FROM cloud_v2_maintenance_wakes
      WHERE workspace_id = $1::uuid AND kind = 'backup_fork' AND outcome = 'stopped'`, values: s => [s.workspace], sees: positive("forks") },
  { name: "retention wakes", text: `SELECT count(*)::int AS wakes FROM cloud_v2_maintenance_wakes
      WHERE workspace_id = ANY($1::uuid[]) AND kind = 'wake' AND outcome = 'stopped'`, values: s => [[s.workspace]], sees: positive("wakes") },
  { name: "retention scrubs", text: "SELECT id::text AS id, archive_scrub FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])", values: s => [[s.workspace]] },
  { name: "retention pins", text: "SELECT id::text AS id, computer_build_id::text AS build FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])",
    values: s => [[s.workspace]] },
  { name: "retention S4 deployed", text: `SELECT count(*)::int AS present FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'cloud_v2_backup_removals'`, values: () => [], sees: positive("present") },
  // stage-setup.ts
  { name: "setup snapshot gone", text: "SELECT snapshot_deleted_at IS NOT NULL AS gone FROM cloud_v2_computer_builds WHERE id = $1::uuid", values: s => [s.build] },
  // stage-waiting.ts
  { name: "waiting row", text: `SELECT waiting_for_base_at IS NOT NULL AS waiting, computer_build_id::text AS build
    FROM cloud_v2_workspaces WHERE id = $1::uuid AND org_id = $2::uuid`, values: s => [s.workspace, s.org] },
  { name: "waiting pin", text: "SELECT computer_build_id::text AS build FROM cloud_v2_workspaces WHERE id = $1::uuid AND org_id = $2::uuid",
    values: s => [s.workspace, s.org] },
  // runner.ts (the inventory)
  { name: "inventory database rows", text: `SELECT
      (SELECT count(*) FROM cloud_v2_workspaces WHERE left(name, length($1)) = $1 AND state <> 'deleted')::int AS workspaces,
      (SELECT count(*) FROM cloud_projects WHERE left(name, length($1)) = $1)::int AS projects`, values: s => [s.prefix],
    sees: rows => Number(rows[0]?.workspaces) > 0 && Number(rows[0]?.projects) > 0 },
  { name: "inventory run bases", text: `SELECT coalesce(c.active_build_id = b.id, false) AS active, b.snapshot_id, b.base_shared
      FROM cloud_v2_computer_builds b LEFT JOIN cloud_v2_computers c ON c.org_id = b.org_id
      WHERE b.org_id = $1::uuid AND (b.id = ANY($2::uuid[]) OR (b.automatic AND b.created_at >= $3::timestamptz)) /* run bases */`,
    values: s => [s.org, [], s.startedAt] },
  // plan.ts
  { name: "platform owners", text: "SELECT id::text AS id FROM users WHERE staff_role = 'platform_owner' AND auth_status = 'active' AND deleted_at IS NULL ORDER BY id",
    values: () => [] },
  { name: "probe organization", text: `SELECT o.id::text AS id, l.workos_organization_id FROM organizations o
    LEFT JOIN workos_organization_links l ON l.organization_id = o.id WHERE (o.slug = $1 OR o.id::text = $1) AND o.deleted_at IS NULL`, values: s => [s.probeSlug] },
  { name: "pro actor", text: `SELECT id::text AS id FROM users WHERE staff_role = 'platform_owner' AND auth_status = 'active' AND deleted_at IS NULL
    AND left(id::text, 8) = $1`, values: s => [s.owner.slice(0, 8)] },
  { name: "probe diagnostics", text: `SELECT o.deleted_at IS NULL AS organization_present, o.lifecycle_status = 'active' AS organization_active,
      (o.is_personal OR o.cloud_workspaces_allowed) AS cloud_allowed, m.user_id IS NOT NULL AS member, (u.auth_status = 'active' AND u.deleted_at IS NULL) AS user_active
    FROM organizations o LEFT JOIN organization_members m ON m.org_id = o.id AND m.user_id = $2::uuid LEFT JOIN users u ON u.id = $2::uuid
    WHERE o.id = $1::uuid`, values: s => [s.org, s.user], sees: rows => rows[0]?.member === true && rows[0]?.user_active === true },
  // live.ts (the Pro port)
  { name: "pro grant", text: `SELECT status, cloud_workspaces_allowed, source, valid_from, valid_until
    FROM account_entitlements WHERE user_id = $1::uuid`, values: s => [s.user] },
  // rehearsal-cli.ts (--plan)
  { name: "shared base in use", text: `SELECT count(*)::int AS n FROM cloud_v2_computers c
          JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id WHERE b.base_shared`, values: () => [], sees: positive("n") },
  { name: "shared bases table", text: "SELECT to_regclass('public.cloud_v2_shared_bases') IS NOT NULL AS present", values: () => [], sees: rows => rows[0]?.present === true },
  { name: "shared base for the runtime", text: `SELECT name, state FROM cloud_v2_shared_bases WHERE runtime_sha256 = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1`, values: s => [s.runtime] },
  { name: "organizations per shared base", text: `SELECT split_part(snapshot_name, '@', 1) AS name, count(*)::int AS organizations FROM cloud_v2_computers
    WHERE position('@' in snapshot_name) > 0 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`, values: () => [] },
  { name: "organizations on their own base", text: "SELECT count(*)::int AS n FROM cloud_v2_computers WHERE snapshot_name IS NOT NULL AND position('@' in snapshot_name) = 0",
    values: () => [], sees: positive("n") },
];
