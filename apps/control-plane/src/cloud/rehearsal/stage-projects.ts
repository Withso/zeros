// Stage A, projects (CLOUD_V2_READY_COPIES_ENABLED): a one-repository project's copy, a workspace forked from it with a
// turn, a terminal, files, a pushed branch and a pull request, its lifecycle, then a two-repository project with a pull
// request in the second repository and a rewind across both, and every copy machine gone after the projects.
import { z } from "zod";
import { type Bridge, type StageContext } from "./contract.js";
import { answered, check, copyMachines, createProject, createWorkspace, deleteProject, deleteWorkspace, getWorkspace, lifecycle,
  openAndClosePull, parse, readFile, turn, until, waitCopyReady, waitState, workspaceRoot, writeFile, type WorkspaceDocument } from "./steps.js";

export async function stageProjects(ctx: StageContext): Promise<Record<string, number>> {
  const { prefix } = ctx.state, one = ctx.repositories.one, two = ctx.repositories.two;
  check(two, "repository_two", "missing");
  const counts: Record<string, number> = { workspaces: 0, pulls: 0, turns: 0, copiesGone: 0 };

  // A1: the copy.
  ctx.step("project_one");
  const projectOne = await createProject(ctx, { name: `${prefix}one`, level: "organization", repositories: [one] });
  await waitCopyReady(ctx, projectOne.id);
  const copiesOne = await copyMachines(ctx, projectOne.id);
  check(copiesOne.length > 0, "copy_machine", "missing");

  // A2: a workspace forked from it.
  ctx.step("workspace_one");
  let workspace = await createWorkspace(ctx, { name: `${prefix}one-w`, projectId: projectOne.id, branch: `${prefix}one` });
  counts.workspaces!++;
  ctx.state.created.branches.push({ repository: one, name: `${prefix}one` }); await ctx.save();
  await forkedFromCopy(ctx, workspace);
  let bridge = await ctx.ports.bridge(workspace.id);
  let path: string, content: string;
  try {
    const root = await workspaceRoot(bridge, workspace.id), scope = { workspaceId: workspace.id, cwd: root };
    ctx.step("turn");
    await turn(ctx, bridge, workspace, root, `${prefix}chat-ok`, "Reply with exactly: ok. Do not use tools or read files.", "turn");
    check(await answered(bridge, `${prefix}chat-ok`, "ok", "turn_answer"), "turn_answer", "no_answer");
    counts.turns!++;
    ctx.step("terminal");
    await terminalRoundTrip(ctx, bridge, scope, `${prefix}pty`, workspace.branch);
    ctx.step("files");
    path = `${root}/${prefix}file.txt`; content = `${prefix}content\n`;
    await writeFile(bridge, scope, path, content, "file_write");
    check(await readFile(bridge, scope, path, "file_read") === content, "file_read", "content");

    // A3: commit, push, a pull request opened then closed unmerged, then the branch deleted.
    ctx.step("pull_one");
    await bridge.op("git.commit", { ...scope, message: `${prefix}commit`, files: [path] });
    await bridge.op("git.push", { ...scope, setUpstream: true });
    await openAndClosePull(ctx, workspace.id, undefined, `${prefix}pull-one`, "pull_one");
    counts.pulls!++;
  } finally { bridge.close(); }
  await ctx.ports.github.deleteBranch(one, `${prefix}one`);

  // A4: stop and wake keep the file; archive and open bring it back; delete reads 404 or deleted.
  ctx.step("stop_wake");
  await lifecycle(ctx, workspace.id, "stop", "stop");
  await waitState(ctx, workspace.id, "stopped", "stopped");
  await lifecycle(ctx, workspace.id, "start", "wake");
  workspace = await waitState(ctx, workspace.id, "running", "woken");
  bridge = await ctx.ports.bridge(workspace.id);
  try {
    const root = await workspaceRoot(bridge, workspace.id);
    check(await readFile(bridge, { workspaceId: workspace.id, cwd: root }, path, "wake_file") === content, "wake_file", "content");
  } finally { bridge.close(); }
  ctx.step("archive_open");
  await lifecycle(ctx, workspace.id, "archive", "archive");
  await until(ctx, "archived", ctx.timing.stateMs, ctx.timing.pollMs, async () => {
    const row = await getWorkspace(ctx, workspace.id, "archived");
    check(row && row.state !== "failed", "archived", "state");
    return row.archivedAt && row.state === "stopped";
  });
  await lifecycle(ctx, workspace.id, "start", "open");
  workspace = await waitState(ctx, workspace.id, "running", "opened");
  check(!workspace.archivedAt, "opened", "still_archived");
  ctx.step("delete_one");
  await deleteWorkspace(ctx, workspace.id);

  // A5: two repositories.
  ctx.step("project_two");
  const projectTwo = await createProject(ctx, { name: `${prefix}two`, level: "organization", repositories: [one, two] });
  await waitCopyReady(ctx, projectTwo.id, "copy_two_ready");
  await copyMachines(ctx, projectTwo.id);
  ctx.step("workspace_two");
  const pair = await createWorkspace(ctx, { name: `${prefix}two-w`, projectId: projectTwo.id, branch: `${prefix}two` });
  counts.workspaces!++;
  ctx.state.created.branches.push({ repository: one, name: `${prefix}two` }, { repository: two, name: `${prefix}two` }); await ctx.save();
  const checkouts = pair.repositories ?? [];
  check(checkouts.length === 2, "workspace_two_repositories", `count_${checkouts.length}`);
  const first = checkouts.find(row => row.repository.toLowerCase() === one.toLowerCase());
  const second = checkouts.find(row => row.repository.toLowerCase() === two.toLowerCase());
  check(first && second, "workspace_two_repositories", "identity");
  bridge = await ctx.ports.bridge(pair.id);
  try {
    const root = await workspaceRoot(bridge, pair.id), scope = { workspaceId: pair.id, cwd: root };
    ctx.step("both_folders");
    for (const [index, checkout] of [first, second].entries()) {
      const marker = `${checkout.checkoutPath}/${prefix}folder-${index}.txt`;
      await writeFile(bridge, scope, marker, `${prefix}${index}\n`, `folder_${index}_write`);
      check(await readFile(bridge, scope, marker, `folder_${index}_read`) === `${prefix}${index}\n`, `folder_${index}_read`, "content");
    }
    ctx.step("pull_two");
    const inTwo = { ...scope, repository: second.repository };
    const pullFile = `${second.checkoutPath}/${prefix}pull.txt`;
    await writeFile(bridge, scope, pullFile, `${prefix}pull\n`, "pull_two_write");
    await bridge.op("git.commit", { ...inTwo, message: `${prefix}commit-two`, files: [pullFile] });
    await bridge.op("git.push", { ...inTwo, setUpstream: true });
    await openAndClosePull(ctx, pair.id, second.repository, `${prefix}pull-two`, "pull_two");
    counts.pulls!++;

    // A rewind across both: each turn writes a file in a different repository; resetting from the second
    // turn removes its file in R2 and keeps the first's in R1.
    ctx.step("rewind");
    const chatId = `${prefix}chat-rewind`;
    const firstFile = `${first.checkoutPath}/${prefix}rewind-1.txt`, secondFile = `${second.checkoutPath}/${prefix}rewind-2.txt`;
    await turn(ctx, bridge, pair, root, chatId, `Create the file ${firstFile} containing the single line one. Then reply with exactly: ok.`, "rewind_turn_1");
    await turn(ctx, bridge, pair, root, chatId, `Create the file ${secondFile} containing the single line two. Then reply with exactly: ok.`, "rewind_turn_2");
    counts.turns! += 2;
    check(await readFile(bridge, scope, firstFile, "rewind_file_1") !== null, "rewind_file_1", "not_written");
    check(await readFile(bridge, scope, secondFile, "rewind_file_2") !== null, "rewind_file_2", "not_written");
    const turns = parse(z.object({ turns: z.array(z.object({ chatId: z.string(), turnId: z.string(), startedAt: z.number() }).passthrough()) }),
      await bridge.op("turns.list", { ...scope, limit: 100 }), "rewind_turns").turns
      .filter(row => row.chatId === chatId).sort((left, right) => left.startedAt - right.startedAt);
    check(turns.length === 2, "rewind_turns", `count_${turns.length}`);
    await bridge.op("turns.reset", { ...scope, chatId, turnId: turns[1]!.turnId, mode: "filesAndTranscript" });
    check(await readFile(bridge, scope, secondFile, "rewind_after_2") === null, "rewind_after_2", "kept");
    check(await readFile(bridge, scope, firstFile, "rewind_after_1") !== null, "rewind_after_1", "removed");
  } finally { bridge.close(); }
  await ctx.ports.github.deleteBranch(two, `${prefix}two`);
  await ctx.ports.github.deleteBranch(one, `${prefix}two`).catch(() => undefined);
  ctx.step("delete_two");
  await deleteWorkspace(ctx, pair.id);

  // A6: deleting the projects removes every copy machine they had.
  ctx.step("copies_gone");
  const machines = [...new Set([...await copyMachines(ctx, projectOne.id), ...await copyMachines(ctx, projectTwo.id)])];
  await deleteProject(ctx, projectOne.id);
  await deleteProject(ctx, projectTwo.id);
  await until(ctx, "copies_gone", ctx.timing.copyMs, ctx.timing.pollMs, async () => {
    const left = await Promise.all(machines.map(machine => ctx.ports.boat.inspect(machine)));
    return left.every(row => row === null || row.state === "deleted");
  });
  counts.copiesGone = machines.length;
  return counts;
}

/** The workspace's machine was forked from a ready copy: the fork record is complete, and Boat named it "<source> fork". */
async function forkedFromCopy(ctx: StageContext, workspace: WorkspaceDocument): Promise<void> {
  const rows = await ctx.ports.database.read(`SELECT count(*)::int AS forks FROM cloud_v2_ready_copy_forks
    WHERE workspace_id = $1::uuid AND completed_at IS NOT NULL`, [workspace.id]);
  check(Number(rows[0]?.forks) === 1, "forked_from_copy", "no_fork_record");
  check(workspace.boatSandboxId, "forked_from_copy", "no_machine");
  const machine = await ctx.ports.boat.inspect(workspace.boatSandboxId);
  check(machine?.name?.endsWith(" fork"), "forked_from_copy", "not_a_fork");
}

/** gate0's terminal check: a PTY at the workspace root prints a marker and the branch. */
async function terminalRoundTrip(ctx: StageContext, bridge: Bridge, scope: { workspaceId: string; cwd: string }, sessionId: string, branch: string) {
  const created = parse(z.object({ type: z.literal("PTY_CREATED"), sessionId: z.string(), cwd: z.string() }).passthrough(),
    await bridge.request("PTY_CREATE", { ...scope, sessionId, cols: 120, rows: 30 }, "terminal_create"), "terminal_create");
  check(created.cwd === scope.cwd, "terminal_cwd", "mismatch");
  const marker = `${sessionId}:${branch}`;
  bridge.send("PTY_WRITE", { sessionId: created.sessionId, data: `printf '%s:%s\\n' '${sessionId}' "$(git branch --show-current)"\n` });
  await until(ctx, "terminal_output", ctx.timing.stateMs, ctx.timing.pollMs, async () => bridge.frames()
    .filter(frame => frame.type === "PTY_DATA" && frame.sessionId === created.sessionId)
    .map(frame => typeof frame.data === "string" ? frame.data : "").join("").includes(marker));
  bridge.send("PTY_KILL", { sessionId: created.sessionId });
}
