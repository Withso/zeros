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

  const lifecycle = () => new CloudV2Lifecycle({ store, compute: boat, runtime,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
    sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
    sandboxName: () => `zeros-fixture-${randomUUID()}`, sleep: async () => {}, now: () => clock });
  const due = (id: string) => pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=clock_timestamp() WHERE id=$1", [id]);
  const creates = () => boat.calls.filter(call => call.op === "create").map(call => call.args[0] as { from?: string; name: string });
  /** Workspace machines only (the lifecycle names them zeros-fixture-…), not the builder that makes a base. */
  const workspaceMachines = () => creates().filter(call => call.name.startsWith("zeros-fixture-"));
  /** A project workspace created while the organization's base is being prepared (no shared base). */
  async function waiting(installScript: string | null = null) {
    if (installScript) await pool.query("INSERT INTO cloud_v2_computers (org_id, recipe_revision, install_script) VALUES ($1, 1, $2)", [org, installScript]);
    const projectId = await project();
    const computers = computersWith();
    const created = await create(computers, member, { projectId });
    const id = (created.response as unknown as { id: string }).id;
    expect(await outcomeOf(id)).toBe("waits");
    return { computers, id, buildId: (await workspaceRow(id)).computer_build_id };
  }

  describe("a workspace waiting for the shared base that is still being built", () => {
    // The builder's shared base for the pinned runtime, as its resolver reports it.
    const resolved = (initial: SharedBaseState) => {
      const holder = { state: initial };
      const computers = new CloudV2Computers(pool, pool, resolveRepository, resolveRepository, { readyCopies: true, runtimeSha256: runtime.sha256,
        sharedBase: { state: async () => holder.state }, sharedBaseAvailable: async (name?: string) => !!name && boat.snapshots.has(name) });
      return { holder, computers };
    };

    it("waits on its organization's base row, held unclaimed; when the shared base is ready that row goes live on it with no machine", async () => {
      const { holder, computers } = resolved({ state: "building" });
      const projectId = await project();
      const created = await create(computers, member, { projectId });
      const id = (created.response as unknown as { id: string }).id;
      // The ordinary waiting path: the workspace waits, bound to the organization's own queued base row.
      expect(await outcomeOf(id)).toBe("waits");
      const row = (await workspaceRow(id)).computer_build_id;
      expect((await pool.query("SELECT state, automatic, base_shared FROM cloud_v2_computer_builds WHERE id=$1", [row])).rows[0])
        .toEqual({ state: "queued", automatic: true, base_shared: false });
      // While the shared base is building the row is held: no builder machine, no claim.
      await builder(computers).tick();
      expect((await pool.query("SELECT state FROM cloud_v2_computer_builds WHERE id=$1", [row])).rows[0].state).toBe("queued");
      expect(creates()).toEqual([]);
      await lifecycle().tick();
      expect(await workspaceRow(id)).toMatchObject({ state: "creating", computer_build_id: row });
      // Ready (and at Boat): the same row becomes the shared base, with no machine; the workspace boots from it.
      holder.state = { state: "ready", name: SHARED, source: "database" };
      boat.snapshots.set(SHARED, new Map());
      await builder(computers).tick();
      expect((await pool.query("SELECT state, base_shared, snapshot_id FROM cloud_v2_computer_builds WHERE id=$1", [row])).rows[0])
        .toMatchObject({ state: "succeeded", base_shared: true, snapshot_id: `${SHARED}@${row}` });
      expect(creates()).toEqual([]);
      await due(id);
      await lifecycle().tick();
      expect(creates().at(-1)).toMatchObject({ from: SHARED });
      expect(await workspaceRow(id)).toMatchObject({ computer_build_id: row, waiting_for_base_at: null });
    });

    it("builds the organization's own base on that same row when the shared build has failed, or after 30 minutes held", async () => {
      for (const after of ["failed", "held"] as const) {
        org = await organization();
        const { holder, computers } = resolved({ state: "building" });
        const created = await create(computers, member, { projectId: await project() });
        const id = (created.response as unknown as { id: string }).id;
        const row = (await workspaceRow(id)).computer_build_id;
        if (after === "failed") holder.state = { state: "failed", nextAttemptAt: null };
        else await pool.query("UPDATE cloud_v2_computer_builds SET created_at=clock_timestamp()-interval '31 minutes' WHERE id=$1", [row]);
        const before = creates().length;
        await builder(computers).tick();
        // Its own builder machine, on the row the workspace is bound to: never re-bound.
        expect(creates().length).toBe(before + 1);
        expect((await pool.query("SELECT state, base_shared FROM cloud_v2_computer_builds WHERE id=$1", [row])).rows[0])
          .toEqual({ state: "succeeded", base_shared: false });
        expect((await workspaceRow(id)).computer_build_id).toBe(row);
      }
    });

    it("never queues for an organization without an install script from the sweep while the shared base is building", async () => {
      const { holder, computers } = resolved({ state: "building" });
      await project();
      await builder(computers).tick();
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n).toBe(0);
      // Once the shared build has failed, the sweep gives it its own base.
      holder.state = { state: "failed", nextAttemptAt: null };
      clock += 61_000;
      await builder(computers).tick();
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n).toBe(1);
    });
  });

  describe("a workspace waiting for its base", () => {
    it("waits while the base is prepared, then boots from it, its boot deadline counted from when the base went live", async () => {
      const { computers, id, buildId } = await waiting();
      // Created long ago as far as the deadline is concerned: still waits, never times out while its base is coming.
      await pool.query("UPDATE cloud_v2_workspaces SET created_at=clock_timestamp()-interval '20 minutes' WHERE id=$1", [id]);
      await lifecycle().tick();
      expect(creates()).toEqual([]);
      expect(await workspaceRow(id)).toMatchObject({ state: "creating", computer_build_id: buildId });
      expect((await store.get(id, member)).preparing).toBe("computer");
      await builder(computers).tick();
      const base = (await pool.query("SELECT snapshot_id FROM cloud_v2_computer_builds WHERE id=$1", [buildId])).rows[0].snapshot_id as string;
      await due(id);
      await lifecycle().tick();
      expect(creates().at(-1)).toMatchObject({ from: base });
      expect((await workspaceRow(id)).waiting_for_base_at).toBeNull();
      expect((await store.get(id, member)).preparing).toBeUndefined();
      // Booting, no hello yet: the next tick still counts its deadline from when the base went live, not from the create.
      await due(id);
      await lifecycle().tick();
      expect((await pool.query("SELECT state, error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]).toEqual({ state: "creating", error_code: null });
    });

    it("counts its boot deadline from the tick that saw the base live, however long after the base finished that tick came", async () => {
      const { computers, id } = await waiting();
      await builder(computers).tick();
      // A long wait, and then the lifecycle was down or backlogged: created 30 minutes ago, and its base finished 11 minutes
      // before any tick looked at this workspace.
      await pool.query("UPDATE cloud_v2_workspaces SET created_at=clock_timestamp()-interval '30 minutes' WHERE id=$1", [id]);
      await pool.query("UPDATE cloud_v2_computer_builds SET finished_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [org]);
      clock = Date.now();
      await due(id);
      await lifecycle().tick();
      expect(workspaceMachines()).toHaveLength(1);
      expect((await pool.query("SELECT state, error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]).toEqual({ state: "creating", error_code: null });
      // No hello: still within its 10 minutes of that tick at 9, timed out at 11.
      clock += 9 * 60_000;
      await due(id);
      await lifecycle().tick();
      expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].state).toBe("creating");
      clock += 2 * 60_000;
      await due(id);
      await lifecycle().tick();
      expect((await pool.query("SELECT state, error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]).toEqual({ state: "failed", error_code: "worker_boot_timeout" });
    });

    it("moves to a newer live base when the one it waited for fails, in one statement, and fails plainly when there is none", async () => {
      const first = await waiting();
      await pool.query("UPDATE cloud_v2_computer_builds SET state='failed', error_code='computer_install_script_failed', finished_at=clock_timestamp() WHERE id=$1", [first.buildId]);
      await lifecycle().tick();
      expect(await workspaceRow(first.id)).toMatchObject({ state: "failed" });
      expect((await pool.query("SELECT error_code FROM cloud_v2_workspaces WHERE id=$1", [first.id])).rows[0].error_code).toBe("cloud_computer_preparation_failed");
      // In another organization, a create waits on a base that is then cancelled; an admin's build goes live meanwhile.
      org = await organization();
      const computers = computersWith();
      const second = await create(computers, member, { projectId: await project() });
      const secondId = (second.response as unknown as { id: string }).id, waitedOn = (await workspaceRow(secondId)).computer_build_id;
      await pool.query("UPDATE cloud_v2_computer_builds SET state='cancelled', finished_at=clock_timestamp() WHERE id=$1", [waitedOn]);
      const manual = await computers.enqueue(org, admin, { repositories: [] });
      await builder(computers).tick();
      expect((await computers.overview(org)).activeBuildId).toBe(manual.id);
      await due(secondId);
      await lifecycle().tick();
      expect((await workspaceRow(secondId)).computer_build_id).toBe(manual.id);
      await due(secondId);
      await lifecycle().tick();
      expect(creates().at(-1)?.from).toBeTruthy();
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces w JOIN cloud_v2_computer_builds b ON b.id=w.computer_build_id WHERE w.state='creating' AND b.state IN ('failed','cancelled')")).rows[0].n).toBe(0);
    });

    it("lets stop, archive and delete end the wait cleanly: stop ends the create with no machine, archive is refused, delete deletes", async () => {
      const { computers, id } = await waiting();
      await expect(store.requestLifecycle(id, member, "archive")).rejects.toMatchObject({ code: "workspace_unavailable" });
      expect((await store.requestLifecycle(id, member, "stop")).moved).toBe(true);
      expect((await pool.query("SELECT state, error_code, waiting_for_base_at FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0])
        .toEqual({ state: "failed", error_code: "cloud_create_stopped", waiting_for_base_at: null });
      const other = (await create(computers, member, { projectId: (await pool.query("SELECT id FROM cloud_projects WHERE org_id=$1 LIMIT 1", [org])).rows[0].id })).response as unknown as { id: string };
      await store.manage(other.id, "delete", async () => {});
      await lifecycle().tick();
      expect((await workspaceRow(other.id)).state).toBe("deleted");
      // The base still goes live for the organization; neither stopped nor deleted create makes a machine from it.
      await builder(computers).tick();
      await due(id);
      await lifecycle().tick();
      expect(workspaceMachines()).toEqual([]);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces w JOIN cloud_v2_computer_builds b ON b.id=w.computer_build_id WHERE w.state='creating'")).rows[0].n).toBe(0);
    });

    it("gives up before any machine when its member leaves while it waits: their private workspace is archived", async () => {
      const mine = await project(["withso/notes"], { level: "personal", owner: member });
      const computers = computersWith();
      const id = ((await create(computers, member, { projectId: mine })).response as unknown as { id: string }).id;
      expect(await outcomeOf(id)).toBe("waits");
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, member]);
      await builder(computers).tick();
      await due(id);
      await lifecycle().tick();
      expect((await pool.query("SELECT state, error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0])
        .toEqual({ state: "failed", error_code: "cloud_create_archived" });
      expect(workspaceMachines()).toEqual([]);
    });

    it("gives up before any machine when Pro ends while it waits in a Personal organization", async () => {
      configureCloudPersonal(pool, true);
      org = await organization({ personal: true });
      const computers = computersWith();
      const id = ((await create(computers, admin, { projectId: await project() })).response as unknown as { id: string }).id;
      expect(await outcomeOf(id)).toBe("waits");
      await pool.query("UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1", [admin]);
      await lifecycle().tick();
      expect((await pool.query("SELECT state, error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0])
        .toEqual({ state: "failed", error_code: "cloud_creator_access_lost" });
      expect(workspaceMachines()).toEqual([]);
    });
  });

  describe("a base that fails between the create's check and its write", () => {
    it("still writes the waiting workspace, which then fails plainly, never build_required", async () => {
      const projectId = await project();
      const computers = computersWith();
      const state = await computers.ensureBase(org) as Extract<CloudV2BaseState, { state: "preparing" }>;
      // The base fails after ensureBase answered, before the insert.
      await pool.query("UPDATE cloud_v2_computer_builds SET state='failed', error_code='computer_install_script_failed', finished_at=clock_timestamp() WHERE id=$1", [state.buildId]);
      const id = randomUUID(), branch = "zeros/race";
      await store.createWorkspace({ id, organizationId: org, creatorUserId: member, name: "zeros", repository: "withso/zeros", branch, baseBranch: "main",
        computerBuildId: state.buildId!, projectId, checkoutFolder: "zeros/zeros",
        repositories: [{ repository: "withso/zeros", repositoryId: repositoryId("withso/zeros"), folder: "zeros", branch, baseBranch: "main", baseCommit: "c".repeat(40) }] });
      expect(await outcomeOf(id)).toBe("waits");
      await lifecycle().tick();
      expect((await pool.query("SELECT state, error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0])
        .toEqual({ state: "failed", error_code: "cloud_computer_preparation_failed" });
    });
  });

  describe("the sweep", () => {
    const automatic = async () => (await pool.query("SELECT org_id, state FROM cloud_v2_computer_builds WHERE automatic AND NOT base_shared ORDER BY created_at")).rows;
    const tickAt = async (computers: CloudV2Computers, at: number) => { clock = at; await builder(computers).tick(); };

    it("starts machines for automatic bases within the hourly and daily budget, and a waiting create always goes first", async () => {
      const orgs = [org];
      for (let index = 0; index < 4; index++) orgs.push(await organization());
      for (const id of orgs) await project(["withso/zeros"], { at: id });
      const computers = computersWith({ budget: { perHour: 2, perDay: 3 } });
      await tickAt(computers, Date.now());
      expect(await automatic()).toHaveLength(2);
      await tickAt(computers, clock + 61_000);
      expect((await automatic()).map(row => row.state)).toEqual(["succeeded", "succeeded"]);
      expect(await automatic()).toHaveLength(2);
      // An hour on: the hourly budget has room again, the daily one for one more.
      await pool.query("UPDATE cloud_v2_computer_builds SET started_at=started_at-interval '2 hours', created_at=created_at-interval '2 hours' WHERE automatic");
      await tickAt(computers, clock + 61_000);
      await tickAt(computers, clock + 61_000);
      expect(await automatic()).toHaveLength(3);
      await tickAt(computers, clock + 61_000);
      expect(await automatic()).toHaveLength(3);
      // Budget spent for the day: a create in an organization with no base still gets its machine, first.
      const waitingOrg = (await pool.query<{ id: string }>(
        "SELECT o.id FROM organizations o WHERE o.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM cloud_v2_computer_builds b WHERE b.org_id=o.id) LIMIT 1", [orgs])).rows[0]!.id;
      org = waitingOrg;
      const created = await create(computers, admin, { projectId: (await pool.query("SELECT id FROM cloud_projects WHERE org_id=$1", [waitingOrg])).rows[0].id });
      const id = (created.response as unknown as { id: string }).id;
      await tickAt(computers, clock + 61_000);
      expect((await pool.query("SELECT b.state FROM cloud_v2_workspaces w JOIN cloud_v2_computer_builds b ON b.id=w.computer_build_id WHERE w.id=$1", [id])).rows[0].state).toBe("succeeded");
    });

    it("gives a base only to organizations with cloud and some use, never a Personal one, and the shared base to any number at no machine", async () => {
      const without = await organization({ cloud: false }); await project(["withso/zeros"], { at: without });
      const unused = await organization();
      const old = await organization();
      await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, created_at)
        VALUES ($1,$2,$3,'w','withso/zeros','b','main','deleted', clock_timestamp()-interval '40 days')`, [randomUUID(), old, admin]);
      configureCloudPersonal(pool, true);
      const personal = await organization({ personal: true }); await project(["withso/zeros"], { at: personal });
      const used: string[] = [org];
      await project();
      for (let index = 0; index < 29; index++) { const id = await organization(); used.push(id); await project(["withso/zeros"], { at: id }); }
      boat.snapshots.set(SHARED, new Map());
      const computers = computersWith({ shared: true, budget: { perHour: 1, perDay: 1 } });
      await tickAt(computers, Date.now());
      await tickAt(computers, clock + 61_000);
      const based = new Set((await pool.query<{ org_id: string }>("SELECT org_id FROM cloud_v2_computer_builds")).rows.map(row => row.org_id));
      expect(used.every(id => based.has(id))).toBe(true);
      for (const id of [without, unused, old, personal]) expect(based.has(id)).toBe(false);
      expect(creates()).toEqual([]);
      // The Personal organization gets its base at first use.
      expect((await computers.ensureBase(personal)).state).toBe("ready");
    });
  });

  describe("the sweep and organizations in backoff", () => {
    it("skips organizations whose base is in its failure backoff, so they never fill its page", async () => {
      // 30 organizations, each used recently, each with a base that just failed; one more with only a project.
      for (let index = 0; index < 30; index++) {
        const id = await organization();
        await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state)
          VALUES ($1,$2,$3,'w','withso/zeros','b','main','stopped')`, [randomUUID(), id, admin]);
        await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_targets, source_policy_version,
            base_only, automatic, error_code, finished_at) VALUES ($1,$2,1,'{"repositories":[]}','failed',NULL,'[]',2,true,true,'computer_install_script_failed',clock_timestamp())`,
          [randomUUID(), id]);
      }
      await project();
      const computers = computersWith();
      expect((await computers.sweepCandidates(25)).map(row => row.organizationId)).toEqual([org]);
      await builder(computers).tick();
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n).toBe(1);
      // Once their backoff ends they are swept again.
      await pool.query("UPDATE cloud_v2_computer_builds SET finished_at=finished_at-interval '16 minutes' WHERE org_id<>$1", [org]);
      expect(await computers.sweepCandidates(25)).toHaveLength(25);
    });
  });

  describe("first copies", () => {
    it("builds a copy for a project made while the base was being prepared, once the base is live, with nobody touching it", async () => {
      const shared = await project();
      const personal = await project(["withso/notes"], { level: "personal", owner: member });
      const computers = computersWith();
      // Saved while there is no base: each asks, and waits (ensureBase runs first, as the routes do).
      await computers.ensureBase(org);
      await copyBuilder().reconcile(org, shared, "project_created");
      await copyBuilder().reconcile(org, personal, "project_created");
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE org_id=$1", [org])).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_projects WHERE org_id=$1 AND copy_requested_at IS NOT NULL", [org])).rows[0].n).toBe(2);
      await builder(computers).tick();
      for (let index = 0; index < 4; index++) await copyBuilder().tick();
      const rows = (await pool.query<{ project_id: string; state: string; created_by: string }>(
        "SELECT project_id, state, created_by FROM cloud_v2_ready_copies WHERE org_id=$1 ORDER BY created_at", [org])).rows;
      expect(rows.map(row => [row.project_id, row.state]).sort()).toEqual([[shared, "ready"], [personal, "ready"]].sort());
      // Each copy is its project's creator's (the personal one its member's), never the base's: the base has no creator.
      expect(Object.fromEntries(rows.map(row => [row.project_id, row.created_by]))).toEqual({ [shared]: admin, [personal]: member });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_projects WHERE copy_requested_at IS NOT NULL")).rows[0].n).toBe(0);
    });
  });

  describe("a create while the base is in its first backoff", () => {
    it("asks for one immediate retry, and only one: after a second failure it waits out the backoff", async () => {
      await pool.query("INSERT INTO cloud_v2_computers (org_id, recipe_revision, install_script) VALUES ($1, 1, 'exit-7-tools')", [org]);
      let failing = true;
      boat.script = (_machine, command) => failing && command.includes("exit-7-tools") ? { exitCode: 7, stdout: "", timedOut: false } : undefined;
      const projectId = await project();
      const computers = computersWith();
      await computers.ensureBase(org);
      await builder(computers).tick();
      expect(await computers.ensureBase(org)).toMatchObject({ state: "failed", failures: 1 });
      // A create does not wait 15 minutes for a quick failure: it asks once, and waits for that try.
      const first = await create(computers, member, { projectId });
      expect(first.status).toBe(201);
      expect(await outcomeOf((first.response as unknown as { id: string }).id)).toBe("waits");
      await builder(computers).tick();
      // That try failed too: now in its backoff, a create is told so, and asks for nothing more.
      await expect(create(computers, member, { projectId })).rejects.toMatchObject({ code: "cloud_computer_preparation_failed" });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n).toBe(2);
      // The sweep never asks early.
      failing = false;
      expect(await computers.ensureBase(org)).toMatchObject({ state: "failed", failures: 2 });
    });
  });

  describe("a base whose creator is gone", () => {
    it("still gives projects their copies, as their creators, and is still refreshed, as an automatic base", async () => {
      // An admin's base; then the admin's account is deleted (created_by ON DELETE SET NULL).
      const computers = computersWith();
      const pressed = await computers.enqueue(org, admin, { repositories: [] });
      await builder(computers).tick();
      expect((await computers.overview(org)).activeBuildId).toBe(pressed.id);
      await pool.query("UPDATE cloud_v2_computer_builds SET created_by=NULL WHERE id=$1", [pressed.id]);
      const projectId = await project(["withso/zeros"], { owner: member });
      await copyBuilder().reconcile(org, projectId, "project_created");
      for (let index = 0; index < 3; index++) await copyBuilder().tick();
      expect((await pool.query("SELECT state, created_by FROM cloud_v2_ready_copies WHERE project_id=$1", [projectId])).rows)
        .toEqual([{ state: "ready", created_by: member }]);
      expect(await computers.ensureBase(org)).toEqual({ state: "ready", buildId: pressed.id });
      // A new runtime: it is refreshed, by Zeros, as an automatic base.
      const other = "c".repeat(64);
      const [candidate] = await computers.refreshCandidates(other);
      expect(candidate).toMatchObject({ activeBuildId: pressed.id, createdBy: null, runtimeStale: true });
      expect(await computers.enqueueAutomatic(org, pressed.id, "runtime", other)).toMatchObject({ automatic: true, createdBy: null });
    });
  });

  describe("the legacy build", () => {
    const legacy = async () => (await pool.query<{ legacy_build_id: string | null; base_live_at: Date | null }>(
      "SELECT legacy_build_id, base_live_at FROM cloud_v2_computers WHERE org_id=$1", [org])).rows[0]!;
    const snapshotOf = async (id: string) => (await pool.query<{ snapshot_id: string | null }>("SELECT snapshot_id FROM cloud_v2_computer_builds WHERE id=$1", [id])).rows[0]!.snapshot_id;
    const offCreate = (user = admin) => createCloudWorkspaceOperations({ store, computers: computersWith({ readyCopies: false }),
      authorizeBuildRepository: async (_o: string, _u: string, _b: string, repository: string) => ({ repository, repositoryId: repositoryId(repository) }),
      remoteHead: async () => "d".repeat(40) } as unknown as CloudV2RouteDeps)
      .create(user, { organizationId: org, repository: "withso/zeros" }, { document: w => w as never, receiptDocument: w => w as never });

    it("keeps the build a base replaced, serves creates from it with the setting off, and through off, on and off again", async () => {
      const pre = await preSwitchBuild();
      const preSnapshot = (await snapshotOf(pre.id))!;
      const on = computersWith({ shared: true });
      boat.snapshots.set(SHARED, new Map());
      expect((await on.ensureBase(org)).state).toBe("ready");
      const first = await legacy();
      expect(first.legacy_build_id).toBe(pre.id);
      expect(first.base_live_at).not.toBeNull();
      await builder(on).tick();
      expect(boat.calls.filter(call => call.op === "deleteSnapshot").map(call => call.args[0])).not.toContain(preSnapshot);
      // Off: creates come from the legacy build, as before the switch.
      const off = await offCreate();
      expect(off.status).toBe(201);
      expect((await workspaceRow((off.response as unknown as { id: string }).id)).computer_build_id).toBe(pre.id);
      // On again: the base is still live, the legacy build and its 30 days unchanged; off again: still served.
      expect((await on.ensureBase(org)).state).toBe("ready");
      expect(await legacy()).toEqual(first);
      expect((await offCreate()).status).toBe(201);
      await builder(computersWith({ readyCopies: false })).tick();
      expect(await snapshotOf(pre.id)).toBe(preSnapshot);
    });

    it("releases the legacy build 30 days after the base went live, only once no workspace is on it, and not before", async () => {
      const pre = await preSwitchBuild();
      const on = computersWith({ shared: true });
      boat.snapshots.set(SHARED, new Map());
      await on.ensureBase(org);
      const pinned = await offCreate();
      const pinnedId = (pinned.response as unknown as { id: string }).id;
      expect(await on.releaseLegacyBuilds()).toBe(0);
      await pool.query("UPDATE cloud_v2_computers SET base_live_at=clock_timestamp()-interval '31 days' WHERE org_id=$1", [org]);
      expect(await on.releaseLegacyBuilds()).toBe(0);
      await store.manage(pinnedId, "delete", async () => {});
      await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1", [pinnedId]);
      expect(await on.releaseLegacyBuilds()).toBe(1);
      expect((await legacy()).legacy_build_id).toBeNull();
      await builder(on).tick();
      expect(await snapshotOf(pre.id)).toBeNull();
      // Turned off after that: the organization has only its base, which installs no repository. An old-style create is
      // refused until someone builds the Cloud Computer with its repositories again: why the legacy build is kept 30 days.
      await expect(offCreate()).rejects.toMatchObject({ code: "repository_not_installed" });
    });

    it("after its 30 days, a stopped workspace on it no longer keeps it; it then opens from the live base, with or without a backup", async () => {
      const pre = await preSwitchBuild();
      const on = computersWith({ shared: true });
      boat.snapshots.set(SHARED, new Map());
      await on.ensureBase(org);
      const live = (await computersWith({ shared: true }).overview(org)).activeBuildId!;
      // Two workspaces created from the legacy build with the setting off, both stopped with their machines.
      const ids: string[] = [];
      for (const _ of [0, 1]) ids.push(((await offCreate()).response as unknown as { id: string }).id);
      await pool.query("UPDATE cloud_v2_workspaces SET state='stopped', boat_sandbox_id='bx_' || substr(md5(id::text), 1, 10) WHERE id = ANY($1::uuid[])", [ids]);
      await pool.query("UPDATE cloud_v2_computers SET base_live_at=clock_timestamp()-interval '31 days' WHERE org_id=$1", [org]);
      // A machine already made never reads the image again: they hold nothing, and the legacy snapshot goes.
      expect(await on.releaseLegacyBuilds()).toBe(1);
      await builder(on).tick();
      expect(await snapshotOf(pre.id)).toBeNull();
      // Both machines lost; each opens from the live base: one rebuilt clean, one from its backup.
      const [clean, backedUp] = ids as [string, string];
      await pool.query("UPDATE cloud_v2_workspaces SET state='starting' WHERE id = ANY($1::uuid[])", [ids]);
      await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":"fixture"}', checkpoint_sha256=$3,
        checkpoint_bytes=100, checkpoint_saved_at=clock_timestamp() WHERE id=$1`, [backedUp, `cloud-v2/checkpoints/${backedUp}/${randomUUID()}.zck`, "a".repeat(64)]);
      const image = await store.pinRestoreImage(clean);
      expect(image).not.toBeNull();
      expect((await workspaceRow(clean)).computer_build_id).toBe(live);
      const lost = (await pool.query<{ boat_sandbox_id: string }>("SELECT boat_sandbox_id FROM cloud_v2_workspaces WHERE id=$1", [backedUp])).rows[0]!.boat_sandbox_id;
      const begun = await store.beginRestore(backedUp, lost, { attempt: randomUUID(), name: "zeros-restore", env: {} });
      expect(begun).not.toBe("no_computer");
      expect(begun).not.toBeNull();
      expect((await workspaceRow(backedUp)).computer_build_id).toBe(live);
    });

    it("after its 30 days, still kept while a workspace is creating or restoring from it with no machine yet", async () => {
      const pre = await preSwitchBuild();
      const on = computersWith({ shared: true });
      boat.snapshots.set(SHARED, new Map());
      await on.ensureBase(org);
      const restoring = ((await offCreate()).response as unknown as { id: string }).id;
      const creating = ((await offCreate()).response as unknown as { id: string }).id;
      await pool.query(`UPDATE cloud_v2_workspaces SET state='stopped', boat_sandbox_id=NULL, restore_pending=true, restore_attempt=gen_random_uuid(),
        restore_create=jsonb_build_object('from', null, 'name', 'zeros-restore', 'env', '{}'::jsonb, 'requestedAt', clock_timestamp()), checkpoint_object=$2,
        checkpoint_key='{"sealed":"fixture"}', checkpoint_sha256=$3, checkpoint_bytes=100, checkpoint_saved_at=clock_timestamp() WHERE id=$1`,
        [restoring, `cloud-v2/checkpoints/${restoring}/${randomUUID()}.zck`, "a".repeat(64)]);
      await pool.query("UPDATE cloud_v2_computers SET base_live_at=clock_timestamp()-interval '31 days' WHERE org_id=$1", [org]);
      expect(await on.releaseLegacyBuilds()).toBe(0);
      // The create gets its machine; the restore is still waiting for its own: kept.
      await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_created01', state='running' WHERE id=$1", [creating]);
      expect(await on.releaseLegacyBuilds()).toBe(0);
      await builder(on).tick();
      expect(await snapshotOf(pre.id)).not.toBeNull();
      // The restore has its machine: nothing reads the legacy image any more.
      await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_restored1', restore_pending=false, state='running' WHERE id=$1", [restoring]);
      expect(await on.releaseLegacyBuilds()).toBe(1);
    });
  });

  describe("with the setting on", () => {
    it("never refreshes a pre-switch build, which would queue a full build and hold the base back; ensureBase replaces it", async () => {
      const pre = await preSwitchBuild();
      const other = "c".repeat(64);
      // Off, the pre-switch build is refreshed as it always was; on, never.
      expect((await computersWith({ readyCopies: false }).refreshCandidates(other)).map(row => row.activeBuildId)).toEqual([pre.id]);
      const on = computersWith();
      expect(await on.refreshCandidates(other)).toEqual([]);
      await builder(on).tick();
      // The sweep queued the organization's base instead, never a build of its repositories.
      expect((await pool.query("SELECT base_only, automatic FROM cloud_v2_computer_builds WHERE org_id=$1 AND id<>$2", [org, pre.id])).rows)
        .toEqual([{ base_only: true, automatic: true }]);
    });
  });

  describe("with the setting off", () => {
    it("never refreshes a base, which would queue a build with no repository; on, an automatic base is refreshed as another", async () => {
      boat.snapshots.set(SHARED, new Map());
      await pool.query("INSERT INTO cloud_v2_computers (org_id, recipe_revision, install_script) VALUES ($1, 1, 'echo tools')", [org]);
      const on = computersWith();
      await on.ensureBase(org);
      await builder(on).tick();
      const other = "c".repeat(64);
      expect(await computersWith({ readyCopies: false }).refreshCandidates(other)).toEqual([]);
      const [candidate] = await on.refreshCandidates(other);
      expect(candidate).toMatchObject({ organizationId: org, createdBy: null, baseOnly: true, runtimeStale: true });
      const refresh = await on.enqueueAutomatic(org, candidate!.activeBuildId, "runtime", other);
      expect(refresh).toMatchObject({ automatic: true, createdBy: null, reason: "runtime", state: "queued" });
      // Interrupted, it is retried as another automatic base.
      await pool.query("UPDATE cloud_v2_computer_builds SET state='failed', error_code='computer_build_interrupted', finished_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [refresh!.id]);
      expect(await on.retryInterrupted(other)).toBe(1);
      expect((await pool.query("SELECT automatic, created_by, retry_of FROM cloud_v2_computer_builds WHERE retry_of=$1", [refresh!.id])).rows)
        .toEqual([{ automatic: true, created_by: null, retry_of: refresh!.id }]);
    });
  });

  describe("ready copies off", () => {
    it("starts a project workspace of several repositories, with ready copies off, from its base with every repository cloned", async () => {
      boat.snapshots.set(SHARED, new Map());
      const on = computersWith({ shared: true });
      const projectId = await project(["withso/zeros", "withso/web"]);
      const created = (await create(on, admin, { projectId })).response as unknown as { id: string };
      expect(await store.workspaceImage(created.id)).toEqual({ from: SHARED, prune: [], checkout: false });
      await lifecycle().tick();
      expect(creates().at(-1)).toMatchObject({ from: SHARED });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspace_repositories WHERE workspace_id=$1", [created.id])).rows[0].n).toBe(2);
    });
  });

  describe("a base that cannot be prepared", () => {
    it("says why with when Zeros tries again, raises one operator line per failure, and tries again after the backoff", async () => {
      await pool.query("INSERT INTO cloud_v2_computers (org_id, recipe_revision, install_script) VALUES ($1, 1, 'exit-7-tools')", [org]);
      boat.script = (_machine, command) => command.includes("exit-7-tools") ? { exitCode: 7, stdout: "", timedOut: false } : undefined;
      await project();
      const computers = computersWith();
      expect((await computers.ensureBase(org)).state).toBe("preparing");
      await builder(computers).tick();
      const failed = await computers.ensureBase(org) as Extract<CloudV2BaseState, { state: "failed" }>;
      expect(failed).toMatchObject({ state: "failed", errorCode: "computer_install_script_failed", failures: 1 });
      expect(Date.parse(failed.nextAttemptAt) - Date.now()).toBeGreaterThan(14 * 60_000);
      expect((await computers.overview(org)).base).toMatchObject({ state: "failed", errorCode: "computer_install_script_failed" });
      expect(errors).toEqual([`[cloud-v2] automatic base build failed org=${org.slice(0, 8)} code=computer_install_script_failed`]);
      // Still in its backoff: nothing new; after it, another try (and its own line when it fails), now 30 minutes out.
      await builder(computers).tick();
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n).toBe(1);
      await pool.query("UPDATE cloud_v2_computer_builds SET finished_at=finished_at-interval '16 minutes' WHERE org_id=$1", [org]);
      expect((await computers.ensureBase(org)).state).toBe("preparing");
      await builder(computers).tick();
      expect(errors).toHaveLength(2);
      expect(await computers.ensureBase(org)).toMatchObject({ state: "failed", failures: 2 });
    });
  });
});
