import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CloudV2ComputerBuilder, CloudV2Computers, type CloudV2ComputerOptions } from "./computer.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import { CloudV2ReadyCopies, CloudV2ReadyCopyBuilder, CloudV2ReadyCopyForks, READY_COPY_REFRESH_STARTS, type ReadyCopyWorkspace } from "./ready-copies.js";
import { CloudV2ReadyCopySecrets } from "./ready-copy-secrets.js";
import { CloudV2Store } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DAY = 24 * 60 * 60_000;
const repositoryId = (repository: string) => BigInt(`0x${createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12)}`).toString();
const resolveRepository: CloudV2ComputerSourceResolver = async (_org, _user, target) => ({
  repository: target.repository, repositoryId: target.repositoryId ?? repositoryId(target.repository),
});
const runtime = { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" };
const RECIPE = { repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] };

d("cloud v2 ready copies", () => {
  let pool: pg.Pool, copies: CloudV2ReadyCopies, boat: FakeBoat, clock: number;
  let org: string, admin: string, member: string;
  const warnings: string[] = [];
  const logger = { warn: (line: string) => { warnings.push(line); } };

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    warnings.length = 0;
    clock = Date.now();
    boat = new FakeBoat(() => clock);
    copies = new CloudV2ReadyCopies(pool);
    [admin, member] = [randomUUID(), randomUUID()];
    for (const id of [admin, member]) await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [id, `u-${id}@example.test`]);
    await grantTestPro(pool, admin, member);
    org = randomUUID();
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)",
      [org, `org-${org}`, admin]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [org, admin, member]);
  });

  const computersWith = (options: CloudV2ComputerOptions = { readyCopies: true }) =>
    new CloudV2Computers(pool, pool, resolveRepository, resolveRepository, options);
  const copyBuilder = (extra: Partial<ConstructorParameters<typeof CloudV2ReadyCopyBuilder>[0]> = {}) => new CloudV2ReadyCopyBuilder({
    copies, compute: boat, channel: "alpha", runtime, cloneToken: async () => "synthetic-clone-token",
    now: () => clock, sleep: async () => {}, logger, ...extra,
  });
  async function liveBase(computers = computersWith(), builder = copyBuilder(), recipe = RECIPE) {
    const build = await computers.enqueue(org, admin, recipe, { configure: true });
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "synthetic-clone-token",
      onActivated: ({ organizationId, reason }) => builder.baseActivated(organizationId, reason) }).tick();
    return build;
  }
  const row = async (generation: number, repository = "withso/zeros") =>
    (await copies.list(org, repository)).find(copy => copy.generation === generation)!;
  const workspace = (extra: Partial<ReadyCopyWorkspace> = {}): ReadyCopyWorkspace => ({
    id: randomUUID(), organizationId: org, repository: "withso/zeros", baseBranch: "main",
    createdAt: new Date(clock).toISOString(), boatSandboxId: null, ...extra,
  });
  const forks = () => new CloudV2ReadyCopyForks({ copies, compute: boat, now: () => clock, logger,
    queueFirst: (organizationId, repository) => copyBuilder().queueFirstCopies(organizationId, repository) });

  it("with the setting off, builds every repository into the Cloud Computer and queues no copy", async () => {
    await liveBase(computersWith({}));
    const build = (await pool.query("SELECT base_only, source_policy_version, recipe FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0];
    expect(build).toMatchObject({ base_only: false, source_policy_version: 3 });
    expect(build.recipe.repositories[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(boat.commands.some(command => command.command.includes("clone"))).toBe(true);
    expect(await copies.list(org)).toEqual([]);
  });

  it("builds only the base with its install script, then a ready copy that cloned fully, set up and stopped", async () => {
    const computers = computersWith();
    await computers.saveInstallScript(org, admin, "sudo -n apt-get install -y jq", 0);
    await liveBase(computers);
    const build = (await pool.query("SELECT base_only, source_policy_version, install_script, recipe FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0];
    expect(build).toMatchObject({ base_only: true, source_policy_version: 2, install_script: "sudo -n apt-get install -y jq" });
    expect(build.recipe.repositories[0]).not.toHaveProperty("commit");
    const baseMachine = boat.calls.find(call => call.op === "create")!;
    expect(boat.commands.filter(command => command.machineId === (baseMachine.args[0] as { key: string }).key)).toEqual([]);
    expect(boat.commands.some(command => command.command.includes("apt-get install -y jq"))).toBe(true);
    expect(boat.commands.some(command => command.command.includes(" clone "))).toBe(false);
    expect(await copies.list(org)).toMatchObject([{ generation: 1, state: "building", refresh: false }]);
    expect((await computers.overview(org))).toMatchObject({ installScript: "sudo -n apt-get install -y jq", readyCopies: true });

    await copyBuilder().tick();
    const copy = await row(1);
    expect(copy).toMatchObject({ state: "ready", branch: "main", commit: "c".repeat(40), stale: false });
    const machine = boat.machine(copy.machineId!)!;
    expect(machine).toMatchObject({ state: "archived", from: expect.stringMatching(/^zeros-alpha-.*-v1$/) });
    expect(copy.stoppedAt?.getTime()).toBe(clock);
    const own = boat.commands.filter(command => command.machineId === copy.machineId).map(command => command.command);
    const clone = own.find(command => command.includes(" clone "))!;
    expect(clone).not.toMatch(/--depth|--filter|--single-branch/);
    expect(own.some(command => command.includes("pnpm install"))).toBe(true);
    expect(own.at(-1)).toContain("rm -rf /tmp/zeros-command-input-*");
    // Released desktops read the default branch the first copy verified.
    expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual([{ repository: "withso/zeros", defaultBranch: "main" }]);
  });

  it("joins concurrent requests for one repository into one build", async () => {
    await liveBase();
    const base = (await copies.base(org))!;
    const requests = await Promise.all(Array.from({ length: 5 }, () => copies.request({ organizationId: org, repository: "Withso/Zeros",
      repositoryId: repositoryId("withso/zeros"), createdBy: admin, computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}` })));
    expect(new Set(requests.map(request => request.id)).size).toBe(1);
    expect(await copies.list(org)).toHaveLength(1);
  });

  it("keeps the previous generation ready when a refresh fails, and records why", async () => {
    await liveBase();
    await copyBuilder().tick();
    const first = await row(1);
    clock += 7 * DAY + 60_000;
    boat.script = (_machine, command) => command.includes("pnpm install") ? { exitCode: 1, stdout: "", timedOut: false } : undefined;
    const builder = copyBuilder();
    await builder.tick();
    const second = await row(2);
    expect(second).toMatchObject({ state: "failed", failureReason: "ready_copy_setup_failed", refresh: true, builtFromBase: `copy:${first.id}` });
    expect(await row(1)).toMatchObject({ state: "ready" });
    expect((await copies.forkable(org, "withso/zeros", new Date(clock)))?.id).toBe(first.id);
    expect(boat.machine(second.machineId!)!.state).toBe("deleted");
    // Not retried within the hour.
    await builder.maintain();
    expect(await copies.list(org)).toHaveLength(2);
  });

  it("switches generations atomically while a create forks the old one, and deletes it only after that fork has its machine", async () => {
    await liveBase();
    await copyBuilder().tick();
    const first = await row(1), w1 = workspace();
    boat.loseNextReply("fork");
    await expect(forks().prepare(w1)).rejects.toThrow();
    // A new base within Boat's key window: generation 2 is rebuilt from it.
    clock += 60_000;
    await copyBuilder().baseActivated(org, "manual");
    await copyBuilder().tick();
    expect(await row(2)).toMatchObject({ state: "ready", refresh: true });
    expect(await row(1)).toMatchObject({ state: "retired" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE org_id=$1 AND state='ready'", [org])).rows[0].n).toBe(1);
    // A fork that began from generation 1 keeps its machine.
    expect(boat.machine(first.machineId!)!.state).toBe("archived");
    const w2 = await forks().prepare(workspace());
    expect(boat.machine((w2 as { sandboxId: string }).sandboxId)!.source).toBe((await row(2)).machineId);
    const recovered = await forks().prepare(w1);
    expect(boat.machine((recovered as { sandboxId: string }).sandboxId)!.source).toBe(first.machineId);
    await copyBuilder().cleanup();
    expect(boat.machine(first.machineId!)!.state).toBe("deleted");
    // A fork whose reply was lost longer ago than Boat keeps its key no longer holds a copy.
    expect(await copies.cleanupCandidates(new Date(clock + 2 * DAY))).toEqual([]);
  });

  it("recovers two forks of one ready copy made close together, one reply lost, each by its own key", async () => {
    await liveBase();
    await copyBuilder().tick();
    const copy = await row(1), first = workspace(), second = workspace();
    boat.loseNextReply("fork");
    await expect(forks().prepare(first)).rejects.toThrow();
    const made = await forks().prepare(second) as { sandboxId: string };
    const recovered = await forks().prepare(first) as { sandboxId: string };
    expect(recovered.sandboxId).not.toBe(made.sandboxId);
    expect(boat.machine(recovered.sandboxId)!.name).toBe(boat.machine(made.sandboxId)!.name);
    expect(boat.machine(made.sandboxId)!.name).toBe(`${boat.machine(copy.machineId!)!.name} fork`);
    expect((await copies.forkOf(first.id))?.sandboxId).toBe(recovered.sandboxId);
    expect((await copies.forkOf(second.id))?.sandboxId).toBe(made.sandboxId);
    expect(boat.calls.some(call => call.op === "findSandbox")).toBe(false);
    expect([...boat.machines.values()].filter(machine => machine.source === copy.machineId)).toHaveLength(2);
  });

  it("falls back to the direct clone, logged, and waits a bounded time for a first copy still building", async () => {
    const none = await forks().prepare(workspace());
    expect(none).toBeNull();
    expect(warnings.some(line => line.includes("cloning directly"))).toBe(true);
    await liveBase();
    const fresh = workspace();
    expect(await forks().prepare(fresh)).toEqual({ waitMs: 3_000 });
    clock += 91_000;
    expect(await forks().prepare(fresh)).toBeNull();
    expect(boat.calls.some(call => call.op === "fork")).toBe(false);
  });

  it("never leaves a ready copy forkable past 13 days, and stops refreshing one unused for 60 days while keeping it", async () => {
    await liveBase();
    await copyBuilder().tick();
    boat.script = (_machine, command) => command.includes("pnpm install") ? { exitCode: 1, stdout: "", timedOut: false } : undefined;
    const start = clock;
    for (let day = 0; day <= 20; day++) {
      clock = start + day * DAY;
      await copyBuilder().tick();
      const { rows } = await pool.query(`SELECT id FROM cloud_v2_ready_copies WHERE state='ready' AND NOT stale
        AND stopped_at <= $1::timestamptz - interval '13 days'`, [new Date(clock)]);
      expect(rows).toEqual([]);
    }
    expect(await copies.forkable(org, "withso/zeros", new Date(clock))).toBeNull();

    // A healthy copy nobody forks for 60 days is kept, stale, and not rebuilt.
    boat.script = null;
    await pool.query("DELETE FROM cloud_v2_ready_copies WHERE state<>'ready'");
    await pool.query("UPDATE cloud_v2_ready_copies SET stopped_at=$1, stale=false, last_forked_at=$2, created_at=$2",
      [new Date(clock), new Date(clock - 61 * DAY)]);
    clock += 8 * DAY;
    await copyBuilder().tick();
    expect(await copies.list(org)).toMatchObject([{ state: "ready" }]);
  });

  it("refreshes every copy after a new Cloud Computer build, within the deployment's start limits", async () => {
    await liveBase();
    await copyBuilder().tick();
    await copyBuilder().baseActivated(org, "runtime");
    expect((await row(1)).stale).toBe(false);
    await copyBuilder().baseActivated(org, "manual");
    expect((await row(1)).stale).toBe(true);
    expect(await copies.forkable(org, "withso/zeros", new Date(clock))).toBeNull();
    // Many queued refreshes: at most 12 start a minute and 60 an hour; a first copy is never held back.
    const base = (await copies.base(org))!;
    for (let index = 0; index < 70; index++)
      await copies.request({ organizationId: org, repository: `withso/r${index}`, repositoryId: String(1000 + index), createdBy: admin,
        computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}`, refresh: true });
    const started = async () => { let count = 0; while (await copies.claim(new Date(clock))) count++; return count; };
    expect(await started()).toBe(READY_COPY_REFRESH_STARTS.perMinute);
    let total = READY_COPY_REFRESH_STARTS.perMinute;
    for (let minute = 1; minute < 10; minute++) { clock += 61_000; total += await started(); }
    expect(total).toBe(READY_COPY_REFRESH_STARTS.perHour);
    await copies.request({ organizationId: org, repository: "withso/first", repositoryId: "9999", createdBy: admin,
      computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}` });
    expect((await copies.claim(new Date(clock)))?.repository).toBe("withso/first");
  });

  it("hands build secrets to setup on standard input only, and leaves none on the stopped copy", async () => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys), value = "npm_fixture_secret_4f1c";
    expect(await secrets.save(org, "Withso/Zeros", admin, { NPM_TOKEN: value })).toEqual(["NPM_TOKEN"]);
    expect(JSON.stringify((await pool.query("SELECT * FROM cloud_v2_ready_copy_secrets")).rows)).not.toContain(value);
    await expect(secrets.save(org, "withso/zeros", admin, { PATH: "x" })).rejects.toThrow();
    await liveBase();
    // A setup that echoes the secret: its detached job log lands on the disk.
    boat.script = (machine, command, input) => {
      if (!command.includes("pnpm install")) return undefined;
      expect(input).toContain(`NPM_TOKEN=${Buffer.from(value).toString("base64")}`);
      boat.write(machine.id, "/tmp/zeros-job-fixture.log", `installing with ${value}`);
      return { exitCode: 0, stdout: `installing with ${value}`, timedOut: false };
    };
    await copyBuilder({ secrets: (organizationId, repository) => secrets.open(organizationId, repository) }).tick();
    const copy = await row(1), machine = boat.machine(copy.machineId!)!;
    expect(copy.state).toBe("ready");
    expect(machine.state).toBe("archived");
    expect(JSON.stringify(machine.env)).not.toContain(value);
    expect([...machine.files.values()].some(content => content.includes(value))).toBe(false);
    const encoded = Buffer.from(value).toString("base64");
    expect(boat.commands.some(command => command.command.includes(value) || command.command.includes(encoded))).toBe(false);
    expect(JSON.stringify(boat.calls)).not.toContain(value);
    expect(warnings.join("\n")).not.toContain(value);
    expect(JSON.stringify(await copies.list(org))).not.toContain(value);
  });

  it("never makes a copy ready that a setup left a build secret on", async () => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys), value = "npm_fixture_secret_9a2e";
    await secrets.save(org, "withso/zeros", admin, { NPM_TOKEN: value });
    await liveBase();
    boat.script = (machine, command) => {
      if (!command.includes("pnpm install")) return undefined;
      boat.write(machine.id, "/home/user/withso/zeros/.npmrc", `//registry.npmjs.org/:_authToken=${value}`);
      return { exitCode: 0, stdout: "", timedOut: false };
    };
    await copyBuilder({ secrets: (organizationId, repository) => secrets.open(organizationId, repository) }).tick();
    const copy = await row(1);
    expect(copy).toMatchObject({ state: "failed", failureReason: "ready_copy_secret_left" });
    expect(boat.machine(copy.machineId!)!.state).toBe("deleted");
    expect(await copies.forkable(org, "withso/zeros", new Date(clock))).toBeNull();
  });

  it("retires the copy of a repository removed from the Cloud Computer", async () => {
    await liveBase();
    await copyBuilder().tick();
    const copy = await row(1);
    await liveBase(computersWith(), copyBuilder(), { repositories: [{ repository: "withso/other" }] });
    clock += 7 * DAY + 60_000;
    await copyBuilder().tick();
    expect(await row(1)).toMatchObject({ state: "retired" });
    expect(boat.machine(copy.machineId!)!.state).toBe("deleted");
  });

  it("starts organizations without an install script from the shared base, and gives one its own base once it adds a script", async () => {
    const computers = computersWith({ readyCopies: true, sharedBaseSnapshot: "zeros-base-1" });
    const shared = await liveBase(computers);
    expect(boat.calls.filter(call => call.op === "create")).toEqual([]);
    const build = (await pool.query("SELECT base_shared, snapshot_id FROM cloud_v2_computer_builds WHERE id=$1", [shared.id])).rows[0];
    expect(build).toEqual({ base_shared: true, snapshot_id: `zeros-base-1@${shared.id}` });
    const store = new CloudV2Store(pool), id = randomUUID();
    await store.createWorkspace({ id, organizationId: org, creatorUserId: admin, name: "zeros", repository: "withso/zeros",
      branch: "zeros/w", baseBranch: "main", computerBuildId: shared.id });
    expect(await store.workspaceImage(id)).toEqual({ from: "zeros-base-1", prune: [], checkout: false });
    await copyBuilder().tick();
    expect(boat.calls.find(call => call.op === "create")!.args[0]).toMatchObject({ from: "zeros-base-1" });

    const revision = (await computers.overview(org)).recipeRevision;
    await computers.saveInstallScript(org, admin, "sudo -n apt-get install -y jq", revision);
    await computers.buildConfigured(org, admin, revision + 1);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "synthetic-clone-token" }).tick();
    expect((await pool.query("SELECT base_shared FROM cloud_v2_computer_builds WHERE org_id=$1 ORDER BY version", [org])).rows)
      .toEqual([{ base_shared: true }, { base_shared: false }]);
    expect(boat.calls.filter(call => call.op === "deleteSnapshot").map(call => call.args[0])).not.toContain("zeros-base-1");
  });

  it("keeps an organization on its current Cloud Computer until its next build, with creates and released reads unchanged", async () => {
    await liveBase(computersWith({}));
    const store = new CloudV2Store(pool);
    const before = { installed: await store.installedRepositories(org), active: await store.activeComputer(org) };
    const builder = copyBuilder();
    await builder.queueFirstCopies(org);
    await builder.tick();
    expect(await copies.list(org)).toEqual([]);
    expect(await forks().prepare(workspace())).toBeNull();
    expect(before.active).not.toHaveProperty("baseOnly");
    expect(await store.installedRepositories(org)).toEqual(before.installed);
    const overview = await computersWith().overview(org);
    expect(overview.activeBuildId).toBe(before.active!.buildId);
  });

  it("never stamps a workspace's activity when a copy is built or forked", async () => {
    await liveBase();
    await copyBuilder().tick();
    const store = new CloudV2Store(pool), id = randomUUID();
    const base = (await copies.base(org))!;
    await store.createWorkspace({ id, organizationId: org, creatorUserId: member, name: "zeros", repository: "withso/zeros",
      branch: "zeros/w", baseBranch: "main", computerBuildId: base.buildId });
    const fetchBase = vi.fn(async () => true);
    const readyCopies = { prepare: (w: Parameters<CloudV2ReadyCopyForks["prepare"]>[0]) => forks().prepare(w), fetchBase };
    await new CloudV2Lifecycle({ store, compute: boat, readyCopies, runtime,
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
      sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
      sandboxName: () => `zeros-fixture-${id}`, sleep: async () => {}, now: () => clock,
    }).tick();
    const workspaceRow = (await pool.query("SELECT boat_sandbox_id, active_at FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];
    expect(workspaceRow.active_at).toBeNull();
    expect(boat.machine(workspaceRow.boat_sandbox_id)!.source).toBe((await row(1)).machineId);
    expect(boat.calls.filter(call => call.op === "create")).toHaveLength(2);
    expect(fetchBase).toHaveBeenCalledOnce();
    expect((await row(1)).lastForkedAt?.getTime()).toBe(clock);
  });
});
