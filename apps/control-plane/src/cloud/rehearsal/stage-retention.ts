// Stage C, retention (CLOUD_V2_RETENTION_ENABLED): a workspace W with unpushed work in R2 and a hand-written ignored file
// in R1, and a clean workspace K, through the stop, the backup, an invisible wake, Keep, the automatic archive, the
// archived wake's scrub, a deleted machine and the open that restores (W) or rebuilds (K); then, when S4 is deployed,
// the backup's removal. Clocks move only through shiftClock, on these two workspaces.
import { z } from "zod";
import { RehearsalFailure, type StageContext } from "./contract.js";
import { shiftClock } from "./clock.js";
import { call, check, createProject, createWorkspace, deleteProject, deleteWorkspace, getWorkspace, lifecycle, parse, readFile, shell, until,
  waitCopyReady, waitState, workspaceRoot, WorkspaceDocument } from "./steps.js";

const HOUR_DAYS = 1 / 24;

export async function stageRetention(ctx: StageContext): Promise<Record<string, number>> {
  const { prefix } = ctx.state, one = ctx.repositories.one, two = ctx.repositories.two;
  check(two, "repository_two", "missing");
  const counts: Record<string, number> = { shifts: 0, wakes: 0, restored: 0, rebuilt: 0, removal: 0 };
  const shift = async (ids: string[], days: number) => { await shiftClock(ctx.ports.database, ctx.state, ids, days); counts.shifts!++; await ctx.save(); };

  ctx.step("project");
  const project = await createProject(ctx, { name: `${prefix}ret`, level: "organization", repositories: [one, two] });
  await waitCopyReady(ctx, project.id);
  ctx.step("workspaces");
  const w = await createWorkspace(ctx, { name: `${prefix}ret-w`, projectId: project.id, branch: `${prefix}ret-w` });
  const k = await createWorkspace(ctx, { name: `${prefix}ret-k`, projectId: project.id, branch: `${prefix}ret-k` });
  const both = [w.id, k.id];
  const first = checkout(w, one), second = checkout(w, two);

  // C1: unpushed work in R2 (a commit and an untracked file), a hand-written ignored file in R1, then stop.
  ctx.step("unpushed_work");
  const ignored = `${prefix}hand.env`, ignoredBytes = `${prefix}person-bytes\n`;
  let bridge = await ctx.ports.bridge(w.id);
  try {
    const root = await workspaceRoot(bridge, w.id), scope = { workspaceId: w.id, cwd: root };
    const r2 = await shell(ctx, bridge, { ...scope, cwd: second.checkoutPath }, `${prefix}pty-r2`,
      `printf '%s\\n' '${prefix}committed' > '${prefix}committed.txt' && git add '${prefix}committed.txt' && ` +
      `git -c user.name=rehearsal -c user.email=rehearsal@invalid commit -q -m '${prefix}unpushed' && printf '%s\\n' '${prefix}untracked' > '${prefix}untracked.txt'`, "unpushed_r2");
    check(r2.exitCode === 0, "unpushed_r2", `exit_${r2.exitCode}`);
    const r1 = await shell(ctx, bridge, { ...scope, cwd: first.checkoutPath }, `${prefix}pty-r1`,
      `printf '%s\\n' '${prefix}*.env' >> "$(git rev-parse --git-path info/exclude)" && printf '%s\\n' '${prefix}person-bytes' > '${ignored}' && ` +
      `git check-ignore -q '${ignored}'`, "ignored_r1");
    check(r1.exitCode === 0, "ignored_r1", `exit_${r1.exitCode}`);
  } finally { bridge.close(); }
  ctx.step("stop");
  for (const id of both) await lifecycle(ctx, id, "stop", "stop");
  for (const id of both) await waitState(ctx, id, "stopped", "stopped");
  check((await ctx.ports.storage.keys(w.id)).length === 0, "stop_no_upload", "uploaded");
  const probes = await ctx.ports.database.read(`SELECT id::text AS id, backup_probe FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [both]);
  check(probes.find(row => row.id === w.id)?.backup_probe === "dirty", "stop_probe_w", "not_dirty");
  check(probes.find(row => row.id === k.id)?.backup_probe === "clean", "stop_probe_k", "not_clean");

  // C2: an hour later, W's backup fork runs and uploads one object; K, clean, has none.
  ctx.step("backup");
  await shift(both, HOUR_DAYS + 1 / 1440);
  await until(ctx, "backup", ctx.timing.scanMs, ctx.timing.pollMs, async () => {
    const rows = await ctx.ports.database.read(`SELECT count(*)::int AS forks FROM cloud_v2_maintenance_wakes
      WHERE workspace_id = $1::uuid AND kind = 'backup_fork' AND outcome = 'stopped'`, [w.id]);
    return Number(rows[0]?.forks) >= 1 && (await ctx.ports.storage.keys(w.id)).length >= 1;
  });
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
  check(archived[0]!.backupRemovalAt && archived[0]!.machineExpectedGoneAt, "archive_fields", "w_dates");
  check(archived[1]!.machineExpectedGoneAt && !archived[1]!.backupRemovalAt, "archive_fields", "k_dates");

  // C6: the archived wake scrubs the machine; W's scrub is covered by its backup.
  ctx.step("archived_wake");
  await shift(both, 10.6);
  await until(ctx, "archived_wake", ctx.timing.scanMs, ctx.timing.pollMs, async () => {
    const rows = await ctx.ports.database.read(`SELECT id::text AS id, archive_scrub FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [both]);
    return rows.length === 2 && rows.every(row => row.archive_scrub !== null);
  });
  const scrubs = await ctx.ports.database.read(`SELECT id::text AS id, archive_scrub FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])`, [both]);
  check(scrubs.find(row => row.id === w.id)?.archive_scrub === "backup", "archived_wake_w", "not_backup");
  check(scrubs.find(row => row.id === k.id)?.archive_scrub === "clean", "archived_wake_k", "not_clean");
  counts.wakes! += 2;

  // C7: W's machine deleted (the run's one deliberate machine deletion), then opened: restored from its backup.
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
  bridge = await ctx.ports.bridge(w.id);
  try {
    const root = await workspaceRoot(bridge, w.id), scope = { workspaceId: w.id, cwd: root };
    const log = await shell(ctx, bridge, { ...scope, cwd: second.checkoutPath }, `${prefix}pty-log`, "git log --format=%s -n 20", "restored_commit");
    check(log.output.split(/\r?\n/).some(line => line.trim() === `${prefix}unpushed`), "restored_commit", "missing");
    check(await readFile(bridge, scope, `${second.checkoutPath}/${prefix}untracked.txt`, "restored_untracked") === `${prefix}untracked\n`, "restored_untracked", "missing");
    check(await readFile(bridge, scope, `${first.checkoutPath}/${ignored}`, "restored_ignored") === ignoredBytes, "restored_ignored", "bytes");
  } finally { bridge.close(); }
  counts.restored!++;

  // C8: K, clean, with its machine deleted: opened, rebuilt from GitHub, nothing reported lost.
  ctx.step("rebuild");
  await lifecycle(ctx, k.id, "start", "rebuild_open");
  const rebuilt = await waitState(ctx, k.id, "running", "rebuilt");
  check(!rebuilt.archivedAt && !rebuilt.lostWork, "rebuilt", rebuilt.lostWork ? "lost_work" : "still_archived");
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
