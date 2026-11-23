// The rehearsal's runner: preconditions, one stage at a time (stopping at the first failure), cleanup of everything
// with the run's prefix, and the final inventory. Every line it prints goes through safeLine.
import { RehearsalFailure, STAGE_NEEDS_ACCOUNT, stageSwitches, type Api, type Ports, type RehearsalState, type StageContext, type StageName, type Switch } from "./contract.js";
import { assertRepository, prefixed, safeLine, stageLine } from "./guard.js";
import { stageProjects } from "./stage-projects.js";
import { stageProvision } from "./stage-provision.js";
import { stagePersonal } from "./stage-personal.js";
import { stageRetention } from "./stage-retention.js";
import { stageSubmodules } from "./stage-submodules.js";
import { stageWaiting, waitingContext } from "./stage-waiting.js";
import { changePro, sameGrant, stageSetup } from "./stage-setup.js";
import { WAITING_INSTALL_SCRIPT, clearEnvironment, disconnectGithubSignIn, githubSignIn, deleteProject, deleteWorkspace, getWorkspace, listProjects, listWorkspaces, readEnvironment,
  readInstallScript, writeInstallScript } from "./steps.js";

export type Stage = (ctx: StageContext) => Promise<Record<string, number>>;
/** Every stage. setup refuses itself on the organization route; personal and submodules run on the Personal route only,
 * and submodules refuses itself until its fixtures exist. */
export const STAGE_RUNNERS: Partial<Record<StageName, Stage>> = { provision: stageProvision, setup: stageSetup, projects: stageProjects,
  personal: stagePersonal, retention: stageRetention, submodules: stageSubmodules, waiting: stageWaiting };

export type RunOptions = {
  switches: ReadonlySet<Switch>;
  /** Refuse to start when the organization already has more active machines than this. */
  maxActive: number;
  /** Machine starts one run may cause, in all its stages. */
  runCap: number;
  log(line: string): void;
  /** Absent when signed in; otherwise why the account is unavailable (sign_in:http_400_invalid_credentials). Stages that
   * need an account are then refused, and the others still run. */
  accountUnavailable?: string;
};
/** The API port when nobody is signed in: every call is refused before it leaves the process. */
export const NO_ACCOUNT: Api = { json: async () => { throw new RehearsalFailure("account", "not_signed_in"); } };
export const DEFAULT_RUN_CAP = 30;
const ACTIVE = new Set(["creating", "starting", "running", "stopping"]);

export function stageContext(ports: Ports, state: RehearsalState, save: () => Promise<void>, repositories: StageContext["repositories"],
  timing: StageContext["timing"], runCap: number): StageContext & { lastStep(): string; takeNotes(): string[] } {
  let last = "start", notes: string[] = [];
  for (const repository of [repositories.one, repositories.two, repositories.submodules, repositories.submoduleFixture]) if (repository) assertRepository(repository);
  return {
    ports, state, save, repositories, timing, projectLevel: state.owner === "personal" ? "personal" : "organization",
    step(name) { last = name; },
    note(code) { if (/^[a-z0-9_:.-]{1,80}$/.test(code) && notes.length < 16) notes.push(code); },
    takeNotes: () => { const taken = notes; notes = []; return taken; },
    start() {
      if (state.machineStarts >= runCap) throw new RehearsalFailure("machine_cap", "run_cap");
      state.machineStarts++;
    },
    lastStep: () => last,
  };
}

/** Runs the named stages in order; stops at the first failure. Returns whether every stage passed. */
export async function runStages(ctx: ReturnType<typeof stageContext>, stages: readonly StageName[], options: RunOptions): Promise<boolean> {
  for (const name of stages) {
    const runner = STAGE_RUNNERS[name];
    const missing = stageSwitches(name, ctx.state.owner).find(needed => !options.switches.has(needed));
    let result: RehearsalState["stages"][StageName];
    if (!runner) result = { ok: false, step: "stage", code: "not_written" };
    else if (missing) result = { ok: false, step: "switch", code: `undeclared_${missing}` };
    else if (STAGE_NEEDS_ACCOUNT[name] && options.accountUnavailable) result = { ok: false, step: "account_unavailable", code: options.accountUnavailable };
    else {
      try {
        await preconditions(ctx, options, STAGE_NEEDS_ACCOUNT[name]);
        result = { ok: true, counts: await runner(ctx) };
      } catch (error) {
        const failure = error instanceof RehearsalFailure ? error : new RehearsalFailure(ctx.lastStep(), "unexpected");
        result = { ok: false, step: failure.step === "step" ? ctx.lastStep() : failure.step, code: failure.code };
      } finally {
        // One temporary role per stage; nothing outlives it.
        await ctx.ports.database.close().catch(() => options.log("database role: close failed; run --cleanup"));
      }
      const notes = ctx.takeNotes();
      if (notes.length) result = { ...result, notes };
    }
    ctx.state.stages[name] = result;
    await ctx.save();
    options.log(stageLine(name, result));
    for (const [key, value] of Object.entries(result.counts ?? {})) options.log(safeLine(`  ${name} ${key} ${value}`));
    for (const note of result.notes ?? []) options.log(safeLine(`  ${name} note ${note}`));
    if (!result.ok) return false;
  }
  return true;
}

async function preconditions(ctx: StageContext, options: RunOptions, account: boolean): Promise<void> {
  if (!await ctx.ports.release()) throw new RehearsalFailure("release_identity", "not_ready");
  if (!account) return;
  const active = (await listWorkspaces(ctx.ports.api, ctx.state.organizationId, "machine_cap")).filter(row => ACTIVE.has(row.state)).length;
  if (active > options.maxActive) throw new RehearsalFailure("machine_cap", "active");
}

// ── Cleanup and inventory ───────────────────────────────

export type Inventory = Record<"workspaces" | "projects" | "branches" | "pulls" | "machines" | "objects" | "environments" | "githubSignIns" | "pro" | "computerBase" |
  "installScripts" | "databaseRows", number>;

/** Removes everything this run created or named with its prefix, best effort per item, then reads the inventory. */
/** Whether cleanup needs a signed-in account: anything recorded that only the API removes, or a create attempted (a
 * machine start is counted before its request, so a lost response is found by listing the prefix). A provision-only
 * run does not. */
export const cleanupNeedsAccount = (state: RehearsalState) => [state.created, state.waiting?.created].some(created => created &&
  created.workspaces.length + created.projects.length + created.environments.length + created.githubSignIns.length + (created.pro?.operations.length ?? 0) > 0)
  || state.machineStarts > 0;

export async function cleanup(ctx: StageContext, options: { accountless?: boolean; keepBase?: boolean; log(line: string): void }): Promise<{ inventory: Inventory; failures: number }> {
  const main = await cleanupOrganization(ctx, options);
  if (!ctx.state.waiting) return main;
  // Stage waiting's organization, as its own account: the same steps, and one inventory summed over both.
  if (!ctx.ports.waiting) {
    options.log(safeLine("cleanup waiting: waiting_account_required"));
    return { inventory: main.inventory, failures: main.failures + 1 };
  }
  const waiting = await cleanupOrganization(waitingContext(ctx), { ...options, log: line => options.log(line.replace(/^cleanup /, "cleanup waiting ")) });
  // Branches, pull requests and the database's prefixed rows are read run-wide by each pass: counted once.
  const once = new Set(["branches", "pulls", "databaseRows"]);
  const inventory = Object.fromEntries(Object.entries(main.inventory).map(([kind, count]) =>
    [kind, once.has(kind) ? count : count + waiting.inventory[kind as keyof Inventory]])) as Inventory;
  return { inventory, failures: main.failures + waiting.failures };
}

async function cleanupOrganization(ctx: StageContext, options: { accountless?: boolean; keepBase?: boolean; log(line: string): void }): Promise<{ inventory: Inventory; failures: number }> {
  const { ports, state } = ctx;
  if (options.accountless && cleanupNeedsAccount(state)) throw new RehearsalFailure("cleanup", "account_required");
  let failures = 0;
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try { await work(); } catch (error) {
      failures++;
      options.log(safeLine(`cleanup ${what}: ${error instanceof RehearsalFailure ? error.code : "failed"}`));
    }
  };
  // A run that changed Pro may have left it off (a failure inside stage B): while off, the API refuses the account's own
  // workspaces (403 pro_required), so Pro is on again first, and put back to the grant before the run at the end.
  if (state.created.pro?.operations.length && !options.accountless) await attempt("pro_for_cleanup", async () => {
    if (!ports.pro) throw new RehearsalFailure("cleanup_pro", "pro_actor_required");
    const current = await ports.pro.read();
    const now = ports.clock.now();
    if (current !== "foreign" && !(current?.enabled && (current.validUntil === null || Date.parse(current.validUntil) > now + 3_600_000)))
      await changePro(ctx, { enabled: true, validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 2 * 3_600_000).toISOString() }, "on");
  });
  const repositories = fixtureRepositories(ctx);
  for (const repository of repositories) {
    await attempt("pulls", async () => { for (const number of await ports.github.openPulls(repository, state.prefix)) await ports.github.closePull(repository, number); });
    await attempt("branches", async () => { for (const branch of await ports.github.branches(repository, state.prefix)) await ports.github.deleteBranch(repository, branch); });
  }
  // Workspaces: the recorded ids, and any prefixed workspace a lost create response left unrecorded.
  let workspaces = [...state.created.workspaces];
  if (!options.accountless) await attempt("workspace_list", async () => {
    for (const row of await listWorkspaces(ports.api, state.organizationId, "cleanup_list"))
      if (prefixed(state.prefix, row.name) && !workspaces.includes(row.id)) { workspaces.push(row.id); state.created.workspaces.push(row.id); }
  });
  for (const id of workspaces) await attempt("workspace", async () => {
    await getWorkspace(ctx, id, "cleanup_read");
    await deleteWorkspace(ctx, id, "cleanup_workspace");
  });
  let projects = [...state.created.projects];
  if (!options.accountless) await attempt("project_list", async () => {
    for (const row of await listProjects(ports.api, state.organizationId, "cleanup_projects"))
      if (prefixed(state.prefix, row.name) && !projects.includes(row.id)) { projects.push(row.id); state.created.projects.push(row.id); }
  });
  for (const id of projects) await attempt("project", () => deleteProject(ctx, id, "cleanup_project"));
  await ctx.save();
  // Machines the API's own deletion did not remove (a copy still stopping, a fork): only ids this run recorded.
  for (const machine of state.created.machines) await attempt("machine", async () => {
    const row = await ports.boat.inspect(machine);
    if (row && row.state !== "deleted") await ports.boat.delete(machine);
  });
  workspaces = state.created.workspaces; projects = state.created.projects;
  for (const target of state.created.environments) await attempt("environment", () => clearEnvironment(ctx, target, "cleanup_environment"));
  for (const organizationId of state.created.githubSignIns) await attempt("github_sign_in", () => disconnectGithubSignIn(ctx, organizationId, "cleanup_github_sign_in"));
  // The install script stage waiting set, only while it is still the one it set.
  if (state.created.installScript) await attempt("install_script", async () => {
    const current = await readInstallScript(ctx, "cleanup_install_script");
    if (current.installScript === WAITING_INSTALL_SCRIPT) await writeInstallScript(ctx, null, current.recipeRevision, "cleanup_install_script");
    delete state.created.installScript; await ctx.save();
  });
  // The Cloud Computer base this run caused, unless --keep-base: as the product's own baseMissing does, the organization's
  // live pointer goes, then that build's Boat named snapshot, then the build records it gone. The build row stays (history).
  // The run's bases: the automatic one Zeros prepared for it (by organization, `automatic`, newer than the run's start),
  // a build an older run requested, and stage C's rebuild, which replaced it. Only the live one is removed.
  if (!options.keepBase) await attempt("cloud_computer", () => removeRunBase(ctx));
  // The Pro grant last: everything above may need the account's cloud.
  if (state.created.pro?.operations.length) await attempt("pro", async () => {
    if (!ports.pro) throw new RehearsalFailure("cleanup_pro", "pro_actor_required");
    const current = await ports.pro.read();
    if (current === "foreign") throw new RehearsalFailure("cleanup_pro", "foreign_grant");
    const before = state.created.pro!.before;
    if (sameGrant(current, before)) return;
    await changePro(ctx, before ?? { enabled: false, validFrom: new Date(ports.clock.now() - 60_000).toISOString(), validUntil: null }, "restore");
  });
  for (const id of workspaces) await attempt("objects", async () => { for (const key of await ports.storage.keys(id)) await ports.storage.delete(key); });
  const inventory = await readInventory(ctx, options.accountless === true, options.keepBase === true).finally(() => ports.database.close().catch(() => { failures++; }));
  return { inventory, failures };
}

/** Accountless (a provision-only run): the API's kinds are read from the database only, where prefixed rows still count. The
 * fixture repositories are never created or deleted by the rehearsal, so they are not part of the inventory. */
export async function readInventory(ctx: StageContext, accountless = false, keepBase = false): Promise<Inventory> {
  const { ports, state } = ctx;
  const repositories = fixtureRepositories(ctx);
  let branches = 0, pulls = 0, machines = 0, objects = 0, workspaces = 0, environments = 0, githubSignIns = 0, pro = 0;
  for (const repository of repositories) {
    branches += (await ports.github.branches(repository, state.prefix)).length;
    pulls += (await ports.github.openPulls(repository, state.prefix)).length;
  }
  for (const machine of state.created.machines) {
    const row = await ports.boat.inspect(machine);
    if (row && row.state !== "deleted") machines++;
  }
  for (const id of state.created.workspaces) objects += (await ports.storage.keys(id)).length;
  for (const target of state.created.environments) if (!(await readEnvironment(ctx, target.repository, target.repositoryId, "inventory_environment")).empty) environments++;
  for (const organizationId of state.created.githubSignIns) if ((await githubSignIn(ctx, organizationId, "inventory_github_sign_in")).methods.pat.configured) githubSignIns++;
  // Pro counts as remaining while the grant differs from the one before the run (either may be "none").
  if (state.created.pro?.operations.length) {
    // Without the Pro port (no --pro-actor) the grant cannot be read: it counts as remaining.
    const current = ports.pro ? await ports.pro.read() : "foreign";
    if (current === "foreign" || !sameGrant(current, state.created.pro.before)) pro = 1;
  }
  if (!accountless) for (const row of await listWorkspaces(ports.api, state.organizationId, "inventory_workspaces"))
    if (prefixed(state.prefix, row.name) && row.state !== "deleted") workspaces++;
  const projects = accountless ? 0 : (await listProjects(ports.api, state.organizationId, "inventory_projects")).filter(row => prefixed(state.prefix, row.name)).length;
  const rows = await ports.database.read(`SELECT
      (SELECT count(*) FROM cloud_v2_workspaces WHERE left(name, length($1)) = $1 AND state <> 'deleted')::int AS workspaces,
      (SELECT count(*) FROM cloud_projects WHERE left(name, length($1)) = $1)::int AS projects`, [state.prefix]);
  const databaseRows = Number(rows[0]?.workspaces ?? 0) + Number(rows[0]?.projects ?? 0);
  let computerBase = 0;
  // Every base the run caused that is still live, or whose own Boat snapshot is still there (a replaced one the product's
  // cleanup has not removed yet counts until it has). The shared base is Zeros's and never counted.
  if (!keepBase) for (const row of await ports.database.read(`SELECT coalesce(c.active_build_id = b.id, false) AS active, b.snapshot_id, b.base_shared
      FROM cloud_v2_computer_builds b LEFT JOIN cloud_v2_computers c ON c.org_id = b.org_id
      WHERE b.org_id = $1::uuid AND (b.id = ANY($2::uuid[]) OR (b.automatic AND b.created_at >= $3::timestamptz)) /* run bases */`,
      [state.organizationId, runBaseIds(state), state.startedAt]))
    if (row.active === true || (row.base_shared !== true && row.snapshot_id && await ports.boat.snapshotExists(String(row.snapshot_id)))) computerBase++;
  // Stage waiting's install script counts until cleanup has put the organization back to none.
  const installScripts = state.created.installScript ? 1 : 0;
  return { workspaces, projects, branches, pulls, machines, objects, environments, githubSignIns, pro, computerBase, installScripts, databaseRows };
}

export function inventoryLines(inventory: Inventory): { lines: string[]; clean: boolean } {
  const left = Object.entries(inventory).filter(([, count]) => count !== 0);
  return {
    lines: [...Object.entries(inventory).map(([kind, count]) => safeLine(`inventory ${kind} ${count}`)),
      safeLine(left.length ? `inventory remaining: ${left.map(([kind]) => kind).join(", ")}` : "inventory clean")],
    clean: left.length === 0,
  };
}

function fixtureRepositories(ctx: StageContext): string[] {
  return [...new Set([ctx.repositories.one, ctx.repositories.two, ctx.repositories.submodules, ctx.repositories.submoduleFixture]
    .filter((value): value is string => !!value).map(assertRepository))];
}

/** The base builds this run recorded: an older run's requested build, stage C's rebuilds, the automatic ones it caused. */
const runBaseIds = (state: RehearsalState): string[] =>
  [state.created.computerBuild, ...state.created.computerRebuilds ?? [], ...state.created.bases ?? []].filter((id): id is string => !!id);

/** Removes the run's live base: only a build the run caused, only in the run's own organization, only while it is the one
 * live. The shared base (a reference to Zeros's snapshot) loses only the organization's pointer. */
async function removeRunBase(ctx: StageContext): Promise<void> {
  const { ports, state } = ctx;
  const live = await ports.database.transaction(async query => {
    const row = (await query(`SELECT b.id::text AS id, b.snapshot_id, b.base_shared FROM cloud_v2_computers c
      JOIN cloud_v2_computer_builds b ON b.id = c.active_build_id AND b.org_id = c.org_id
      WHERE c.org_id = $1::uuid AND (b.id = ANY($2::uuid[]) OR (b.automatic AND b.created_at >= $3::timestamptz)) FOR UPDATE OF c, b`,
      [state.organizationId, runBaseIds(state), state.startedAt])).rows[0];
    if (!row) return null;
    await query(`UPDATE cloud_v2_computers SET active_build_id = NULL, snapshot_name = NULL, updated_at = clock_timestamp()
      WHERE org_id = $1::uuid AND active_build_id = $2::uuid`, [state.organizationId, row.id]);
    return { buildId: String(row.id), snapshot: row.snapshot_id === null || row.base_shared === true ? null : String(row.snapshot_id) };
  });
  if (!live?.snapshot) return;
  const { buildId, snapshot } = live;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(snapshot)) throw new RehearsalFailure("cloud_computer", "snapshot_name");
  if (await ports.boat.snapshotExists(snapshot)) await ports.boat.deleteSnapshot(snapshot);
  await ports.database.transaction(query => query(`UPDATE cloud_v2_computer_builds SET snapshot_id = NULL, snapshot_deleted_at = clock_timestamp()
    WHERE id = $1::uuid AND org_id = $2::uuid AND snapshot_id = $3`, [buildId, state.organizationId, snapshot]));
}
