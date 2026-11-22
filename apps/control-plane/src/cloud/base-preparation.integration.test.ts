// A safe switch-on for ready copies (computer.ts ensureBase, the sweep, the legacy build): turning
// CLOUD_V2_READY_COPIES_ENABLED on never leaves an organization that could create a cloud workspace unable to create
// one, and nobody presses Build for a Cloud Computer without an install script. Boat is the shared fake throughout.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { configureCloudPersonal } from "../db-context.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CloudV2ComputerBuilder, CloudV2Computers, type CloudV2BaseState, type CloudV2ComputerOptions } from "./computer.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import { CloudV2ReadyCopies, CloudV2ReadyCopyBuilder } from "./ready-copies.js";
import { CloudV2Store } from "./store.js";
import { CloudProjects, migrateProjects } from "./projects.js";
import { createCloudWorkspaceOperations } from "./workspace-create.js";
import type { CloudV2RouteDeps } from "./routes.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DAY = 24 * 60 * 60_000;
const SHARED = "zeros-base-1";
const repositoryId = (repository: string) => BigInt(`0x${createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12)}`).toString();
const resolveRepository: CloudV2ComputerSourceResolver = async (_org, _user, target) => ({
  repository: target.repository, repositoryId: target.repositoryId ?? repositoryId(target.repository),
});
const runtime = { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" };
/** What a Cloud Computer installed before projects. */
const RECIPE = { repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] };

type OrgState = "no build" | "pre-switch build" | "pre-switch build with an install script" | "built base" | "shared base";
type Outcome = "project" | "waits" | "pre-switch";

d("ready copies: a safe switch-on", () => {
  let pool: pg.Pool, boat: FakeBoat, clock: number, store: CloudV2Store;
  let org: string, admin: string, member: string;
  const tokens: string[] = [];
  const errors: string[] = [];
  const logger = { warn: () => {}, error: (line: string) => { errors.push(line); } };

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { configureCloudPersonal(pool, false); await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    configureCloudPersonal(pool, false);
    tokens.length = 0; errors.length = 0;
    clock = Date.now();
    boat = new FakeBoat(() => clock);
    store = new CloudV2Store(pool);
    [admin, member] = [randomUUID(), randomUUID()];
    for (const id of [admin, member]) await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [id, `u-${id}@example.test`]);
    await grantTestPro(pool, admin, member);
    org = await organization();
  });

  async function organization(options: { personal?: boolean; cloud?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, $4, $5)",
      // A Personal organization's cloud is its owner's Pro and the personal switch (cloud_organization_enabled), never this column.
      [id, `org-${id}`, admin, options.personal === true, !options.personal && options.cloud !== false]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [id, admin]);
    if (!options.personal) await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [id, member]);
    return id;
  }
  async function project(repositories: string[] = ["withso/zeros"], options: { level?: "organization" | "personal"; owner?: string; at?: string } = {}): Promise<string> {
    const id = randomUUID(), level = options.level ?? "organization", target = options.at ?? org;
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, target, `p-${id.slice(0, 8)}`, level, level === "personal" ? options.owner : null, options.owner ?? admin]);
    for (const [position, repository] of repositories.entries())
      await pool.query("INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id) VALUES ($1,$2,$3,$4)",
        [id, position, repository, repositoryId(repository)]);
    return id;
  }

  const computersWith = (options: { shared?: boolean; readyCopies?: boolean; budget?: CloudV2ComputerOptions["automaticBaseBudget"] } = {}) =>
    new CloudV2Computers(pool, pool, resolveRepository, resolveRepository, {
      ...(options.readyCopies === false ? {} : { readyCopies: true, runtimeSha256: runtime.sha256 }),
      ...(options.shared ? { sharedBaseSnapshot: SHARED, sharedBaseAvailable: async () => boat.snapshots.has(SHARED) } : {}),
      ...(options.budget ? { automaticBaseBudget: options.budget } : {}),
    });
  const copies = () => new CloudV2ReadyCopies(pool);
  const copyBuilder = () => new CloudV2ReadyCopyBuilder({ copies: copies(), compute: boat, channel: "alpha", runtime,
    cloneToken: async (_org, user) => { tokens.push(`copy:${user}`); return "synthetic-clone-token"; }, now: () => clock, sleep: async () => {}, logger });
  const builder = (computers: CloudV2Computers) => new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, logger,
    cloneToken: async (_org, user) => { tokens.push(`computer:${user}`); return "synthetic-clone-token"; },
    onActivated: ({ organizationId, reason }) => copyBuilder().baseActivated(organizationId, reason), now: () => clock });
  /** A Cloud Computer as built before the switch: it installs withso/zeros; migrateProjects makes its project, as at boot. */
  async function preSwitchBuild(installScript?: string) {
    const off = computersWith({ readyCopies: false });
    const build = await off.enqueue(org, admin, RECIPE, { configure: true });
    await builder(off).tick();
    if (installScript) await pool.query("UPDATE cloud_v2_computers SET install_script=$2 WHERE org_id=$1", [org, installScript]);
    await migrateProjects(pool);
    return build;
  }
  async function arrange(state: OrgState, shared: boolean): Promise<CloudV2Computers> {
    if (state === "shared base") {
      boat.snapshots.set(SHARED, new Map());
      expect((await computersWith({ shared: true }).ensureBase(org)).state).toBe("ready");
      await project();
    } else if (state === "built base") {
      await pool.query("INSERT INTO cloud_v2_computers (org_id, recipe_revision, install_script) VALUES ($1, 1, 'echo tools')", [org]);
      const on = computersWith();
      await on.ensureBase(org);
      await builder(on).tick();
      await project();
    } else if (state === "no build") await project();
    else await preSwitchBuild(state === "pre-switch build" ? undefined : "echo tools");
    if (shared) boat.snapshots.set(SHARED, new Map()); else boat.snapshots.delete(SHARED);
    return computersWith({ shared });
  }
  const operations = (computers: CloudV2Computers) => createCloudWorkspaceOperations({
    store, computers, projects: new CloudProjects(pool),
    projectAccess: async (_o: string, _u: string, repositories: { repository: string; repositoryId: string; baseBranch?: string | null }[]) =>
      repositories.map(entry => ({ ...entry, baseBranch: entry.baseBranch ?? "main", baseCommit: "c".repeat(40) })),
    authorizeBuildRepository: async (_o: string, _u: string, _b: string, repository: string) => ({ repository, repositoryId: repositoryId(repository) }),
    remoteHead: async () => "d".repeat(40),
  } as unknown as CloudV2RouteDeps);
  const create = (computers: CloudV2Computers, user: string, body: { repository?: string; projectId?: string }) =>
    operations(computers).create(user, { organizationId: org, ...body }, { document: workspace => workspace as never, receiptDocument: workspace => workspace as never });
  const workspaceRow = async (id: string) => (await pool.query<{ project_id: string | null; waiting_for_base_at: Date | null; computer_build_id: string; state: string }>(
    "SELECT project_id, waiting_for_base_at, computer_build_id, state FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]!;
  const outcomeOf = async (id: string): Promise<Outcome> => {
    const row = await workspaceRow(id);
    return !row.project_id ? "pre-switch" : row.waiting_for_base_at ? "waits" : "project";
  };
  /** What a create gets in each state: never a refusal for the base. */
  const expected = (state: OrgState, shared: boolean): Outcome =>
    state === "built base" || state === "shared base" ? "project"
      : state === "no build" ? (shared ? "project" : "waits")
        : state === "pre-switch build" && shared ? "project" : "pre-switch";

  const STATES: OrgState[] = ["no build", "pre-switch build", "pre-switch build with an install script", "built base", "shared base"];
  const matrix = STATES.flatMap(state => [true, false].flatMap(shared => (["organization", "personal"] as const).flatMap(owner =>
    (owner === "personal" ? ["admin"] as const : ["admin", "member"] as const).flatMap(caller =>
      (["repository", "project"] as const).map(request => ({ state, shared, owner, caller, request }))))));

  it.each(matrix)("$state, shared base $shared, $owner, $caller, by $request: a create is accepted or waits, never refused for the base",
    async ({ state, shared, owner, caller, request }) => {
      if (owner === "personal") { configureCloudPersonal(pool, true); org = await organization({ personal: true }); }
      const computers = await arrange(state, shared);
      const projectId = (await pool.query<{ id: string }>("SELECT id FROM cloud_projects WHERE org_id=$1 ORDER BY created_at LIMIT 1", [org])).rows[0]!.id;
      const result = await create(computers, caller === "admin" ? admin : member, request === "repository" ? { repository: "withso/zeros" } : { projectId });
      expect(result.status).toBe(201);
      const id = (result.response as unknown as { id: string }).id;
      expect(await outcomeOf(id)).toBe(expected(state, shared));
      // A waiting workspace says so; the others never do.
      expect("preparing" in result.response).toBe(expected(state, shared) === "waits");
    });

  it("makes one base for an organization under concurrent creates", async () => {
    await project();
    const computers = computersWith();
    const states = await Promise.all(Array.from({ length: 6 }, () => computers.ensureBase(org)));
    const builds = (await pool.query("SELECT id FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows;
    expect(builds).toHaveLength(1);
    expect(new Set(states.map(state => state.state === "preparing" ? state.buildId : null))).toEqual(new Set([builds[0]!.id]));
    boat.snapshots.set(SHARED, new Map());
    const other = await organization(), shared = computersWith({ shared: true });
    org = other;
    await Promise.all(Array.from({ length: 6 }, () => shared.ensureBase(other)));
    expect((await pool.query("SELECT base_shared, automatic, created_by FROM cloud_v2_computer_builds WHERE org_id=$1", [other])).rows)
      .toEqual([{ base_shared: true, automatic: true, created_by: null }]);
  });

  it("runs an automatic base with no creator, no source and no token: an empty builder environment, its install script, nothing cloned", async () => {
    await pool.query("INSERT INTO cloud_v2_computers (org_id, recipe_revision, install_script) VALUES ($1, 1, 'echo tools')", [org]);
    const computers = computersWith();
    const state = await computers.ensureBase(org);
    expect(state.state).toBe("preparing");
    const row = (await pool.query("SELECT created_by, automatic, base_only, source_targets, install_script FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0];
    expect(row).toEqual({ created_by: null, automatic: true, base_only: true, source_targets: [], install_script: "echo tools" });
    await builder(computers).tick();
    expect(boat.calls.filter(call => call.op === "create").map(call => (call.args[0] as { env: Record<string, string> }).env)).toEqual([{}]);
    expect(tokens).toEqual([]);
    const commands = boat.commands.map(command => `${command.command}\n${command.input ?? ""}`).join("\n");
    expect(commands).toContain("echo tools");
    expect(commands).not.toMatch(/Authorization|x-access-token|git clone/);
    const overview = await computers.overview(org);
    expect(overview.base).toEqual({ state: "ready", buildId: (state as { buildId: string }).buildId });
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", automatic: true, createdBy: null });
    expect(await computers.log(org, overview.builds[0]!.id)).toContain("prepared automatically by Zeros");
    // A copy is built as its project's creator, never as the base's (it has none).
    expect((await copies().base(org))?.createdBy).toBeNull();
  });

  it("cancels an automatic base when its organization loses cloud, and never queues one for an organization without cloud", async () => {
    await project();
    const computers = computersWith();
    expect((await computers.ensureBase(org)).state).toBe("preparing");
    await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [org]);
    await builder(computers).tick();
    expect((await pool.query("SELECT state, error_code FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows)
      .toEqual([{ state: "cancelled", error_code: "computer_cloud_unavailable" }]);
    expect(await computers.ensureBase(org)).toEqual({ state: "unavailable" });
    // A Personal organization without the personal switch, or without Pro: never a build, from a create or the sweep.
    const personal = await organization({ personal: true });
    await project(["withso/zeros"], { at: personal });
    expect(await computers.ensureBase(personal)).toEqual({ state: "unavailable" });
    configureCloudPersonal(pool, true);
    await pool.query("UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1", [admin]);
    await builder(computers).tick();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [personal])).rows[0].n).toBe(0);
  });
});
