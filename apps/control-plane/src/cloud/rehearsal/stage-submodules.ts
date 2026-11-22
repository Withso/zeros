// Stage D, submodules (#1247's per-repository switch), on the Personal route: R3 holds one public and one private
// submodule (the private one a fixture repository the token can read). The copy's build fetches both with the member's
// token; a workspace forked from it has both at their gitlink commits. With a token sign-in a create mints no read-only
// submodule token: the private one is "readable" (held by the copy, and the creator can read it) and the create names why
// it fetched none itself. D3 (a second member who cannot read the private one) needs a second member: not on this route.
import { z } from "zod";
import { RehearsalFailure, type StageContext } from "./contract.js";
import { check, createProject, createWorkspace, deleteProject, deleteWorkspace, parse, shell, waitCopyReady, workspaceRoot } from "./steps.js";

export async function stageSubmodules(ctx: StageContext): Promise<Record<string, number>> {
  check(ctx.state.owner === "personal", "owner", "personal_route_only");
  const { submodules: three, privateSubmodule } = ctx.repositories;
  check(three && privateSubmodule, "fixtures", "not_named");
  for (const repository of [three, privateSubmodule])
    if (!await ctx.ports.github.repositoryExists(repository)) throw new RehearsalFailure("fixtures", "missing");
  const { prefix } = ctx.state;
  const counts: Record<string, number> = { copyFetched: 0, workspaceInitialized: 0 };

  ctx.step("project");
  const project = await createProject(ctx, { name: `${prefix}sub`, repositories: [{ repository: three, fetchSubmodules: true }] });
  await waitCopyReady(ctx, project.id);
  // D1: the copy's build fetched both, as its own record says.
  ctx.step("copy_submodules");
  const copy = await ctx.ports.database.read(`SELECT result FROM cloud_v2_ready_copies WHERE project_id = $1::uuid AND state = 'ready'
    ORDER BY generation DESC LIMIT 1`, [project.id]);
  const result = parse(z.array(z.object({ submodules: z.array(z.object({ path: z.string(), fetched: z.boolean() }).passthrough()).optional() }).passthrough()),
    copy[0]?.result ?? null, "copy_submodules");
  counts.copyFetched = result.flatMap(entry => entry.submodules ?? []).filter(row => row.fetched).length;
  check(counts.copyFetched === 2, "copy_submodules", `fetched_${counts.copyFetched}`);

  // D2: a workspace forked from the copy has both checked out at their gitlink commits.
  ctx.step("workspace");
  const workspace = await createWorkspace(ctx, { name: `${prefix}sub-w`, projectId: project.id, branch: `${prefix}sub` });
  const forks = await ctx.ports.database.read(`SELECT count(*)::int AS forks FROM cloud_v2_ready_copy_forks WHERE workspace_id = $1::uuid AND completed_at IS NOT NULL`, [workspace.id]);
  check(Number(forks[0]?.forks) === 1, "workspace_fork", "not_forked");
  const rows = await ctx.ports.database.read(`SELECT path, status FROM cloud_v2_workspace_submodules WHERE workspace_id = $1::uuid ORDER BY position, path`, [workspace.id]);
  const held = rows.filter(row => row.status === "fetch" || row.status === "readable").length;
  check(held === 2, "workspace_submodules", `held_${held}`);
  // A token sign-in names, once, why the create fetched no private submodule itself.
  if (rows.some(row => row.path === ".gitmodules" && row.status === "skipped")) ctx.note("submodules:token_sign_in_named");
  const bridge = await ctx.ports.bridge(workspace.id);
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
  ctx.note("d3:not_rehearsed_single_member");

  ctx.step("delete");
  await deleteWorkspace(ctx, workspace.id);
  await deleteProject(ctx, project.id);
  return counts;
}
