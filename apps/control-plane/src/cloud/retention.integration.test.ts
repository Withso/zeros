// Retention (CLOUD_V2_RETENTION_ENABLED) on the real store and the stateful
// fake Boat. The database stamps its own times, so "an hour later" moves the
// recorded times back instead of a clock forward. Commands on the fake are
// answered by meaning: a marker file named UNPUSHED stands for work that is
// not on GitHub, and an archive is the set of such files it captured.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CLOUD_V2_BACKUP_DELAY_MS, CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS, CloudV2Lifecycle, type CloudV2LifecycleDeps, type CloudV2TimingRecord } from "./lifecycle.js";
import { CloudV2Store } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const HOME = "/home/user";
const REPOS = [
  { repository: "acme/app", folder: "app", branch: "zeros/w" },
  { repository: "acme/api", folder: "api", branch: "zeros/w-api" },
  { repository: "acme/docs", folder: "docs", branch: "zeros/w-docs" },
];
const path = (folder: string) => `${HOME}/proj/${folder}`;
const OBJECT = /cloud-v2\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.zck/;

d("cloud v2 retention", () => {
  let pool: pg.Pool, store: CloudV2Store, boat: FakeBoat, org: string, user: string, id: string, vm: string, readyCopy: string;
  let archives: Map<string, Map<string, string>>, uploads: string[], errors: string[], warnings: string[], timings: CloudV2TimingRecord[];
  /** Branches GitHub has, by checkout path. */
  let remoteBranches: Set<string>;
  let backupFails: boolean;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    archives = new Map(); uploads = []; errors = []; warnings = []; timings = []; remoteBranches = new Set(); backupFails = false;
    boat = new FakeBoat();
    boat.script = (machine, command, input) => {
      if (command.includes("zeros-backup-probe")) {
        const dirty = REPOS.some(repo => command.includes(path(repo.folder)) && machine.files.has(`${path(repo.folder)}/UNPUSHED`));
        return { exitCode: 0, stdout: `zeros-backup-probe ${dirty ? "dirty" : "clean"}\n`, timedOut: false };
      }
      if (command.includes("zeros-checkpoint-saved")) {
        if (backupFails) return { exitCode: 3, stdout: "zeros-checkpoint-error checkpoint_upload_failed upload\n", timedOut: false };
        const object = OBJECT.exec(command)![0];
        archives.set(object, new Map([...machine.files].filter(([file]) => file.endsWith("/UNPUSHED")
          && REPOS.some(repo => command.includes(path(repo.folder)) && file.startsWith(`${path(repo.folder)}/`)))));
        return { exitCode: 0, stdout: `zeros-checkpoint-saved bytes=100 sha256=${"e".repeat(64)}\n`, timedOut: false };
      }
      if (command.includes("zeros-checkpoint-restored")) {
        const object = OBJECT.exec(command)![0];
        for (const [file, content] of archives.get(object) ?? []) machine.files.set(file, content);
        return { exitCode: 0, stdout: "zeros-checkpoint-restored\n", timedOut: false };
      }
      if (command.includes("ls-remote --exit-code")) {
        expect(input).toMatch(/^Authorization: Basic /);
        const repo = REPOS.find(entry => command.includes(path(entry.folder)))!;
        if (remoteBranches.has(path(repo.folder))) machine.files.set(`${path(repo.folder)}/.git/refs/heads/${repo.branch}`, "from GitHub");
        return { exitCode: 0, stdout: "", timedOut: false };
      }
      return undefined;
    };
    [user, org, id] = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [user, `u-${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)",
      [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org, user]);
    const build = randomUUID();
    await pool.query("INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_policy_version, snapshot_id) VALUES ($1,$2,1,'{\"repositories\":[]}','succeeded',$3,2,'zeros-base')",
      [build, org, user]);
    await pool.query("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name, recipe_revision) VALUES ($1,$2,'zeros-base',1)", [org, build]);
    // The workspace's own running VM, with the worker running as token delivery left it.
    ({ sandboxId: vm } = await boat.create({ key: id, name: `zeros-ws-${id.slice(0, 8)}`, env: { ZEROS_WORKSPACE_ID: id } }));
    boat.machine(vm)!.worker = { enabled: true, active: true };
    readyCopy = boat.stopped("zeros-ready-copy");
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id, boat_sandbox_id, checkout_path, folder)
      VALUES ($1,$2,$3,'w','acme/app','zeros/w','main','running',$4,$5,'proj/app','proj')`, [id, org, user, build, vm]);
    await pool.query("UPDATE cloud_v2_workspace_repositories SET folder='app' WHERE workspace_id=$1 AND position=0", [id]);
    for (const [position, repo] of REPOS.entries()) if (position > 0)
      await pool.query(`INSERT INTO cloud_v2_workspace_repositories (workspace_id, position, repository, folder, branch, base_branch) VALUES ($1,$2,$3,$4,$5,'main')`,
        [id, position, repo.repository, repo.folder, repo.branch]);
    store = new CloudV2Store(pool);
  });

  const checkpoints = (): NonNullable<CloudV2LifecycleDeps["checkpoints"]> => ({
    storage: {
      uploadUrl: async (_workspace, object) => { uploads.push(object); return `https://storage.example.test/upload/${object}?sig=1`; },
      downloadUrl: async (_workspace, object) => `https://storage.example.test/download/${object}?sig=1`,
      size: async (_workspace, object) => archives.has(object) ? 100 : null,
      delete: async (_workspace, object) => { archives.delete(object); },
      prune: async () => {},
    },
    seal: () => ({ sealed: true }),
    open: () => Buffer.alloc(32, 7),
  });
  const lifecycle = (extra: Partial<CloudV2LifecycleDeps> = {}) => new CloudV2Lifecycle({
    store, compute: boat, checkpoints: checkpoints(), retention: true,
    runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime.tar.gz" },
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
    sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({ ZEROS_WORKSPACE_ID: id }),
    sandboxName: () => `zeros-ws-${id.slice(0, 8)}`, sleep: async () => {},
    repositories: async () => REPOS.slice(1).map(repo => ({ repository: repo.repository, checkoutFolder: `proj/${repo.folder}`, baseBranch: "main" })),
    githubToken: async () => ({ token: "synthetic-github-token" }),
    restoreSource: async () => readyCopy,
    logger: { warn: line => { warnings.push(line); }, error: line => { errors.push(line); } },
    timing: record => { timings.push(record); },
    ...extra,
  });
  const row = async () => (await pool.query(`SELECT state, boat_sandbox_id, stopped_at, retention_started_at, backup_probe, backup_probe_generation, stop_generation,
    checkpoint_object, checkpoint_stop_generation, checkpoint_retry_fork, checkpoint_retry_exhausted_at, restore_pending, backup_forked_at
    FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
  /** The recorded stop and retention start, `ms` earlier. */
  const earlier = (ms: number) => pool.query(`UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - make_interval(secs => $2::double precision / 1000),
    retention_started_at=retention_started_at - make_interval(secs => $2::double precision / 1000),
    checkpoint_retry_at=checkpoint_retry_at - make_interval(secs => $2::double precision / 1000) WHERE id=$1`, [id, ms]);
  async function stop(): Promise<void> {
    await store.transition(id, ["running"], "stopping");
    await lifecycle().tick();
    expect((await row()).state).toBe("stopped");
  }
  async function wake(): Promise<void> {
    await store.transition(id, ["stopped"], "starting");
    await lifecycle().tick();
  }
  const forks = () => boat.calls.filter(call => call.op === "fork" && call.args[0] === vm);

  it("stops without uploading anything, with the worker service stopped and disabled, and keeps Boat's stoppedAt", async () => {
    await stop();
    expect(uploads).toEqual([]);
    expect(boat.commands.some(command => command.command.includes("zeros-checkpoint-saved"))).toBe(false);
    expect(boat.machine(vm)!.worker).toEqual({ enabled: false, active: false });
    const stopped = await row();
    expect(stopped).toMatchObject({ backup_probe: "clean", backup_probe_generation: stopped.stop_generation, checkpoint_object: null });
    expect(stopped.retention_started_at).toBeInstanceOf(Date);
    expect(stopped.stopped_at.getTime()).toBe(boat.machine(vm)!.stoppedAt);
    // Resumed later, the machine still runs no worker; a fork of it would not either.
    await boat.resume(vm);
    expect(boat.machine(vm)!.worker).toEqual({ enabled: false, active: false });
  });

  const workerOffRow = async () => (await pool.query("SELECT worker_off_unverified_at FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].worker_off_unverified_at;
  const isOffStep = (command: string) => command.includes("systemctl disable zeros-worker.service") && !command.includes("zeros-backup-probe");

  it("switches the worker off as its own step, verifies it, and retries once when the first attempt fails", async () => {
    let failures = 1;
    boat.failCommand = (machine, command) => machine.id === vm && isOffStep(command) && failures-- > 0;
    await stop();
    expect(boat.machine(vm)!.worker).toEqual({ enabled: false, active: false });
    const own = boat.commands.filter(command => command.machineId === vm).map(command => command.command);
    expect(own.filter(isOffStep)).toHaveLength(2);
    expect(own.some(command => command.includes("zeros-worker-unit"))).toBe(true);
    expect(await workerOffRow()).toBeNull();
  });

  it("completes a stop whose worker it could not switch off, records it, and still backs up through the fork", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    boat.failCommand = (machine, command) => machine.id === vm && isOffStep(command);
    await stop();
    expect((await row()).state).toBe("stopped");
    expect(boat.machine(vm)!.worker).toEqual({ enabled: true, active: true });
    expect(await workerOffRow()).toBeInstanceOf(Date);
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    await lifecycle().tick();
    // The fork booted the enabled worker; it is switched off there, verified, then backed up.
    const fork = [...boat.machines.values()].find(machine => machine.source === vm)!;
    const own = boat.commands.filter(command => command.machineId === fork.id).map(command => command.command);
    expect(own.some(isOffStep)).toBe(true);
    expect(own.findIndex(isOffStep)).toBeLessThan(own.findIndex(command => command.includes("zeros-checkpoint-saved")));
    const saved = await row();
    expect(saved).toMatchObject({ checkpoint_stop_generation: saved.stop_generation, checkpoint_retry_exhausted_at: null });
    expect(fork.state).toBe("deleted");
    expect(errors.some(line => line.includes("backup fork had its worker unit on"))).toBe(true);
    // The source machine itself was not fixed: the flag stays for a later wake to act on.
    expect(await workerOffRow()).toBeInstanceOf(Date);
  });

  it("refuses a fork whose worker it cannot switch off there either", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    boat.failCommand = (_machine, command) => isOffStep(command);
    await stop();
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    await lifecycle().tick();
    const fork = [...boat.machines.values()].find(machine => machine.source === vm)!;
    expect(boat.commands.some(command => command.machineId === fork.id && command.command.includes("zeros-checkpoint-saved"))).toBe(false);
    expect(fork.state).toBe("deleted");
    expect((await row()).checkpoint_retry_exhausted_at).toBeInstanceOf(Date);
    expect(errors.some(line => line.includes("backup fork refused: its worker unit is on"))).toBe(true);
  });

  it("with the switch off, still checkpoints at the stop exactly as before", async () => {
    await store.transition(id, ["running"], "stopping");
    await lifecycle({ retention: false }).tick();
    expect(uploads).toHaveLength(1);
    expect(boat.commands.some(command => command.command.includes("zeros-backup-probe"))).toBe(false);
    expect((await row()).checkpoint_object).toMatch(OBJECT);
  });

  it("never forks or backs up a stop that left nothing off GitHub", async () => {
    await stop();
    await earlier(2 * CLOUD_V2_BACKUP_DELAY_MS);
    await lifecycle().tick();
    expect(forks()).toEqual([]);
    expect(uploads).toEqual([]);
  });

  it("backs up an hour later on a fork, holding the one repository with work, then restores it onto a ready copy fork", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    const stoppedAt = boat.machine(vm)!.stoppedAt;
    expect((await row()).backup_probe).toBe("dirty");
    // Not before the hour.
    await lifecycle().tick();
    expect(forks()).toEqual([]);
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    const before = (await row()).stopped_at.getTime();
    await lifecycle().tick();
    expect(forks()).toHaveLength(1);
    const forkId = [...boat.machines.values()].find(machine => machine.source === vm)!.id;
    // The fork was checked for a worker, captured the smaller backup of every repository, and is gone.
    const own = boat.commands.filter(command => command.machineId === forkId).map(command => command.command);
    expect(own.some(command => command.includes("zeros-worker-unit"))).toBe(true);
    const backup = own.find(command => command.includes("zeros-checkpoint-saved"))!;
    for (const repo of REPOS) expect(backup).toContain(path(repo.folder));
    expect(backup).not.toContain(".claude/projects");
    expect(boat.machine(forkId)!.state).toBe("deleted");
    // A backup never moves the source's stoppedAt, at Boat or in the row.
    expect(boat.machine(vm)!.stoppedAt).toBe(stoppedAt);
    const saved = await row();
    expect(saved.stopped_at.getTime()).toBe(before);
    expect(saved).toMatchObject({ checkpoint_stop_generation: saved.stop_generation, checkpoint_retry_fork: null });
    expect(saved.backup_forked_at).toBeInstanceOf(Date);
    expect([...archives.get(saved.checkpoint_object)!.keys()]).toEqual([`${path("api")}/UNPUSHED`]);

    // Boat loses the VM; opening it restores onto a fork of the project's ready copy.
    boat.machine(vm)!.state = "deleted";
    await wake();
    const restored = await row();
    expect(restored.restore_pending).toBe(false);
    const replacement = boat.machine(restored.boat_sandbox_id)!;
    expect(replacement.source).toBe(readyCopy);
    expect(replacement.files.get(`${path("api")}/UNPUSHED`)).toBe("api work");
    expect(replacement.files.has(`${path("app")}/UNPUSHED`)).toBe(false);
    expect(replacement.files.has(`${path("docs")}/UNPUSHED`)).toBe(false);
    expect(warnings.some(line => line.includes("restored an earlier"))).toBe(false);
  });

  it("restores the last earlier checkpoint when the VM is lost before the stop's backup, and says so", async () => {
    // A full checkpoint from an earlier stop.
    const object = `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`;
    archives.set(object, new Map([[`${path("app")}/UNPUSHED`, "older work"]]));
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
      checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, object, "e".repeat(64)]);
    boat.write(vm, `${path("app")}/UNPUSHED`, "newer work");
    await stop();
    boat.machine(vm)!.state = "deleted";
    await wake();
    const replacement = boat.machine((await row()).boat_sandbox_id)!;
    expect(replacement.files.get(`${path("app")}/UNPUSHED`)).toBe("older work");
    expect(warnings.some(line => line.startsWith("[cloud-v2] restored an earlier backup or checkpoint"))).toBe(true);
    expect(timings).toContainEqual(expect.objectContaining({ phase: "checkpoint_restore", checkpoint: "earlier" }));
  });

  it("restores a clean workspace without a backup: GitHub's branch where it exists, the base branch where it was never pushed", async () => {
    remoteBranches.add(path("app"));
    await stop();
    boat.machine(vm)!.state = "deleted";
    await wake();
    const restored = await row();
    expect(restored).toMatchObject({ restore_pending: false, checkpoint_object: null });
    expect(restored.boat_sandbox_id).not.toBe(vm);
    const replacement = boat.machine(restored.boat_sandbox_id)!;
    expect(replacement.source).toBe(readyCopy);
    // The first repository's pushed branch is checked out from GitHub; the others are left for the worker to create from the base.
    expect(replacement.files.get(`${path("app")}/.git/refs/heads/zeros/w`)).toBe("from GitHub");
    expect(replacement.files.has(`${path("api")}/.git/refs/heads/zeros/w-api`)).toBe(false);
    const branchCommands = boat.commands.filter(command => command.machineId === replacement.id && command.command.includes("ls-remote --exit-code"));
    expect(branchCommands).toHaveLength(3);
    expect(timings).toContainEqual(expect.objectContaining({ phase: "checkpoint_restore", checkpoint: "none" }));
  });

  it("falls back to the Cloud Computer when the ready copy can no longer be forked", async () => {
    await stop();
    boat.machine(vm)!.state = "deleted";
    boat.machine(readyCopy)!.state = "deleted";
    await store.transition(id, ["stopped"], "starting");
    const cloned: string[] = [];
    await lifecycle({ prepareRepository: async (_workspace, sandboxId) => { cloned.push(sandboxId); } }).tick();
    const restored = await row();
    expect(restored.boat_sandbox_id).not.toBe(vm);
    const replacement = boat.machine(restored.boat_sandbox_id)!;
    expect(replacement.source).toBeNull();
    expect(replacement.from).toEqual(expect.any(String));
    expect(cloned).toEqual([replacement.id]);
    expect(warnings.some(line => line.includes("ready copy fork refused for a restore"))).toBe(true);
  });

  it("sweeps a fork whose delete failed, and alerts on one it can no longer find", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    boat.loseNextReply("delete");
    await lifecycle().tick();
    const forkId = [...boat.machines.values()].find(machine => machine.source === vm)!.id;
    // Boat deleted it but the reply was lost: the record stays until a later scan confirms.
    expect((await row()).checkpoint_retry_fork).toMatchObject({ sandboxId: forkId });
    await lifecycle().tick();
    expect((await row()).checkpoint_retry_fork).toBeNull();
    expect(boat.machine(forkId)!.state).toBe("deleted");

    // A fork request whose reply never came, past Boat's key window: nothing can find it.
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_retry_fork=jsonb_build_object('attempt',$2::text,'name','','source',$3::text,
      'requestedAt',clock_timestamp() - interval '2 days') WHERE id=$1`, [id, randomUUID(), vm]);
    await lifecycle().tick();
    expect((await row()).checkpoint_retry_fork).toBeNull();
    expect(errors.some(line => line.startsWith("[cloud-v2] backup fork leaked"))).toBe(true);
  });

  it("retries a failed backup with backoff inside its window, then reports it", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    backupFails = true;
    await stop();
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    await lifecycle().tick();
    const first = await row();
    expect(first.checkpoint_retry_exhausted_at).toBeNull();
    expect(forks()).toHaveLength(1);
    // Not again until its backoff has passed.
    await lifecycle().tick();
    expect(forks()).toHaveLength(1);
    // The window closes; the next attempt reports instead of forking again.
    await earlier(CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS - CLOUD_V2_BACKUP_DELAY_MS - 5 * 60_000);
    await lifecycle().tick();
    expect((await row()).checkpoint_retry_exhausted_at).toBeInstanceOf(Date);
    expect(errors.some(line => line.startsWith("[cloud-v2] checkpoint retries exhausted"))).toBe(true);
    for (const machine of boat.machines.values()) if (machine.source === vm) expect(machine.state).toBe("deleted");
  });

  it("keeps to the hourly fork cap", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    // Another workspace's backup fork began this hour.
    const other = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, backup_forked_at)
      VALUES ($1,$2,$3,'o','acme/other','zeros/o','main','stopped',clock_timestamp())`, [other, org, user]);
    await lifecycle({ backupForksPerHour: 1 }).tick();
    expect(forks()).toEqual([]);
    await lifecycle({ backupForksPerHour: 2 }).tick();
    expect(forks()).toHaveLength(1);
  });
});
