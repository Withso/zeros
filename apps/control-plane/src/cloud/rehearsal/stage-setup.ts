// Stage setup. On the Personal route: the selected test user's Individual Pro (manage-account-pro.ts, actor the one active
// platform owner) and its own GitHub sign-in by token, so its Personal organization is a full cloud owner. Both are
// recorded before they are made, and cleanup puts both back. On the organization route it is a proposal, refused until
// approved (plan.ts lists it).
import { z } from "zod";
import { RehearsalFailure, type ProGrant, type StageContext } from "./contract.js";
import { call, check, githubSignIn, parse, until } from "./steps.js";

const DAY_MS = 86_400_000;

export async function stageSetup(ctx: StageContext): Promise<Record<string, number>> {
  if (ctx.state.owner !== "personal") throw new RehearsalFailure("setup", "organization_route_awaiting_approval");
  const { pro, githubSignIn: signIn } = ctx.ports;
  check(pro, "setup_pro", "not_configured");
  check(signIn, "setup_github_sign_in", "not_configured");
  const counts: Record<string, number> = { proChanges: 0, githubSignIn: 0 };

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

  // A project's copy builds only on the organization's own active base (ready copies on, no shared base): a Personal
  // organization that never built one gets it here, explicitly, as one builder machine.
  ctx.step("cloud_computer");
  counts.computerBuilt = await ensureComputer(ctx);
  return counts;
}

const Computer = z.object({ activeBuildId: z.string().nullable(), recipeRevision: z.number().int().nonnegative(),
  builds: z.array(z.object({ id: z.string(), state: z.string(), builderSandboxId: z.string().nullable().optional() }).passthrough()) }).passthrough();
/** The Personal organization's active Cloud Computer, built once when it has none. Returns 1 when this run built it. */
export async function ensureComputer(ctx: StageContext): Promise<number> {
  const path = `/v1/cloud-v2/organizations/${ctx.state.organizationId}/computer`;
  const read = async (step: string) => parse(Computer, (await call(ctx.ports.api, "GET", path, step)).body, step);
  const current = await read("computer_read");
  const active = current.activeBuildId && current.builds.find(build => build.id === current.activeBuildId);
  if (active && active.state === "succeeded") { ctx.note("cloud_computer:existing"); return 0; }
  if (!ctx.state.created.computerBuild) {
    ctx.start("computer_build");
    const requested = parse(z.object({ build: z.object({ id: z.string().uuid() }).passthrough() }),
      (await call(ctx.ports.api, "POST", `${path}/builds`, "computer_build", { revision: current.recipeRevision })).body, "computer_build");
    ctx.state.created.computerBuild = requested.build.id;
    await ctx.save();
  }
  const id = ctx.state.created.computerBuild;
  await until(ctx, "computer_built", ctx.timing.computerMs, ctx.timing.pollMs, async () => {
    const overview = await read("computer_built");
    const build = overview.builds.find(row => row.id === id);
    if (build?.builderSandboxId && !ctx.state.created.machines.includes(build.builderSandboxId)) ctx.state.created.machines.push(build.builderSandboxId);
    check(build && !["failed", "cancelled"].includes(build.state), "computer_built", build ? `build_${build.state}` : "build_missing");
    return overview.activeBuildId === id && build.state === "succeeded";
  });
  ctx.note("cloud_computer:built_by_this_run");
  return 1;
}

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
