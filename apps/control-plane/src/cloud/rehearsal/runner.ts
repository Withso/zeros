// The rehearsal's runner: preconditions, one stage at a time (stopping at the first failure), cleanup of everything
// with the run's prefix, and the final inventory. Every line it prints goes through safeLine.
import { RehearsalFailure, STAGE_SWITCH, type Ports, type RehearsalState, type StageContext, type StageName, type Switch } from "./contract.js";
import { assertRepository, prefixed, safeLine, stageLine } from "./guard.js";
import { stageProjects } from "./stage-projects.js";
import { stageProvision } from "./stage-provision.js";
import { stageRetention } from "./stage-retention.js";
import { deleteProject, deleteWorkspace, getWorkspace, listProjects, listWorkspaces } from "./steps.js";

export type Stage = (ctx: StageContext) => Promise<Record<string, number>>;
/** Stages not written yet (B and D wait on the owner's answers) are absent and refused. */
export const STAGE_RUNNERS: Partial<Record<StageName, Stage>> = { provision: stageProvision, projects: stageProjects, retention: stageRetention };

export type RunOptions = {
  switches: ReadonlySet<Switch>;
  /** Refuse to start when the organization already has more active machines than this. */
  maxActive: number;
  /** Machine starts one run may cause, in all its stages. */
  runCap: number;
  log(line: string): void;
};
export const DEFAULT_RUN_CAP = 30;
const ACTIVE = new Set(["creating", "starting", "running", "stopping"]);

export function stageContext(ports: Ports, state: RehearsalState, save: () => Promise<void>, repositories: StageContext["repositories"],
  timing: StageContext["timing"], runCap: number): StageContext & { lastStep(): string } {
  let last = "start";
  for (const repository of [repositories.one, repositories.two, repositories.submodules]) if (repository) assertRepository(repository);
  return {
    ports, state, save, repositories, timing,
    step(name) { last = name; },
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
    const needed = STAGE_SWITCH[name];
    let result: RehearsalState["stages"][StageName];
    if (!runner) result = { ok: false, step: "stage", code: "not_written" };
    else if (needed && !options.switches.has(needed)) result = { ok: false, step: "switch", code: `undeclared_${needed}` };
    else {
      try {
        await preconditions(ctx, options);
        result = { ok: true, counts: await runner(ctx) };
      } catch (error) {
        const failure = error instanceof RehearsalFailure ? error : new RehearsalFailure(ctx.lastStep(), "unexpected");
        result = { ok: false, step: failure.step === "step" ? ctx.lastStep() : failure.step, code: failure.code };
      } finally {
        // One temporary role per stage; nothing outlives it.
        await ctx.ports.database.close().catch(() => options.log("database role: close failed; run --cleanup"));
      }
    }
    ctx.state.stages[name] = result;
    await ctx.save();
    options.log(stageLine(name, result));
    for (const [key, value] of Object.entries(result.counts ?? {})) options.log(safeLine(`  ${name} ${key} ${value}`));
    if (!result.ok) return false;
  }
  return true;
}

async function preconditions(ctx: StageContext, options: RunOptions): Promise<void> {
  if (!await ctx.ports.release()) throw new RehearsalFailure("release_identity", "not_ready");
  const active = (await listWorkspaces(ctx.ports.api, ctx.state.organizationId, "machine_cap")).filter(row => ACTIVE.has(row.state)).length;
  if (active > options.maxActive) throw new RehearsalFailure("machine_cap", "active");
}

// ── Cleanup and inventory ───────────────────────────────

export type Inventory = Record<"workspaces" | "projects" | "branches" | "pulls" | "machines" | "objects" | "databaseRows" | "repositories", number>;

/** Removes everything this run created or named with its prefix, best effort per item, then reads the inventory. */
export async function cleanup(ctx: StageContext, options: { keepFixtures: boolean; log(line: string): void }): Promise<{ inventory: Inventory; failures: number }> {
  const { ports, state } = ctx;
  let failures = 0;
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try { await work(); } catch (error) {
      failures++;
      options.log(safeLine(`cleanup ${what}: ${error instanceof RehearsalFailure ? error.code : "failed"}`));
    }
  };
  const repositories = fixtureRepositories(ctx);
  for (const repository of repositories) {
    await attempt("pulls", async () => { for (const number of await ports.github.openPulls(repository, state.prefix)) await ports.github.closePull(repository, number); });
    await attempt("branches", async () => { for (const branch of await ports.github.branches(repository, state.prefix)) await ports.github.deleteBranch(repository, branch); });
  }
  // Workspaces: the recorded ids, and any prefixed workspace a lost create response left unrecorded.
  let workspaces = [...state.created.workspaces];
  await attempt("workspace_list", async () => {
    for (const row of await listWorkspaces(ports.api, state.organizationId, "cleanup_list"))
      if (prefixed(state.prefix, row.name) && !workspaces.includes(row.id)) { workspaces.push(row.id); state.created.workspaces.push(row.id); }
  });
  for (const id of workspaces) await attempt("workspace", async () => {
    await getWorkspace(ctx, id, "cleanup_read");
    await deleteWorkspace(ctx, id, "cleanup_workspace");
  });
  let projects = [...state.created.projects];
  await attempt("project_list", async () => {
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
  for (const id of workspaces) await attempt("objects", async () => { for (const key of await ports.storage.keys(id)) await ports.storage.delete(key); });
  if (!options.keepFixtures) for (const repository of state.created.repositories)
    await attempt("repository", () => ports.github.deleteRepository(assertRepository(repository)));
  const inventory = await readInventory(ctx, options.keepFixtures).finally(() => ports.database.close().catch(() => { failures++; }));
  return { inventory, failures };
}

export async function readInventory(ctx: StageContext, keepFixtures: boolean): Promise<Inventory> {
  const { ports, state } = ctx;
  const repositories = fixtureRepositories(ctx);
  let branches = 0, pulls = 0, machines = 0, objects = 0, workspaces = 0, remaining = 0;
  for (const repository of repositories) {
    branches += (await ports.github.branches(repository, state.prefix)).length;
    pulls += (await ports.github.openPulls(repository, state.prefix)).length;
  }
  for (const machine of state.created.machines) {
    const row = await ports.boat.inspect(machine);
    if (row && row.state !== "deleted") machines++;
  }
  for (const id of state.created.workspaces) objects += (await ports.storage.keys(id)).length;
  for (const row of await listWorkspaces(ports.api, state.organizationId, "inventory_workspaces"))
    if (prefixed(state.prefix, row.name) && row.state !== "deleted") workspaces++;
  const projects = (await listProjects(ports.api, state.organizationId, "inventory_projects")).filter(row => prefixed(state.prefix, row.name)).length;
  const rows = await ports.database.read(`SELECT
      (SELECT count(*) FROM cloud_v2_workspaces WHERE left(name, length($1)) = $1 AND state <> 'deleted')::int AS workspaces,
      (SELECT count(*) FROM cloud_projects WHERE left(name, length($1)) = $1)::int AS projects`, [state.prefix]);
  const databaseRows = Number(rows[0]?.workspaces ?? 0) + Number(rows[0]?.projects ?? 0);
  if (!keepFixtures) for (const repository of state.created.repositories) if (await ports.github.repositoryExists(repository)) remaining++;
  return { workspaces, projects, branches, pulls, machines, objects, databaseRows, repositories: remaining };
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
  return [...new Set([ctx.repositories.one, ctx.repositories.two, ctx.repositories.submodules, ...ctx.state.created.repositories]
    .filter((value): value is string => !!value).map(assertRepository))];
}
