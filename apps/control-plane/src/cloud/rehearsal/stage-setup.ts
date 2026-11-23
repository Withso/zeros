// Stage setup. On the Personal route: the selected test user's Individual Pro (manage-account-pro.ts, actor the one active
// platform owner) and its own GitHub sign-in by token, so its Personal organization is a full cloud owner. Both are
// recorded before they are made, and cleanup puts both back. On the organization route it is a proposal, refused until
// approved (plan.ts lists it).
import { z } from "zod";
import { RehearsalFailure, type ProGrant, type StageContext } from "./contract.js";
import { call, check, connectAgentLogin, githubSignIn, parse, readBase, until } from "./steps.js";

const DAY_MS = 86_400_000;

export async function stageSetup(ctx: StageContext): Promise<Record<string, number>> {
  if (ctx.state.owner !== "personal") throw new RehearsalFailure("setup", "organization_route_awaiting_approval");
  const counts: Record<string, number> = { proChanges: 0, githubSignIn: 0 };
  await prepareOwner(ctx, counts);

  // The rehearsal's agent credentials, every one .env.agent has: each connected for this account here, as Settings does,
  // so the turns run on each. A connection already there that this run did not make is left alone (and used).
  for (const credential of ctx.ports.agentCredentials ?? []) {
    ctx.step(`agent_login_${credential.provider}`);
    const outcome = await connectAgentLogin(ctx, credential);
    ctx.note(`agent_login:${outcome}:${credential.provider}`);
    counts.agentLogins = (counts.agentLogins ?? 0) + (outcome === "connected" ? 1 : 0);
  }

  // The organization's base (#1260): nobody presses Build. Zeros prepares it at the first project (or a create), so
  // setup only reads what there is; the first create waits for it (steps.ts baseReady), and stage waiting rehearses a
  // create made while one is still being prepared.
  ctx.step("cloud_computer");
  const base = await readBase(ctx, "cloud_computer");
  check(base.state !== "absent", "cloud_computer", "base_view_absent");
  check(base.state !== "unavailable", "cloud_computer", "base_unavailable");
  ctx.note(`cloud_computer:base_${base.state}`);
  counts.baseReadyAtSetup = base.state === "ready" ? 1 : 0;
  return counts;
}

/** The Personal organization as a full cloud owner: Pro for its account, and its own GitHub sign-in by token. Each change
 * is recorded before it is made. Stage waiting runs it for its own account and organization. */
export async function prepareOwner(ctx: StageContext, counts: Record<string, number>): Promise<void> {
  const { pro, githubSignIn: signIn } = ctx.ports;
  check(pro, "setup_pro", "not_configured");
  check(signIn, "setup_github_sign_in", "not_configured");
  ctx.step("pro");
  await grantPro(ctx, counts);
  ctx.step("personal_cloud");
  await until(ctx, "personal_cloud", ctx.timing.stateMs, ctx.timing.pollMs, async () => await personalSeat(ctx) === "pro");

  ctx.step("github_sign_in");
  const organizationId = ctx.state.organizationId;
  const status = await githubSignIn(ctx, organizationId, "github_sign_in_read");
  const ours = ctx.state.created.githubSignIns.includes(organizationId);
  // Never replace a sign-in this run did not make: a person's own, or another run's.
  check(!status.methods.pat.configured || ours, "github_sign_in", "exists");
  check(!status.methods["github-app"].configured, "github_sign_in", "app_sign_in_exists");
  if (!status.methods.pat.configured) {
    if (!ours) { ctx.state.created.githubSignIns.push(organizationId); await ctx.save(); }
    await signIn.connect(organizationId, status.generation);
  }
  const after = await githubSignIn(ctx, organizationId, "github_sign_in_after");
  check(after.methods.pat.configured && after.selectedMethod === "pat", "github_sign_in_after", "not_connected");
  counts.githubSignIn = 1;
}

const Computer = z.object({ activeBuildId: z.string().nullable(), recipeRevision: z.number().int().nonnegative(),
  builds: z.array(z.object({ id: z.string(), state: z.string(), builderSandboxId: z.string().nullable().optional() }).passthrough()) }).passthrough();

/** Pro on for a day, unless it already runs at least half a day longer; the grant before the run's first change is kept. */
export async function grantPro(ctx: StageContext, counts?: Record<string, number>): Promise<void> {
  const pro = ctx.ports.pro!;
  const current = await pro.read();
  check(current !== "foreign", "pro", "foreign_grant");
  if (!ctx.state.created.pro) { ctx.state.created.pro = { before: current, operations: [] }; await ctx.save(); }
  const now = ctx.ports.clock.now();
  if (current?.enabled && current.validUntil !== null && Date.parse(current.validUntil) > now + DAY_MS / 2) return;
  if (current?.enabled && current.validUntil === null) return;
  await changePro(ctx, { enabled: true, validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + DAY_MS).toISOString() }, "on");
  if (counts) counts.proChanges!++;
}

export async function changePro(ctx: StageContext, grant: ProGrant, what: "on" | "off" | "restore"): Promise<void> {
  const operation = await ctx.ports.pro!.change(grant, `Alpha rehearsal ${ctx.state.prefix}: Individual Pro ${what} for the Personal route`);
  ctx.state.created.pro!.operations.push(operation);
  await ctx.save();
}

/** The selected account's seat in the run's Personal organization: "pro" while its cloud is on. */
export async function personalSeat(ctx: StageContext): Promise<string | null> {
  const me = parse(z.object({ organizations: z.array(z.object({ id: z.string(), seat: z.string().optional() }).passthrough()) }).passthrough(),
    (await call(ctx.ports.api, "GET", "/v1/me", "me")).body, "me");
  return me.organizations.find(org => org.id === ctx.state.organizationId)?.seat ?? null;
}

/** Whether two grants both mean "no Pro", or are the same grant. */
export function sameGrant(left: ProGrant | null, right: ProGrant | null): boolean {
  if (!left?.enabled && !right?.enabled) return true;
  return !!left && !!right && left.enabled === right.enabled && left.validFrom === right.validFrom && left.validUntil === right.validUntil;
}

/** Rebuilds the organization's Cloud Computer once more (one builder machine), as a runtime change or the daily refresh
 * does, and waits until the new build is live and the replaced one's snapshot has been cleaned up. Returns both ids. */
export async function rebuildComputer(ctx: StageContext): Promise<{ previous: string; current: string }> {
  const path = `/v1/cloud-v2/organizations/${ctx.state.organizationId}/computer`;
  const read = async (step: string) => parse(Computer, (await call(ctx.ports.api, "GET", path, step)).body, step);
  const before = await read("computer_rebuild_read");
  check(before.activeBuildId, "computer_rebuild", "no_active_build");
  ctx.start("computer_build");
  const requested = parse(z.object({ build: z.object({ id: z.string().uuid() }).passthrough() }),
    (await call(ctx.ports.api, "POST", `${path}/builds`, "computer_rebuild", { revision: before.recipeRevision })).body, "computer_rebuild");
  (ctx.state.created.computerRebuilds ??= []).push(requested.build.id);
  await ctx.save();
  await until(ctx, "computer_rebuilt", ctx.timing.computerMs, ctx.timing.pollMs, async () => {
    const overview = await read("computer_rebuilt");
    const build = overview.builds.find(row => row.id === requested.build.id);
    if (build?.builderSandboxId && !ctx.state.created.machines.includes(build.builderSandboxId)) ctx.state.created.machines.push(build.builderSandboxId);
    check(build && !["failed", "cancelled"].includes(build.state), "computer_rebuilt", build ? `build_${build.state}` : "build_missing");
    return overview.activeBuildId === requested.build.id && build.state === "succeeded";
  });
  // The product's cleanup deletes a replaced build's snapshot once nobody is creating from it.
  await until(ctx, "computer_previous_cleaned", ctx.timing.scanMs, ctx.timing.pollMs, async () =>
    (await ctx.ports.database.read("SELECT snapshot_deleted_at IS NOT NULL AS gone FROM cloud_v2_computer_builds WHERE id = $1::uuid", [before.activeBuildId]))[0]?.gone === true);
  return { previous: before.activeBuildId!, current: requested.build.id };
}
