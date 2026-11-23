// Stage B, personal cloud (CLOUD_V2_PERSONAL_CLOUD_ENABLED), on the Personal route after setup: a personal project and
// workspace in the test user's Personal organization; a second test user sees none of it; Pro ended, the workspace is
// refused (403 pro_required), its connect too, and the machine stops (the minutes measured); Pro again, it opens.
import { z } from "zod";
import { type StageContext } from "./contract.js";
import { TEAM_OWNERSHIP_HEADER, TEAM_SHARING_HEADER } from "../team-sharing/contract.js";

/** The desktop's TEAM_SHARING_HEADERS, by the server's own header names. */
const TEAM_SHARING_READ_HEADERS = { [TEAM_SHARING_HEADER]: "1", [TEAM_OWNERSHIP_HEADER]: "1" };
import { changePro, personalSeat } from "./stage-setup.js";
import { call, check, connectWorkspace, errorCode, createProject, createWorkspace, deleteProject, deleteWorkspace, lifecycle, until, waitCopyReady, waitState } from "./steps.js";

const DAY_MS = 86_400_000;

export async function stagePersonal(ctx: StageContext): Promise<Record<string, number>> {
  check(ctx.state.owner === "personal", "owner", "personal_route_only");
  const { other, pro } = ctx.ports;
  check(pro && ctx.state.created.pro, "pro", "run_setup_first");
  check(other, "other_account", "not_configured");
  check(await personalSeat(ctx) === "pro", "pro", "inactive");
  const { prefix } = ctx.state, organizationId = ctx.state.organizationId;
  const counts: Record<string, number> = { workspaces: 0, hiddenReads: 0, minutesToStop: 0 };

  ctx.step("project");
  const project = await createProject(ctx, { name: `${prefix}p`, repositories: [ctx.repositories.one] });
  await waitCopyReady(ctx, project.id);
  ctx.step("workspace");
  const workspace = await createWorkspace(ctx, { name: `${prefix}p-w`, projectId: project.id, branch: `${prefix}p` });
  counts.workspaces!++;

  // B5: the second test user reaches none of it, on any route, exactly as for something that does not exist.
  ctx.step("other_sees_nothing");
  const slug = z.object({ organizations: z.array(z.object({ id: z.string(), slug: z.string().nullable().optional() }).passthrough()) }).passthrough()
    .parse((await call(ctx.ports.api, "GET", "/v1/me", "me")).body).organizations.find(org => org.id === organizationId)?.slug;
  const number = (workspace as { number?: unknown }).number;
  const hidden: [string, string][] = [
    [`/v1/cloud-v2/workspaces/${workspace.id}`, "other_workspace"],
    [`/v1/cloud-v2/organizations/${organizationId}/cloud-projects`, "other_projects"],
    [`/v1/cloud-v2/organizations/${organizationId}/cloud-projects/${project.id}`, "other_project"],
    ...(slug && typeof number === "number" ? [[`/v1/cloud-v2/workspaces/by-number/${slug}/${number}`, "other_by_number"] as [string, string]] : []),
  ];
  // Each read twice: plain, and as today's desktop reads a workspace and the list, with its team-sharing headers
  // (apps/desktop/src/renderer/platform/control-plane-headers.ts TEAM_SHARING_HEADERS), which route a shared
  // workspace through the team path: both must hide it.
  for (const headers of [{}, TEAM_SHARING_READ_HEADERS]) {
    for (const [path, step] of hidden) { await call(other, "GET", path, step, undefined, { ok: [404], headers }); counts.hiddenReads!++; }
    const listed = await call(other, "GET", `/v1/cloud-v2/workspaces?organizationId=${organizationId}`, "other_list", undefined, { ok: [200, 403, 404], headers });
    check(listed.status !== 200 || !JSON.stringify(listed.body).includes(workspace.id), "other_list", "visible");
  }
  counts.hiddenReads!++;

  // B3: Pro ended. The owner's workspace answers 403 pro_required and refuses a connect; the machine stops.
  ctx.step("pro_off");
  const now = ctx.ports.clock.now();
  await changePro(ctx, { enabled: false, validFrom: new Date(now - 60_000).toISOString(), validUntil: null }, "off");
  const stoppedFrom = ctx.ports.clock.now();
  await until(ctx, "pro_required", ctx.timing.stateMs, ctx.timing.pollMs, async () =>
    (await call(ctx.ports.api, "GET", `/v1/cloud-v2/workspaces/${workspace.id}`, "pro_required", undefined, { ok: [200, 403] })).status === 403);
  const refused = await call(ctx.ports.api, "GET", `/v1/cloud-v2/workspaces/${workspace.id}`, "pro_required_code", undefined, { ok: [403] });
  check(errorCode(refused) === "http_403_pro_required", "pro_required_code", "other_code");
  const connect = await connectWorkspace(ctx.ports.api, workspace.id, "connect_refused", [403]);
  check(errorCode(connect) === "http_403_pro_required", "connect_refused", "other_code");
  ctx.note("worker_token:not_observable");
  ctx.step("idle_stop");
  await until(ctx, "idle_stop", ctx.timing.idleStopMs, ctx.timing.pollMs, async () =>
    (await ctx.ports.database.read("SELECT state FROM cloud_v2_workspaces WHERE id = $1::uuid", [workspace.id]))[0]?.state === "stopped");
  counts.minutesToStop = Math.round((ctx.ports.clock.now() - stoppedFrom) / 60_000);

  // B4: Pro again; the workspace opens.
  ctx.step("pro_on");
  const again = ctx.ports.clock.now();
  await changePro(ctx, { enabled: true, validFrom: new Date(again - 60_000).toISOString(), validUntil: new Date(again + DAY_MS).toISOString() }, "on");
  await until(ctx, "pro_again", ctx.timing.stateMs, ctx.timing.pollMs, async () =>
    (await call(ctx.ports.api, "GET", `/v1/cloud-v2/workspaces/${workspace.id}`, "pro_again", undefined, { ok: [200, 403] })).status === 200);
  await lifecycle(ctx, workspace.id, "start", "reopen");
  await waitState(ctx, workspace.id, "running", "reopened");

  ctx.step("delete");
  await deleteWorkspace(ctx, workspace.id);
  await deleteProject(ctx, project.id);
  return counts;
}
