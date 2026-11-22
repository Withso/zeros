import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAlpha } from "../__fixtures__/rehearsal-alpha-fake.js";
import { shiftClock } from "./clock.js";
import { RehearsalFailure, type RehearsalState, type StageName } from "./contract.js";
import { assertRepository, safeLine } from "./guard.js";
import { accountLines, readAccount, refusal, writeLines } from "./plan.js";
import { cleanup, inventoryLines, readInventory, runStages, stageContext } from "./runner.js";
import { parseArguments } from "./rehearsal-cli.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { loadState, newState, saveState } from "./state.js";

const R1 = "Withso/zeros-dev-fixture";
const TIMING = { pollMs: 1_000, stateMs: 60_000, copyMs: 60_000, turnMs: 60_000, scanMs: 300_000, archiveScanMs: 3_900_000 };

function setup(options: { provisioned?: boolean } = {}) {
  const alpha = new FakeAlpha(options.provisioned === false ? [R1] : [R1, FIXTURE_TWO]);
  const state = newState(randomUUID(), alpha.organizationId, new Date(alpha.now));
  const lines: string[] = [];
  const saved: RehearsalState[] = [];
  const ctx = stageContext(alpha.ports(), state, async () => { saved.push(structuredClone(state)); }, { one: R1, two: FIXTURE_TWO }, TIMING, 30);
  const options_ = { switches: new Set(["projects", "personal", "retention"] as const), maxActive: 10, runCap: 30, log: (line: string) => lines.push(line) };
  return { alpha, state, ctx, lines, saved, options: options_ };
}
const EMPTY = { workspaces: 0, projects: 0, branches: 0, pulls: 0, machines: 0, objects: 0, databaseRows: 0, repositories: 0 };

describe("rehearsal guards", () => {
  it("refuses every repository but the fixtures, by name", () => {
    expect(assertRepository("Withso/zeros-dev-fixture")).toBe("Withso/zeros-dev-fixture");
    expect(assertRepository("Withso/zeros-dev-fixture-two")).toBe("Withso/zeros-dev-fixture-two");
    for (const refused of ["Withso/zeros", "withso/ZEROS", "Withso/zeros-dev", "someone/zeros-dev-fixture", "Withso/zeros-dev-fixture/../zeros", "Withso/zeros-dev-fixturex"])
      expect(() => assertRepository(refused), refused).toThrow(RehearsalFailure);
  });

  it("withholds any line that could carry a credential, URL, email or body", () => {
    for (const unsafe of ["see https://api-alpha.zeros.build/v1/me", "Bearer abc", "eyJhbGciOiJIUzI1NiJ9.payload", "ghs_abcdefghijklmnop", "user-1@zeros.build",
      `token ${"a".repeat(60)}`, "password=hunter2", '{"error":"x"}', "two\nlines"])
      expect(safeLine(unsafe), unsafe).toBe("line withheld (unsafe)");
    expect(safeLine("stage projects: failed copy_ready timeout")).toBe("stage projects: failed copy_ready timeout");
  });

  it("parses the command line and refuses what it does not know", () => {
    expect(parseArguments(["all", "--plan", "--switches", "projects,retention"])).toMatchObject({ stages: ["provision", "projects", "retention"], plan: true, account: "owner" });
    expect(parseArguments(["retention", "--account", "3", "--run", randomUUID()])).toMatchObject({ stages: ["retention"], account: 3 });
    for (const bad of [["nope"], ["all", "--plan", "--cleanup", "--run", "x"], ["all", "--cleanup"], ["all", "--account", "11"], ["all", "--switches", "billing"],
      ["all", "--repository", "Withso/zeros"]])
      expect(() => parseArguments(bad), bad.join(" ")).toThrow(RehearsalFailure);
  });
});

describe("rehearsal state file", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rehearsal-")); });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("is written 0600 in a 0700 directory, whole, and read back exactly", async () => {
    const state = newState(randomUUID(), randomUUID(), new Date());
    state.created.workspaces.push(randomUUID());
    const folder = join(directory, "state");
    await saveState(state, folder);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, `${state.runId}.json`))).mode & 0o777).toBe(0o600);
    expect(await loadState(state.runId, folder)).toEqual(state);
    expect(await readFile(join(folder, `${state.runId}.json`), "utf8")).not.toMatch(/token|password|secret|@/i);
  });

  it("refuses a state that is not a run's", async () => {
    await expect(loadState("../etc/passwd", directory)).rejects.toThrow(RehearsalFailure);
    const state = newState(randomUUID(), randomUUID(), new Date());
    await expect(saveState({ ...state, prefix: "x-" }, directory)).rejects.toThrow(RehearsalFailure);
  });
});

describe("shiftClock refusals", () => {
  it("moves only this run's prefixed workspaces in its organizations, at most four, and reads the shift back", async () => {
    const { alpha, state, ctx } = setup();
    const own = await ctx.ports.api.json("POST", `/v1/cloud-v2/organizations/${state.organizationId}/cloud-projects`,
      { name: `${state.prefix}p`, level: "organization", repositories: [{ repository: R1 }] });
    const project = (own.body as { project: { id: string } }).project.id;
    const make = async (name: string) => ((await ctx.ports.api.json("POST", "/v1/cloud-v2/workspaces", { name, projectId: project, branch: name })).body as { workspace: { id: string } }).workspace.id;
    const mine = await make(`${state.prefix}w`), unprefixed = await make("someone-else"), foreign = await make(`${state.prefix}foreign`);
    alpha.workspaces.get(foreign)!.organizationId = randomUUID();
    state.created.workspaces.push(mine, unprefixed, foreign);

    await expect(shiftClock(ctx.ports.database, state, [randomUUID()], 1)).rejects.toMatchObject({ code: "not_this_run" });
    await expect(shiftClock(ctx.ports.database, state, [unprefixed], 1)).rejects.toMatchObject({ code: "refused" });
    await expect(shiftClock(ctx.ports.database, state, [foreign], 1)).rejects.toMatchObject({ code: "refused" });
    await expect(shiftClock(ctx.ports.database, state, [mine, mine], 1)).rejects.toMatchObject({ code: "too_many" });
    await expect(shiftClock(ctx.ports.database, state, [1, 2, 3, 4, 5].map(() => mine), 1)).rejects.toMatchObject({ code: "too_many" });
    for (const days of [0, -1, 91, Number.NaN]) await expect(shiftClock(ctx.ports.database, state, [mine], days)).rejects.toMatchObject({ code: "invalid_days" });
    expect(alpha.shifts).toEqual([]);
    expect(await shiftClock(ctx.ports.database, state, [mine], 1.5)).toEqual({ workspaces: 1, wakes: 0 });
    expect(alpha.shifts).toEqual([{ ids: [mine], days: 1.5 }]);
    expect(state.shifts).toBe(1);
  });
});

describe("rehearsal stages against a fake Alpha", () => {
  it("runs provision, projects and retention in order, then cleanup leaves an empty inventory", async () => {
    const { alpha, state, ctx, lines, options } = setup({ provisioned: false });
    expect(await runStages(ctx, ["provision", "projects", "retention"], options)).toBe(true);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage provision: ok", "stage projects: ok", "stage retention: ok"]);
    expect(state.created.repositories).toEqual([FIXTURE_TWO]);
    expect(state.stages.projects?.counts).toEqual({ workspaces: 2, pulls: 2, turns: 3, copiesGone: 2 });
    expect(state.stages.retention?.counts).toMatchObject({ restored: 1, rebuilt: 1, removal: 1 });
    // Four shifts of both workspaces, then the removal's one of W alone.
    expect(alpha.shifts.map(shift => shift.ids.length)).toEqual([2, 2, 2, 2, 1]);
    expect(state.machineStarts).toBe(11);
    const { inventory } = await cleanup(ctx, { keepFixtures: false, log: line => lines.push(line) });
    expect(inventory).toEqual(EMPTY);
    expect(alpha.repositories.has(FIXTURE_TWO.toLowerCase())).toBe(false);
    for (const line of lines) expect(safeLine(line)).toBe(line);
  });

  it("skips the backup removal when S4 is not deployed, and cleanup removes the backup it leaves", async () => {
    const { alpha, ctx, options } = setup();
    alpha.s4 = false;
    expect(await runStages(ctx, ["retention"], options)).toBe(true);
    expect(ctx.state.stages.retention?.counts?.removal).toBe(0);
    expect(alpha.objects.size).toBe(1);
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.objects.size).toBe(0);
  });

  it("refuses a stage whose switch is not declared, a stage not written yet, and an organization over its machine cap", async () => {
    const { alpha, ctx, lines, options } = setup();
    expect(await runStages(ctx, ["projects"], { ...options, switches: new Set(["retention"] as const) })).toBe(false);
    expect(lines.at(-1)).toBe("stage projects: failed switch undeclared_projects");
    expect(await runStages(ctx, ["personal"], options)).toBe(false);
    expect(lines.at(-1)).toBe("stage personal: failed stage not_written");
    expect(alpha.writes).toEqual([]);
    expect(await runStages(ctx, ["projects"], { ...options, maxActive: -1 })).toBe(false);
    expect(lines.at(-1)).toBe("stage projects: failed machine_cap active");
    expect(alpha.writes).toEqual([]);
  });

  it("stops at the first failure and runs no later stage", async () => {
    const { ctx, lines, options } = setup();
    ctx.ports.release = async () => false;
    expect(await runStages(ctx, ["projects", "retention"], options)).toBe(false);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage projects: failed release_identity not_ready"]);
  });

  it("stops creating machines at the run's cap", async () => {
    const { alpha, state } = setup();
    const ctx = stageContext(alpha.ports(), state, async () => undefined, { one: R1, two: FIXTURE_TWO }, TIMING, 3);
    const lines: string[] = [];
    expect(await runStages(ctx, ["projects"], { switches: new Set(["projects"] as const), maxActive: 10, runCap: 3, log: line => lines.push(line) })).toBe(false);
    expect(lines.at(-1)).toMatch(/^stage projects: failed machine_cap run_cap$/);
    expect(state.machineStarts).toBe(3);
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
  });

  for (const stage of ["projects", "retention"] as StageName[]) {
    it(`cleanup after a failure at any step of ${stage} leaves an empty inventory`, async () => {
      const clean = setup();
      expect(await runStages(clean.ctx, [stage], clean.options)).toBe(true);
      const total = clean.alpha.calls;
      expect(total).toBeGreaterThan(40);
      let failed = 0;
      for (let at = 1; at <= total; at++) for (const after of [false, true]) {
        const { alpha, ctx, lines, options } = setup();
        alpha.fault = { at, after };
        const passed = await runStages(ctx, [stage], options);
        alpha.fault = undefined;
        if (passed) continue;
        failed++;
        expect(lines.at(-1), `call ${at}${after ? " after" : ""}`).toMatch(/^stage \w+: failed \S+ \S+$/);
        const { inventory } = await cleanup(ctx, { keepFixtures: true, log: () => undefined });
        expect(inventory, `call ${at}${after ? " after" : ""}: ${lines.at(-1)}`).toEqual(EMPTY);
      }
      // Nearly every injected fault fails the stage (a read the stage tolerates, such as a missing file, may not).
      expect(failed).toBeGreaterThan(total * 1.5);
    }, 120_000);
  }

  it("prints the inventory by kind and names what remains", async () => {
    const { ctx } = setup();
    const inventory = await readInventory(ctx, true);
    expect(inventoryLines(inventory)).toEqual({ clean: true, lines: [...Object.keys(EMPTY).map(kind => `inventory ${kind} 0`), "inventory clean"] });
    expect(inventoryLines({ ...inventory, machines: 2, pulls: 1 }).lines.at(-1)).toBe("inventory remaining: pulls, machines");
  });
});

describe("rehearsal --plan", () => {
  it("reads accounts with GETs only and lists every write without making one", async () => {
    const { alpha, state } = setup();
    const summary = await readAccount(alpha.api(), "owner", state.organizationId, "Withso");
    expect(alpha.writes).toEqual([]);
    expect(summary).toMatchObject({ admin: true, fixtureConnection: true, connections: { organization: 1, personal: 0, logins: ["Withso"] } });
    for (const line of accountLines(summary)) expect(safeLine(line)).toBe(line);
    const switches = new Set(["projects", "retention"] as const);
    expect(refusal("projects", summary, switches)).toBeNull();
    expect(refusal("retention", summary, new Set(["projects"] as const))).toBe("undeclared_retention");
    expect(refusal("personal", summary, switches)).toBe("not_written");
    expect(refusal("projects", { ...summary, admin: false }, switches)).toBe("not_owner_or_admin");
    expect(refusal("projects", { ...summary, fixtureConnection: false }, switches)).toBe("no_fixture_connection");
    for (const stage of ["provision", "projects", "personal", "retention", "submodules"] as StageName[])
      for (const line of writeLines(stage, "zr-<run>-", { one: R1 })) { expect(line).not.toBe("line withheld (unsafe)"); }
  });
});
