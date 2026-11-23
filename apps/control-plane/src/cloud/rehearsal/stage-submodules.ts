// Stage D, submodules (#1247's per-repository switch), on the Personal route. R3 (Withso/zeros-dev-fixture-submodules,
// public) holds two public submodules: vendor/hello (octocat/Hello-World, third party, pinned) and vendor/private (a
// Withso fixture that is public despite its name). D proves the common case: the copy's build and a workspace forked from it
// fetch public submodules with no credential, at their gitlink commits. Nothing about private submodules is rehearsed (no
// private submodule fixture): read-only submodule tokens and the "creator cannot read it" path are reported as not rehearsed.
import { z } from "zod";
import { RehearsalFailure, type StageContext } from "./contract.js";
import { openBridge, check, createProject, createWorkspace, deleteProject, deleteWorkspace, parse, seenShape, shell, waitCopyReady, workspaceRoot } from "./steps.js";

const SUBMODULE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
/** For each path: `zr-sub <path> <gitlink|none> <head|none> <changes>`. The head is read only from the folder's own Git
 * entry (`<path>/.git`), so a folder without one never reads the superproject's HEAD. */
export function submoduleCommitsCommand(paths: readonly string[]): string {
  if (!paths.every(path => SUBMODULE_PATH.test(path) && !path.includes(".."))) throw new RehearsalFailure("submodule_commits", "path");
  return `for p in ${paths.map(path => `'${path}'`).join(" ")}; do ` +
    `l=$(git ls-files -s -- "$p" | awk '$1 == "160000" { print $2 }'); ` +
    `h=$( [ -e "$p/.git" ] && git -C "$p" rev-parse HEAD 2>/dev/null ); ` +
    `c=$(git status --porcelain -- "$p" | wc -l | tr -d ' '); ` +
    `printf 'zr-sub %s %s %s %s\\n' "$p" "\${l:-none}" "\${h:-none}" "\${c:-0}"; done`;
}
export function readSubmoduleCommits(output: string): Map<string, { gitlink: string; head: string; changes: number }> {
  const rows = new Map<string, { gitlink: string; head: string; changes: number }>();
  for (const match of output.matchAll(/^zr-sub (\S+) ([0-9a-f]{40}|none) ([0-9a-f]{40}|none) (\d+)$/gm))
    rows.set(match[1]!, { gitlink: match[2]!, head: match[3]!, changes: Number(match[4]) });
  return rows;
}
/** `submodule_status:<initialized|unregistered|other_commit|conflicted>_<n>`, one per kind seen, or why none was read. */
export function submoduleStatusNotes(exitCode: number, output: string): string[] {
  if (exitCode !== 0) return [`submodule_status:exit_${exitCode}`];
  const kinds: Record<string, string> = { " ": "initialized", "-": "uninitialized", "+": "other_commit", U: "conflicted" };
  const counted = new Map<string, number>();
  for (const line of output.split("\n")) {
    const kind = /^([ +\-U])[0-9a-f]{40} /.exec(line)?.[1];
    if (kind) counted.set(kinds[kind]!, (counted.get(kinds[kind]!) ?? 0) + 1);
  }
  return counted.size ? [...counted].map(([kind, n]) => `submodule_status:${kind}_${n}`) : [`submodule_status:unread:${seenShape(output)}`];
}

export async function stageSubmodules(ctx: StageContext): Promise<Record<string, number>> {
  check(ctx.state.owner === "personal", "owner", "personal_route_only");
  const { submodules: three, submoduleFixture } = ctx.repositories;
  check(three && submoduleFixture, "fixtures", "not_named");
  for (const repository of [three, submoduleFixture])
    if (!await ctx.ports.github.repositoryExists(repository)) throw new RehearsalFailure("fixtures", "missing");
  const { prefix } = ctx.state;
  const counts: Record<string, number> = { copyFetched: 0, copyPublic: 0, workspaceFetched: 0, workspaceAtGitlink: 0 };

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
    const scope = { workspaceId: workspace.id, cwd: checkout };
    // Each planned submodule at its gitlink: its own Git directory's HEAD equals the commit the superproject's index records
    // (mode 160000), and the superproject shows no change for that path. One line per path, the command's own marker.
    const paths = rows.map(row => String(row.path));
    check(paths.length === 2 && paths.every(path => SUBMODULE_PATH.test(path)), "submodule_commits", `paths_${paths.length}`);
    const commits = await shell(ctx, bridge, scope, `${prefix}pty-sub`, submoduleCommitsCommand(paths), "submodule_commits");
    const seen = readSubmoduleCommits(commits.output);
    for (const [index, path] of paths.entries()) {
      const row = seen.get(path), at = `${index + 1}`;
      check(row, "submodule_commits", `unread_${at}:${seenShape(commits.output)}`);
      check(/^[0-9a-f]{40}$/.test(row.gitlink), "submodule_commits", `no_gitlink_${at}`);
      check(row.head !== "none", "submodule_commits", `no_checkout_${at}`);
      check(row.head === row.gitlink, "submodule_commits", `other_commit_${at}`);
      check(row.changes === 0, "submodule_commits", `changed_${at}`);
      counts.workspaceAtGitlink!++;
    }
    // `git submodule status` reads the registration in .git/config, which this product's layout does not write: its
    // prefix is a note only (" " initialized, "-" not registered, "+" another commit, "U" conflicted), never a failure.
    const status = await shell(ctx, bridge, scope, `${prefix}pty-substatus`, "git --no-pager submodule status", "submodule_status");
    for (const note of submoduleStatusNotes(status.exitCode, status.output)) ctx.note(note);
  } finally { bridge.close(); }
  // Not rehearsed, and not a failure: there is no private submodule fixture (the owner made every new fixture public).
  ctx.note("private_submodule:not_rehearsed_no_fixture");

  ctx.step("delete");
  await deleteWorkspace(ctx, workspace.id);
  await deleteProject(ctx, project.id);
  return counts;
}
