import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CloudV2ComputerBuilder, CloudV2Computers, type CloudV2ComputerOptions } from "./computer.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import { CloudV2ReadyCopies, CloudV2ReadyCopyBuilder, CloudV2ReadyCopyForks, READY_COPY_HISTORY_LIMIT, READY_COPY_REFRESH_STARTS, READY_COPY_RETRY_LIMIT,
  type ReadyCopyWorkspace } from "./ready-copies.js";
import { CloudV2ReadyCopySecrets } from "./ready-copy-secrets.js";
import { CloudV2Store } from "./store.js";
import { CloudRepositoryLevels } from "./repository-levels.js";
import { CloudProjects } from "./projects.js";
import { scheduleCloudDeletion } from "./deletion.js";
import { withSystemTx } from "../db.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DAY = 24 * 60 * 60_000;
const repositoryId = (repository: string) => BigInt(`0x${createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12)}`).toString();
const resolveRepository: CloudV2ComputerSourceResolver = async (_org, _user, target) => ({
  repository: target.repository, repositoryId: target.repositoryId ?? repositoryId(target.repository),
});
const runtime = { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" };
/** What a Cloud Computer held before projects; with ready copies on it holds none. */
const RECIPE = { repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] };
const BASE = { repositories: [] };

d("cloud v2 ready copies", () => {
  let pool: pg.Pool, copies: CloudV2ReadyCopies, boat: FakeBoat, clock: number;
  let org: string, admin: string, member: string, zeros: string;
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
    await pool.query(`INSERT INTO cloud_github_installations (id, org_id, installation_id, account_login, level, added_by)
      VALUES ($1,$2,77,'withso','organization',$3)`, [randomUUID(), org, admin]);
    zeros = await project([{ repository: "withso/zeros", setup: "pnpm install" }], { name: "zeros" });
  });

  /** A create's repositories for a one-repository project, as the create path passes them. */
  const one = (repository: string, branch: string) => ({ repositories: [{ repository, repositoryId: repositoryId(repository),
    folder: repository.split("/")[1]!, branch, baseBranch: "main" }], checkoutFolder: `p/${repository.split("/")[1]!}` });
  /** A project written as its routes would, without GitHub. */
  async function project(repositories: { repository: string; setup?: string | null; defaultBranch?: string | null }[],
    options: { level?: "organization" | "personal"; owner?: string; name?: string } = {}): Promise<string> {
    const id = randomUUID(), level = options.level ?? "organization";
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, org, options.name ?? `p-${id.slice(0, 8)}`, level, level === "personal" ? options.owner : null, options.owner ?? admin]);
    for (const [position, entry] of repositories.entries())
      await pool.query(`INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id, default_branch, setup)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, position, entry.repository, repositoryId(entry.repository), entry.defaultBranch ?? null, entry.setup ?? null]);
    return id;
  }

  const computersWith = (options: CloudV2ComputerOptions = { readyCopies: true }) =>
    new CloudV2Computers(pool, pool, resolveRepository, resolveRepository, options);
  const copyBuilder = (extra: Partial<ConstructorParameters<typeof CloudV2ReadyCopyBuilder>[0]> = {}) => new CloudV2ReadyCopyBuilder({
    copies, compute: boat, channel: "alpha", runtime, cloneToken: async () => "synthetic-clone-token",
    now: () => clock, sleep: async () => {}, logger, ...extra,
  });
  async function liveBase(computers = computersWith(), builder = copyBuilder(), recipe: { repositories: { repository: string; setup?: string }[] } = BASE) {
    const build = await computers.enqueue(org, admin, recipe, { configure: true });
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "synthetic-clone-token",
      onActivated: ({ organizationId, reason }) => builder.baseActivated(organizationId, reason) }).tick();
    return build;
  }
  const row = async (generation: number, projectId = zeros) =>
    (await copies.list(org, projectId)).find(copy => copy.generation === generation)!;
  /** A workspace row of a project, as a create writes it. */
  const workspace = async (extra: Partial<ReadyCopyWorkspace> = {}, creator = member): Promise<ReadyCopyWorkspace> => {
    const value = { id: randomUUID(), organizationId: org, repository: "withso/zeros", baseBranch: "main",
      createdAt: new Date(clock).toISOString(), boatSandboxId: null, projectId: zeros, ...extra };
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, project_id, private_owner_user_id)
      VALUES ($1,$2,$3,'w',$4,$5,'main','creating',$6,$7)`, [value.id, org, creator, value.repository, `zeros/${value.id.slice(0, 8)}`,
      value.projectId ?? null, value.privateOwnerUserId ?? null]);
    return value;
  };
  const forks = () => new CloudV2ReadyCopyForks({ copies, compute: boat, now: () => clock, logger,
    queueFirst: (organizationId, projectId) => copyBuilder().queueFirst(organizationId, projectId) });

  it("with the setting off, builds every repository into the Cloud Computer and queues no copy", async () => {
    await liveBase(computersWith({}), copyBuilder(), RECIPE);
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
    // Tools only: the Cloud Computer holds no repository.
    expect(build.recipe.repositories).toEqual([]);
    const baseMachine = boat.calls.find(call => call.op === "create")!;
    expect(boat.commands.filter(command => command.machineId === (baseMachine.args[0] as { key: string }).key)).toEqual([]);
    expect(boat.commands.some(command => command.command.includes("apt-get install -y jq"))).toBe(true);
    expect(boat.commands.some(command => command.command.includes(" clone "))).toBe(false);
    expect(await copies.list(org)).toMatchObject([{ generation: 1, state: "building", refresh: false }]);
    expect((await computers.overview(org))).toMatchObject({ installScript: "sudo -n apt-get install -y jq", readyCopies: true, recipe: { repositories: [] } });

    await copyBuilder().tick();
    const copy = await row(1);
    expect(copy).toMatchObject({ state: "ready", stale: false, trigger: "computer_build",
      result: [{ repository: "withso/zeros", repositoryId: repositoryId("withso/zeros"), branch: "main", commit: "c".repeat(40) }] });
    const machine = boat.machine(copy.machineId!)!;
    expect(machine).toMatchObject({ state: "archived", from: expect.stringMatching(/^zeros-alpha-.*-v1$/) });
    expect(copy.stoppedAt?.getTime()).toBe(clock);
    const own = boat.commands.filter(command => command.machineId === copy.machineId).map(command => command.command);
    const clone = own.find(command => command.includes(" clone "))!;
    expect(clone).not.toMatch(/--depth|--filter|--single-branch/);
    expect(own.some(command => command.includes("pnpm install"))).toBe(true);
    expect(own.at(-1)).toContain("rm -rf /tmp/zeros-command-input-*");
    expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual([]);
  });

  it("joins concurrent requests for one project into one build", async () => {
    await liveBase();
    const base = (await copies.base(org))!;
    const requests = await Promise.all(Array.from({ length: 5 }, () => copies.request({ organizationId: org, projectId: zeros,
      createdBy: admin, computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}` })));
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
    expect((await copies.forkable(org, zeros, new Date(clock)))?.id).toBe(first.id);
    expect(boat.machine(second.machineId!)!.state).toBe("deleted");
    // Not retried within the hour.
    await builder.maintain();
    expect(await copies.list(org)).toHaveLength(2);
  });

  it("switches generations atomically while a create forks the old one, and deletes it only after that fork has its machine", async () => {
    await liveBase();
    await copyBuilder().tick();
    const first = await row(1), w1 = await workspace();
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
    const w2 = await forks().prepare(await workspace());
    expect(boat.machine((w2 as { sandboxId: string }).sandboxId)!.source).toBe((await row(2)).machineId);
    const recovered = await forks().prepare(w1);
    expect(boat.machine((recovered as { sandboxId: string }).sandboxId)!.source).toBe(first.machineId);
    await copyBuilder().cleanup();
    expect(boat.machine(first.machineId!)!.state).toBe("deleted");
    // A fork whose reply was lost longer ago than Boat keeps its key no longer holds a copy.
    expect(await copies.cleanupCandidates(new Date(clock + 2 * DAY))).toEqual([]);
  });

  it("concurrent creates fork one ready copy without a database deadlock", async () => {
    await liveBase();
    await copyBuilder().tick();
    for (let round = 0; round < 6; round++) {
      const batch = await Promise.all(Array.from({ length: 4 }, () => workspace()));
      const results = await Promise.allSettled(batch.map(item => forks().prepare(item)));
      expect(results.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason))).toEqual([]);
    }
  });

  it("forks, a promote, stale marking and expiry race on one project without a deadlock or a lost machine", async () => {
    await liveBase();
    await copyBuilder().tick();
    for (let round = 0; round < 4; round++) {
      const base = (await copies.base(org))!, ready = (await copies.list(org)).find(copy => copy.state === "ready")!;
      const next = await copies.request({ organizationId: org, projectId: zeros,
        createdBy: admin, computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}`, refresh: true });
      await copies.machineCreated(next.id, boat.stopped(`copy-${round}`));
      const batch = await Promise.all(Array.from({ length: 4 }, () => workspace()));
      const results = await Promise.allSettled([
        ...batch.map(item => forks().prepare(item)),
        copies.promote(next.id, { repositories: [], stoppedAt: new Date(clock) }),
        copies.markStale(org), copies.markExpiring(new Date(clock)), copies.retireUnavailable(),
      ]);
      expect(results.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason))).toEqual([]);
      // Every fork that began holds its copy until cleanup may delete it.
      for (const item of batch) {
        const fork = await copies.forkOf(item.id);
        if (fork) expect(boat.machine(fork.sandboxId!)!.source).toBe(fork.copyId === ready.id ? ready.machineId : (await copies.get(fork.copyId))!.machineId);
      }
      await copies.markStale(org).then(() => pool.query("UPDATE cloud_v2_ready_copies SET stale=false WHERE state='ready'"));
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE org_id=$1 AND state='ready'", [org])).rows[0].n).toBe(1);
  });

  it("recovers two forks of one ready copy made close together, one reply lost, each by its own key", async () => {
    await liveBase();
    await copyBuilder().tick();
    const copy = await row(1), first = await workspace(), second = await workspace();
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
    const none = await forks().prepare(await workspace());
    expect(none).toBeNull();
    // A workspace from before projects never forks.
    expect(await forks().prepare(await workspace({ projectId: null }))).toBeNull();
    expect(warnings.some(line => line.includes("cloning directly"))).toBe(true);
    await liveBase();
    const fresh = await workspace();
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
    expect(await copies.forkable(org, zeros, new Date(clock))).toBeNull();

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
    expect(await copies.forkable(org, zeros, new Date(clock))).toBeNull();
    // Many queued refreshes: at most 12 start a minute and 60 an hour; a first copy is never held back.
    const base = (await copies.base(org))!;
    for (let index = 0; index < 70; index++)
      await copies.request({ organizationId: org, projectId: await project([{ repository: `withso/r${index}` }]), createdBy: admin,
        computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}`, refresh: true });
    const started = async () => { let count = 0; while (await copies.claim(new Date(clock))) count++; return count; };
    expect(await started()).toBe(READY_COPY_REFRESH_STARTS.perMinute);
    let total = READY_COPY_REFRESH_STARTS.perMinute;
    for (let minute = 1; minute < 10; minute++) { clock += 61_000; total += await started(); }
    expect(total).toBe(READY_COPY_REFRESH_STARTS.perHour);
    const first = await project([{ repository: "withso/first" }]);
    await copies.request({ organizationId: org, projectId: first, createdBy: admin, computerBuildId: base.buildId, builtFromBase: `snapshot:${base.snapshot}` });
    expect((await copies.claim(new Date(clock)))?.projectId).toBe(first);
  });

  it("hands build secrets to setup on standard input only, and leaves none on the stopped copy", async () => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys), value = "npm_fixture_secret_4f1c";
    expect(await secrets.save(org, zeros, admin, { NPM_TOKEN: value })).toEqual(["NPM_TOKEN"]);
    expect(JSON.stringify((await pool.query("SELECT * FROM cloud_v2_ready_copy_secrets")).rows)).not.toContain(value);
    await expect(secrets.save(org, zeros, admin, { PATH: "x" })).rejects.toThrow();
    await liveBase();
    // A setup that echoes the secret: its detached job log lands on the disk.
    boat.script = (machine, command, input) => {
      if (!command.includes("pnpm install")) return undefined;
      expect(input).toContain(`NPM_TOKEN=${Buffer.from(value).toString("base64")}`);
      boat.write(machine.id, "/tmp/zeros-job-fixture.log", `installing with ${value}`);
      return { exitCode: 0, stdout: `installing with ${value}`, timedOut: false };
    };
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).tick();
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
    await secrets.save(org, zeros, admin, { NPM_TOKEN: value });
    await liveBase();
    boat.script = (machine, command) => {
      if (!command.includes("pnpm install")) return undefined;
      boat.write(machine.id, "/home/user/withso/zeros/.npmrc", `//registry.npmjs.org/:_authToken=${value}`);
      return { exitCode: 0, stdout: "", timedOut: false };
    };
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).tick();
    const copy = await row(1);
    expect(copy).toMatchObject({ state: "failed", failureReason: "ready_copy_secret_left", failureDetail: "/home/user/withso/zeros/.npmrc",
      failureRepository: "withso/zeros", failureStep: "secret_search" });
    expect(boat.machine(copy.machineId!)!.state).toBe("deleted");
    expect(await copies.forkable(org, zeros, new Date(clock))).toBeNull();
    expect(await copies.failures(org)).toEqual([expect.objectContaining({ projectId: zeros, project: "zeros", repository: "withso/zeros",
      step: "secret_search", reason: "ready_copy_secret_left", detail: "/home/user/withso/zeros/.npmrc" })]);
  });

  it.each([
    ["outside the home", "/etc/profile.d/npm.sh", (value: string) => `export NPM_TOKEN=${value}`, "/etc/profile.d/npm.sh"],
    ["in a file named after the secret", (value: string) => `/root/.cache/${value}`, (value: string) => value, "/root/.cache/… (a name there contains a build secret)"],
  ] as const)("finds a build secret left %s and records only where, never the value", async (_case, path, content, detail) => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys), value = "npm_fixture_secret_b7d4";
    await secrets.save(org, zeros, admin, { NPM_TOKEN: value });
    await liveBase();
    boat.script = (machine, command) => {
      if (!command.includes("pnpm install")) return undefined;
      boat.write(machine.id, typeof path === "string" ? path : path(value), content(value));
      return { exitCode: 0, stdout: "", timedOut: false };
    };
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).tick();
    expect(await row(1)).toMatchObject({ state: "failed", failureReason: "ready_copy_secret_left", failureDetail: detail });
    expect(JSON.stringify(await copies.failures(org))).not.toContain(value);
    expect(JSON.stringify((await pool.query("SELECT * FROM cloud_v2_ready_copies")).rows)).not.toContain(value);
  });

  it("fails a copy whose secret search did not finish", async () => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys);
    await secrets.save(org, zeros, admin, { NPM_TOKEN: "npm_fixture_secret_c3e9" });
    await liveBase();
    boat.script = (_machine, command) => command.includes("grep -lsIF") ? { exitCode: 0, stdout: "zeros-search-status=124,0\n", timedOut: false } : undefined;
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).tick();
    expect(await row(1)).toMatchObject({ state: "failed", failureReason: "ready_copy_secret_search_incomplete", failureDetail: null });
  });

  it("retires the copy of a removed project, and of a personal project whose member left", async () => {
    await liveBase();
    const mine = await project([{ repository: "withso/notes" }], { level: "personal", owner: member });
    await copyBuilder().queueFirst(org, mine);
    await copyBuilder().tick();
    await copyBuilder().tick();
    const copy = await row(1), personal = await row(1, mine);
    expect([copy.state, personal.state]).toEqual(["ready", "ready"]);
    await new CloudProjects(pool).remove(org, admin, zeros);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, member]);
    await copyBuilder().tick();
    expect(await row(1)).toMatchObject({ state: "retired" });
    expect(await row(1, mine)).toMatchObject({ state: "retired" });
    expect(boat.machine(copy.machineId!)!.state).toBe("deleted");
    expect(boat.machine(personal.machineId!)!.state).toBe("deleted");
  });

  it("removes build secrets with the organization and with their project, and copies when cloud access ends", async () => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys);
    const other = await project([{ repository: "withso/other" }]);
    const secretRows = async () => (await pool.query("SELECT project_id FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 ORDER BY project_id", [org])).rows;
    await liveBase();
    await secrets.save(org, zeros, admin, { NPM_TOKEN: "fixture-value-1" });
    await secrets.save(org, other, admin, { NPM_TOKEN: "fixture-value-2" });
    // An envelope moved to another project never opens.
    await pool.query("UPDATE cloud_v2_ready_copy_secrets SET envelope=(SELECT envelope FROM cloud_v2_ready_copy_secrets WHERE project_id=$1) WHERE project_id=$2", [zeros, other]);
    await expect(secrets.open(org, other)).rejects.toThrow();
    // Removing a project removes its secrets with it.
    await new CloudProjects(pool).remove(org, admin, other);
    expect(await secretRows()).toEqual([{ project_id: zeros }]);
    await copyBuilder().tick();
    const copy = (await copies.list(org)).find(row => row.state === "ready")!;
    // Losing cloud access retires the copy; cleanup deletes its machine.
    await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [org]);
    await copyBuilder().tick();
    expect((await copies.get(copy.id))!.state).toBe("retired");
    expect(boat.machine(copy.machineId!)!.state).toBe("deleted");
    await pool.query("UPDATE organizations SET cloud_workspaces_allowed=true WHERE id=$1", [org]);
    await withSystemTx(pool, tx => scheduleCloudDeletion(tx, { organizationId: org }));
    expect(await secretRows()).toEqual([]);
  });

  it("starts organizations without an install script from the shared base, and gives one its own base once it adds a script", async () => {
    const computers = computersWith({ readyCopies: true, sharedBaseSnapshot: "zeros-base-1" });
    boat.snapshots.set("zeros-base-1", new Map());
    const shared = await liveBase(computers);
    expect(boat.calls.filter(call => call.op === "snapshotExists").map(call => call.args[0])).toEqual(["zeros-base-1"]);
    expect(boat.calls.filter(call => call.op === "create")).toEqual([]);
    const build = (await pool.query("SELECT base_shared, snapshot_id FROM cloud_v2_computer_builds WHERE id=$1", [shared.id])).rows[0];
    expect(build).toEqual({ base_shared: true, snapshot_id: `zeros-base-1@${shared.id}` });
    const store = new CloudV2Store(pool), id = randomUUID();
    await store.createWorkspace({ id, organizationId: org, creatorUserId: admin, name: "zeros", repository: "withso/zeros",
      branch: "zeros/w", baseBranch: "main", computerBuildId: shared.id, projectId: zeros, ...one("withso/zeros", "zeros/w") });
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

  it("fails a shared-base build with a plain line when Boat lacks the snapshot, and never leaves an organization on a base that is gone", async () => {
    const computers = computersWith({ readyCopies: true, sharedBaseSnapshot: "zeros-base-1" });
    const builds = async () => (await pool.query("SELECT id, state, error_code FROM cloud_v2_computer_builds WHERE org_id=$1 ORDER BY version", [org])).rows;
    const missing = await liveBase(computers);
    expect((await builds())[0]).toMatchObject({ state: "failed", error_code: "computer_shared_base_missing" });
    expect(await computers.log(org, missing.id)).toContain("Zeros's shared base is not available right now, so nothing changed.");
    expect((await computers.overview(org)).activeBuildId).toBeNull();
    expect(await copies.base(org)).toBeNull();
    expect(boat.calls.filter(call => call.op === "create")).toEqual([]);
    // Live on it, then it goes: the next build fails and the organization no longer points at it.
    boat.snapshots.set("zeros-base-1", new Map());
    const live = await liveBase(computers);
    expect((await computers.overview(org)).activeBuildId).toBe(live.id);
    boat.snapshots.delete("zeros-base-1");
    await liveBase(computers);
    expect((await builds()).map(build => build.error_code)).toEqual(["computer_shared_base_missing", null, "computer_shared_base_missing"]);
    expect((await computers.overview(org)).activeBuildId).toBeNull();
    expect(await copies.base(org)).toBeNull();
    const store = new CloudV2Store(pool);
    expect(await store.activeComputer(org)).toBeNull();
  });

  it("keeps an organization on its current Cloud Computer until its next build, with creates and released reads unchanged", async () => {
    await liveBase(computersWith({}), copyBuilder(), RECIPE);
    const store = new CloudV2Store(pool);
    const before = { installed: await store.installedRepositories(org), active: await store.activeComputer(org) };
    const builder = copyBuilder();
    await builder.baseActivated(org, "manual");
    await builder.queueFirst(org, zeros);
    await builder.tick();
    expect(await copies.list(org)).toEqual([]);
    expect(await forks().prepare(await workspace())).toBeNull();
    expect(before.active).not.toHaveProperty("baseOnly");
    expect(await store.installedRepositories(org)).toEqual(before.installed);
    const overview = await computersWith().overview(org);
    expect(overview.activeBuildId).toBe(before.active!.buildId);
  });

  it("clones an organization project through the organization's connection, never an admin's own login", async () => {
    const cloneToken = vi.fn(async () => "synthetic-admin-token"), sharedCloneToken = vi.fn(async () => "synthetic-installation-token");
    await liveBase();
    await copyBuilder({ cloneToken, sharedCloneToken }).tick();
    expect(sharedCloneToken).toHaveBeenCalledWith(org, { repository: "withso/zeros", repositoryId: repositoryId("withso/zeros") });
    expect(cloneToken).not.toHaveBeenCalled();
    expect(await row(1)).toMatchObject({ state: "ready" });
  });

  it("clones a copy as the base creator without saving a credential, and fetches a fork's branch as its own creator", async () => {
    const cloneToken = vi.fn(async () => "synthetic-base-token");
    await liveBase();
    await copyBuilder({ cloneToken }).tick();
    expect(cloneToken).toHaveBeenCalledWith(org, admin, expect.objectContaining({ repository: "withso/zeros" }));
    const copy = await row(1);
    const clone = boat.commands.find(command => command.machineId === copy.machineId && command.command.includes(" clone "))!;
    expect(clone.command).not.toMatch(/synthetic-base-token|credential\.helper|insteadOf|x-access-token/);
    expect(clone.command).toContain("--config-env=http.extraHeader=ZEROS_GITHUB_AUTH_HEADER");
    expect(clone.input).toContain(Buffer.from("x-access-token:synthetic-base-token").toString("base64"));
    const creator = await workspace(), githubToken = vi.fn(async () => ({ token: "synthetic-creator-token" }));
    const forked = await new CloudV2ReadyCopyForks({ copies, compute: boat, now: () => clock, githubToken }).prepare(creator) as { sandboxId: string };
    expect(await new CloudV2ReadyCopyForks({ copies, compute: boat, now: () => clock, githubToken }).fetchBase(creator, forked.sandboxId)).toBe(true);
    expect(githubToken).toHaveBeenCalledWith(creator);
    const fetch = boat.commands.find(command => command.machineId === forked.sandboxId && command.command.includes(" fetch "))!;
    expect(fetch.command).not.toContain("synthetic-creator-token");
    expect(fetch.input).toContain(Buffer.from("x-access-token:synthetic-creator-token").toString("base64"));
    expect(fetch.input).not.toContain(Buffer.from("x-access-token:synthetic-base-token").toString("base64"));
  });

  it("builds a personal project's copy as its member, forks it only for that member, and stops with the setting", async () => {
    await liveBase();
    const levels = new CloudRepositoryLevels(pool);
    const other = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [other, `u-${other}@example.test`]);
    await grantTestPro(pool, other);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, other]);
    const mine = await project([{ repository: "withso/notes" }], { level: "personal", owner: member, name: "notes" });
    const cloneToken = vi.fn(async () => "synthetic-member-token");
    await copyBuilder({ cloneToken }).reconcile(org, mine, "project_created");
    // One build a tick: the organization project's first copy, then this one.
    await copyBuilder({ cloneToken }).tick();
    await copyBuilder({ cloneToken }).tick();
    expect(cloneToken).toHaveBeenCalledWith(org, member, { repository: "withso/notes", repositoryId: repositoryId("withso/notes") });
    const copy = (await copies.list(org, mine))[0]!;
    expect(copy).toMatchObject({ state: "ready", trigger: "project_created" });
    // Not the admin's page, not another member's status.
    expect(await copies.failures(org)).toEqual([]);
    expect([...(await copies.status(org, other)).keys()]).not.toContain(mine);
    expect([...(await copies.status(org, admin)).keys()]).not.toContain(mine);
    expect((await copies.status(org, member)).get(mine)).toBe("ready");

    const store = new CloudV2Store(pool), base = (await copies.base(org))!, id = randomUUID();
    const created = await store.createWorkspace({ id, organizationId: org, creatorUserId: member, name: "notes", repository: "withso/notes",
      branch: "zeros/n", baseBranch: "main", computerBuildId: base.buildId, projectId: mine, ...one("withso/notes", "zeros/n") });
    expect(created).toMatchObject({ privateOwnerUserId: member, projectId: mine });
    await expect(store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: other, name: "notes", repository: "withso/notes",
      branch: "zeros/o", baseBranch: "main", computerBuildId: base.buildId, projectId: mine, ...one("withso/notes", "zeros/o") })).rejects.toMatchObject({ code: "project_unavailable" });
    const forked = await forks().prepare({ id, organizationId: org, repository: "withso/notes", baseBranch: "main", createdAt: created.createdAt,
      boatSandboxId: null, projectId: mine, privateOwnerUserId: member }) as { sandboxId: string };
    expect(boat.machine(forked.sandboxId)!.source).toBe(copy.machineId);
    // Another member's workspace never reaches the personal copy, even asked directly.
    const theirs = await workspace({ repository: "withso/notes", projectId: mine }, other);
    await expect(copies.beginFork(theirs.id, org, copy.id, new Date(clock))).rejects.toMatchObject({ code: "ready_copy_project_mismatch" });
    // Nor does a workspace of another project.
    const elsewhere = await workspace();
    await expect(copies.beginFork(elsewhere.id, org, copy.id, new Date(clock))).rejects.toMatchObject({ code: "ready_copy_project_mismatch" });

    // Forbidden for one member: no refresh, no create; the copy and its workspace stay.
    await levels.setPersonalAllowed(org, admin, false);
    clock += 8 * DAY;
    await copyBuilder({ cloneToken }).maintain();
    expect(await copies.list(org, mine)).toHaveLength(1);
    await expect(store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: member, name: "notes", repository: "withso/notes",
      branch: "zeros/m", baseBranch: "main", computerBuildId: base.buildId, projectId: mine, ...one("withso/notes", "zeros/m") })).rejects.toMatchObject({ code: "project_unavailable" });
    // Allowed again but unforked for 14 days: no longer refreshed either.
    await levels.setPersonalAllowed(org, admin, true);
    await pool.query("UPDATE cloud_v2_ready_copies SET last_forked_at=$2 WHERE id=$1", [copy.id, new Date(clock - 15 * DAY)]);
    await copyBuilder({ cloneToken }).maintain();
    expect(await copies.list(org, mine)).toHaveLength(1);
    await pool.query("UPDATE cloud_v2_ready_copies SET last_forked_at=$2 WHERE id=$1", [copy.id, new Date(clock - DAY)]);
    await copyBuilder({ cloneToken }).maintain();
    expect(await copies.list(org, mine)).toMatchObject([{ state: "ready" }, { state: "building", refresh: true, createdBy: member }]);
  });

  it("clones every repository of a project in full, runs each setup in its own folder in order, and names the repository and step that failed", async () => {
    const both = await project([{ repository: "withso/api", setup: "make api" }, { repository: "withso/web", setup: "make web" }], { name: "both" });
    await liveBase();
    await pool.query("DELETE FROM cloud_v2_ready_copies WHERE project_id=$1", [zeros]);
    await copyBuilder().tick();
    const copy = await row(1, both), own = boat.commands.filter(command => command.machineId === copy.machineId).map(command => command.command);
    expect(copy).toMatchObject({ state: "ready", result: [expect.objectContaining({ repository: "withso/api", branch: "main" }),
      expect.objectContaining({ repository: "withso/web", branch: "main" })] });
    const at = (needle: string) => own.findIndex(command => command.includes(needle));
    const clones = own.filter(command => command.includes(" clone "));
    expect(clones).toHaveLength(2);
    for (const clone of clones) expect(clone).not.toMatch(/--depth|--filter|--single-branch/);
    // Every clone first, then each setup in position order, each in its own folder, then the scrub.
    expect(at("/home/user/withso/api")).toBeLessThan(at("/home/user/withso/web"));
    expect(Math.max(...clones.map(clone => own.indexOf(clone)))).toBeLessThan(at("make api"));
    expect(at("make api")).toBeLessThan(at("make web"));
    expect(own.find(command => command.includes("make web"))).toContain("/home/user/withso/web");
    expect(at("make web")).toBeLessThan(at("rm -rf /tmp/zeros-command-input-*"));
    // The second repository's setup fails: the line says which and where.
    boat.script = (_machine, command) => command.includes("make web") ? { exitCode: 2, stdout: "web failed", timedOut: false } : undefined;
    await copyBuilder().buildNow(org, both, admin);
    await copyBuilder().tick();
    expect(await row(2, both)).toMatchObject({ state: "failed", failureReason: "ready_copy_setup_failed", failureRepository: "withso/web",
      failureStep: "setup", setupOutput: "web failed" });
    // A clone that fails names its repository too.
    boat.script = (_machine, command) => command.includes(" clone ") && command.includes("withso/api") ? { exitCode: 128, stdout: "", timedOut: false } : undefined;
    await pool.query("UPDATE cloud_v2_ready_copies SET created_at=created_at - interval '1 hour' WHERE trigger='manual'");
    await copyBuilder().buildNow(org, both, admin);
    await copyBuilder().tick();
    expect(await row(3, both)).toMatchObject({ state: "failed", failureReason: "ready_copy_clone_failed", failureRepository: "withso/api", failureStep: "clone" });
    expect(await row(1, both)).toMatchObject({ state: "ready" });
  });

  it("backs a failing copy off from 1 hour doubling to a day, stops after the limit, and starts over when something changes", async () => {
    await liveBase();
    boat.script = (_machine, command) => command.includes("pnpm install") ? { exitCode: 1, stdout: "", timedOut: false } : undefined;
    await copyBuilder().tick();
    const generations = async () => (await copies.list(org, zeros)).length;
    const state = async () => copies.retryState(zeros, await copies.inputs(org, zeros), new Date(clock));
    for (let failures = 1; failures < READY_COPY_RETRY_LIMIT; failures++) {
      const retry = await state();
      const wait = Math.min(60 * 60_000 * 2 ** (failures - 1), DAY);
      expect(retry).toMatchObject({ failures, allowed: false });
      expect(retry.nextAt!.getTime() - (await row(failures)).finishedAt!.getTime()).toBe(wait);
      clock = retry.nextAt!.getTime() - 60_000;
      await copyBuilder().tick();
      expect(await generations()).toBe(failures);
      clock = retry.nextAt!.getTime() + 1;
      await copyBuilder().tick();
      expect(await generations()).toBe(failures + 1);
    }
    expect(await state()).toMatchObject({ failures: READY_COPY_RETRY_LIMIT, nextAt: null, allowed: false });
    clock += 7 * DAY;
    await copyBuilder().tick();
    expect(await generations()).toBe(READY_COPY_RETRY_LIMIT);
    // Build secrets changed: the inputs differ, so it is retried at once.
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    await new CloudV2ReadyCopySecrets(pool, keys).save(org, zeros, admin, { NPM_TOKEN: "npm_fixture_secret_retry" });
    await copyBuilder().tick();
    expect(await generations()).toBe(READY_COPY_RETRY_LIMIT + 1);
    // Retry now restarts the count: its failure waits 1 hour again.
    await copyBuilder().retryNow(org, zeros);
    await copyBuilder().tick();
    expect((await copies.list(org, zeros)).at(-1)).toMatchObject({ state: "failed", manualRetry: true });
    expect(await state()).toMatchObject({ failures: 1 });
    // A new Cloud Computer base starts it over too.
    await liveBase();
    expect((await copies.list(org, zeros)).at(-1)).toMatchObject({ state: "building" });
  });

  it("keeps a failed or unverifiable copy from members: no wait, no tray line, nothing in their lists", async () => {
    await liveBase();
    boat.script = (_machine, command) => command.includes("pnpm install") ? { exitCode: 1, stdout: "", timedOut: false } : undefined;
    await copyBuilder().tick();
    expect(await row(1)).toMatchObject({ state: "failed" });
    // Every create takes the direct clone at once, and none queues another build within the backoff.
    for (let create = 0; create < 3; create++) expect(await forks().prepare(await workspace())).toBeNull();
    expect(await copies.list(org, zeros)).toHaveLength(1);
    // Create's list says nothing is getting ready (no tray line), and members never see the cause.
    expect((await copies.status(org, member)).get(zeros)).toBeNull();
    const summaries = await copies.failureSummaries(org, new Date(clock));
    expect(summaries).toEqual([expect.objectContaining({ projectId: zeros, repository: "withso/zeros", step: "setup", reason: "ready_copy_setup_failed", failures: 1 })]);
    // Only while a generation is actually building does a create wait, bounded.
    clock += 61 * 60_000;
    await copyBuilder().maintain();
    expect(await forks().prepare(await workspace())).toEqual({ waitMs: 3_000 });
    const older = await workspace({ createdAt: new Date(clock - 91_000).toISOString() });
    expect(await forks().prepare(older)).toBeNull();
  });

  it("stores why each generation ran, and rebuilds one project's copy when its setup, repositories or secrets are saved", async () => {
    const computers = computersWith(), projects = new CloudProjects(pool);
    await liveBase(computers);
    await copyBuilder().tick();
    expect(await row(1)).toMatchObject({ state: "ready", trigger: "computer_build" });
    // A saved setup rebuilds this project's copy alone, with no Cloud Computer build.
    const builds = (await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n;
    const saved = await projects.update(org, admin, zeros, { repositories: [{ repository: "withso/zeros", repositoryId: repositoryId("withso/zeros"),
      setup: "pnpm install --frozen-lockfile" }] });
    expect(saved.change).toBe("setup_changed");
    await copyBuilder().reconcile(org, zeros, "setup_changed");
    await copyBuilder().reconcile(org, zeros, "setup_changed");
    expect(await copies.list(org, zeros)).toHaveLength(2);
    await copyBuilder().tick();
    expect(await row(2)).toMatchObject({ state: "ready", trigger: "setup_changed", builtFromBase: `copy:${(await row(1)).id}` });
    const second = (await row(2)).machineId;
    expect(boat.commands.filter(command => command.machineId === second).some(command => command.command.includes("pnpm install --frozen-lockfile"))).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE org_id=$1", [org])).rows[0].n).toBe(builds);
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    await new CloudV2ReadyCopySecrets(pool, keys).save(org, zeros, admin, { NPM_TOKEN: "npm_fixture_secret_hist" });
    await copyBuilder().reconcile(org, zeros, "secrets_changed");
    expect(await row(3)).toMatchObject({ trigger: "secrets_changed" });
    await copyBuilder().tick();
    // Another repository: the copy is rebuilt from the base, never forked from one without it.
    const added = await projects.update(org, admin, zeros, { repositories: [{ repository: "withso/zeros", repositoryId: repositoryId("withso/zeros"),
      setup: "pnpm install --frozen-lockfile" }, { repository: "withso/docs", repositoryId: repositoryId("withso/docs") }] });
    expect(added.change).toBe("repositories_changed");
    await copyBuilder().reconcile(org, zeros, "repositories_changed");
    expect(await row(4)).toMatchObject({ trigger: "repositories_changed", builtFromBase: expect.stringMatching(/^snapshot:/) });
    await copyBuilder().tick();
    clock += 7 * DAY + 60_000;
    await copyBuilder().maintain();
    expect(await row(5)).toMatchObject({ trigger: "weekly_update" });
    await copyBuilder().tick();
    // A new Cloud Computer base: every copy is rebuilt from it.
    await liveBase(computers);
    await copyBuilder().maintain();
    expect(await row(6)).toMatchObject({ trigger: "computer_build" });
    // A project created later gets its own first copy.
    const later = await project([{ repository: "withso/later" }]);
    await copyBuilder().reconcile(org, later, "project_created");
    expect(await row(1, later)).toMatchObject({ trigger: "project_created" });
  });

  it("keeps a failed setup's last output with every build secret redacted, and none for a build that passed", async () => {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const secrets = new CloudV2ReadyCopySecrets(pool, keys), value = "s3cr3t/value+with=chars";
    await secrets.save(org, zeros, admin, { NPM_TOKEN: value });
    await liveBase();
    const echo = `installing\nraw ${value}\nb64 ${Buffer.from(value).toString("base64")}\nb64url ${Buffer.from(value).toString("base64url")}\nurl ${encodeURIComponent(value)}\nnpm ERR! failed\n`;
    boat.script = (_machine, command) => command.includes("pnpm install") ? { exitCode: 1, stdout: "x".repeat(40_000) + echo, timedOut: false } : undefined;
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).tick();
    const failed = await row(1);
    expect(failed.setupOutput).toContain("npm ERR! failed");
    expect(Buffer.byteLength(failed.setupOutput!)).toBeLessThanOrEqual(16 * 1024);
    for (const form of [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url"), encodeURIComponent(value)])
      expect(failed.setupOutput).not.toContain(form);
    expect(failed.setupOutput!.match(/\[redacted\]/g)).toHaveLength(4);
    boat.script = null;
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).retryNow(org, zeros, admin);
    await copyBuilder({ secrets: (organizationId, projectId) => secrets.open(organizationId, projectId) }).tick();
    expect(await row(2)).toMatchObject({ state: "ready", setupOutput: null, trigger: "manual", triggeredBy: admin });
  });

  it("keeps the detail of the latest 20 generations, coalesces Build now with a running build, and limits it", async () => {
    await liveBase();
    await copyBuilder().tick();
    const builder = copyBuilder();
    const first = await builder.buildNow(org, zeros, admin);
    expect(await builder.buildNow(org, zeros, member)).toMatchObject({ id: first!.id });
    await builder.tick();
    await expect(builder.buildNow(org, zeros, admin)).rejects.toMatchObject({ code: "ready_copy_build_limited" });
    clock += 11 * 60_000;
    await pool.query("UPDATE cloud_v2_ready_copies SET created_at=$1 WHERE trigger='manual'", [new Date(clock - 11 * 60_000)]);
    expect(await builder.buildNow(org, zeros, admin)).toMatchObject({ trigger: "manual" });
    await builder.tick();
    // Older generations keep their result but lose their detail; their machines are cleaned as before.
    for (let generation = 0; generation < READY_COPY_HISTORY_LIMIT + 2; generation++)
      await pool.query(`INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, failure_reason, failure_detail, setup_output, finished_at)
        VALUES ($1,$2,$3,$4,'failed',$5,'ready_copy_setup_failed','/home/user/x','output',now())`,
        [randomUUID(), org, zeros, 100 + generation, `fixture-${generation}`]);
    await copies.fail((await copies.request({ organizationId: org, projectId: zeros, createdBy: admin,
      computerBuildId: (await copies.base(org))!.buildId, builtFromBase: "snapshot:x" })).id, "ready_copy_setup_failed", new Date(clock));
    const kept = (await pool.query(`SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE org_id=$1 AND detail_pruned_at IS NULL`, [org])).rows[0].n;
    expect(kept).toBe(READY_COPY_HISTORY_LIMIT);
    expect((await pool.query(`SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE org_id=$1 AND detail_pruned_at IS NOT NULL
      AND (setup_output IS NOT NULL OR failure_detail IS NOT NULL)`, [org])).rows[0].n).toBe(0);
    expect(await copies.history(org, zeros)).toHaveLength(READY_COPY_HISTORY_LIMIT);
  });

  it("never stamps a workspace's activity when a copy is built or forked", async () => {
    await liveBase();
    await copyBuilder().tick();
    const store = new CloudV2Store(pool), id = randomUUID();
    const base = (await copies.base(org))!;
    await store.createWorkspace({ id, organizationId: org, creatorUserId: member, name: "zeros", repository: "withso/zeros",
      branch: "zeros/w", baseBranch: "main", computerBuildId: base.buildId, projectId: zeros, ...one("withso/zeros", "zeros/w") });
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

  it("keeps a removed project's workspaces working, private ones private, with nothing left on project_id", async () => {
    await liveBase();
    const mine = await project([{ repository: "withso/notes" }], { level: "personal", owner: member, name: "notes" });
    await copyBuilder().reconcile(org, mine, "project_created");
    await copyBuilder().tick();
    await copyBuilder().tick();
    const store = new CloudV2Store(pool), base = (await copies.base(org))!, projects = new CloudProjects(pool);
    const make = (projectId: string, repository: string, branch = `zeros/${randomUUID().slice(0, 8)}`) => store.createWorkspace({ id: randomUUID(),
      organizationId: org, creatorUserId: member, name: "w", repository, branch, baseBranch: "main", computerBuildId: base.buildId, projectId,
      ...one(repository, branch) });
    const shared = await make(zeros, "withso/zeros"), personal = await make(mine, "withso/notes");
    // Both forked their project's copy; a third is still waiting to be made.
    for (const made of [shared, personal]) expect(await forks().prepare({ ...made, boatSandboxId: null })).toHaveProperty("sandboxId");
    const waiting = await make(zeros, "withso/zeros");
    const images = { shared: await store.workspaceImage(shared.id), personal: await store.workspaceImage(personal.id) };
    const sandboxes = [(await copies.forkOf(shared.id))!.sandboxId!, (await copies.forkOf(personal.id))!.sandboxId!];

    await projects.remove(org, admin, zeros);
    await projects.remove(org, member, mine);
    // Nothing points at the removed projects; the personal workspace stays its member's.
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces WHERE project_id = ANY($1::uuid[])", [[zeros, mine]])).rows[0].n).toBe(0);
    expect(await store.get(personal.id, member)).toMatchObject({ privateOwnerUserId: member });
    expect(await store.get(personal.id, member)).not.toHaveProperty("projectId");
    await expect(store.get(personal.id, admin)).rejects.toMatchObject({ status: 404 });
    // They keep working: the same machines and states, and a restore starts from the
    // same Cloud Computer base and clones, needing neither the project nor its copy.
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[]) ORDER BY state", [[shared.id, personal.id]])).rows)
      .toEqual([{ state: "creating" }, { state: "creating" }]);
    expect({ shared: await store.workspaceImage(shared.id), personal: await store.workspaceImage(personal.id) }).toEqual(images);
    for (const sandbox of sandboxes) expect(boat.machine(sandbox)!.state).toBe("running");
    // A create still waiting clones directly: no fork, no copy needed.
    expect(await forks().prepare({ ...(await store.get(waiting.id, member)), boatSandboxId: null })).toBeNull();
    expect(await copies.forkOf(waiting.id)).toBeNull();
    // The copies are retired and their machines deleted; the workspaces' forks are untouched.
    await copyBuilder().tick();
    for (const id of [zeros, mine]) expect((await copies.list(org, id)).map(row => row.state)).toEqual(["retired"]);
    for (const sandbox of sandboxes) expect(boat.machine(sandbox)!.state).toBe("running");
  });

  it("stores a workspace of several repositories: each in its folder, every source bound, and only the project's set", async () => {
    await liveBase();
    const app = await project([{ repository: "withso/api" }, { repository: "withso/web" }, { repository: "acme/web" }], { name: "Zeros App" });
    const store = new CloudV2Store(pool), base = (await copies.base(org))!, id = randomUUID();
    const repositories = [["withso/api", "api", "release"], ["withso/web", "web", "main"], ["acme/web", "web-acme", "next"]].map(([repository, folder, baseBranch], index) =>
      ({ repository: repository!, repositoryId: repositoryId(repository!), folder: folder!, branch: "zeros/app-1", baseBranch: baseBranch!, baseCommit: String(index).repeat(40) }));
    const input = { organizationId: org, creatorUserId: member, name: "Zeros App", repository: "withso/api", branch: "zeros/app-1", baseBranch: "release",
      computerBuildId: base.buildId, projectId: app, checkoutFolder: "zeros-app/api", folder: "zeros-app" };
    const created = await store.createWorkspace({ id, ...input, repositories });
    expect(created).toMatchObject({ repository: "withso/api", branch: "zeros/app-1", baseBranch: "release", folder: "zeros-app", checkoutFolder: "zeros-app/api", projectId: app });
    expect((await pool.query(`SELECT position, repository, repository_id::text AS id, folder, branch, base_branch, base_commit
      FROM cloud_v2_workspace_repositories WHERE workspace_id=$1 ORDER BY position`, [id])).rows).toEqual(repositories.map((entry, position) => ({
      position, repository: entry.repository, id: entry.repositoryId, folder: entry.folder, branch: "zeros/app-1", base_branch: entry.baseBranch, base_commit: entry.baseCommit })));
    expect((await pool.query("SELECT source_repository, repository_id::text AS id FROM cloud_v2_github_sources WHERE workspace_id=$1 ORDER BY source_repository", [id])).rows)
      .toEqual(repositories.map(entry => ({ source_repository: entry.repository, id: entry.repositoryId })).sort((a, b) => a.source_repository.localeCompare(b.source_repository)));
    expect((await pool.query("SELECT source_repositories FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].source_repositories).toEqual(repositories.map(entry => entry.repository));
    // Anything but the project's repositories in its order is refused.
    for (const wrong of [repositories.slice(0, 2), [repositories[1]!, repositories[0]!, repositories[2]!], [...repositories.slice(0, 2), { ...repositories[2]!, repositoryId: "77" }]])
      await expect(store.createWorkspace({ id: randomUUID(), ...input, repository: wrong[0]!.repository, repositories: wrong })).rejects.toMatchObject({ code: "project_unavailable" });
  });
});
