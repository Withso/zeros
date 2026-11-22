import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate0Failure } from "../gate0.js";
import { signInAccount, signInAll, type SignInDeps } from "./accounts.js";
import { FakeAlpha } from "../__fixtures__/rehearsal-alpha-fake.js";
import { shiftClock } from "./clock.js";
import { RehearsalFailure, type RehearsalState, type StageName } from "./contract.js";
import { assertRepository, safeLine } from "./guard.js";
import { accountLines, PERSONAL_ROUTE_GAPS, readAccount, refusal, writeLines } from "./plan.js";
import { cleanup, cleanupNeedsAccount, inventoryLines, NO_ACCOUNT, readInventory, runStages, stageContext } from "./runner.js";
import { parseArguments } from "./rehearsal-cli.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { loadState, newState, saveState } from "./state.js";
import { databaseErrorCode, liveDatabase, type DatabaseClient } from "./live.js";
import { platformOwners } from "./plan.js";

const R1 = "Withso/zeros-dev-fixture";
const TIMING = { pollMs: 30_000, stateMs: 120_000, copyMs: 120_000, turnMs: 120_000, scanMs: 300_000, archiveScanMs: 3_900_000, idleStopMs: 2_100_000 };

const R3 = "Withso/zeros-dev-fixture-submodules", PRIVATE_SUB = "Withso/zeros-dev-fixture-private-sub";
function setup(options: { provisioned?: boolean; owner?: "personal" | "organization"; submodules?: boolean } = {}) {
  const alpha = new FakeAlpha([R1, ...options.provisioned === false ? [] : [FIXTURE_TWO], ...options.submodules === false ? [] : [R3, PRIVATE_SUB]]);
  const state = newState(randomUUID(), alpha.organizationId, new Date(alpha.now), options.owner ?? "organization");
  // On the Personal route the test user starts with no GitHub sign-in; setup connects one.
  if (options.owner === "personal") alpha.githubIdentity = false;
  const lines: string[] = [];
  const saved: RehearsalState[] = [];
  const ctx = stageContext(alpha.ports(), state, async () => { saved.push(structuredClone(state)); },
    { one: R1, two: FIXTURE_TWO, submodules: R3, privateSubmodule: PRIVATE_SUB }, TIMING, 30);
  const options_ = { switches: new Set(["projects", "personal", "retention"] as const), maxActive: 10, runCap: 30, log: (line: string) => lines.push(line) };
  return { alpha, state, ctx, lines, saved, options: options_ };
}
const EMPTY = { workspaces: 0, projects: 0, branches: 0, pulls: 0, machines: 0, objects: 0, environments: 0, githubSignIns: 0, pro: 0, databaseRows: 0, repositories: 0 };

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
    expect(parseArguments(["all", "--plan", "--switches", "projects,personal,retention"]))
      .toMatchObject({ stages: ["provision", "setup", "projects", "personal", "retention", "submodules"], plan: true, owner: "personal", account: 2 });
    expect(parseArguments(["all", "--owner", "organization", "--account", "owner"])).toMatchObject({ stages: ["provision", "setup", "projects", "retention"], account: "owner" });
    expect(parseArguments(["personal", "--account", "4", "--other", "5", "--pro-actor", "3e515301"])).toMatchObject({ account: 4, other: 5, proActor: "3e515301" });
    expect(parseArguments(["retention", "--account", "3", "--run", randomUUID()])).toMatchObject({ stages: ["retention"], account: 3 });
    for (const bad of [["nope"], ["all", "--plan", "--cleanup", "--run", "x"], ["all", "--cleanup"], ["all", "--account", "11"], ["all", "--switches", "billing"],
      ["all", "--repository", "Withso/zeros"], ["all", "--owner", "team"], ["all", "--account", "4", "--other", "4"], ["all", "--pro-actor", "3E5153"]])
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
    expect(state.stages.projects?.counts).toEqual({ workspaces: 2, pulls: 2, turns: 3, copiesGone: 2, environments: 2 });
    expect(state.stages.projects?.notes).toEqual(["environment:seeded"]);
    expect(state.stages.retention?.notes).toEqual(["environment_case:seeded_edited"]);
    // Every environment this run seeded is empty again at the end of its stage.
    expect([...alpha.environments.values()].every(environment => environment.files.size === 0)).toBe(true);
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
    expect(await runStages(ctx, ["submodules"], options)).toBe(false);
    expect(lines.at(-1)).toBe("stage submodules: failed owner personal_route_only");
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

  for (const [stage, owner, prelude] of [["projects", "organization", []], ["retention", "organization", []], ["setup", "personal", []],
    ["personal", "personal", ["setup"]], ["submodules", "personal", ["setup"]]] as [StageName, "personal" | "organization", StageName[]][]) {
    it(`cleanup after a failure at any step of ${stage} (${owner} route) leaves an empty inventory`, async () => {
      const clean = setup({ owner });
      expect(await runStages(clean.ctx, prelude, clean.options)).toBe(true);
      const offset = clean.alpha.calls;
      expect(await runStages(clean.ctx, [stage], clean.options)).toBe(true);
      const total = clean.alpha.calls - offset;
      expect(total).toBeGreaterThan(5);
      let failed = 0;
      for (let at = 1; at <= total; at++) for (const after of [false, true]) {
        const { alpha, ctx, lines, options } = setup({ owner });
        expect(await runStages(ctx, prelude, options)).toBe(true);
        alpha.fault = { at: alpha.calls + at, after };
        const passed = await runStages(ctx, [stage], options);
        alpha.fault = undefined;
        if (passed) continue;
        failed++;
        const failure = lines.filter(line => line.startsWith("stage ")).at(-1);
        expect(failure, `call ${at}${after ? " after" : ""}`).toMatch(/^stage \w+: failed \S+ \S+$/);
        const { inventory } = await cleanup(ctx, { keepFixtures: true, log: () => undefined });
        expect(inventory, `call ${at}${after ? " after" : ""}: ${failure}`).toEqual(EMPTY);
      }
      // Nearly every injected fault fails the stage (a read the stage tolerates, such as a missing file, may not).
      expect(failed).toBeGreaterThan(total);
    }, 120_000);
  }

  it("prints the inventory by kind and names what remains", async () => {
    const { ctx } = setup();
    const inventory = await readInventory(ctx, true);
    expect(inventoryLines(inventory)).toEqual({ clean: true, lines: [...Object.keys(EMPTY).map(kind => `inventory ${kind} 0`), "inventory clean"] });
    expect(inventoryLines({ ...inventory, machines: 2, pulls: 1 }).lines.at(-1)).toBe("inventory remaining: pulls, machines");
  });
});

describe("rehearsal environments and the worker-off record", () => {
  it("never overwrites an account's environment: an existing one skips seeding, and retention uses a hand-made ignored file", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.environments.set(alpha.repositoryId(R1), { revision: 3, files: new Map([[".env", "theirs"]]) });
    expect(await runStages(ctx, ["projects", "retention"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(["environment_skipped:environment_exists"]);
    expect(state.stages.projects?.counts?.environments).toBeUndefined();
    expect(state.stages.retention?.notes).toEqual(["environment_case:hand_made_ignored", "environment_skipped:environment_exists"]);
    expect(alpha.environments.get(alpha.repositoryId(R1))).toEqual({ revision: 3, files: new Map([[".env", "theirs"]]) });
    expect(state.created.environments).toEqual([]);
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
  });

  it("skips seeding when a repository does not ignore .env", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.ignoresEnv = false;
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(["environment_skipped:path_not_ignored"]);
    expect(alpha.writes.filter(write => write.startsWith("PATCH"))).toEqual([]);
  });

  it("cleanup clears an environment a failed stage seeded", async () => {
    const { alpha, ctx, options } = setup();
    // Fail the stage right after both seeds: at the second workspace create, which follows them.
    let calls = 0;
    const api = ctx.ports.api;
    ctx.ports.api = { json: async (method, path, body, headers) => {
      if (method === "POST" && path === "/v1/cloud-v2/workspaces" && ++calls === 2) throw new Error("lost");
      return api.json(method, path, body, headers);
    } };
    expect(await runStages(ctx, ["projects"], options)).toBe(false);
    expect([...alpha.environments.values()].some(environment => environment.files.size > 0)).toBe(true);
    ctx.ports.api = api;
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
    expect([...alpha.environments.values()].every(environment => environment.files.size === 0)).toBe(true);
  });

  it("fails the stop when the row does not record the worker unit verified off", async () => {
    const { alpha, ctx, lines, options } = setup();
    alpha.workerOff = false;
    expect(await runStages(ctx, ["retention"], options)).toBe(false);
    expect(lines).toContain("stage retention: failed stop_worker_off unverified");
    expect(ctx.state.stages.retention).toMatchObject({ ok: false, step: "stop_worker_off", code: "unverified" });
  });
});

describe("rehearsal database roles", () => {
  /** A PlanetScale and a Postgres that record what was asked of them. */
  function provider(custom?: () => DatabaseClient) {
    const requests: { method: string; path: string; body?: unknown }[] = [], statements: string[] = [];
    let next = 0;
    const live = new Set<string>();
    const planetScale = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (path === "/databases/alpha") return { status: 200, body: { default_branch: "main" } };
      if (method === "POST") { const id = `role-${++next}`; live.add(id); return { status: 201, body: { id, name: "n", username: "u", password: "p", access_host_url: "h.example" } }; }
      const id = path.split("/").at(-1)!;
      if (method === "DELETE") { live.delete(id); return { status: 204, body: null }; }
      return { status: live.has(id) ? 200 : 404, body: null };
    };
    const client = (): DatabaseClient => ({
      connect: async () => undefined, end: async () => undefined,
      query: async text => { statements.push(text); return { rows: text.includes("session_user") ? [{ name: "u.routing" }] : [{ id: "abcdef12-0000-0000-0000-000000000000" }], rowCount: 1 }; },
    });
    const database = liveDatabase({ organization: "o", database: "alpha", tokenId: "t", token: "t", roleName: kind => `r-${kind}`, planetScale,
      client: custom ?? client, sleep: async () => undefined });
    const inherited = () => requests.filter(request => request.method === "POST").map(request => (request.body as { inherited_roles: string[] }).inherited_roles);
    return { database, requests, statements, live, inherited };
  }

  it("reads through a pg_read_all_data role in the RLS-safe form, never postgres, and deletes it at close", async () => {
    const { database, statements, live, inherited } = provider();
    expect(await platformOwners(database)).toEqual(["abcdef12"]);
    await database.read("SELECT 1 AS one");
    expect(inherited()).toEqual([["pg_read_all_data"]]);
    expect(statements).toContain("BEGIN READ ONLY");
    const reads = statements.filter(text => text.includes("CROSS JOIN LATERAL"));
    expect(reads).toHaveLength(2);
    for (const text of reads) expect(text).toMatch(/^WITH cfg AS MATERIALIZED \(SELECT set_config\('app\.system','on',true\) AS v\)/);
    expect(statements.some(text => text.startsWith("GRANT"))).toBe(false);
    expect(live.size).toBe(1);
    await database.close();
    expect(live.size).toBe(0);
  });

  it("mints a postgres role only for a write transaction, grants zeros_app to its session user, and deletes it before returning", async () => {
    const { database, statements, live, inherited } = provider();
    expect(await database.transaction(async query => { expect(live.size).toBe(1); return (await query("SELECT 2")).rowCount; })).toBe(1);
    expect(inherited()).toEqual([["postgres"]]);
    expect(statements).toContain('GRANT zeros_app TO "u.routing"');
    expect(live.size).toBe(0);
    await expect(database.transaction(async () => { throw new RehearsalFailure("work", "failed"); })).rejects.toMatchObject({ code: "failed" });
    expect(live.size).toBe(0);
    expect(statements).toContain("ROLLBACK");
  });

  it("names a database failure by SQLSTATE only, and replaces a dropped read connection once", async () => {
    expect(databaseErrorCode({ code: "42501", message: "permission denied for table users" })).toBe("sqlstate_42501");
    expect(databaseErrorCode({ code: "57P01" })).toBe("connection");
    expect(databaseErrorCode({ code: "08006" })).toBe("connection");
    expect(databaseErrorCode(new Error("read ECONNRESET"))).toBe("connection");
    let dropped = false;
    const { database: flaky, live, inherited } = provider(() => ({ connect: async () => undefined, end: async () => undefined,
      query: async text => {
        if (text.includes("LATERAL") && !dropped) { dropped = true; throw Object.assign(new Error("terminated"), { code: "57P01" }); }
        return { rows: [{ one: 1 }], rowCount: 1 };
      } }));
    expect(await flaky.read("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    // Two read roles minted, the first deleted when its connection dropped.
    expect(inherited()).toEqual([["pg_read_all_data"], ["pg_read_all_data"]]);
    expect(live.size).toBe(1);
    await flaky.close();
    expect(live.size).toBe(0);
    // A refused query is not retried: its SQLSTATE is the code.
    const { database: refused, inherited: once } = provider(() => ({ connect: async () => undefined, end: async () => undefined,
      query: async text => { if (text.includes("LATERAL")) throw Object.assign(new Error("permission denied"), { code: "42501" }); return { rows: [], rowCount: 0 }; } }));
    await expect(refused.read("SELECT 1")).rejects.toMatchObject({ step: "database", code: "sqlstate_42501" });
    expect(once()).toHaveLength(1);
  });

  it("stage A never asks for a write; stage C's only writes are its shifts", async () => {
    const projects = setup();
    expect(await runStages(projects.ctx, ["projects"], projects.options)).toBe(true);
    expect(projects.alpha.transactions).toBe(0);
    const retention = setup();
    expect(await runStages(retention.ctx, ["retention"], retention.options)).toBe(true);
    expect(retention.alpha.transactions).toBe(retention.alpha.shifts.length);
  });
});

describe("rehearsal on the Personal route", () => {
  const all = { switches: new Set(["projects", "personal", "retention"] as const) };

  it("runs provision, setup, projects, personal and retention in the test user's Personal organization, then cleanup restores everything", async () => {
    const { alpha, state, ctx, lines, options } = setup({ provisioned: false, owner: "personal" });
    expect(await runStages(ctx, ["provision", "setup", "projects", "personal", "retention"], { ...options, ...all })).toBe(true);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage provision: ok", "stage setup: ok", "stage projects: ok", "stage personal: ok", "stage retention: ok"]);
    expect(ctx.projectLevel).toBe("personal");
    expect(state.stages.setup?.counts).toEqual({ proChanges: 1, githubSignIn: 1 });
    // Pro ended: the machine stopped after the 20-minute idle stop; four reads and the list were hidden from the second user.
    expect(state.stages.personal?.counts).toMatchObject({ workspaces: 1, hiddenReads: 5, minutesToStop: 20 });
    expect(state.stages.personal?.notes).toEqual(["worker_token:not_observable"]);
    expect(alpha.proChanges.map(grant => grant.enabled)).toEqual([true, false, true]);
    expect(alpha.writes.filter(write => write.startsWith("other"))).toEqual([]);
    expect(state.created.githubSignIns).toEqual([alpha.organizationId]);
    const { inventory } = await cleanup(ctx, { keepFixtures: false, log: line => lines.push(line) });
    expect(inventory).toEqual(EMPTY);
    // Pro is back to "none" (the grant ends; there was none before), and the token sign-in is gone.
    expect(alpha.pro()).toBe(false);
    expect(alpha.patConnected).toBe(false);
    for (const line of lines) expect(safeLine(line)).toBe(line);
  });

  it("rehearses submodules: the copy fetched both, the forked workspace holds both at their commits, the token sign-in named", async () => {
    const { ctx, state, options } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup", "submodules"], { ...options, ...all })).toBe(true);
    expect(state.stages.submodules?.counts).toEqual({ copyFetched: 2, workspaceInitialized: 2 });
    expect(state.stages.submodules?.notes).toEqual(["submodules:token_sign_in_named", "d3:not_rehearsed_single_member"]);
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
  });

  it("refuses submodules until its fixtures exist, and off the Personal route", async () => {
    const missing = setup({ owner: "personal", submodules: false });
    expect(await runStages(missing.ctx, ["submodules"], { ...missing.options, ...all })).toBe(false);
    expect(missing.ctx.state.stages.submodules).toMatchObject({ step: "fixtures", code: "missing" });
    expect(missing.alpha.writes).toEqual([]);
    const organization = setup();
    expect(await runStages(organization.ctx, ["submodules"], organization.options)).toBe(false);
    expect(organization.ctx.state.stages.submodules).toMatchObject({ step: "owner", code: "personal_route_only" });
  });

  it("puts back a grant that existed before the run, exactly", async () => {
    const { alpha, ctx, options } = setup({ owner: "personal" });
    const before = { enabled: true, validFrom: new Date(alpha.now - 1e9).toISOString(), validUntil: new Date(alpha.now + 3_600_000).toISOString() };
    alpha.proGrant = { ...before };
    expect(await runStages(ctx, ["setup", "personal"], { ...options, ...all })).toBe(true);
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.proGrant).toEqual(before);
  });

  it("cleanup after Pro was left off turns it on to delete, then puts the grant back", async () => {
    const { alpha, ctx, options } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup"], { ...options, ...all })).toBe(true);
    // Fail stage B just after its Pro-off change: the workspace now answers 403 pro_required.
    let changes = 0;
    const port = ctx.ports.pro!;
    ctx.ports.pro = { read: port.read, change: async (grant, reason) => { const id = await port.change(grant, reason); if (++changes === 1) throw new RehearsalFailure("injected", "fault"); return id; } };
    expect(await runStages(ctx, ["personal"], { ...options, ...all })).toBe(false);
    expect(alpha.pro()).toBe(false);
    ctx.ports.pro = port;
    expect((await cleanup(ctx, { keepFixtures: true, log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.pro()).toBe(false);
  });

  it("never replaces a sign-in or a grant it did not make, and refuses B before setup", async () => {
    const existing = setup({ owner: "personal" });
    existing.alpha.patConnected = true;
    expect(await runStages(existing.ctx, ["setup"], { ...existing.options, ...all })).toBe(false);
    expect(existing.ctx.state.stages.setup).toMatchObject({ step: "github_sign_in", code: "exists" });
    const foreign = setup({ owner: "personal" });
    foreign.alpha.proGrant = "foreign";
    expect(await runStages(foreign.ctx, ["setup"], { ...foreign.options, ...all })).toBe(false);
    expect(foreign.ctx.state.stages.setup).toMatchObject({ step: "pro", code: "foreign_grant" });
    expect(foreign.alpha.proChanges).toEqual([]);
    const early = setup({ owner: "personal" });
    expect(await runStages(early.ctx, ["personal"], { ...early.options, ...all })).toBe(false);
    expect(early.ctx.state.stages.personal).toMatchObject({ step: "pro", code: "run_setup_first" });
  });

  it("refuses the Personal route's stages without the personal switch, and setup on the organization route", async () => {
    const personal = setup({ owner: "personal" });
    expect(await runStages(personal.ctx, ["projects"], { ...personal.options, switches: new Set(["projects"] as const) })).toBe(false);
    expect(personal.ctx.state.stages.projects).toMatchObject({ step: "switch", code: "undeclared_personal" });
    const organization = setup({ owner: "organization" });
    expect(await runStages(organization.ctx, ["setup"], organization.options)).toBe(false);
    expect(organization.ctx.state.stages.setup).toMatchObject({ code: "organization_route_awaiting_approval" });
  });
});

describe("rehearsal without an account", () => {
  it("runs provision with nobody signed in and refuses the stages that need an account, naming why", async () => {
    const { alpha, state, ctx, lines, options } = setup({ provisioned: false });
    ctx.ports.api = NO_ACCOUNT;
    expect(await runStages(ctx, ["provision", "projects"], { ...options, accountUnavailable: "sign_in:http_429_rate_limit_exceeded" })).toBe(false);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage provision: ok",
      "stage projects: failed account_unavailable sign_in:http_429_rate_limit_exceeded"]);
    expect(alpha.writes).toEqual([]);
    expect(cleanupNeedsAccount(state)).toBe(false);
    expect((await cleanup(ctx, { keepFixtures: false, accountless: true, log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.repositories.has(FIXTURE_TWO.toLowerCase())).toBe(false);
  });

  it("refuses an accountless cleanup of a run that created anything only the API removes", async () => {
    const { ctx, state } = setup();
    state.machineStarts = 1;
    await expect(cleanup(ctx, { keepFixtures: true, accountless: true, log: () => undefined })).rejects.toMatchObject({ code: "account_required" });
  });
});

describe("rehearsal sign-in", () => {
  const account = { label: "3", email: "user-3@zeros.build", password: "pw" };
  const session = () => ({ accessToken: async () => "t", close: vi.fn(async () => undefined) });
  const me = (organizations: unknown[]) => ({ json: async () => ({ status: 200, body: { user: { id: randomUUID() }, organizations } }) });
  const deps = (overrides: Partial<SignInDeps> = {}): SignInDeps & { waits: number[] } => {
    const waits: number[] = [];
    return { waits, subject: async () => "user_3", signIn: async () => session(), api: () => me([{ id: randomUUID(), slug: null }]),
      sleep: async ms => { waits.push(ms); }, ...overrides };
  };

  it("names the failed step and its closed code, and closes a session it opened", async () => {
    expect(await signInAccount(account, deps({ subject: async () => { throw new RehearsalFailure("subject_lookup", "not_found"); } })))
      .toEqual({ ok: false, label: "3", step: "subject_lookup", code: "not_found" });
    expect(await signInAccount(account, deps({ signIn: async () => { throw new Gate0Failure("sign_in", "http_400_invalid_credentials"); } })))
      .toEqual({ ok: false, label: "3", step: "sign_in", code: "http_400_invalid_credentials" });
    expect(await signInAccount(account, deps({ signIn: async () => { throw new Error("pw leaked"); } })))
      .toEqual({ ok: false, label: "3", step: "sign_in", code: "unexpected" });
    const opened = session();
    expect(await signInAccount(account, deps({ signIn: async () => opened, api: () => ({ json: async () => ({ status: 401, body: null }) }) })))
      .toEqual({ ok: false, label: "3", step: "me_read", code: "http_401" });
    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(await signInAccount(account, deps({ api: () => me([{ id: "not-a-uuid" }]) }))).toEqual({ ok: false, label: "3", step: "me_read", code: "schema:organizations.0.id" });
    // An organization without a slug is not a failure.
    expect(await signInAccount(account, deps())).toMatchObject({ ok: true, organizations: [{ slug: null }], selected: "none" });
  });

  it("retries a throttled step after 5, 15 and 45 seconds, then reports it", async () => {
    let calls = 0;
    const throttledOnce = deps({ signIn: async () => { if (++calls === 1) throw new Gate0Failure("sign_in", "http_429_rate_limit_exceeded"); return session(); } });
    expect(await signInAccount(account, throttledOnce)).toMatchObject({ ok: true });
    expect(throttledOnce.waits).toEqual([5_000]);
    const always = deps({ signIn: async () => { throw new Gate0Failure("sign_in", "http_429"); } });
    expect(await signInAccount(account, always)).toEqual({ ok: false, label: "3", step: "sign_in", code: "http_429" });
    expect(always.waits).toEqual([5_000, 15_000, 45_000]);
    const notThrottled = deps({ signIn: async () => { throw new Gate0Failure("sign_in", "http_400"); } });
    await signInAccount(account, notThrottled);
    expect(notThrottled.waits).toEqual([]);
  });

  it("chooses the probe's WorkOS organization when WorkOS asks, else the first offered, and says which", async () => {
    const choosing = (offered: string[], probe?: string) => deps({ ...(probe ? { probeWorkosOrganization: probe } : {}),
      signIn: async input => { expect(input.selectOrganization(offered)).toBe(probe && offered.includes(probe) ? probe : offered[0]); return session(); } });
    expect(await signInAccount(account, choosing(["org_a", "org_probe"], "org_probe"))).toMatchObject({ selected: "probe" });
    expect(await signInAccount(account, choosing(["org_a"], "org_probe"))).toMatchObject({ selected: "other" });
  });

  it("signs accounts in one at a time, three seconds apart, and keeps going after a failure", async () => {
    let n = 0;
    const spaced = deps({ signIn: async () => { if (++n === 1) throw new Gate0Failure("sign_in", "http_400"); return session(); } });
    const results = await signInAll([account, { ...account, label: "4" }, { ...account, label: "5" }], spaced);
    expect(results.map(result => result.ok)).toEqual([false, true, true]);
    expect(spaced.waits).toEqual([3_000, 3_000]);
  });
});

describe("rehearsal --plan", () => {
  it("reads accounts with GETs only and lists every write without making one", async () => {
    const { alpha, state } = setup();
    const summary = await readAccount(alpha.api(), "owner", state.organizationId, "Withso");
    expect(alpha.writes).toEqual([]);
    expect(summary).toMatchObject({ admin: true, fixtureConnection: true, githubIdentity: true, connections: { organization: 1, personal: 0, logins: ["Withso"] } });
    for (const line of accountLines(summary)) expect(safeLine(line)).toBe(line);
    const switches = new Set(["projects", "retention"] as const), org = "organization" as const;
    expect(refusal("projects", summary, switches, org)).toBeNull();
    expect(refusal("retention", summary, new Set(["projects"] as const), org)).toBe("undeclared_retention");
    expect(refusal("personal", summary, switches, org)).toBe("personal_route_only");
    expect(refusal("projects", { ...summary, admin: false }, switches, org)).toBe("not_owner_or_admin");
    expect(refusal("projects", { ...summary, fixtureConnection: false }, switches, org)).toBe("no_fixture_connection");
    expect(refusal("projects", { ...summary, githubIdentity: false }, switches, org)).toBe("no_github_identity");
    expect(refusal("retention", { failed: "sign_in:http_400_invalid_credentials" }, switches, org)).toBe("account_unavailable:sign_in:http_400_invalid_credentials");
    // provision uses only the App: no account, or a failed one, does not refuse it.
    expect(refusal("provision", { failed: "sign_in:network" }, switches, org)).toBeNull();
    expect(refusal("setup", summary, switches, org)).toBe("awaiting_approval");
    // The Personal route: every stage but provision needs the personal switch; setup needs the token and the actor.
    const all = new Set(["projects", "personal", "retention"] as const);
    expect(refusal("projects", summary, switches)).toBe("undeclared_personal");
    expect(refusal("setup", summary, all)).toBeNull();
    expect(refusal("setup", summary, all, "personal", { token: false, proActor: "resolved" })).toBe("no_github_token");
    expect(refusal("setup", summary, all, "personal", { token: true, proActor: "ambiguous" })).toBe("pro_actor_ambiguous");
    expect(refusal("personal", summary, all)).toBeNull();
    expect(refusal("retention", { ...summary, personal: null }, all)).toBe("no_personal_organization");
    expect(refusal("submodules", summary, all)).toBe("fixtures_not_named");
    expect(refusal("submodules", summary, all, "personal", { token: true, proActor: "resolved", submoduleFixtures: "missing" })).toBe("fixtures_missing");
    expect(refusal("submodules", summary, all, "personal", { token: true, proActor: "resolved", submoduleFixtures: "present" })).toBeNull();
    expect(refusal("submodules", summary, all, "organization")).toBe("personal_route_only");
    for (const line of PERSONAL_ROUTE_GAPS) expect(safeLine(line)).toBe(line);
    alpha.githubIdentity = false;
    expect((await readAccount(alpha.api(), "9", state.organizationId, "Withso")).githubIdentity).toBe(false);
    for (const stage of ["provision", "setup", "projects", "personal", "retention", "submodules"] as StageName[])
      for (const owner of ["personal", "organization"] as const)
        for (const line of writeLines(stage, "zr-<run>-", { one: R1 }, owner)) { expect(line).not.toBe("line withheld (unsafe)"); }
  });
});
