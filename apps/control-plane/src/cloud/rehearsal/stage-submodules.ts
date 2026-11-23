// Stage D, submodules (#1247's per-repository switch), on the Personal route. R3 (Withso/zeros-dev-fixture-submodules,
// public) holds two public submodules: vendor/hello (octocat/Hello-World, third party, pinned) and vendor/private (a
// Withso fixture that is public despite its name). D proves the common case: the copy's build and a workspace forked from it
// fetch public submodules with no credential, at their gitlink commits. Nothing about private submodules is rehearsed (no
// private submodule fixture): read-only submodule tokens and the "creator cannot read it" path are reported as not rehearsed.
import { z } from "zod";
import { RehearsalFailure, type StageContext } from "./contract.js";
import { openBridge, check, createProject, createWorkspace, deleteProject, deleteWorkspace, parse, shell, waitCopyReady, workspaceRoot } from "./steps.js";

export async function stageSubmodules(ctx: StageContext): Promise<Record<string, number>> {
  check(ctx.state.owner === "personal", "owner", "personal_route_only");
  const { submodules: three, submoduleFixture } = ctx.repositories;
  check(three && submoduleFixture, "fixtures", "not_named");
  for (const repository of [three, submoduleFixture])
    if (!await ctx.ports.github.repositoryExists(repository)) throw new RehearsalFailure("fixtures", "missing");
  const { prefix } = ctx.state;
  const counts: Record<string, number> = { copyFetched: 0, copyPublic: 0, workspaceFetched: 0, workspaceInitialized: 0 };

  ctx.step("project");
  const project = await createProject(ctx, { name: `${prefix}sub`, repositories: [{ repository: three, fetchSubmodules: true }] });
  await waitCopyReady(ctx, project.id);
  // D1: the copy's build fetched both, and recorded both as public (fetched with no credential).
  ctx.step("copy_submodules");
  const copy = await ctx.ports.database.read(`SELECT result FROM cloud_v2_ready_copies WHERE project_id = $1::uuid AND state = 'ready'
    ORDER BY generation DESC LIMIT 1`, [project.id]);
  const result = parse(z.array(z.object({ submodules: z.array(z.object({ path: z.string(), fetched: z.boolean(), public: z.literal(true).optional() })
    .passthrough()).optional() }).passthrough()), copy[0]?.result ?? null, "copy_submodules");
  const held = result.flatMap(entry => entry.submodules ?? []);
  counts.copyFetched = held.filter(row => row.fetched).length;
  counts.copyPublic = held.filter(row => row.fetched && row.public === true).length;
  check(counts.copyFetched === 2, "copy_submodules", `fetched_${counts.copyFetched}`);
  check(counts.copyPublic === 2, "copy_submodules", `public_${counts.copyPublic}`);

  // D2: a workspace forked from the copy fetches both itself (public: no token) and has both at their gitlink commits.
  ctx.step("workspace");
  const workspace = await createWorkspace(ctx, { name: `${prefix}sub-w`, projectId: project.id, branch: `${prefix}sub` });
  const forks = await ctx.ports.database.read(`SELECT count(*)::int AS forks FROM cloud_v2_ready_copy_forks WHERE workspace_id = $1::uuid AND completed_at IS NOT NULL`, [workspace.id]);
  check(Number(forks[0]?.forks) === 1, "workspace_fork", "not_forked");
  const rows = await ctx.ports.database.read(`SELECT path, status, public FROM cloud_v2_workspace_submodules WHERE workspace_id = $1::uuid ORDER BY position, path`, [workspace.id]);
  counts.workspaceFetched = rows.filter(row => row.status === "fetch" && row.public === true).length;
  check(counts.workspaceFetched === 2, "workspace_submodules", `fetched_public_${counts.workspaceFetched}`);
  check(!rows.some(row => row.status === "skipped"), "workspace_submodules", "skipped");
  const bridge = await openBridge(ctx, workspace.id);
  try {
    // A one-repository workspace's root is its checkout.
    const checkout = await workspaceRoot(bridge, workspace.id);
    // `git submodule status`: a leading space is initialized at the recorded commit; "-" uninitialized, "+" another commit.
    const status = await shell(ctx, bridge, { workspaceId: workspace.id, cwd: checkout }, `${prefix}pty-sub`, "git submodule status", "submodule_status");
    check(status.exitCode === 0, "submodule_status", `exit_${status.exitCode}`);
    const lines = status.output.split(/\r?\n/).filter(line => /^[ +\-U][0-9a-f]{40} /.test(line));
    counts.workspaceInitialized = lines.filter(line => line.startsWith(" ")).length;
    check(lines.length === 2 && counts.workspaceInitialized === 2, "submodule_status", `initialized_${counts.workspaceInitialized}_of_${lines.length}`);
  } finally { bridge.close(); }
  // Not rehearsed, and not a failure: there is no private submodule fixture (the owner made every new fixture public).
  ctx.note("private_submodule:not_rehearsed_no_fixture");

  ctx.step("delete");
  await deleteWorkspace(ctx, workspace.id);
  await deleteProject(ctx, project.id);
  return counts;
}
