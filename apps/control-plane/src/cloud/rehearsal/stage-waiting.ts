// Stage waiting (#1260's safe switch-on): one workspace created while its organization's base is still being prepared,
// on real machines. It runs in a second, fresh Personal organization (test user 3 by default) so the main organization's
// base, which every other stage waits for before its first create, is never the one in question here.
//
// Rehearsed: the project queues the organization's automatic base (nobody presses Build); a create made at once answers
// with the workspace waiting for it ("Preparing the Cloud Computer…", document field `preparing: "computer"`, bound to
// that base); the base goes live; the workspace boots from it and is running, its boot deadline counted from when the
// base went live (#1260 F1: a wait past ten minutes used to fail it with worker_boot_timeout right after its VM booted).
import { RehearsalFailure, type Created, type StageContext } from "./contract.js";
import { prepareOwner } from "./stage-setup.js";
import { baseReady, check, createProject, deleteProject, deleteWorkspace, postWorkspace, readBase, recordRunBases, waitState } from "./steps.js";

/** The boot deadline a waiting create must not be measured against from its creation (lifecycle.ts BOOT_DEADLINE_MS). */
const BOOT_DEADLINE_MS = 10 * 60_000;

export const emptyCreated = (): Created => ({ projects: [], workspaces: [], machines: [], branches: [], pulls: [], environments: [], githubSignIns: [] });

/** Stage waiting's view of the run: its account's ports and its organization, with the run's own counters and state
 * file. What it creates is recorded under state.waiting, which cleanup removes as it does the main organization's. */
export function waitingContext(ctx: StageContext): StageContext {
  const waiting = ctx.state.waiting;
  if (!waiting) throw new RehearsalFailure("waiting_account", "not_started");
  const ports = { ...ctx.ports, ...(ctx.ports.waiting?.ports ?? {}) };
  return { ...ctx, ports, projectLevel: "personal",
    state: { ...ctx.state, organizationId: waiting.organizationId, organizations: [waiting.organizationId], created: waiting.created } };
}

export async function stageWaiting(ctx: StageContext): Promise<Record<string, number>> {
  check(ctx.state.owner === "personal", "owner", "personal_route_only");
  const account = ctx.ports.waiting;
  check(account, "waiting_account", "not_configured");
  check(account.organizationId !== ctx.state.organizationId, "waiting_account", "same_organization");
  if (!ctx.state.waiting) { ctx.state.waiting = { organizationId: account.organizationId, created: emptyCreated() }; await ctx.save(); }
  check(ctx.state.waiting.organizationId === account.organizationId, "waiting_account", "organization_changed");
  const sub = waitingContext(ctx);
  const counts: Record<string, number> = { proChanges: 0, githubSignIn: 0 };
  await prepareOwner(sub, counts);

  // Fresh: no base, nothing building, before this run's project (a resumed run that already caused its base goes on).
  ctx.step("waiting_fresh");
  const before = await readBase(sub, "waiting_fresh");
  check(before.state !== "absent", "waiting_fresh", "base_view_absent");
  if (!sub.state.created.bases?.length) check(before.state === "none", "waiting_fresh", `base_${before.state}`);

  ctx.step("waiting_project");
  const { prefix } = ctx.state;
  const project = await createProject(sub, { name: `${prefix}wait`, repositories: [ctx.repositories.one] }, "waiting_project");
  const queued = await readBase(sub, "waiting_base_queued");
  // Ready at once is the shared base (CLOUD_V2_SHARED_BASE_SNAPSHOT, no machine): there is then nothing to wait for.
  check(queued.state === "preparing", "waiting_base_queued", `base_${queued.state}`);
  const bases = await recordRunBases(sub);
  check(bases.length > 0, "waiting_base_queued", "not_automatic");

  // The create, made at once: it answers with the workspace waiting for that base.
  ctx.step("waiting_create");
  const startedAt = sub.ports.clock.now();
  const created = await postWorkspace(sub, { name: `${prefix}wait-w`, projectId: project.id, branch: `${prefix}wait` }, "waiting_create");
  check(created.state === "creating", "waiting_create", `state_${created.state}`);
  check(created.preparing === "computer", "waiting_create", "not_preparing");
  const row = (await sub.ports.database.read(`SELECT waiting_for_base_at IS NOT NULL AS waiting, computer_build_id::text AS build
    FROM cloud_v2_workspaces WHERE id = $1::uuid AND org_id = $2::uuid`, [created.id, sub.state.organizationId]))[0];
  check(row?.waiting === true, "waiting_create", "not_waiting");
  check(bases.includes(String(row.build)), "waiting_create", "not_bound_to_run_base");
  counts.createdWhilePreparing = 1;

  ctx.step("waiting_base_ready");
  await baseReady(sub, "waiting_base_ready");
  const waitedMs = sub.ports.clock.now() - startedAt;
  counts.baseWaitSeconds = Math.round(waitedMs / 1000);
  // Past the boot deadline counted from the create: the case #1260's F1 fix is for.
  counts.waitedPastBootDeadline = waitedMs > BOOT_DEADLINE_MS ? 1 : 0;

  ctx.step("waiting_running");
  const running = await waitState(sub, created.id, "running", "waiting_running");
  check(running.preparing === undefined, "waiting_running", "still_preparing");
  const pinned = (await sub.ports.database.read(`SELECT computer_build_id::text AS build FROM cloud_v2_workspaces WHERE id = $1::uuid AND org_id = $2::uuid`,
    [created.id, sub.state.organizationId]))[0];
  check(bases.includes(String(pinned?.build)), "waiting_running", "not_from_run_base");
  counts.bootedFromBase = 1;

  ctx.step("waiting_delete");
  await deleteWorkspace(sub, created.id, "waiting_delete");
  await deleteProject(sub, project.id, "waiting_project_delete");
  return counts;
}
