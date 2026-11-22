// Retention (CLOUD_V2_RETENTION_ENABLED) on the real store and the stateful
// fake Boat. The database stamps its own times, so "an hour later" moves the
// recorded times back instead of a clock forward. Commands on the fake are
// answered by meaning: a marker file named UNPUSHED stands for work that is
// not on GitHub, and an archive is the set of such files it captured.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProviderError } from "./provider-error.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CLOUD_V2_BACKUP_DELAY_MS, CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS, CLOUD_V2_LOSS_CONFIRM_MS, CLOUD_V2_LOSS_UNCONFIRMED_ALERT, CLOUD_V2_MAINTENANCE_LEASE_SECONDS,
  CLOUD_V2_MAINTENANCE_ADOPT_STALE_MS, CLOUD_V2_MAINTENANCE_STALE_MS, CloudV2Lifecycle, type CloudV2LifecycleDeps, type CloudV2TimingRecord } from "./lifecycle.js";
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

  const lostWork = async () => (await store.get(id, user)).lostWork;

  it("rebuilds from GitHub when the VM is lost before a dirty stop's backup, and records that nothing came back", async () => {
    remoteBranches.add(path("app"));
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    const stoppedAt = (await row()).stopped_at;
    boat.machine(vm)!.state = "deleted";
    await wake();
    const restored = await row();
    expect(restored.state).toBe("starting");
    expect(restored.boat_sandbox_id).not.toBe(vm);
    const replacement = boat.machine(restored.boat_sandbox_id)!;
    expect(replacement.source).toBe(readyCopy);
    expect(replacement.files.get(`${path("app")}/.git/refs/heads/zeros/w`)).toBe("from GitHub");
    expect(replacement.files.has(`${path("api")}/UNPUSHED`)).toBe(false);
    expect(await lostWork()).toEqual({ restored: "none", stoppedAt: stoppedAt.toISOString() });
  });

  const notFound = () => new CloudProviderError("provider_not_found", "Boat API request did not succeed", false, { httpStatus: 404 });
  const deletes = () => boat.calls.filter(call => call.op === "delete").map(call => call.args[0]);

  it("does not rebuild a workspace with unbacked work on a single 404, and loses nothing", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    await store.transition(id, ["stopped"], "starting");
    // Boat answers one resume wrongly; the machine is there when asked again.
    const resume = vi.spyOn(boat, "resume").mockRejectedValueOnce(notFound());
    const before = boat.calls.length;
    await lifecycle().tick();
    expect((await row()).boat_sandbox_id).toBe(vm);
    expect(boat.calls.slice(before).filter(call => call.op === "fork" || call.op === "create")).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(await lostWork()).toBeUndefined();
    expect(boat.machine(vm)!.files.get(`${path("api")}/UNPUSHED`)).toBe("api work");
    // The deferred step resumes the same machine.
    await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
    await lifecycle().tick();
    expect(resume).toHaveBeenCalledTimes(2);
    expect((await row()).boat_sandbox_id).toBe(vm);
  });

  it("rebuilds only once two reads apart confirm the machine gone, and never deletes it", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    boat.machine(vm)!.state = "deleted";
    const sleeps: number[] = [];
    await store.transition(id, ["stopped"], "starting");
    await lifecycle({ sleep: async ms => { sleeps.push(ms); } }).tick();
    expect(sleeps).toContain(CLOUD_V2_LOSS_CONFIRM_MS);
    expect(boat.calls.filter(call => call.op === "inspect" && call.args[0] === vm).length).toBeGreaterThanOrEqual(2);
    const restored = await row();
    expect(restored.boat_sandbox_id).not.toBe(vm);
    expect((await lostWork())?.restored).toBe("none");
    expect(deletes()).not.toContain(vm);
    expect((await pool.query("SELECT lost_work_machine FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].lost_work_machine).toBe(vm);
    expect(errors.some(line => line.startsWith("[cloud-v2] rebuilt a workspace whose machine is gone without a backup"))).toBe(true);
    // The old machine's id is never shown to clients.
    expect(JSON.stringify(await store.get(id, user))).not.toContain(vm);
  });

  it("rebuilds a machine Boat expired (archived, no snapshot left) after two reads, with the note and no delete", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    boat.machine(vm)!.expired = true;
    await expect(boat.inspect(vm)).resolves.toMatchObject({ state: "archived", snapshotAvailable: false, dataExpiredAt: expect.any(Date) });
    await store.transition(id, ["stopped"], "starting");
    await lifecycle().tick();
    const restored = await row();
    expect(restored.boat_sandbox_id).not.toBe(vm);
    expect((await lostWork())?.restored).toBe("none");
    expect(deletes()).not.toContain(vm);
    expect((await pool.query("SELECT lost_work_machine FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].lost_work_machine).toBe(vm);
  });

  it("never rebuilds a machine Boat still has on a failed resume, and alerts once the attempts pass the bound", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    await store.transition(id, ["stopped"], "starting");
    const resume = vi.spyOn(boat, "resume").mockRejectedValue(notFound());
    for (let attempt = 1; attempt <= CLOUD_V2_LOSS_UNCONFIRMED_ALERT; attempt++) {
      await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
      await lifecycle().tick();
      const alerted = errors.some(line => line.startsWith("[cloud-v2] resume keeps failing but Boat still has the machine"));
      expect(alerted).toBe(attempt >= CLOUD_V2_LOSS_UNCONFIRMED_ALERT);
    }
    expect(resume).toHaveBeenCalledTimes(CLOUD_V2_LOSS_UNCONFIRMED_ALERT);
    expect((await row()).boat_sandbox_id).toBe(vm);
    expect(deletes()).toEqual([]);
    expect(await lostWork()).toBeUndefined();
    expect(boat.machine(vm)!.files.get(`${path("api")}/UNPUSHED`)).toBe("api work");
  });

  it("keeps the clean rebuild immediate, and deletes the old machine there", async () => {
    await stop();
    boat.machine(vm)!.state = "deleted";
    const sleeps: number[] = [];
    await store.transition(id, ["stopped"], "starting");
    await lifecycle({ sleep: async ms => { sleeps.push(ms); } }).tick();
    expect(sleeps).not.toContain(CLOUD_V2_LOSS_CONFIRM_MS);
    expect((await row()).boat_sandbox_id).not.toBe(vm);
    expect(deletes()).toContain(vm);
    expect(await lostWork()).toBeUndefined();
  });

  it("restores the earlier checkpoint when the VM is lost before the backup, and records that the latest stop's work is missing", async () => {
    const object = `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`;
    archives.set(object, new Map([[`${path("app")}/UNPUSHED`, "older work"]]));
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
      checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, object, "e".repeat(64)]);
    boat.write(vm, `${path("app")}/UNPUSHED`, "newer work");
    await stop();
    const stoppedAt = (await row()).stopped_at;
    boat.machine(vm)!.state = "deleted";
    await wake();
    expect(boat.machine((await row()).boat_sandbox_id)!.files.get(`${path("app")}/UNPUSHED`)).toBe("older work");
    expect(await lostWork()).toEqual({ restored: "earlier", stoppedAt: stoppedAt.toISOString() });
    // The person dismisses it; it does not come back on its own.
    await store.dismissLostWork(id, user);
    expect(await lostWork()).toBeUndefined();
  });

  it("finishes a stop whose VM is already gone, and the next wake rebuilds it", async () => {
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await store.transition(id, ["running"], "stopping");
    boat.machine(vm)!.state = "deleted";
    await lifecycle().tick();
    expect((await row()).state).toBe("stopped");
    await wake();
    const restored = await row();
    expect(restored.boat_sandbox_id).not.toBe(vm);
    expect(boat.machine(restored.boat_sandbox_id)!.source).toBe(readyCopy);
    expect((await lostWork())?.restored).toBe("none");
  });

  it("clears the note at the next successful backup", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET lost_work_restored='none', lost_work_since=clock_timestamp() - interval '1 day' WHERE id=$1", [id]);
    expect((await lostWork())?.restored).toBe("none");
    boat.write(vm, `${path("api")}/UNPUSHED`, "api work");
    await stop();
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    await lifecycle().tick();
    expect((await row()).checkpoint_object).toMatch(OBJECT);
    expect(await lostWork()).toBeUndefined();
  });

  it("treats every stop without its verified worker-off step as unverified, the provider's own stop included", async () => {
    await stop();
    expect((await store.lifecycleWorkspace(id))?.workerOffUnverified).toBeUndefined();
    // Boat archived the VM on its own (a lease or provider stop): no step ran.
    await store.transition(id, ["stopped"], "starting");
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped', stop_generation=stop_generation+1 WHERE id=$1", [id]);
    expect((await store.lifecycleWorkspace(id))?.workerOffUnverified).toBe(true);
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

  describe("maintenance wakes", () => {
    const DAY = 24 * 60 * 60_000;
    /** A clean stop whose machine Boat stopped `days` ago. */
    async function sleeping(days: number): Promise<void> {
      await stop();
      await pool.query("UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - make_interval(secs => $2::double precision / 1000) WHERE id=$1", [id, days * DAY]);
    }
    const wakes = async () => (await pool.query("SELECT kind, outcome, worker_found_running, snapshot_available, deadline_at FROM cloud_v2_maintenance_wakes WHERE workspace_id=$1 ORDER BY started_at", [id])).rows;
    const visible = async () => (await pool.query(`SELECT state, boat_sandbox_id, updated_at, active_at, worker_token_hash, stop_generation FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
    const catalog = async () => Number((await pool.query("SELECT count(*) AS n FROM security_events WHERE payload->>'workspaceId'=$1", [id])).rows[0].n);
    const resumes = (machine = vm) => boat.calls.filter(call => call.op === "resume" && call.args[0] === machine);

    it("wakes a machine 10 days after Boat stopped it, invisibly: same document, no catalog event, no token, no activity", async () => {
      await sleeping(10.6);
      const before = { row: await visible(), document: JSON.stringify(await store.get(id, user)), events: await catalog() };
      await lifecycle().tick();
      expect(resumes()).toEqual([{ op: "resume", args: [vm, CLOUD_V2_MAINTENANCE_LEASE_SECONDS] }]);
      expect(boat.machine(vm)!.state).toBe("archived");
      expect(await visible()).toEqual(before.row);
      expect(JSON.stringify(await store.get(id, user))).toBe(before.document);
      expect(await catalog()).toBe(before.events);
      expect(await wakes()).toMatchObject([{ kind: "wake", outcome: "stopped", worker_found_running: false }]);
      const machine = (await pool.query("SELECT machine_stopped_at, maintenance_attempt FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];
      expect(machine).toMatchObject({ maintenance_attempt: null });
      expect(machine.machine_stopped_at.getTime()).toBe(boat.machine(vm)!.stoppedAt);
      expect(timings).toContainEqual(expect.objectContaining({ phase: "maintenance_wake", outcome: "stopped" }));
      // The next one is 10 days after Boat's new stop, not before.
      await lifecycle().tick();
      expect(resumes()).toHaveLength(1);
    });

    it("counts from the latest stop: a person's stop after a wake restarts the 10 days", async () => {
      await sleeping(10.6);
      await lifecycle().tick();
      expect(resumes()).toHaveLength(1);
      // Boat stopped it 11 days ago at the wake; the person used it since and stopped it yesterday.
      await pool.query(`UPDATE cloud_v2_workspaces SET machine_stopped_at=clock_timestamp() - interval '11 days',
        stopped_at=clock_timestamp() - interval '1 day' WHERE id=$1`, [id]);
      await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '11 days' WHERE workspace_id=$1", [id]);
      await lifecycle().tick();
      expect(resumes()).toHaveLength(1);
    });

    it("leaves a machine stopped less than 10 days alone", async () => {
      await sleeping(9);
      await lifecycle().tick();
      expect(resumes()).toEqual([]);
    });

    it("switches off a worker found running, alerts, and verifies it off", async () => {
      await sleeping(10.6);
      boat.machine(vm)!.worker = { enabled: true, active: true };
      await lifecycle().tick();
      expect(errors.some(line => line.startsWith("[cloud-v2] worker found running during a maintenance wake"))).toBe(true);
      expect(boat.machine(vm)!.worker).toEqual({ enabled: false, active: false });
      expect(await wakes()).toMatchObject([{ outcome: "stopped", worker_found_running: true }]);
      expect((await store.lifecycleWorkspace(id))?.workerOffUnverified).toBeUndefined();
    });

    it("records a machine Boat already expired as gone only after two reads, from Boat's own fields, and does not try again for that stop", async () => {
      await sleeping(10.6);
      boat.machine(vm)!.expired = true;
      const sleeps: number[] = [];
      await lifecycle({ sleep: async ms => { sleeps.push(ms); } }).tick();
      expect(sleeps).toContain(CLOUD_V2_LOSS_CONFIRM_MS);
      expect(boat.calls.filter(call => call.op === "inspect" && call.args[0] === vm).length).toBeGreaterThanOrEqual(2);
      expect(await wakes()).toMatchObject([{ outcome: "gone", snapshot_available: false }]);
      await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '2 hours' WHERE workspace_id=$1", [id]);
      await lifecycle().tick();
      expect(await wakes()).toHaveLength(1);
    });

    it("does not record one wrong 404 as gone: the wake failed, and is tried again after its hour", async () => {
      await sleeping(10.6);
      vi.spyOn(boat, "resume").mockRejectedValueOnce(notFound());
      await lifecycle().tick();
      expect(await wakes()).toMatchObject([{ outcome: "failed" }]);
      await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '2 hours' WHERE workspace_id=$1", [id]);
      await lifecycle().tick();
      expect(await wakes()).toMatchObject([{ outcome: "failed" }, { outcome: "stopped" }]);
    });

    it("expires a mark left by a wake that died between the mark and Boat's resume, and records that wake failed", async () => {
      await sleeping(10.6);
      const crashed = randomUUID();
      await pool.query("INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind, started_at) VALUES ($1, $2, 'wake', clock_timestamp() - interval '2 hours')", [id, crashed]);
      await pool.query(`UPDATE cloud_v2_workspaces SET maintenance_attempt=$2, maintenance_phase='waking',
        maintenance_started_at=clock_timestamp() - interval '2 hours' WHERE id=$1`, [id, crashed]);
      await lifecycle().tick();
      expect(await wakes()).toMatchObject([{ outcome: "failed" }, { outcome: "stopped" }]);
      expect((await pool.query("SELECT maintenance_attempt, maintenance_phase FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0])
        .toEqual({ maintenance_attempt: null, maintenance_phase: null });
      expect(resumes()).toHaveLength(1);
    });

    it("leaves a fresh mark alone: another step is still working it", async () => {
      await sleeping(10.6);
      await pool.query("UPDATE cloud_v2_workspaces SET maintenance_attempt=$2, maintenance_phase='waking', maintenance_started_at=clock_timestamp() WHERE id=$1", [id, randomUUID()]);
      await lifecycle().tick();
      expect(resumes()).toEqual([]);
    });

    describe("a person opening the workspace", () => {
      it("before the wake starts: no wake, an ordinary start", async () => {
        await sleeping(10.6);
        await store.transition(id, ["stopped"], "starting");
        await lifecycle().tick();
        expect(await wakes()).toEqual([]);
        expect(resumes()).toEqual([{ op: "resume", args: [vm] }]);
      });

      /** The person opens the workspace at `point` of a wake; their own step runs at once. It must not
       * touch the machine until the wake has let go, after which their worker runs as usual. */
      async function openDuring(point: "after the resume" | "between the worker-off commands" | "before the stop mark"): Promise<void> {
        await sleeping(10.6);
        const touched: string[] = [];
        let opened = false;
        const open = async () => {
          opened = true;
          await store.transition(id, ["stopped"], "starting");
          const before = boat.calls.length;
          await lifecycle().tick();
          await lifecycle().tick();
          touched.push(...boat.calls.slice(before).filter(call => call.args[0] === vm && call.op !== "inspect").map(call => call.op));
        };
        const realExec = boat.exec.bind(boat);
        boat.exec = async (sandbox, command, timeout) => {
          if (!opened && sandbox === vm && point === "after the resume" && command.includes("zeros-worker-unit")) await open();
          const result = await realExec(sandbox, command, timeout);
          if (!opened && sandbox === vm && point === "between the worker-off commands" && isOffStep(command)) await open();
          return result;
        };
        const realBegin = store.beginMaintenanceStop.bind(store);
        vi.spyOn(store, "beginMaintenanceStop").mockImplementation(async (workspace, attempt) => {
          if (!opened && point === "before the stop mark") await open();
          return realBegin(workspace, attempt);
        });
        await lifecycle().tick();
        expect(opened).toBe(true);
        // While the wake held the machine, the person's start made no call to it.
        expect(touched).toEqual([]);
        expect(await wakes()).toMatchObject([{ outcome: "adopted", worker_found_running: false }]);
        // The wake let go: the person's start now resumes the running machine on its full lease and starts the worker.
        for (let step = 0; step < 4 && !boat.machine(vm)!.worker.active; step++) {
          await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
          await lifecycle().tick();
        }
        expect(boat.machine(vm)!.worker).toEqual({ enabled: true, active: true });
        expect(boat.machine(vm)!.state).toBe("running");
        expect(resumes().at(-1)).toEqual({ op: "resume", args: [vm] });
        expect(boat.machine(vm)!.leaseUntil! - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
        expect(boat.calls.filter(call => call.op === "stop" && call.args[0] === vm)).toHaveLength(1); // the person's own earlier stop only
        expect(errors.filter(line => line.includes("worker found running"))).toEqual([]);
        expect((await pool.query("SELECT maintenance_attempt FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].maintenance_attempt).toBeNull();
      }

      it("after the wake's resume, before its unit check: the wake lets go, and the person's worker runs", () => openDuring("after the resume"));
      it("between the wake's worker-off commands: the wake lets go, and the person's worker runs", () => openDuring("between the worker-off commands"));
      it("just before the wake's stop mark: the wake lets go, and the person's worker runs", () => openDuring("before the stop mark"));

      it("waits on a fresh takeover until the wake lets go, and takes over one whose wake died", async () => {
        await sleeping(10.6);
        await pool.query("UPDATE cloud_v2_workspaces SET maintenance_attempt=$2, maintenance_phase='adopting', maintenance_started_at=clock_timestamp() WHERE id=$1", [id, randomUUID()]);
        await store.transition(id, ["stopped"], "starting");
        await lifecycle().tick();
        expect(resumes()).toEqual([]);
        await pool.query(`UPDATE cloud_v2_workspaces SET next_attempt_at=NULL,
          maintenance_started_at=clock_timestamp() - make_interval(secs => $2::double precision / 1000) WHERE id=$1`, [id, CLOUD_V2_MAINTENANCE_ADOPT_STALE_MS + 10_000]);
        await lifecycle().tick();
        expect(resumes()).toEqual([{ op: "resume", args: [vm] }]);
        expect((await pool.query("SELECT maintenance_attempt FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].maintenance_attempt).toBeNull();
      });

      it("between the stop mark and the stop call: waits, then resumes the stopped machine", async () => {
        await sleeping(10.6);
        const realStop = boat.stop.bind(boat);
        let waited = false;
        boat.stop = async sandbox => {
          if (!waited && sandbox === vm) {
            waited = true;
            await store.transition(id, ["stopped"], "starting");
            const before = resumes().length;
            await lifecycle().tick();
            // The person's start waited for the maintenance stop instead of resuming under it.
            expect(resumes()).toHaveLength(before);
          }
          return realStop(sandbox);
        };
        await lifecycle().tick();
        expect(await wakes()).toMatchObject([{ outcome: "stopped" }]);
        await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
        await lifecycle().tick();
        const calls = boat.calls.filter(call => call.args[0] === vm && (call.op === "stop" || call.op === "resume")).map(call => call.op);
        expect(calls.slice(-3)).toEqual(["resume", "stop", "resume"]);
      });

      it("takes over a stop mark left by a step that died", async () => {
        await sleeping(10.6);
        await pool.query(`UPDATE cloud_v2_workspaces SET maintenance_attempt=$2, maintenance_phase='stopping',
          maintenance_started_at=clock_timestamp() - make_interval(secs => $3::double precision / 1000) WHERE id=$1`, [id, randomUUID(), CLOUD_V2_MAINTENANCE_STALE_MS + 60_000]);
        await store.transition(id, ["stopped"], "starting");
        await lifecycle().tick();
        expect(resumes()).toEqual([{ op: "resume", args: [vm] }]);
        expect((await pool.query("SELECT maintenance_attempt FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].maintenance_attempt).toBeNull();
      });

      it("and a fresh mark keeps the start waiting", async () => {
        await sleeping(10.6);
        await pool.query("UPDATE cloud_v2_workspaces SET maintenance_attempt=$2, maintenance_phase='stopping', maintenance_started_at=clock_timestamp() WHERE id=$1", [id, randomUUID()]);
        await store.transition(id, ["stopped"], "starting");
        await lifecycle().tick();
        expect(resumes()).toEqual([]);
      });
    });

    it("wakes an archived workspace once more, on its machine's own 10 days, then never", async () => {
      // Archived five days after its last stop: the one wake comes five days after the archive.
      await sleeping(5);
      await pool.query("UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() WHERE id=$1", [id]);
      await lifecycle().tick();
      expect(resumes()).toEqual([]);
      await pool.query(`UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - interval '5 days 14 hours',
        archived_at=archived_at - interval '5 days 14 hours' WHERE id=$1`, [id]);
      await lifecycle().tick();
      expect(resumes()).toHaveLength(1);
      expect((await pool.query("SELECT archive_wake_done_at FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].archive_wake_done_at).toBeInstanceOf(Date);
      // Never again, however long it sleeps.
      await pool.query("UPDATE cloud_v2_workspaces SET machine_stopped_at=machine_stopped_at - interval '11 days' WHERE id=$1", [id]);
      await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '2 hours' WHERE workspace_id=$1", [id]);
      await lifecycle().tick();
      expect(resumes()).toHaveLength(1);
    });

    it("gives a workspace archived again its own one wake, when its machine is due", async () => {
      await sleeping(10.6);
      await pool.query(`UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() - interval '2 days',
        archive_wake_done_at=clock_timestamp() - interval '40 days' WHERE id=$1`, [id]);
      await lifecycle().tick();
      expect(resumes()).toHaveLength(1);
    });

    it("works a switch-on backlog larger than a day's budget deadline-first, and reports what it cannot reach", async () => {
      // 12 sleeping workspaces whose machines Boat should delete within the next 12 to 24 hours; nothing
      // on them needs a backup, so the whole budget goes to wakes.
      const others: { id: string; vm: string; days: number }[] = [];
      for (let index = 0; index < 12; index++) {
        const other = randomUUID(), days = 13 + ((index * 7) % 12) * 0.04;
        const { sandboxId } = await boat.create({ key: other, name: `zeros-ws-${other.slice(0, 8)}`, env: {} });
        await boat.stop(sandboxId); await boat.inspect(sandboxId);
        await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, boat_sandbox_id, stopped_at,
            retention_started_at, backup_probe, backup_probe_generation, worker_off_verified_generation)
          VALUES ($1,$2,$3,'o','acme/app','zeros/o','main','stopped',$4, clock_timestamp() - make_interval(secs => $5::double precision),
            clock_timestamp() - interval '20 days', 'clean', 0, 0)`, [other, org, user, sandboxId, days * DAY / 1000]);
        others.push({ id: other, vm: sandboxId, days });
      }
      const order: string[] = [];
      const realResume = boat.resume.bind(boat);
      boat.resume = async (sandbox, ttl) => { order.push(sandbox); return realResume(sandbox, ttl); };
      const running = lifecycle({ maintenancePerDay: 5, maintenancePerHour: 5 });
      for (let scan = 0; scan < 20; scan++) await running.tick();
      // Only the day's budget, the nearest deletions first.
      expect(order).toEqual([...others].sort((a, b) => b.days - a.days).slice(0, 5).map(entry => entry.vm));
      expect(Number((await pool.query("SELECT count(*) AS n FROM cloud_v2_maintenance_wakes")).rows[0].n)).toBe(5);
      // One summary line an hour, written after the first wake: 4 more fit today's budget, and the 7
      // after them cannot be reached before Boat deletes them.
      const summaries = warnings.filter(line => line.startsWith("[cloud-v2] maintenance backlog:"));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatch(/11 due, 11 past due by 2 days, 7 beyond the budget before Boat's expected deletion/);
      expect(timings.find(record => record.phase === "maintenance_backlog")).toMatchObject({ due: 11, overdue: 11, unreachable: 7 });
    });

    it("counts backup forks in the shared budget", async () => {
      await sleeping(10.6);
      await pool.query("INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind) VALUES ($1, $2, 'backup_fork')", [id, randomUUID()]);
      await lifecycle({ maintenancePerHour: 1 }).tick();
      expect(resumes()).toEqual([]);
    });

    it("confirms twice before restoring an earlier checkpoint over a machine that may hold later work, and keeps that machine", async () => {
      const object = `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`;
      archives.set(object, new Map([[`${path("app")}/UNPUSHED`, "older work"]]));
      await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
        checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, object, "e".repeat(64)]);
      boat.write(vm, `${path("app")}/UNPUSHED`, "newer work");
      await stop();
      await store.transition(id, ["stopped"], "starting");
      // One wrong 404: nothing is restored or deleted.
      vi.spyOn(boat, "resume").mockRejectedValueOnce(notFound());
      await lifecycle().tick();
      expect((await row()).boat_sandbox_id).toBe(vm);
      expect(deletes()).toEqual([]);
      // Truly expired: the earlier checkpoint comes back, and the machine is kept, not deleted.
      boat.machine(vm)!.expired = true;
      await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
      await lifecycle().tick();
      expect(boat.machine((await row()).boat_sandbox_id)!.files.get(`${path("app")}/UNPUSHED`)).toBe("older work");
      expect(deletes()).not.toContain(vm);
      expect((await pool.query("SELECT lost_work_machine FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].lost_work_machine).toBe(vm);
    });
  });
});
