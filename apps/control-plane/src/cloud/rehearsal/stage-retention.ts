// Stage C, retention (CLOUD_V2_RETENTION_ENABLED): a workspace W with unpushed work in R2 and, in R1, either the seeded
// environment file edited by hand (when the account's environment for R1 was empty) or a hand-made ignored file, and a
// clean workspace K, through the stop, the backup, an invisible wake, Keep, the automatic archive, the
// archived wake's scrub, a deleted machine and the open that restores (W) or rebuilds (K); then, when S4 is deployed,
// the backup's removal. Clocks move only through shiftClock, on these two workspaces.
import { z } from "zod";
import { RehearsalFailure, type StageContext } from "./contract.js";
import { shiftClock } from "./clock.js";
import { rebuildComputer } from "./stage-setup.js";
import { readEnvironment, reportMachineSnapshot } from "./steps.js";
import { openBridge, call, check, checkText, clearEnvironment, ENVIRONMENT_PATH, seedEnvironments, createProject, createWorkspace, deleteProject, deleteWorkspace, getWorkspace, lifecycle, parse, shell, until,
  waitCopyReady, waitState, workspaceRoot, WorkspaceDocument, expectLine, seenShape } from "./steps.js";

const HOUR_DAYS = 1 / 24;

/** W's backup, as the product records it: a backup fork counted (its maintenance-wakes row), this stop's checkpoint saved,
 * and the fork's record cleared. */
export const BACKUP_STATE = `SELECT (SELECT count(*)::int FROM cloud_v2_maintenance_wakes m WHERE m.workspace_id = w.id AND m.kind = 'backup_fork') AS forks,
    w.checkpoint_object IS NOT NULL AND w.checkpoint_stop_generation IS NOT DISTINCT FROM w.stop_generation AS backed_up,
    w.checkpoint_retry_fork IS NULL AS fork_gone
  FROM cloud_v2_workspaces w WHERE w.id = $1::uuid`;

export async function stageRetention(ctx: StageContext): Promise<Record<string, number>> {
  const { prefix } = ctx.state, one = ctx.repositories.one, two = ctx.repositories.two;
  check(two, "repository_two", "missing");
  const counts: Record<string, number> = { shifts: 0, wakes: 0, restored: 0, rebuilt: 0, removal: 0 };
  const shift = async (ids: string[], days: number) => { await shiftClock(ctx.ports.database, ctx.state, ids, days); counts.shifts!++; await ctx.save(); };

  ctx.step("project");
  const project = await createProject(ctx, { name: `${prefix}ret`, repositories: [one, two] });
  await waitCopyReady(ctx, project.id);
  // The two cases exercise different rules: a seeded file edited by hand (the seed journal) or an unseeded ignored file.
  ctx.step("environment_seed");
  const r1 = project.repositories.find(row => row.repository.toLowerCase() === one.toLowerCase());
  check(r1, "environment_seed", "repository");
  const seedBytes = `${prefix}seed\n`, handBytes = `${prefix}person-bytes`;
  const seed = await seedEnvironments(ctx, [{ repository: r1.repository, repositoryId: r1.repositoryId }], () => seedBytes);
  ctx.note(seed.seeded ? "environment_case:seeded_edited" : "environment_case:hand_made_ignored");
  if (!seed.seeded) ctx.note(`environment_skipped:${seed.reason}`);
  // The worker seeds R1's checkout with every file R1's environment holds, whoever wrote it; the archived wake's scrub
  // removes exactly those (archive-scrub.ts, by the seed journal). So W's scrub reads "backup" when there was one.
  const seededFiles = (await readEnvironment(ctx, r1.repository, r1.repositoryId, "environment_files")).files;
  ctx.step("workspaces");
  const w = await createWorkspace(ctx, { name: `${prefix}ret-w`, projectId: project.id, branch: `${prefix}ret-w` });
  const k = await createWorkspace(ctx, { name: `${prefix}ret-k`, projectId: project.id, branch: `${prefix}ret-k` });
  const both = [w.id, k.id];
  const first = checkout(w, one), second = checkout(w, two);

  // C1: unpushed work in R2 (a commit and an untracked file), the person's own bytes in an ignored file in R1, then stop.
  ctx.step("unpushed_work");
  const ignored = seed.seeded ? ENVIRONMENT_PATH : `${prefix}hand.env`;
  const ignoredBytes = seed.seeded ? `${seedBytes}${handBytes}\n` : `${handBytes}\n`;
  let bridge = await openBridge(ctx, w.id);
  try {
    const root = await workspaceRoot(bridge, w.id), scope = { workspaceId: w.id, cwd: root };
    const r2 = await shell(ctx, bridge, { ...scope, cwd: second.checkoutPath }, `${prefix}pty-r2`,
      `printf '%s\\n' '${prefix}committed' > '${prefix}committed.txt' && git add '${prefix}committed.txt' && ` +
      `git -c user.name=rehearsal -c user.email=rehearsal@invalid commit -q -m '${prefix}unpushed' && printf '%s\\n' '${prefix}untracked' > '${prefix}untracked.txt'`, "unpushed_r2");
    check(r2.exitCode === 0, "unpushed_r2", `exit_${r2.exitCode}`);
    if (seed.seeded) {
      await checkText(bridge, scope, `${first.checkoutPath}/${ENVIRONMENT_PATH}`, seedBytes, "seeded_r1", "content", w);
      const edit = await shell(ctx, bridge, { ...scope, cwd: first.checkoutPath }, `${prefix}pty-r1`,
        `printf '%s\\n' '${handBytes}' >> '${ENVIRONMENT_PATH}' && git check-ignore -q '${ENVIRONMENT_PATH}'`, "edited_r1");
      check(edit.exitCode === 0, "edited_r1", `exit_${edit.exitCode}`);
    } else {
      const made = await shell(ctx, bridge, { ...scope, cwd: first.checkoutPath }, `${prefix}pty-r1`,
        `printf '%s\\n' '${prefix}*.env' >> "$(git rev-parse --git-path info/exclude)" && printf '%s\\n' '${handBytes}' > '${ignored}' && ` +
        `git check-ignore -q '${ignored}'`, "ignored_r1");
      check(made.exitCode === 0, "ignored_r1", `exit_${made.exitCode}`);
    }
  } finally { bridge.close(); }
  ctx.step("stop");
  for (const id of both) await lifecycle(ctx, id, "stop", "stop");
  for (const id of both) await waitState(ctx, id, "stopped", "stopped");
  check((await ctx.ports.storage.keys(w.id)).length === 0, "stop_no_upload", "uploaded");
  // The stop's own record: its probe, and that it verified the worker unit stopped and disabled (a stopped machine runs no
  // command, so the row is the evidence).
  const probes = await ctx.ports.database.read(`SELECT id::text AS id, backup_probe, backup_probe_generation = stop_generation AS current_probe,
      worker_off_unverified_at IS NULL AS worker_off FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [both]);
  check(probes.find(row => row.id === w.id)?.backup_probe === "dirty", "stop_probe_w", "not_dirty");
  check(probes.find(row => row.id === k.id)?.backup_probe === "clean", "stop_probe_k", "not_clean");
  check(probes.length === 2 && probes.every(row => row.current_probe === true), "stop_probe", "not_this_stop");
  check(probes.every(row => row.worker_off === true), "stop_worker_off", "unverified");

  // C2: an hour later, W's backup fork runs and uploads one object; K, clean, has none.
  ctx.step("backup");
  await shift(both, HOUR_DAYS + 1 / 1440);
  // A backup fork's own record is the workspace row (store.ts beginCheckpointFork, saveCheckpoint): this stop's checkpoint
  // saved and the fork record cleared once the fork is gone. Its maintenance-wakes row only counts the machine start in
  // the shared budget; nothing ever finishes it, so its outcome is never read. Then the object itself, in storage.
  const backupState = async () => {
    const row = (await ctx.ports.database.read(BACKUP_STATE, [w.id]))[0];
    const keys = (await ctx.ports.storage.keys(w.id)).length;
    return !row ? "no_row" : Number(row.forks) < 1 ? "no_fork" : row.backed_up !== true ? "not_backed_up" : row.fork_gone !== true ? "fork_present"
      : keys < 1 ? "no_object" : null;
  };
  const backedUp = (step: string) => until(ctx, step, ctx.timing.scanMs, ctx.timing.pollMs, async () => await backupState() === null)
    .catch(async (error: unknown) => {
      const missing = await backupState().catch(() => null);
      throw missing && error instanceof RehearsalFailure && error.code === "timeout" ? new RehearsalFailure(step, `timeout:${missing}`) : error;
    });
  await backedUp("backup");
  check((await ctx.ports.storage.keys(k.id)).length === 0, "backup_k", "uploaded");

  // C3: at ten days a maintenance wake runs and is invisible: stopped throughout, its activity and update times unchanged.
  ctx.step("invisible_wake");
  const before = await documents(ctx, both, "wake_before");
  await shift(both, 10.6);
  const shifted = await documents(ctx, both, "wake_shifted");
  await until(ctx, "invisible_wake", ctx.timing.scanMs, 2_000 < ctx.timing.pollMs ? 2_000 : ctx.timing.pollMs, async () => {
    const now = await documents(ctx, both, "invisible_wake");
    check(now.every(row => row.state === "stopped"), "invisible_wake", "visible_state");
    const rows = await ctx.ports.database.read(`SELECT count(*)::int AS wakes FROM cloud_v2_maintenance_wakes
      WHERE workspace_id = ANY($1::uuid[]) AND kind = 'wake' AND outcome = 'stopped'`, [both]);
    return Number(rows[0]?.wakes) >= 2;
  });
  counts.wakes! += 2;
  // Boat's record of each machine's archive after the wake's own stop, so a failed snapshot attempt at that stop is
  // visible in the run.
  for (const [label, id] of [["wake_w", w.id], ["wake_k", k.id]] as const) {
    const machine = (await getWorkspace(ctx, id, `${label}_machine`))?.boatSandboxId;
    if (machine) await reportMachineSnapshot(ctx, machine, label, counts);
  }
  const after = await documents(ctx, both, "wake_after");
  for (const [index, row] of after.entries())
    check(row.activeAt === shifted[index]!.activeAt && row.updatedAt === shifted[index]!.updatedAt, "invisible_wake", "document_changed");
  check(before.length === 2, "invisible_wake", "documents");

  // C4: Keep on, then off, each read back on the document.
  ctx.step("keep");
  const keep = async (method: "PUT" | "DELETE") => parse(z.object({ workspace: WorkspaceDocument }),
    (await call(ctx.ports.api, method, `/v1/cloud-v2/workspaces/${w.id}/keep`, `keep_${method.toLowerCase()}`)).body, "keep").workspace.keep;
  check(await keep("PUT") === true, "keep_on", "not_kept");
  check(await keep("DELETE") === false, "keep_off", "still_kept");

  // C5: thirty days without activity: archived as inactive, with the removal and machine dates.
  ctx.step("archive");
  await shift(both, 31);
  await until(ctx, "archive", ctx.timing.archiveScanMs, ctx.timing.pollMs, async () => {
    const rows = await documents(ctx, both, "archive");
    return rows.every(row => row.archivedAt && row.archiveReason === "inactive");
  });
  const archived = await documents(ctx, both, "archive_fields");
  // The backup's removal date only where there is a backup. The machine's date is checked after the archived wake: the
  // product leaves out an estimate already past (store.ts archiveFields), and the clock shift has made this one past.
  check(archived[0]!.backupRemovalAt, "archive_fields", "w_removal");
  check(!archived[1]!.backupRemovalAt, "archive_fields", "k_removal");

  // C6: the archived wake scrubs the machine; W's scrub is covered by its backup.
  ctx.step("archived_wake");
  await shift(both, 10.6);
  await until(ctx, "archived_wake", ctx.timing.scanMs, ctx.timing.pollMs, async () => {
    const rows = await ctx.ports.database.read(`SELECT id::text AS id, archive_scrub FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [both]);
    return rows.length === 2 && rows.every(row => row.archive_scrub !== null);
  });
  const scrubs = await ctx.ports.database.read(`SELECT id::text AS id, archive_scrub FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [both]);
  // W's scrub removes the environment files seeded into its checkout, which its backup holds ("backup"); with none (an
  // environment of variables only, or none) there is nothing to remove: "clean". K, whose probe was clean, re-seeds: "clean".
  const wScrub = seededFiles > 0 ? "backup" : "clean";
  check(scrubs.find(row => row.id === w.id)?.archive_scrub === wScrub, "archived_wake_w", `not_${wScrub}`);
  check(scrubs.find(row => row.id === k.id)?.archive_scrub === "clean", "archived_wake_k", "not_clean");
  counts.wakes! += 2;
  // Its stop starts the machine's own clock again: both documents now carry the date Boat is expected to remove it.
  const woken = await documents(ctx, both, "archive_machine_dates");
  check(woken.every(row => row.machineExpectedGoneAt), "archive_machine_dates", "absent");

  // C6b: W opened on its own machine, after the maintenance wakes' stops (the 10-day wake, the archived wake's scrub):
  // the unpushed commit and the untracked file written just before the person's stop are still on its disk. Then stopped
  // again; its backup is untouched, and C7 restores from it.
  ctx.step("own_disk_open");
  await lifecycle(ctx, w.id, "start", "own_disk_open");
  await waitState(ctx, w.id, "running", "own_disk_running");
  bridge = await openBridge(ctx, w.id);
  try {
    const root = await workspaceRoot(bridge, w.id), scope = { workspaceId: w.id, cwd: root };
    await expectLine(ctx, bridge, { ...scope, cwd: second.checkoutPath }, `${prefix}pty-own`, "git --no-pager log --format=%s -n 20", `${prefix}unpushed`, "own_disk_commit");
    await checkText(bridge, scope, `${second.checkoutPath}/${prefix}untracked.txt`, `${prefix}untracked\n`, "own_disk_untracked", "missing", w);
  } finally { bridge.close(); }
  counts.ownDiskKept = 1;
  await lifecycle(ctx, w.id, "stop", "own_disk_stop");
  await waitState(ctx, w.id, "stopped", "own_disk_stopped");
  // That stop is a new stop generation, still dirty (the unpushed commit): its own backup comes an hour later, by fork
  // (the same content, so the earlier checkpoint is confirmed for it). Without it, C7's restore would rightly bring back
  // the earlier backup and note lost work.
  ctx.step("own_disk_backup");
  await shift([w.id], HOUR_DAYS + 1 / 1440);
  await backedUp("own_disk_backup");

  // C7: W's machine deleted (the run's one deliberate machine deletion), then opened: restored from its backup.
  // The Cloud Computer is rebuilt (as a runtime change or the daily refresh does): the workspaces' own builds are replaced
  // and their snapshots cleaned up, so the opens below must rebuild from the live build, never fail for want of an image.
  ctx.step("computer_rebuild");
  const computer = await rebuildComputer(ctx);
  counts.computerRebuilt = 1;
  ctx.step("restore");
  const machineW = (await getWorkspace(ctx, w.id, "restore_machine"))?.boatSandboxId;
  const machineK = (await getWorkspace(ctx, k.id, "rebuild_machine"))?.boatSandboxId;
  check(machineW && machineK, "restore_machine", "missing");
  for (const machine of [machineW, machineK]) await ctx.ports.boat.delete(machine);
  await until(ctx, "machine_deleted", ctx.timing.stateMs, ctx.timing.pollMs, async () =>
    (await Promise.all([machineW, machineK].map(machine => ctx.ports.boat.inspect(machine)))).every(row => row === null || row.state === "deleted"));
  await lifecycle(ctx, w.id, "start", "restore_open");
  const restored = await waitState(ctx, w.id, "running", "restored");
  check(!restored.archivedAt && !restored.lostWork, "restored", restored.lostWork ? "lost_work" : "still_archived");
  bridge = await openBridge(ctx, w.id);
  try {
    const root = await workspaceRoot(bridge, w.id), scope = { workspaceId: w.id, cwd: root };
    await expectLine(ctx, bridge, { ...scope, cwd: second.checkoutPath }, `${prefix}pty-log`, "git --no-pager log --format=%s -n 20", `${prefix}unpushed`, "restored_commit");
    await checkText(bridge, scope, `${second.checkoutPath}/${prefix}untracked.txt`, `${prefix}untracked\n`, "restored_untracked", "missing", w);
    await checkText(bridge, scope, `${first.checkoutPath}/${ignored}`, ignoredBytes, "restored_ignored", "bytes", w);
  } finally { bridge.close(); }
  counts.restored!++;

  // C8: K, clean, with its machine deleted: opened, rebuilt from GitHub, nothing reported lost.
  ctx.step("rebuild");
  const pinOf = async () => (await ctx.ports.database.read("SELECT id::text AS id, computer_build_id::text AS build FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])",
    [both])).find(row => row.id === k.id)?.build ?? null;
  const pinBefore = await pinOf();
  await lifecycle(ctx, k.id, "start", "rebuild_open");
  const rebuilt = await waitState(ctx, k.id, "running", "rebuilt");
  check(!rebuilt.archivedAt && !rebuilt.lostWork, "rebuilt", rebuilt.lostWork ? "lost_work" : "still_archived");
  // Which image the open used is the product's choice: a fork of the project's ready copy keeps the pin as it was (every
  // later image read uses the organization's active build); a create (no copy, or the fork refused) pins the live build.
  // The stage cannot tell which ran, so the pin is a note; what it asserts is the checkout: at each repository's head.
  const pinAfter = await pinOf();
  ctx.note(`rebuilt_pin:${pinAfter === computer.current ? "live" : pinAfter === pinBefore ? "unchanged" : "other"}`);
  bridge = await openBridge(ctx, k.id);
  try {
    const root = await workspaceRoot(bridge, k.id), scope = { workspaceId: k.id, cwd: root };
    for (const [index, repository] of [one, two].entries()) {
      const expected = await ctx.ports.github.defaultHead?.(repository) ?? null;
      if (!expected) { ctx.note(`rebuilt_head_${index + 1}:not_read`); continue; }
      const head = await shell(ctx, bridge, { ...scope, cwd: checkout(rebuilt, repository).checkoutPath }, `${prefix}pty-k${index + 1}`,
        `printf 'zr-head %s\\n' "$(git rev-parse HEAD)"`, `rebuilt_head_${index + 1}`);
      const seen = /^zr-head ([0-9a-f]{40})$/m.exec(head.output)?.[1];
      check(seen === expected, `rebuilt_head_${index + 1}`, seen ? "other_commit" : `unread:${seenShape(head.output)}`);
    }
  } finally { bridge.close(); }
  counts.rebuilt!++;

  // C9: S4 (#1246) deployed: an archived backup is removed at 60 days, and `restores` says what opening would bring back.
  ctx.step("removal");
  const deployed = (await ctx.ports.database.read(`SELECT count(*)::int AS present FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'cloud_v2_backup_removals'`))[0]?.present;
  if (Number(deployed) === 1) {
    await lifecycle(ctx, w.id, "stop", "removal_stop");
    await waitState(ctx, w.id, "stopped", "removal_stopped");
    // The backup it was restored from is still W's: that is what the removal must take.
    check((await ctx.ports.storage.keys(w.id)).length >= 1, "removal_backup", "missing");
    await lifecycle(ctx, w.id, "archive", "removal_archive");
    await until(ctx, "removal_archived", ctx.timing.stateMs, ctx.timing.pollMs, async () => (await getWorkspace(ctx, w.id, "removal_archived"))?.archivedAt);
    check((await getWorkspace(ctx, w.id, "removal_restores"))?.restores !== undefined, "removal_restores", "absent");
    await shift([w.id], 61);
    await until(ctx, "removal", ctx.timing.archiveScanMs, ctx.timing.pollMs, async () => (await ctx.ports.storage.keys(w.id)).length === 0);
    const removed = await getWorkspace(ctx, w.id, "removal_document");
    check(removed && !removed.backupRemovalAt && removed.restores !== undefined, "removal_document", "fields");
    counts.removal = 1;
  } else counts.removal = 0;

  ctx.step("delete");
  for (const id of both) await deleteWorkspace(ctx, id);
  await deleteProject(ctx, project.id);
  if (seed.seeded) for (const target of ctx.state.created.environments) await clearEnvironment(ctx, target);
  return counts;
}

function checkout(workspace: WorkspaceDocument, repository: string) {
  const found = workspace.repositories?.find(row => row.repository.toLowerCase() === repository.toLowerCase());
  if (!found) throw new RehearsalFailure("workspace_repositories", "identity");
  return found;
}
async function documents(ctx: StageContext, ids: readonly string[], step: string): Promise<WorkspaceDocument[]> {
  const rows: WorkspaceDocument[] = [];
  for (const id of ids) { const row = await getWorkspace(ctx, id, step); check(row, step, "missing"); rows.push(row); }
  return rows;
}
