// Retention (CLOUD_V2_RETENTION_ENABLED) on the real store and the stateful
// fake Boat. The database stamps its own times, so "an hour later" moves the
// recorded times back instead of a clock forward. Commands on the fake are
// answered by meaning: a marker file named UNPUSHED stands for work that is
// not on GitHub, and an archive is the set of such files it captured.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudProviderError } from "./provider-error.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CLOUD_V2_BACKUP_DELAY_MS, CLOUD_V2_CHECKPOINT_RETRY_WINDOW_MS, CLOUD_V2_LOSS_CONFIRM_MS, CLOUD_V2_LOSS_UNCONFIRMED_ALERT, CLOUD_V2_MAINTENANCE_LEASE_SECONDS,
  CLOUD_V2_MAINTENANCE_ADOPT_STALE_MS, CLOUD_V2_MAINTENANCE_STALE_MS, CloudV2Lifecycle, type CloudV2LifecycleDeps, type CloudV2TimingRecord } from "./lifecycle.js";
import { CLOUD_V2_BACKUP_REMOVAL_AT_SQL, CloudV2Store, setCloudV2RetentionDocuments } from "./store.js";
import { cloudV2BoatSnapshotName } from "./resource-names.js";
import { scheduleCloudDeletion } from "./deletion.js";
import { CloudV2ReadyCopies } from "./ready-copies.js";
import { assertOrganizationCloudPurgeReady } from "../deletion-lifecycle.js";
import { withSystemTx } from "../db.js";
import { workspaceSetupBuild } from "./setup-selection.js";

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
  /** C4B: the next backup left out a planned submodule folder holding a person's own clone. */
  let partialBackup: boolean;
  /** Retention S3: machines whose stop marker exists; machines something wrote to since; the change check timing out;
   * the environment restore failing; the bytes the server seeded, by path. */
  /** Retention S4: prefixes listed in the bucket with no object of their own here (orphans, non-ids). */
  let extraPrefixes: Set<string>;
  /** When each stored object was last written (R2's LastModified); absent means long ago. */
  let objectTimes: Map<string, number>;
  let markers: Set<string>, written: Set<string>, changeTimesOut: boolean, environmentRestoreFails: boolean, seeded: Map<string, string>;
  /** The checkouts the machine's commands look at: the project's three by default; a pre-switch workspace has its own. */
  let checkouts: string[];
  /** A pre-switch workspace's branch ref, kept by its backup as its unpushed commit. */
  let keepRefs: boolean;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(() => pool.end());
  // As composition does with CLOUD_V2_RETENTION_ENABLED on; off again after, for any later file in this worker.
  afterEach(() => setCloudV2RetentionDocuments(false));
  beforeEach(async () => {
    setCloudV2RetentionDocuments(true);
    await resetMigratedTestDatabase(pool);
    archives = new Map(); uploads = []; errors = []; warnings = []; timings = []; remoteBranches = new Set(); backupFails = false; partialBackup = false;
    markers = new Set(); written = new Set(); extraPrefixes = new Set(); objectTimes = new Map(); changeTimesOut = false; environmentRestoreFails = false; seeded = new Map();
    checkouts = REPOS.map(repo => path(repo.folder)); keepRefs = false;
    boat = new FakeBoat();
    boat.script = (machine, command, input) => {
      if (command.includes("zeros-backup-probe")) {
        const dirty = checkouts.some(checkout => command.includes(checkout) && machine.files.has(`${checkout}/UNPUSHED`));
        return { exitCode: 0, stdout: `zeros-backup-probe ${dirty ? "dirty" : "clean"}\n`, timedOut: false };
      }
      if (command.includes("zeros-checkpoint-saved")) {
        if (backupFails) return { exitCode: 3, stdout: "zeros-checkpoint-error checkpoint_upload_failed upload\n", timedOut: false };
        const object = OBJECT.exec(command)![0];
        archives.set(object, new Map([...machine.files].filter(([file]) => (file.endsWith("/UNPUSHED") || file.endsWith("/.env")
          || (keepRefs && file.includes("/.git/refs/heads/"))) && checkouts.some(checkout => command.includes(checkout) && file.startsWith(`${checkout}/`)))));
        return { exitCode: 0, stdout: `${partialBackup ? "zeros-checkpoint-partial\n" : ""}zeros-checkpoint-saved bytes=100 sha256=${"e".repeat(64)}\n`, timedOut: false };
      }
      if (command.includes("zeros-checkpoint-restored")) {
        const object = OBJECT.exec(command)![0];
        for (const [file, content] of archives.get(object) ?? []) machine.files.set(file, content);
        return { exitCode: 0, stdout: "zeros-checkpoint-restored\n", timedOut: false };
      }
      // Retention S3's commands on the machine.
      if (command.includes("zeros-stop-marker") && !command.includes("zeros-changed")) { markers.add(machine.id); written.delete(machine.id); return { exitCode: 0, stdout: "", timedOut: false }; }
      if (command.includes("zeros-changed")) {
        if (changeTimesOut) return { exitCode: 124, stdout: "", timedOut: true };
        const changed = !markers.has(machine.id) || written.has(machine.id);
        markers.add(machine.id);
        return { exitCode: 0, stdout: `zeros-changed ${changed ? "yes" : "no"}\n`, timedOut: false };
      }
      if (command.includes("zeros-archive-scrub")) {
        const mode = /scrub\.mjs" '\\''(backup|reseed|keep)'/.exec(command)?.[1];
        machine.files.delete("/home/user/.claude/.credentials.json");
        const env = [...machine.files.keys()].filter(file => file.endsWith("/.env"));
        let result = "partial";
        if (mode === "backup") { for (const file of env) machine.files.delete(file); result = env.length ? "backup" : "clean"; }
        if (mode === "reseed" && env.every(file => machine.files.get(file) === seeded.get(file))) { for (const file of env) machine.files.delete(file); result = "clean"; }
        return { exitCode: 0, stdout: `zeros-archive-scrub ${result}\n`, timedOut: false };
      }
      if (command.includes("zeros-environment-restored")) {
        if (environmentRestoreFails) return { exitCode: 3, stdout: "zeros-checkpoint-error checkpoint_download_failed download\n", timedOut: false };
        const object = OBJECT.exec(command)![0];
        for (const [file, content] of archives.get(object) ?? []) if (file.endsWith("/.env")) machine.files.set(file, content);
        return { exitCode: 0, stdout: "zeros-environment-restored\n", timedOut: false };
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
      // As R2: every object under the workspace's prefix but those kept.
      prune: async (workspace, keep = [], before) => {
        for (const object of [...archives.keys()])
          if (object.startsWith(`cloud-v2/checkpoints/${workspace}/`) && !keep.includes(object) && (!before || (objectTimes.get(object) ?? 0) < before.getTime()))
            archives.delete(object);
      },
      workspacePrefixes: async (after, limit) => {
        const names = [...new Set([...archives.keys()].map(object => object.split("/")[2]!)), ...extraPrefixes].sort();
        const page = names.filter(name => !after || `cloud-v2/checkpoints/${name}/` > after).slice(0, limit);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        return { ids: page.filter(name => uuid.test(name)), unparsed: page.filter(name => !uuid.test(name)).length };
      },
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

  describe("a clean rebuild after the Cloud Computer was rebuilt takes the live build, as a backup restore does", () => {
    /** A newer build goes live, as a runtime change or the daily refresh does; with `cleaned`, the workspace's own build's
     * snapshot is gone, as cleanup leaves a replaced build nobody is creating from. */
    const rebuildComputer = async (cleaned: boolean) => {
      const newer = randomUUID();
      await pool.query("INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_policy_version, snapshot_id) VALUES ($1,$2,2,'{\"repositories\":[]}','succeeded',$3,2,'zeros-base-2')",
        [newer, org, user]);
      await pool.query("UPDATE cloud_v2_computers SET active_build_id=$2, snapshot_name='zeros-base-2' WHERE org_id=$1", [org, newer]);
      if (cleaned) await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_deleted_at=clock_timestamp() WHERE org_id=$1 AND id<>$2", [org, newer]);
      return newer;
    };
    // A workspace with no project's ready copy to fork rebuilds from the Cloud Computer and clones its checkout.
    let cloned: string[] = [];
    const clean = () => lifecycle({ restoreSource: async () => null, prepareRepository: async (_workspace, sandboxId) => { cloned.push(sandboxId); } });
    beforeEach(() => { cloned = []; });
    const columns = async (names: string) => (await pool.query(`SELECT ${names} FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
    const rebuilt = async (newer: string) => {
      const restored = await row();
      const pin = await columns("computer_build_id, error_code");
      expect(restored.state, `error_code ${pin.error_code}`).toBe("starting");
      expect(restored.boat_sandbox_id).not.toBe(vm);
      expect(boat.machine(restored.boat_sandbox_id)!.from).toBe(cloudV2BoatSnapshotName("zeros-base-2"));
      expect(pin.computer_build_id).toBe(newer);
      expect(cloned).toEqual([restored.boat_sandbox_id]);
    };

    it("rebuilds a lost VM from the organization's live Computer when its own build was replaced and cleaned up", async () => {
      remoteBranches.add(path("app"));
      await stop();
      expect((await row()).backup_probe).toBe("clean");
      const newer = await rebuildComputer(true);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await clean().tick();
      await rebuilt(newer);
    });

    it("takes the live build even while its own build's snapshot still exists: the rebuild needs nothing from the older one", async () => {
      await stop();
      const newer = await rebuildComputer(false);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await clean().tick();
      await rebuilt(newer);
    });

    // Ready copies on: the live build may be a base that holds no repository, which Zeros prepared (no creator), or the
    // shared Zeros base (its snapshot a reference, name@build). Both are what restoreBuild takes; no rule of its own.
    it.each([
      { kind: "a base Zeros prepared", shared: false },
      { kind: "the shared Zeros base", shared: true },
    ])("rebuilds a lost VM from the live build when it is $kind", async ({ shared }) => {
      remoteBranches.add(path("app"));
      await stop();
      const base = randomUUID(), snapshot = shared ? `zeros-shared@${base}` : "zeros-base-3";
      await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_policy_version, snapshot_id,
          source_targets, base_only, base_shared, automatic) VALUES ($1,$2,3,'{"repositories":[]}','succeeded',NULL,2,$3,'[]',true,$4,true)`,
        [base, org, snapshot, shared]);
      await pool.query("UPDATE cloud_v2_computers SET active_build_id=$2, snapshot_name=$3 WHERE org_id=$1", [org, base, snapshot]);
      await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_deleted_at=clock_timestamp() WHERE org_id=$1 AND id<>$2", [org, base]);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await clean().tick();
      const restored = await row();
      expect(restored.state).toBe("starting");
      expect(boat.machine(restored.boat_sandbox_id)!.from).toBe(shared ? "zeros-shared" : "zeros-base-3");
      expect((await columns("computer_build_id")).computer_build_id).toBe(base);
      expect(cloned).toEqual([restored.boat_sandbox_id]);
    });

    it("opens an archived workspace whose machine expired: restores reads pushed, and the open rebuilds from GitHub with the lost-work note", async () => {
      remoteBranches.add(path("app"));
      boat.write(vm, `${path("app")}/UNPUSHED`, "work");
      await stop();
      await store.requestLifecycle(id, user, "archive");
      const newer = await rebuildComputer(true);
      // Twelve days on, Boat has expired the machine; the archived wake records it gone.
      await pool.query(`UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - interval '12 days 1 hour', archived_at=archived_at - interval '12 days',
        retention_started_at=retention_started_at - interval '13 days' WHERE id=$1`, [id]);
      boat.machine(vm)!.expired = true;
      await clean().tick();
      expect(await columns("machine_gone_at IS NOT NULL AS gone")).toEqual({ gone: true });
      // Before the open, the document says what opening brings back: what was pushed, not the machine's unpushed work.
      expect((await store.get(id, user)).restores).toBe("pushed");
      await store.requestLifecycle(id, user, "start");
      for (let step = 0; step < 3 && (await row()).boat_sandbox_id === vm; step++) {
        await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
        await clean().tick();
      }
      await rebuilt(newer);
      // And the open did exactly that: rebuilt from GitHub, the unpushed work not back, the note recorded.
      expect(boat.machine((await row()).boat_sandbox_id)!.files.has(`${path("app")}/UNPUSHED`)).toBe(false);
      expect((await store.get(id, user)).lostWork).toMatchObject({ restored: "none" });
    }, 30_000);

    it("a workspace the earlier code failed with cloud_computer_build_required stays failed until opened again, then rebuilds", async () => {
      await stop();
      const newer = await rebuildComputer(true);
      boat.machine(vm)!.state = "deleted";
      // What the earlier code left: the open failed with no usable image.
      await store.transition(id, ["stopped"], "starting");
      await pool.query("UPDATE cloud_v2_workspaces SET state='failed', error_code='cloud_computer_build_required' WHERE id=$1", [id]);
      await clean().tick();
      expect((await row()).state).toBe("failed");
      // Opening it again (the desktop's Open, or Start on the API) rebuilds it.
      await store.requestLifecycle(id, user, "start");
      await clean().tick();
      await rebuilt(newer);
    });
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

  describe("a workspace's submodules (C4B)", () => {
    /** acme/lib fetched at app/lib, as the worker does: its folder is one more checkout the machine's commands look at. */
    const lib = { position: 0, repository: "acme/lib", repositoryId: "42", checkoutFolder: "proj/app/lib", repositoryFolder: "proj/app",
      baseCommit: "c".repeat(40), gitDir: `modules/${"d".repeat(64)}` };
    const others = REPOS.slice(1).map(repo => ({ repository: repo.repository, checkoutFolder: `proj/${repo.folder}`, baseBranch: "main" }));
    const withSubmodules = { checkouts: async () => ({ repositories: others, submodules: [lib] }), submoduleToken: async () => ({ token: "synthetic-submodule-token" }) };
    /** Before this change: the lifecycle knew no submodules, so its probe and backup never looked at one. */
    const before = { checkouts: async () => ({ repositories: others, submodules: [] }) };
    const sub = `${path("app")}/lib`;
    const migration = () => pool.query(readFileSync(new URL("../../migrations/0269_cloud_v2_submodule_probe.sql", import.meta.url), "utf8")
      .replace("SET LOCAL lock_timeout = '5s';", ""));
    const fetched = () => pool.query(`INSERT INTO cloud_v2_workspace_submodules (workspace_id, position, path, status, repository, repository_id, commit, git_dir)
      VALUES ($1, 0, 'lib', 'fetch', 'acme/lib', '42', $2, $3)`, [id, lib.baseCommit, lib.gitDir]);
    beforeEach(() => { checkouts.push(sub); });
    const stopWith = async (deps: Partial<CloudV2LifecycleDeps>) => {
      await store.transition(id, ["running"], "stopping");
      await lifecycle(deps).tick();
      expect((await row()).state).toBe("stopped");
    };

    it("backs up a submodule's stash on a fork and brings it back when the machine is lost", async () => {
      boat.write(vm, `${sub}/UNPUSHED`, "stash");
      await stopWith(withSubmodules);
      expect((await row()).backup_probe).toBe("dirty");
      await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
      await lifecycle(withSubmodules).tick();
      const forkId = [...boat.machines.values()].find(machine => machine.source === vm)!.id;
      const backup = boat.commands.filter(command => command.machineId === forkId).map(command => command.command).find(command => command.includes("zeros-checkpoint-saved"))!;
      expect(backup).toContain("step=submodule-1");
      expect([...archives.get((await row()).checkpoint_object)!.keys()]).toContain(`${sub}/UNPUSHED`);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await lifecycle(withSubmodules).tick();
      expect(boat.machine((await row()).boat_sandbox_id)!.files.get(`${sub}/UNPUSHED`)).toBe("stash");
    });

    it("0269: a stop probed clean before this change is unknown for that stop, and its next maintenance backs it up within the budget", async () => {
      boat.write(vm, `${sub}/UNPUSHED`, "stash");
      await stopWith(before);
      const stopped = await row();
      expect(stopped.backup_probe).toBe("clean");
      await fetched();
      await migration();
      expect(await row()).toMatchObject({ backup_probe: "unknown", backup_probe_generation: stopped.backup_probe_generation });
      await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
      // Its backup is a fork the shared budget counts: with none left this hour, nothing is forked.
      await pool.query("INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind) VALUES ($1, $2, 'backup_fork')", [id, randomUUID()]);
      await lifecycle({ ...withSubmodules, maintenancePerHour: 1 }).tick();
      expect(forks()).toEqual([]);
      await pool.query("DELETE FROM cloud_v2_maintenance_wakes WHERE workspace_id=$1", [id]);
      await lifecycle(withSubmodules).tick();
      expect(forks()).toHaveLength(1);
      expect([...archives.get((await row()).checkpoint_object)!.keys()]).toContain(`${sub}/UNPUSHED`);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await lifecycle(withSubmodules).tick();
      expect(boat.machine((await row()).boat_sandbox_id)!.files.get(`${sub}/UNPUSHED`)).toBe("stash");
    });

    it("0269: once that machine is gone, opening says so: no clean rebuild without the note", async () => {
      remoteBranches.add(path("app"));
      boat.write(vm, `${sub}/UNPUSHED`, "stash");
      await stopWith(before);
      const stoppedAt = (await row()).stopped_at;
      await fetched();
      await migration();
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await lifecycle(withSubmodules).tick();
      expect((await row()).state).toBe("starting");
      expect(await lostWork()).toEqual({ restored: "none", stoppedAt: stoppedAt.toISOString() });
    });

    /** Before this change: a submodule edit made the repository dirty, so a backup was taken, holding none of it. */
    const oldBackup = async () => {
      boat.write(vm, `${path("app")}/UNPUSHED`, "moved gitlink");
      boat.write(vm, `${sub}/UNPUSHED`, "stash");
      await stopWith(before);
      await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
      await lifecycle(before).tick();
      const saved = await row();
      expect(saved.checkpoint_stop_generation).toBe(saved.stop_generation);
      archives.get(saved.checkpoint_object)!.delete(`${sub}/UNPUSHED`);
      return saved;
    };

    it("0269: a backup the old capture made is this stop's no more, so maintenance backs the stop up again and the stash survives", async () => {
      const saved = await oldBackup();
      await fetched();
      await migration();
      expect(await row()).toMatchObject({ checkpoint_object: saved.checkpoint_object, checkpoint_stop_generation: null });
      await pool.query("UPDATE cloud_v2_workspaces SET checkpoint_retry_at=NULL WHERE id=$1", [id]);
      await lifecycle(withSubmodules).tick();
      const again = await row();
      expect(again.checkpoint_object).not.toBe(saved.checkpoint_object);
      expect(again.checkpoint_stop_generation).toBe(again.stop_generation);
      expect([...archives.get(again.checkpoint_object)!.keys()]).toContain(`${sub}/UNPUSHED`);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await lifecycle(withSubmodules).tick();
      expect(boat.machine((await row()).boat_sandbox_id)!.files.get(`${sub}/UNPUSHED`)).toBe("stash");
    });

    it("0269: archived, its machine gone, restores answers pushed, and the open says the latest stop's work is missing", async () => {
      await oldBackup();
      await fetched();
      await store.requestLifecycle(id, user, "archive");
      // Boat has said the machine is gone: what opening brings back is the backup's alone.
      await pool.query("UPDATE cloud_v2_workspaces SET machine_gone_at=clock_timestamp() WHERE id=$1", [id]);
      expect((await store.get(id, user)).restores).toBe("all");
      await migration();
      expect((await store.get(id, user)).restores).toBe("pushed");
      // Opened once its machine is gone: the old backup comes back as an earlier checkpoint, with the note.
      await pool.query("UPDATE cloud_v2_workspaces SET archived_at=NULL WHERE id=$1", [id]);
      boat.machine(vm)!.state = "deleted";
      await store.transition(id, ["stopped"], "starting");
      await lifecycle(withSubmodules).tick();
      expect(await lostWork()).toMatchObject({ restored: "earlier" });
    });

    it("a backup that left out a person's own clone in a submodule folder never answers all", async () => {
      boat.write(vm, `${sub}/UNPUSHED`, "their own clone's work");
      partialBackup = true;
      await stopWith(withSubmodules);
      await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
      await lifecycle(withSubmodules).tick();
      const saved = await pool.query("SELECT checkpoint_partial, checkpoint_stop_generation = stop_generation AS this_stop FROM cloud_v2_workspaces WHERE id=$1", [id]);
      expect(saved.rows[0]).toEqual({ checkpoint_partial: true, this_stop: true });
      await store.requestLifecycle(id, user, "archive");
      await pool.query("UPDATE cloud_v2_workspaces SET machine_gone_at=clock_timestamp() WHERE id=$1", [id]);
      expect((await store.get(id, user)).restores).toBe("pushed");
      // The next backup that holds everything answers all again.
      await pool.query("UPDATE cloud_v2_workspaces SET checkpoint_partial=false WHERE id=$1", [id]);
      expect((await store.get(id, user)).restores).toBe("all");
    });

    it("0269: leaves a clean stop alone without a fetched submodule", async () => {
      await stopWith(before);
      await pool.query(`INSERT INTO cloud_v2_workspace_submodules (workspace_id, position, path, status, reason) VALUES ($1, 0, 'vendor/x', 'skipped', 'no access')`, [id]);
      await migration();
      expect((await row()).backup_probe).toBe("clean");
    });
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

  describe("activity, Keep and archive (S3)", () => {
    const DAY = 24 * 60 * 60_000;
    const columns = async (names: string) => (await pool.query(`SELECT ${names} FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
    /** Moves every clock of the workspace `days` into the past. */
    const ago = (days: number, names = "stopped_at, active_at, person_activity_at, retention_started_at") => pool.query(
      `UPDATE cloud_v2_workspaces SET ${names.split(",").map(name => `${name.trim()}=${name.trim()} - make_interval(secs => $2::double precision)`).join(", ")} WHERE id=$1`,
      [id, days * DAY / 1000]);
    async function member(role = "member") {
      const other = randomUUID();
      await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'M')", [other, `m-${other}@example.test`]);
      await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)", [org, other, role]);
      return other;
    }
    const forksOf = () => boat.calls.filter(call => call.op === "fork" && call.args[0] === vm).length;

    /** Runs `statement` while another connection holds the workspace row FOR UPDATE, and says whether it resolved while
     * that lock was still held. Ordering, not duration: the lock is kept until the statement resolves, so a statement
     * that waited for it could only reach the fallback (which then releases it) and never pass slowly. */
    const whileRowHeld = async (statement: () => Promise<unknown>, fallbackMs = 25_000): Promise<"resolved while held" | "waited for the lock"> => {
      const holder = await pool.connect();
      let held = true;
      try {
        await holder.query("BEGIN"); await holder.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id]);
        const resolved = statement().then(() => held ? "resolved while held" as const : "waited for the lock" as const);
        const outcome = await Promise.race([resolved, new Promise<"waited for the lock">(resolve => setTimeout(() => resolve("waited for the lock"), fallbackMs))]);
        held = false;
        await holder.query("ROLLBACK");
        await resolved;
        return outcome;
      } finally { if (held) await holder.query("ROLLBACK").catch(() => {}); holder.release(); }
    };

    it("tells a statement that waits for the held row from one that does not (the helper the two no-wait tests use)", async () => {
      // An update of the held row must wait: it can never resolve while the lock is held, however fast the machine.
      expect(await whileRowHeld(() => pool.query("UPDATE cloud_v2_workspaces SET name=name WHERE id=$1", [id]), 1_500)).toBe("waited for the lock");
      expect(await whileRowHeld(() => pool.query("SELECT 1"))).toBe("resolved while held");
    }, 30_000);

    describe("activity", () => {
      it("stamps a person's call at most every 30 seconds, and never waits for a row the lifecycle holds", async () => {
        await store.personActivity(id);
        const first = (await columns("person_activity_at")).person_activity_at;
        expect(first).toBeInstanceOf(Date);
        await store.personActivity(id);
        expect((await columns("person_activity_at")).person_activity_at).toEqual(first);
        await pool.query("UPDATE cloud_v2_workspaces SET person_activity_at=person_activity_at - interval '1 minute' WHERE id=$1", [id]);
        expect(await whileRowHeld(() => store.personActivity(id))).toBe("resolved while held");
      }, 30_000);

      it("starts the clock at switch-on: a workspace asleep 90 days, its machine long gone, is archived 30 days after, not at once and not never", async () => {
        await stop();
        await pool.query("UPDATE cloud_v2_workspaces SET retention_started_at=NULL, stopped_at=clock_timestamp() - interval '90 days', active_at=clock_timestamp() - interval '90 days' WHERE id=$1", [id]);
        boat.machine(vm)!.expired = true;
        // A maintenance wake in the same pass may hold the row; a scan never waits for it, the next takes it.
        await lifecycle().tick();
        await lifecycle().tick();
        const started = await columns("retention_started_at, archived_at");
        expect(started.retention_started_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
        expect(started.archived_at).toBeNull();
        await ago(29, "retention_started_at");
        await lifecycle().tick();
        expect((await columns("archived_at")).archived_at).toBeNull();
        await ago(1.1, "retention_started_at");
        await lifecycle().tick();
        expect(await columns("archive_reason")).toEqual({ archive_reason: "inactive" });
      });
    });

    it("never reads access: a workspace whose creator lost it is still backed up, woken and archived on schedule", async () => {
      boat.write(vm, `${path("app")}/UNPUSHED`, "work");
      await stop();
      // The creator is on Hold, or their Pro ended: they cannot use the workspace now.
      await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [org]);
      await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
      await lifecycle().tick();
      expect(forksOf()).toBe(1);
      await pool.query(`UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - interval '10 days 14 hours',
        retention_started_at=retention_started_at - interval '31 days', active_at=active_at - interval '31 days' WHERE id=$1`, [id]);
      await lifecycle().tick();
      await lifecycle().tick();
      expect(boat.calls.some(call => call.op === "resume" && call.args[0] === vm && call.args[1] === CLOUD_V2_MAINTENANCE_LEASE_SECONDS)).toBe(true);
      expect((await columns("archive_reason")).archive_reason).toBe("inactive");
    });

    describe("Keep", () => {
      it("exempts a workspace from automatic archive, set and cleared by anyone who can use it, and counts as activity", async () => {
        await stop();
        await ago(31);
        const kept = await store.setKeep(id, user, true);
        expect(kept.keep).toBe(true);
        await ago(31);
        await lifecycle().tick();
        expect((await columns("archived_at")).archived_at).toBeNull();
        expect((await store.setKeep(id, user, false)).keep).toBe(false);
        await ago(31);
        await lifecycle().tick();
        expect((await columns("archive_reason")).archive_reason).toBe("inactive");
      });

      it("refuses everyone else: another member of a creator's workspace, and anyone but its member on a personal project's", async () => {
        const other = await member();
        await expect(store.setKeep(id, other, true)).rejects.toMatchObject({ status: 404 });
        await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2, private_owner_user_id=$2 WHERE id=$1", [id, other]);
        await expect(store.setKeep(id, user, true)).rejects.toMatchObject({ status: 404 });
        expect((await store.setKeep(id, other, true)).keep).toBe(true);
      });
    });

    describe("Keep and archive (owner decision, 2026-11-22: Keep only while not archived)", () => {
      it("clears Keep at a manual archive, sets the backup's removal date, and an open does not bring it back", async () => {
        await stop();
        await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
          checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`, "e".repeat(64)]);
        expect((await store.setKeep(id, user, true)).keep).toBe(true);
        await store.requestLifecycle(id, user, "archive");
        const archived = await store.get(id, user);
        expect(archived).toMatchObject({ keep: false, archiveReason: "manual" });
        expect(Date.parse(archived.backupRemovalAt!) - Date.parse(archived.archivedAt!)).toBe(60 * DAY);
        expect(await columns("keep_set_at, keep_set_by")).toEqual({ keep_set_at: null, keep_set_by: null });
        await store.requestLifecycle(id, user, "start");
        expect((await store.get(id, user)).keep).toBe(false);
      });

      it("refuses Keep on every kind of archived workspace: manual, inactive and a returning member's", async () => {
        await stop();
        await store.requestLifecycle(id, user, "archive");
        await expect(store.setKeep(id, user, true)).rejects.toMatchObject({ status: 409, code: "keep_refused_archived" });
        await store.requestLifecycle(id, user, "start");
        await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [id]);
        await ago(31);
        await store.archiveInactive({ inactiveMs: 30 * DAY, limit: 200 });
        await expect(store.setKeep(id, user, true)).rejects.toMatchObject({ status: 409, code: "keep_refused_archived" });
        await store.requestLifecycle(id, user, "start");
        // A member's personal-project workspace, archived when they left, theirs again when re-added.
        const leaver = await member();
        await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2, private_owner_user_id=$2 WHERE id=$1", [id, leaver]);
        expect((await store.setKeep(id, leaver, true)).keep).toBe(true);
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
        expect(await columns("archive_reason, keep_set_at")).toEqual({ archive_reason: "member_left", keep_set_at: null });
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
        await expect(store.setKeep(id, leaver, true)).rejects.toMatchObject({ status: 409, code: "keep_refused_archived" });
      });
    });

    describe("automatic archive", () => {
      it("archives only a quiet one: not during a maintenance wake, nor once a start is pending", async () => {
        await stop();
        await ago(31);
        await pool.query("UPDATE cloud_v2_workspaces SET maintenance_attempt=$2, maintenance_phase='waking', maintenance_started_at=clock_timestamp() WHERE id=$1", [id, randomUUID()]);
        await store.archiveInactive({ inactiveMs: 30 * DAY, limit: 200 });
        expect((await columns("archived_at")).archived_at).toBeNull();
        await pool.query("UPDATE cloud_v2_workspaces SET maintenance_attempt=NULL, maintenance_phase=NULL, maintenance_started_at=NULL WHERE id=$1", [id]);
        // Opened meanwhile: a start is pending.
        await store.transition(id, ["stopped"], "starting");
        await store.archiveInactive({ inactiveMs: 30 * DAY, limit: 200 });
        expect((await columns("archived_at")).archived_at).toBeNull();
        await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [id]);
        await store.archiveInactive({ inactiveMs: 30 * DAY, limit: 200 });
        expect((await columns("archive_reason")).archive_reason).toBe("inactive");
      });

      it("works the herd 200 a run, oldest clock first, and sends no mail", async () => {
        await stop();
        await ago(40);
        for (let index = 0; index < 204; index++)
          await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, stopped_at, retention_started_at)
            VALUES ($1,$2,$3,$4,'acme/app','zeros/h','main','stopped', clock_timestamp() - interval '35 days', clock_timestamp() - interval '35 days')`, [randomUUID(), org, user, `h${index}`]);
        const first = await store.archiveInactive({ inactiveMs: 30 * DAY, limit: 200 });
        expect(first.archived).toHaveLength(200);
        // The oldest clock (this workspace, 40 days) is in the first run.
        expect(first.archived.map(entry => entry.id)).toContain(id);
        expect((await store.archiveInactive({ inactiveMs: 30 * DAY, limit: 200 })).archived).toHaveLength(5);
        // Owner decision (2026-11-22): the archive is shown in the app, never mailed.
        expect(Number((await pool.query("SELECT count(*) AS n FROM security_notification_outbox")).rows[0].n)).toBe(0);
      });

      it("carries no retention field at all with the switch off: the document is exactly what it was", async () => {
        await stop();
        await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
          checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`, "e".repeat(64)]);
        await store.requestLifecycle(id, user, "archive");
        setCloudV2RetentionDocuments(false);
        const plain = await store.get(id, user);
        for (const field of ["keep", "archiveReason", "machineExpectedGoneAt", "backupRemovalAt"]) expect(plain).not.toHaveProperty(field);
        setCloudV2RetentionDocuments(true);
        expect(await store.get(id, user)).toMatchObject({ keep: false, archiveReason: "manual" });
      });

      it("counts the backup's removal from the switch, never from history, and drops an estimate already past", async () => {
        await stop();
        await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
          checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`, "e".repeat(64)]);
        // Archived 100 days before retention applied to it.
        await pool.query(`UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() - interval '100 days', archive_reason='manual', retention_started_at=NULL,
          stopped_at=clock_timestamp() - interval '101 days' WHERE id=$1`, [id]);
        expect(await store.get(id, user)).not.toHaveProperty("backupRemovalAt");
        await store.startRetentionClocks(10);
        const started = (await columns("retention_started_at")).retention_started_at as Date;
        const document = await store.get(id, user);
        expect(Date.parse(document.backupRemovalAt!) - started.getTime()).toBe(60 * DAY);
        // The SQL expression S4 removes by is the same date.
        const sql = (await pool.query(`SELECT ${CLOUD_V2_BACKUP_REMOVAL_AT_SQL} AS at FROM cloud_v2_workspaces w WHERE w.id=$1`, [id])).rows[0].at as Date;
        expect(sql.toISOString()).toBe(document.backupRemovalAt);
        // Its machine's estimate (101 days since its stop) is long past: no date rather than a wrong one.
        expect(document).not.toHaveProperty("machineExpectedGoneAt");
      });

      it("carries the archive's fields on the document, and refuses Keep while archived", async () => {
        await stop();
        await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
          checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`, "e".repeat(64)]);
        await ago(31);
        await lifecycle().tick();
        await lifecycle().tick();
        const archived = await store.get(id, user);
        expect(archived).toMatchObject({ keep: false, archiveReason: "inactive", machineExpectedGoneAt: { estimate: true } });
        expect(Date.parse(archived.backupRemovalAt!) - Date.parse(archived.archivedAt!)).toBe(60 * DAY);
        // Boat's 14 days after the machine's last stop, plus the archived wake's 10 while that wake is still owed.
        // The same pass may archive the workspace and then give it that wake, or wake it first: both are right.
        const stops = await columns("greatest(machine_stopped_at, stopped_at) AS last, archive_wake_done_at >= archived_at AS woken");
        expect(Date.parse(archived.machineExpectedGoneAt!.at) - stops.last.getTime()).toBe((stops.woken ? 14 : 24) * DAY);
        // Once the archived wake is recorded, only Boat's 14 days remain.
        await pool.query("UPDATE cloud_v2_workspaces SET archive_wake_done_at=clock_timestamp() WHERE id=$1", [id]);
        expect(Date.parse((await store.get(id, user)).machineExpectedGoneAt!.at) - stops.last.getTime()).toBe(14 * DAY);
        // Keep exists only while not archived: refused here, and clearing it changes nothing.
        await expect(store.setKeep(id, user, true)).rejects.toMatchObject({ status: 409, code: "keep_refused_archived" });
        expect(await store.setKeep(id, user, false)).toMatchObject({ keep: false, archiveReason: "inactive", backupRemovalAt: archived.backupRemovalAt });
        // Opening un-archives it, and the reason goes with it.
        await store.requestLifecycle(id, user, "start");
        const opened = await store.get(id, user);
        expect(opened.archivedAt).toBeNull();
        expect(opened).not.toHaveProperty("archiveReason");
      });
    });

    describe("a member who leaves", () => {
      async function privateTo(person: string) {
        await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2, private_owner_user_id=$2 WHERE id=$1", [id, person]);
      }

      it("archives their personal project's workspace at once, stops it the ordinary way, and with retention off still uploads its checkpoint", async () => {
        const leaver = await member();
        await privateTo(leaver);
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
        expect(await columns("archive_reason, state")).toEqual({ archive_reason: "member_left", state: "running" });
        await lifecycle({ retention: false }).tick();
        expect((await columns("state")).state).toBe("stopping");
        await lifecycle({ retention: false }).tick();
        expect(await columns("state, archive_reason")).toEqual({ state: "stopped", archive_reason: "member_left" });
        expect(uploads.length).toBeGreaterThan(0);
      });

      it("never lets anyone else in, admins included, and gives the member their workspace back when re-added", async () => {
        const leaver = await member(), admin = await member("admin");
        await privateTo(leaver);
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
        for (const person of [user, admin, leaver]) await expect(store.setKeep(id, person, true)).rejects.toMatchObject({ status: 404 });
        // Shared execution's creator-loss trigger clears the creator when they leave; their return restores it.
        await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active', creator_user_id=NULL, creator_absent_reason='left', creator_absent_at=clock_timestamp() WHERE id=$1", [id]);
        await member();
        expect((await columns("creator_user_id")).creator_user_id).toBeNull();
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
        expect(await columns("creator_user_id, creator_absent_reason, archive_reason")).toEqual({ creator_user_id: leaver, creator_absent_reason: null, archive_reason: "member_left" });
      });

      it("leaves the transaction's own settings exactly as they were: '0', '1' or unset, through both membership triggers", async () => {
        const leaver = await member();
        await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2, private_owner_user_id=$2 WHERE id=$1", [id, leaver]);
        for (const before of [null, "0", "1"] as const) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            if (before !== null) await client.query("SELECT set_config('app.system', $1, true), set_config('app.cloud_team_ownership', $1, true)", [before]);
            // Both triggers fire in this transaction: the departure archives, the return restores.
            await client.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
            expect((await client.query("SELECT archive_reason FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].archive_reason).toBe("member_left");
            await client.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
            const after = (await client.query("SELECT current_setting('app.system', true) AS system, current_setting('app.cloud_team_ownership', true) AS ownership")).rows[0];
            if (before === null) for (const value of [after.system, after.ownership]) expect(["on", "1"]).not.toContain(value);
            else expect(after).toEqual({ system: before, ownership: before });
          } finally { await client.query("ROLLBACK"); client.release(); }
        }
        expect((await columns("archive_reason")).archive_reason).toBeNull();
      });

      it("never fails or waits on a removal while the workspace row is held (a start in progress), and archives it on the next sweep", async () => {
        const leaver = await member();
        await privateTo(leaver);
        await pool.query("UPDATE cloud_v2_workspaces SET state='starting' WHERE id=$1", [id]);
        expect(await whileRowHeld(() => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver])))
          .toBe("resolved while held");
        expect((await columns("archived_at")).archived_at).toBeNull();
        expect(await store.archiveDepartedPrivate(200)).toEqual([id]);
        expect(await columns("archive_reason")).toEqual({ archive_reason: "member_left" });
        expect(await store.archiveForSystem(id)).toBe(true);
        expect((await columns("state")).state).toBe("stopping");
      }, 30_000);

      it("leaves a manual archive exactly as before, but for its reason", async () => {
        for (const state of ["running", "stopped"] as const) {
          if (state === "stopped") await stop();
          const before = (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];
          await store.requestLifecycle(id, user, "archive");
          const after = (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];
          const changed = Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(before[key])).sort();
          expect(changed).toEqual(state === "running"
            ? ["archive_reason", "archived_at", "execution_intent_id", "state", "stop_generation", "updated_at"].filter(key => key in after && (key !== "execution_intent_id" || after[key] !== before[key])).sort()
            : ["archive_reason", "archived_at", "updated_at"]);
          expect(after.archive_reason).toBe("manual");
          await store.requestLifecycle(id, user, "start");
          if (state === "running") { await pool.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [id]); }
        }
      });
    });

    describe("final backup and scrub", () => {
      const ENV = `${path("app")}/.env`;
      const archive = () => store.requestLifecycle(id, user, "archive");
      const sleepFor = (days: number) => pool.query(`UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - make_interval(secs => $2::double precision),
        machine_stopped_at=machine_stopped_at - make_interval(secs => $2::double precision),
        archived_at=archived_at - make_interval(secs => $2::double precision),
        retention_started_at=retention_started_at - make_interval(secs => $2::double precision) WHERE id=$1`, [id, days * DAY / 1000]);
      const wakeRows = async () => (await pool.query("SELECT outcome, changed_since_stop, scrub FROM cloud_v2_maintenance_wakes WHERE workspace_id=$1 AND kind='wake' ORDER BY started_at", [id])).rows;

      it("takes no fork at archive when this stop's backup is settled and nothing changed since", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
        await lifecycle().tick();
        expect(forksOf()).toBe(1);
        await archive();
        await lifecycle().tick();
        expect(forksOf()).toBe(1);
      });

      it("takes exactly one backup for a running workspace stopped by its archive", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await archive();
        await lifecycle().tick();
        expect((await columns("state")).state).toBe("stopped");
        // The archive's backup goes first, without the hour's delay.
        await lifecycle().tick();
        expect(forksOf()).toBe(1);
        await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
        await lifecycle().tick();
        expect(forksOf()).toBe(1);
      });

      for (const [name, setup] of [
        ["a file written while a wake had the machine awake", () => { written.add(vm); }],
        ["the change check timing out", () => { changeTimesOut = true; }],
      ] as const) it(`takes one at archive after ${name}, though the stop's probe was clean`, async () => {
        await stop();
        expect(markers.has(vm)).toBe(true);
        setup();
        await sleepFor(10.6);
        await lifecycle().tick();
        expect(await wakeRows()).toMatchObject([{ outcome: "stopped", changed_since_stop: true }]);
        changeTimesOut = false;
        await archive();
        await lifecycle().tick();
        expect(forksOf()).toBe(1);
      });

      it("scrubs the machine at its one archived wake, and an open puts the person's own environment file back before the worker starts", async () => {
        boat.write(vm, ENV, "TOKEN=the person's own edit");
        seeded.set(ENV, "TOKEN=from the server");
        boat.write(vm, "/home/user/.claude/.credentials.json", "{}");
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
        await lifecycle().tick();
        await archive();
        await sleepFor(10.6);
        await lifecycle().tick();
        expect(await wakeRows()).toMatchObject([{ outcome: "stopped", scrub: "backup" }]);
        expect(boat.machine(vm)!.files.has(ENV)).toBe(false);
        expect(boat.machine(vm)!.files.has("/home/user/.claude/.credentials.json")).toBe(false);
        expect(await columns("archive_scrub")).toEqual({ archive_scrub: "backup" });
        // Never woken again.
        await sleepFor(11);
        await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '2 hours' WHERE workspace_id=$1", [id]);
        await lifecycle().tick();
        expect(await wakeRows()).toHaveLength(1);
        // Opened: the person's bytes come back before the token reaches the worker.
        await store.requestLifecycle(id, user, "start");
        await lifecycle().tick();
        expect(boat.machine(vm)!.files.get(ENV)).toBe("TOKEN=the person's own edit");
        const commands = boat.commands.filter(command => command.machineId === vm).map(command => command.command);
        const restoredAt = commands.findIndex(command => command.includes("zeros-environment-restored"));
        const tokenAt = commands.findLastIndex(command => command.includes("worker-token") && !command.includes("zeros-archive-scrub"));
        expect(restoredAt).toBeGreaterThanOrEqual(0);
        expect(tokenAt).toBeGreaterThan(restoredAt);
        expect(await columns("archive_scrub")).toEqual({ archive_scrub: "clean" });
      });

      it("does the same for a second repository: its hand-edited environment file is scrubbed, then comes back on open", async () => {
        const API_ENV = `${path("api")}/.env`;
        boat.write(vm, API_ENV, "API_TOKEN=the person's own edit");
        boat.write(vm, `${path("api")}/UNPUSHED`, "work");
        await stop();
        await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
        await lifecycle().tick();
        await archive();
        await sleepFor(10.6);
        await lifecycle().tick();
        expect(await wakeRows()).toMatchObject([{ outcome: "stopped", scrub: "backup" }]);
        expect(boat.machine(vm)!.files.has(API_ENV)).toBe(false);
        // The scrub was given every checkout, each with its own seed journal.
        const scrubbed = boat.commands.find(command => command.machineId === vm && command.command.includes("zeros-archive-scrub"))!.command;
        for (const repo of REPOS) expect(scrubbed).toContain(path(repo.folder));
        expect(scrubbed).toContain("repositories/2/environment-seed/manifest.json");
        await store.requestLifecycle(id, user, "start");
        await lifecycle().tick();
        expect(boat.machine(vm)!.files.get(API_ENV)).toBe("API_TOKEN=the person's own edit");
        const restore = boat.commands.find(command => command.machineId === vm && command.command.includes("zeros-environment-restored"))!.command;
        expect(restore).toContain("repositories/1/environment.tar");
      });

      it("rebuilds from the backup when the scrubbed files cannot be put back, never starting a checkout without them", async () => {
        boat.write(vm, ENV, "TOKEN=the person's own edit");
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
        await lifecycle().tick();
        await archive();
        await sleepFor(10.6);
        await lifecycle().tick();
        environmentRestoreFails = true;
        await store.requestLifecycle(id, user, "start");
        await lifecycle().tick();
        expect(boat.commands.filter(command => command.machineId === vm && command.command.includes("zeros-environment-restored"))).toHaveLength(2);
        expect(boat.commands.some(command => command.machineId === vm && command.command.includes("worker-token") && command.command.includes("zw2w_"))).toBe(false);
        const replaced = (await columns("boat_sandbox_id, restore_pending")).boat_sandbox_id;
        expect(replaced).not.toBe(vm);
      });

      it("never starves the archived wake: unsettled by day 12, it wakes without scrubbing, and the next is the one archived wake (2 at most)", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        backupFails = true;
        await stop();
        // Archived five days after the stop; its backup keeps failing, so it stays unsettled until 12 days after the archive.
        await pool.query("UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - interval '5 days', retention_started_at=retention_started_at - interval '5 days' WHERE id=$1", [id]);
        await archive();
        await lifecycle().tick();
        await pool.query("UPDATE cloud_v2_workspaces SET checkpoint_retry_at=clock_timestamp() + interval '30 days' WHERE id=$1", [id]);
        await sleepFor(5.6);
        await lifecycle().tick();
        expect(await wakeRows()).toEqual([]);
        await sleepFor(1.5);
        await lifecycle().tick();
        expect(await wakeRows()).toMatchObject([{ outcome: "stopped", scrub: null }]);
        expect((await columns("archive_wake_done_at")).archive_wake_done_at).toBeNull();
        await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '11 days' WHERE workspace_id=$1", [id]);
        await sleepFor(10.6);
        await lifecycle().tick();
        expect(await wakeRows()).toMatchObject([{ scrub: null }, { outcome: "stopped", scrub: "partial" }]);
        expect((await columns("archive_wake_done_at")).archive_wake_done_at).toBeInstanceOf(Date);
        await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - interval '11 days' WHERE workspace_id=$1", [id]);
        await sleepFor(11);
        await lifecycle().tick();
        expect(await wakeRows()).toHaveLength(2);
      });
    });
  });

  describe("backup removal, clean-up and alerts (S4)", () => {
    const DAY = 24 * 60 * 60_000;
    const columns = async (names: string) => (await pool.query(`SELECT ${names} FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
    const backup = async (object = `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`) => {
      archives.set(object, new Map([[`${path("app")}/UNPUSHED`, "only in the backup"]]));
      await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2, checkpoint_key='{"sealed":true}', checkpoint_sha256=$3, checkpoint_bytes=100,
        checkpoint_saved_at=clock_timestamp(), checkpoint_stop_generation=stop_generation WHERE id=$1`, [id, object, "e".repeat(64)]);
      return object;
    };
    /** Archived `days` ago, retention having applied since before that. */
    const archivedAgo = (days: number) => pool.query(`UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() - make_interval(secs => $2::double precision),
      archive_reason='manual', retention_started_at=clock_timestamp() - make_interval(secs => $2::double precision + 3600)
      WHERE id=$1`, [id, days * DAY / 1000]);
    const removals = async () => (await pool.query("SELECT object, done_at IS NOT NULL AS done FROM cloud_v2_backup_removals WHERE workspace_id=$1", [id])).rows;

    describe("removal at greatest(archive, retention's start) + 60 days", () => {
      it("clears the row's backup first, then deletes its objects, and the archived document shows no removal date after", async () => {
        await stop();
        const object = await backup();
        const stale = `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`; archives.set(stale, new Map());
        await archivedAgo(59);
        await lifecycle().tick();
        expect(archives.has(object)).toBe(true);
        await archivedAgo(61);
        await lifecycle().tick();
        expect(await columns("checkpoint_object, checkpoint_key, checkpoint_sha256")).toEqual({ checkpoint_object: null, checkpoint_key: null, checkpoint_sha256: null });
        expect(await removals()).toEqual([{ object, done: true }]);
        // Every object of the workspace went, the earlier one included; the machine is untouched.
        expect([...archives.keys()].filter(key => key.includes(id))).toEqual([]);
        expect(deletes()).not.toContain(vm);
        const document = await store.get(id, user);
        expect(document).toMatchObject({ archiveReason: "manual" });
        expect(document).not.toHaveProperty("backupRemovalAt");
      });

      it("never cuts off an open: a workspace starting keeps its backup", async () => {
        await stop();
        const object = await backup();
        await archivedAgo(61);
        await store.requestLifecycle(id, user, "start");
        expect(await store.claimBackupRemovals(10)).toEqual([]);
        expect((await columns("checkpoint_object")).checkpoint_object).toBe(object);
      });

      it("keeps an object a later stop uploaded between the claim and the prune", async () => {
        await stop();
        const object = await backup();
        await archivedAgo(61);
        expect(await store.claimBackupRemovals(10)).toMatchObject([{ workspaceId: id, object }]);
        // Opened (which un-archives it) and stopped again meanwhile: a new backup for the new stop.
        await pool.query("UPDATE cloud_v2_workspaces SET archived_at=NULL, archive_reason=NULL WHERE id=$1", [id]);
        const later = await backup();
        await lifecycle().tick();
        expect(archives.has(object)).toBe(false);
        expect(archives.has(later)).toBe(true);
        expect((await columns("checkpoint_object")).checkpoint_object).toBe(later);
      });

      it("never backs up that archived stop again", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await backup();
        await archivedAgo(61);
        await lifecycle().tick();
        expect((await columns("checkpoint_object")).checkpoint_object).toBeNull();
        const forksBefore = boat.calls.filter(call => call.op === "fork").length;
        for (let run = 0; run < 3; run++) await lifecycle().tick();
        expect(boat.calls.filter(call => call.op === "fork").length).toBe(forksBefore);
      });

      it("after removal, opens from GitHub with the lost-work note when the stop's work was only in the backup", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await backup();
        await archivedAgo(61);
        await lifecycle().tick();
        boat.machine(vm)!.expired = true;
        await store.requestLifecycle(id, user, "start");
        for (let step = 0; step < 4 && (await columns("boat_sandbox_id")).boat_sandbox_id === vm; step++) {
          await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
          await lifecycle().tick();
        }
        expect((await columns("boat_sandbox_id")).boat_sandbox_id).not.toBe(vm);
        expect((await store.get(id, user)).lostWork).toMatchObject({ restored: "none" });
      });
    });

    /** As S3's whileRowHeld, for any row: `lock` takes it FOR UPDATE on another connection, kept until `statement`
     * resolves; the answer says whether it resolved while the lock was still held (ordering, not duration). */
    const whileHeld = async (lock: [string, unknown[]], statement: () => Promise<unknown>): Promise<"resolved while held" | "waited for the lock"> => {
      const holder = await pool.connect();
      let held = true;
      try {
        await holder.query("BEGIN"); await holder.query(lock[0], lock[1]);
        const resolved = statement().then(() => held ? "resolved while held" as const : "waited for the lock" as const);
        const outcome = await Promise.race([resolved, new Promise<"waited for the lock">(resolve => setTimeout(() => resolve("waited for the lock"), 25_000))]);
        held = false;
        await holder.query("ROLLBACK");
        await resolved;
        return outcome;
      } finally { if (held) await holder.query("ROLLBACK").catch(() => {}); holder.release(); }
    };

    it("keeps an upload that finished after the claim, even before the row records it", async () => {
      await stop();
      const object = await backup();
      await archivedAgo(61);
      expect(await store.claimBackupRemovals(10)).toMatchObject([{ object }]);
      // The workspace was opened and stopped again; its new upload has finished, but the row does not name it yet.
      await new Promise(resolve => setTimeout(resolve, 20));
      const later = `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`;
      archives.set(later, new Map()); objectTimes.set(later, Date.now());
      await lifecycle().tick();
      expect(archives.has(object)).toBe(false);
      expect(archives.has(later)).toBe(true);
    }, 30_000);

    describe("never waits for a row another transaction holds", () => {
      it("a member's removal with one of their personal projects' secret rows held: the lane finishes it", async () => {
        const leaver = randomUUID(), project = randomUUID();
        await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'L')", [leaver, `l-${leaver}@example.test`]);
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
        await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,'Mine','personal',$3,$3)", [project, org, leaver]);
        await pool.query("INSERT INTO cloud_v2_ready_copy_secrets (project_id, org_id, envelope, names) VALUES ($1,$2,'{}','{TOKEN}')", [project, org]);
        expect(await whileHeld(["SELECT 1 FROM cloud_v2_ready_copy_secrets WHERE project_id=$1 FOR UPDATE", [project]],
          () => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]))).toBe("resolved while held");
        // Skipped while held; the lane's sweep deletes them.
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copy_secrets WHERE project_id=$1", [project])).rows[0].n).toBe(1);
        await lifecycle({ retention: false }).tick();
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copy_secrets WHERE project_id=$1", [project])).rows[0].n).toBe(0);
      }, 30_000);

      it("a connection's removal with a copy row held: the lane retires it from the record", async () => {
        const installation = randomUUID(), project = randomUUID(), copy = randomUUID();
        await pool.query("INSERT INTO cloud_github_installations (id, org_id, account_login, level) VALUES ($1,$2,'held-acme','organization')", [installation, org]);
        await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, created_by) VALUES ($1,$2,'Held','organization',$3)", [project, org, user]);
        await pool.query("INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id, connection) VALUES ($1,0,'acme/app','42',$2)", [project, installation]);
        await pool.query("INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, machine_id) VALUES ($1,$2,$3,1,'ready',$4,'bx_held')", [copy, org, project, `k-${copy}`]);
        expect(await whileHeld(["SELECT 1 FROM cloud_v2_ready_copies WHERE id=$1 FOR UPDATE", [copy]],
          () => pool.query("DELETE FROM cloud_github_installations WHERE id=$1", [installation]))).toBe("resolved while held");
        expect((await pool.query("SELECT state FROM cloud_v2_ready_copies WHERE id=$1", [copy])).rows[0].state).toBe("ready");
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_disconnected_projects WHERE project_id=$1", [project])).rows[0].n).toBe(1);
        await lifecycle({ retention: false }).tick();
        expect((await pool.query("SELECT state FROM cloud_v2_ready_copies WHERE id=$1", [copy])).rows[0].state).toBe("retired");
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_disconnected_projects WHERE project_id=$1", [project])).rows[0].n).toBe(0);
      }, 30_000);
    });

    it("a connection's removal whose copy retire fails still records the project, and the lane retires it", async () => {
      const installation = randomUUID(), project = randomUUID(), copy = randomUUID();
      await pool.query("INSERT INTO cloud_github_installations (id, org_id, account_login, level) VALUES ($1,$2,'failing-acme','organization')", [installation, org]);
      await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, created_by) VALUES ($1,$2,'Failing','organization',$3)", [project, org, user]);
      await pool.query("INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id, connection) VALUES ($1,0,'acme/app','42',$2)", [project, installation]);
      await pool.query("INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, machine_id) VALUES ($1,$2,$3,1,'ready',$4,'bx_failing')", [copy, org, project, `k-${copy}`]);
      // The trigger's retire fails (any error inside its UPDATE); the removal itself must still succeed.
      await pool.query(`CREATE FUNCTION pg_temp_fail_copy_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'copy update refused'; END $$`);
      await pool.query("CREATE TRIGGER zz_fail_copy_update BEFORE UPDATE ON cloud_v2_ready_copies FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_copy_update()");
      try {
        await pool.query("DELETE FROM cloud_github_installations WHERE id=$1", [installation]);
        expect((await pool.query("SELECT state FROM cloud_v2_ready_copies WHERE id=$1", [copy])).rows[0].state).toBe("ready");
        // The record the lane needs survives the failed retire.
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_disconnected_projects WHERE project_id=$1", [project])).rows[0].n).toBe(1);
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS zz_fail_copy_update ON cloud_v2_ready_copies");
        await pool.query("DROP FUNCTION IF EXISTS pg_temp_fail_copy_update()");
      }
      await lifecycle({ retention: false }).tick();
      expect((await pool.query("SELECT state FROM cloud_v2_ready_copies WHERE id=$1", [copy])).rows[0].state).toBe("retired");
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_disconnected_projects WHERE project_id=$1", [project])).rows[0].n).toBe(0);
    }, 30_000);

    describe("restores: what opening an archived workspace brings back, as the open does", () => {
      /** Archive, then let one wake run: it records Boat's answer (the machine there, or gone). */
      const archiveAndWake = async (expired: boolean) => {
        await store.requestLifecycle(id, user, "archive");
        await pool.query(`UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - interval '12 days 1 hour', archived_at=archived_at - interval '12 days',
          retention_started_at=retention_started_at - interval '13 days' WHERE id=$1`, [id]);
        if (expired) boat.machine(vm)!.expired = true;
        await lifecycle().tick();
      };
      const open = async () => {
        await store.requestLifecycle(id, user, "start");
        for (let step = 0; step < 4; step++) {
          await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
          await lifecycle().tick();
        }
        return { machine: (await columns("boat_sandbox_id")).boat_sandbox_id as string, document: await store.get(id, user) };
      };

      it("all, and the open resumes the same machine: its machine is still there", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await store.requestLifecycle(id, user, "archive");
        expect((await store.get(id, user)).restores).toBe("all");
        const opened = await open();
        expect(opened.machine).toBe(vm);
        expect(opened.document).not.toHaveProperty("lostWork");
      }, 30_000);

      it("all, and the open restores the backup: a backup of this very stop holds everything", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await backup();
        await archiveAndWake(true);
        expect(await columns("machine_gone_at IS NOT NULL AS gone")).toEqual({ gone: true });
        expect((await store.get(id, user)).restores).toBe("all");
        const opened = await open();
        expect(opened.machine).not.toBe(vm);
        expect(boat.machine(opened.machine)!.files.get(`${path("app")}/UNPUSHED`)).toBe("only in the backup");
        expect(opened.document).not.toHaveProperty("lostWork");
      }, 30_000);

      it("all, and the open rebuilds with nothing lost: the stop left nothing off GitHub", async () => {
        await stop();
        await archiveAndWake(true);
        expect((await store.get(id, user)).restores).toBe("all");
        const opened = await open();
        expect(opened.machine).not.toBe(vm);
        expect(opened.document).not.toHaveProperty("lostWork");
      }, 30_000);

      it("pushed, and the open rebuilds with the lost-work note: unpushed work was only on the machine, which is gone", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await archiveAndWake(true);
        expect((await store.get(id, user)).restores).toBe("pushed");
        const opened = await open();
        expect(opened.machine).not.toBe(vm);
        expect(opened.document.lostWork).toMatchObject({ restored: "none" });
      }, 30_000);

      it("pushed with only an earlier stop's backup, which lacks this stop's work; no field with the switch off", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work");
        await stop();
        await backup();
        await pool.query("UPDATE cloud_v2_workspaces SET checkpoint_stop_generation=stop_generation - 1 WHERE id=$1", [id]);
        await archiveAndWake(true);
        expect((await store.get(id, user)).restores).toBe("pushed");
        setCloudV2RetentionDocuments(false);
        expect(await store.get(id, user)).not.toHaveProperty("restores");
        setCloudV2RetentionDocuments(true);
      }, 30_000);
    });

    describe("a departed member's personal project", () => {
      async function personal(owner: string) {
        const project = randomUUID();
        await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,'Mine','personal',$3,$3)", [project, org, owner]);
        await pool.query("INSERT INTO cloud_v2_ready_copy_secrets (project_id, org_id, envelope, names) VALUES ($1,$2,'{}','{TOKEN}')", [project, org]);
        await pool.query("UPDATE cloud_v2_workspaces SET project_id=$2 WHERE id=$1", [id, project]);
        return project;
      }
      const projectRow = async (project: string) => (await pool.query("SELECT owner_left_at IS NOT NULL AS left, retention_started_at IS NOT NULL AS clock FROM cloud_projects WHERE id=$1", [project])).rows[0];
      const secrets = async (project: string) => Number((await pool.query("SELECT count(*) AS n FROM cloud_v2_ready_copy_secrets WHERE project_id=$1", [project])).rows[0].n);

      it("loses its build secrets at once, waits for the member, and is deleted 60 days after retention first sees it", async () => {
        const leaver = randomUUID();
        await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'L')", [leaver, `l-${leaver}@example.test`]);
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
        const project = await personal(leaver);
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
        expect(await secrets(project)).toBe(0);
        expect(await projectRow(project)).toEqual({ left: true, clock: false });
        // Theirs again when re-added: the stamp goes; the secrets must be entered again.
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
        expect(await projectRow(project)).toEqual({ left: false, clock: false });
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
        // Retention's clock starts at its first look; 59 days after, the project is still there; 61, gone.
        await lifecycle().tick();
        expect(await projectRow(project)).toEqual({ left: true, clock: true });
        await pool.query("UPDATE cloud_projects SET owner_left_at=owner_left_at - interval '59 days', retention_started_at=retention_started_at - interval '59 days' WHERE id=$1", [project]);
        await lifecycle().tick();
        expect(await projectRow(project)).toBeDefined();
        await pool.query("UPDATE cloud_projects SET owner_left_at=owner_left_at - interval '2 days', retention_started_at=retention_started_at - interval '2 days' WHERE id=$1", [project]);
        await lifecycle().tick();
        expect(await projectRow(project)).toBeUndefined();
        expect((await columns("project_id")).project_id).toBeNull();
      });

      it("never starts the 60 days with retention off", async () => {
        const leaver = randomUUID();
        await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'L')", [leaver, `l-${leaver}@example.test`]);
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [org, leaver]);
        const project = await personal(leaver);
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, leaver]);
        await pool.query("UPDATE cloud_projects SET owner_left_at=owner_left_at - interval '90 days' WHERE id=$1", [project]);
        await lifecycle({ retention: false }).tick();
        expect(await projectRow(project)).toEqual({ left: true, clock: false });
        // Switched on: the clock starts now, never from the 90 days before.
        await lifecycle().tick();
        expect(await projectRow(project)).toEqual({ left: true, clock: true });
      });
    });

    describe("account deletion", () => {
      async function privateWorkspaceOf(owner: string, mode: "legacy" | "active") {
        await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [org, owner]);
        const other = randomUUID();
        await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, private_owner_user_id, name, repository, branch, base_branch, state, execution_mode)
          VALUES ($1,$2,$3,$3,'p','acme/app','zeros/p','main','stopped',$4)`, [other, org, owner, mode]);
        return other;
      }
      for (const ownership of [false, true]) it(`deletes the account's private workspaces, with team ownership ${ownership ? "on" : "off"}, and never another member's organization workspace`, async () => {
        const leaver = randomUUID();
        await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'L')", [leaver, `l-${leaver}@example.test`]);
        const mine = await privateWorkspaceOf(leaver, ownership ? "active" : "legacy");
        await withSystemTx(pool, async tx => {
          if (ownership) await tx.query("SELECT set_config('app.cloud_team_ownership','1',true)");
          await scheduleCloudDeletion(tx, { userId: leaver });
        });
        expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [mine])).rows[0].state).toBe("deleting");
        // The organization's own workspace, created by someone else and used by the leaver, is untouched.
        expect((await columns("state")).state).not.toBe("deleting");
      });

      it("deletes the account's personal projects, their secrets and copies, and its personal connections", async () => {
        const leaver = randomUUID(), project = randomUUID(), copy = randomUUID(), installation = randomUUID();
        await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'L')", [leaver, `l-${leaver}@example.test`]);
        await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,'Mine','personal',$3,$3)", [project, org, leaver]);
        await pool.query("INSERT INTO cloud_v2_ready_copy_secrets (project_id, org_id, envelope, names) VALUES ($1,$2,'{}','{TOKEN}')", [project, org]);
        await pool.query("INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, machine_id) VALUES ($1,$2,$3,1,'ready',$4,'bx_copy')", [copy, org, project, `k-${copy}`]);
        await pool.query("INSERT INTO cloud_github_installations (id, org_id, account_login, level, owner_user_id) VALUES ($1,$2,'leaver','personal',$3)", [installation, org, leaver]);
        await withSystemTx(pool, tx => scheduleCloudDeletion(tx, { userId: leaver }));
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_projects WHERE id=$1", [project])).rows[0].n).toBe(0);
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copy_secrets WHERE project_id=$1", [project])).rows[0].n).toBe(0);
        expect((await pool.query("SELECT state FROM cloud_v2_ready_copies WHERE id=$1", [copy])).rows[0].state).toBe("retired");
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_github_installations WHERE id=$1", [installation])).rows[0].n).toBe(0);
      });

      it("keeps an organization until every ready copy's machine is confirmed deleted", async () => {
        const project = randomUUID(), copy = randomUUID();
        await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, created_by) VALUES ($1,$2,'Shared','organization',$3)", [project, org, user]);
        await pool.query("INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, machine_id) VALUES ($1,$2,$3,1,'retired',$4,'bx_copy2')", [copy, org, project, `k-${copy}`]);
        await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE org_id=$1", [org]);
        // Every Cloud Computer resource is confirmed deleted; only the copy's machine is left.
        await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id=NULL, snapshot_deleted_at=clock_timestamp() WHERE org_id=$1", [org]);
        await expect(withSystemTx(pool, tx => assertOrganizationCloudPurgeReady(tx, org))).rejects.toThrow("organization_cloud_copy_deletion_not_verified");
        await pool.query("UPDATE cloud_v2_ready_copies SET machine_deleted_at=clock_timestamp() WHERE id=$1", [copy]);
        await expect(withSystemTx(pool, tx => assertOrganizationCloudPurgeReady(tx, org))).resolves.toBeUndefined();
      });
    });

    describe("a GitHub connection removed", () => {
      it("retires the copies built through it, deleted or uninstalled; the next workspace opened queues a new one", async () => {
        const copies = new CloudV2ReadyCopies(pool);
        const make = async () => {
          const installation = randomUUID(), project = randomUUID(), copy = randomUUID();
          await pool.query("INSERT INTO cloud_github_installations (id, org_id, account_login, level) VALUES ($1,$2,$3,'organization')", [installation, org, `acme-${installation.slice(0, 6)}`]);
          await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, created_by) VALUES ($1,$2,$3,'organization',$4)", [project, org, `P-${project.slice(0, 6)}`, user]);
          await pool.query("INSERT INTO cloud_project_repositories (project_id, position, repository, repository_id, connection) VALUES ($1,0,'acme/app','42',$2)", [project, installation]);
          await pool.query("INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, machine_id) VALUES ($1,$2,$3,1,'ready',$4,$5)",
            [copy, org, project, `k-${copy}`, `bx_${copy.slice(0, 8)}`]);
          return { installation, project, copy };
        };
        const state = async (copy: string) => (await pool.query("SELECT state FROM cloud_v2_ready_copies WHERE id=$1", [copy])).rows[0].state;
        const removed = await make(), uninstalled = await make(), untouched = await make();
        await pool.query("DELETE FROM cloud_github_installations WHERE id=$1", [removed.installation]);
        expect(await state(removed.copy)).toBe("retired");
        await pool.query("UPDATE cloud_github_installations SET state='uninstalled' WHERE id=$1", [uninstalled.installation]);
        await copies.retireUnavailable();
        expect(await state(uninstalled.copy)).toBe("retired");
        expect(await state(untouched.copy)).toBe("ready");
        // The project page shows no ready copy now; the next fork request may queue one.
        expect(await copies.mayQueueFirst(removed.project, new Date())).toBe(true);
        expect(await copies.mayQueueFirst(untouched.project, new Date())).toBe(false);
      });
    });

    describe("alerts", () => {
      it("alerts a missed wake once per stop, and again after a new stop", async () => {
        await stop();
        // No wake can run: the maintenance budget is spent.
        await pool.query("UPDATE cloud_v2_workspaces SET stopped_at=stopped_at - interval '12 days 1 hour', retention_started_at=retention_started_at - interval '13 days' WHERE id=$1", [id]);
        const alerts = () => errors.filter(line => line.startsWith("[cloud-v2] missed maintenance wake:"));
        await lifecycle({ maintenancePerDay: 1, maintenancePerHour: 1 }).tick();
        // (The wake itself may run once; block any more and re-age the stop.)
        await pool.query("UPDATE cloud_v2_workspaces SET machine_stopped_at=NULL, stopped_at=clock_timestamp() - interval '12 days 1 hour', missed_wake_alerted_at=NULL WHERE id=$1", [id]);
        await pool.query("INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind) SELECT $1, gen_random_uuid(), 'backup_fork' FROM generate_series(1, 5)", [id]);
        errors.length = 0;
        await lifecycle({ maintenancePerDay: 1, maintenancePerHour: 1 }).tick();
        expect(alerts()).toHaveLength(1);
        await lifecycle({ maintenancePerDay: 1, maintenancePerHour: 1 }).tick();
        expect(alerts()).toHaveLength(1);
        // A new stop, 12 days old in turn: alerted again.
        await pool.query("UPDATE cloud_v2_workspaces SET stopped_at=clock_timestamp() - interval '12 days 1 hour', missed_wake_alerted_at=clock_timestamp() - interval '13 days' WHERE id=$1", [id]);
        await lifecycle({ maintenancePerDay: 1, maintenancePerHour: 1 }).tick();
        expect(alerts()).toHaveLength(2);
      });
    });

    describe("the orphan sweep", () => {
      it("prunes only a prefix whose workspace was deleted 7 days ago; keeps and reports one with no row; skips a non-id", async () => {
        const old = randomUUID(), recent = randomUUID(), missing = randomUUID();
        for (const [workspace, days] of [[old, 8], [recent, 2]] as const) {
          await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, updated_at)
            VALUES ($1,$2,$3,'d','acme/app','zeros/d','main','deleted', clock_timestamp() - make_interval(days => $4))`, [workspace, org, user, days]);
        }
        for (const workspace of [old, recent, missing]) archives.set(`cloud-v2/checkpoints/${workspace}/${randomUUID()}.zck`, new Map());
        extraPrefixes.add("not-a-workspace");
        await lifecycle().tick();
        const kept = (workspace: string) => [...archives.keys()].some(key => key.includes(workspace));
        expect([kept(old), kept(recent), kept(missing)]).toEqual([false, true, true]);
        const report = errors.find(line => line.startsWith("[cloud-v2] backup objects with no workspace row:"))!;
        expect(report).toContain(missing);
        expect(report).toMatch(/1 prefix\(es\), kept .* 1 prefix\(es\) not a workspace id, skipped/);
      });

      it("refuses to run at all while the listing has prefixes but no workspace row exists", async () => {
        const lone = randomUUID();
        archives.set(`cloud-v2/checkpoints/${lone}/${randomUUID()}.zck`, new Map());
        await pool.query("DELETE FROM cloud_v2_workspaces");
        await lifecycle().tick();
        expect([...archives.keys()].some(key => key.includes(lone))).toBe(true);
        expect(errors.some(line => line.startsWith("[cloud-v2] backup orphan sweep refused:"))).toBe(true);
      });
    });

    describe("end to end, on a controlled clock", () => {
      /** Time passes: every clock of the workspace and of its wake records moves `days` into the past. */
      const travel = async (days: number) => {
        const secs = days * DAY / 1000;
        await pool.query(`UPDATE cloud_v2_workspaces SET
            stopped_at=stopped_at - make_interval(secs => $2), machine_stopped_at=machine_stopped_at - make_interval(secs => $2),
            active_at=active_at - make_interval(secs => $2), person_activity_at=person_activity_at - make_interval(secs => $2),
            retention_started_at=retention_started_at - make_interval(secs => $2), archived_at=archived_at - make_interval(secs => $2),
            archive_wake_done_at=archive_wake_done_at - make_interval(secs => $2), backup_forked_at=backup_forked_at - make_interval(secs => $2),
            checkpoint_saved_at=checkpoint_saved_at - make_interval(secs => $2), keep_set_at=keep_set_at - make_interval(secs => $2),
            checkpoint_retry_at=checkpoint_retry_at - make_interval(secs => $2), archive_scrubbed_at=archive_scrubbed_at - make_interval(secs => $2),
            missed_wake_alerted_at=missed_wake_alerted_at - make_interval(secs => $2), next_attempt_at=NULL
          WHERE id=$1`, [id, secs]);
        await pool.query("UPDATE cloud_v2_maintenance_wakes SET started_at=started_at - make_interval(secs => $2), finished_at=finished_at - make_interval(secs => $2) WHERE workspace_id=$1", [id, secs]);
      };
      const wakes = async () => (await pool.query("SELECT outcome, scrub FROM cloud_v2_maintenance_wakes WHERE workspace_id=$1 AND kind='wake' ORDER BY started_at", [id])).rows;
      const document = () => store.get(id, user);

      it("stop, backup at an hour, wakes at 10 and 20 days, archive at 30, the archived wake, machine gone, backup removed, open from GitHub", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work only on the machine");
        await stop();
        expect(await document()).toMatchObject({ state: "stopped", archivedAt: null, keep: false });
        await travel(1 / 24 + 0.01);
        await lifecycle().tick();
        expect(boat.calls.filter(call => call.op === "fork" && call.args[0] === vm)).toHaveLength(1);
        expect((await columns("checkpoint_object")).checkpoint_object).not.toBeNull();
        for (const day of [10, 20]) {
          await travel(10.6);
          await lifecycle().tick();
          expect((await wakes()).length, `wake at ${day} days`).toBe(day / 10);
          expect(await document()).toMatchObject({ state: "stopped", archivedAt: null });
        }
        // 30 days without activity: archived, with its reason and both dates; the stop's backup is final.
        await travel(9);
        await lifecycle().tick();
        await lifecycle().tick();
        const archived = await document();
        expect(archived).toMatchObject({ state: "stopped", archiveReason: "inactive", keep: false, machineExpectedGoneAt: { estimate: true } });
        expect(archived.backupRemovalAt).toEqual(expect.any(String));
        expect(boat.calls.filter(call => call.op === "fork" && call.args[0] === vm)).toHaveLength(1);
        // The one archived wake, with its scrub; then none.
        await travel(10.6);
        await lifecycle().tick();
        expect((await wakes()).at(-1)).toMatchObject({ outcome: "stopped", scrub: expect.any(String) });
        const after = (await wakes()).length;
        await travel(11);
        await lifecycle().tick();
        expect(await wakes()).toHaveLength(after);
        // Boat removes the machine; 60 days after the archive the backup goes.
        boat.machine(vm)!.expired = true;
        await travel(40);
        await lifecycle().tick();
        expect((await columns("checkpoint_object")).checkpoint_object).toBeNull();
        const removed = await document();
        expect(removed).toMatchObject({ archiveReason: "inactive" });
        expect(removed).not.toHaveProperty("backupRemovalAt");
        // Opened: rebuilt from GitHub, with the note that the stop's work did not come back.
        await store.requestLifecycle(id, user, "start");
        for (let step = 0; step < 4 && (await columns("boat_sandbox_id")).boat_sandbox_id === vm; step++) {
          await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [id]);
          await lifecycle().tick();
        }
        expect(await document()).toMatchObject({ archivedAt: null, lostWork: { restored: "none" } });
      }, 60_000);

      it("with Keep set while in use, nothing is archived: the wakes go on and the backup stays", async () => {
        boat.write(vm, `${path("app")}/UNPUSHED`, "work only on the machine");
        await stop();
        expect((await store.setKeep(id, user, true)).keep).toBe(true);
        await travel(1 / 24 + 0.01);
        await lifecycle().tick();
        for (let day = 10; day <= 90; day += 10) {
          await travel(10.6);
          await lifecycle().tick();
          await lifecycle().tick();
          expect(await document(), `at ${day} days`).toMatchObject({ archivedAt: null, keep: true });
        }
        expect((await wakes()).length).toBeGreaterThanOrEqual(8);
        expect((await columns("checkpoint_object")).checkpoint_object).not.toBeNull();
      }, 60_000);
    });
  });

  it("restores a pre-switch workspace's backup onto a base: its files and unpushed commit, its own checkout path and original setup", async () => {
    // Before the switch: a Cloud Computer that installs acme/app with its setup, and the workspace made from it, laid out as then.
    const pre = randomUUID(), checkout = `${HOME}/acme/app`;
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_policy_version, snapshot_id, source_targets)
      VALUES ($1,$2,2,$3,'succeeded',$4,3,'zeros-pre',$5)`, [pre, org, JSON.stringify({ repositories: [{ repository: "acme/app", setup: "pnpm install",
        branch: "main", commit: "c".repeat(40) }] }), user, JSON.stringify([{ repository: "acme/app", repositoryId: "42" }])]);
    await pool.query("UPDATE cloud_v2_computers SET active_build_id=$2, snapshot_name='zeros-pre' WHERE org_id=$1", [org, pre]);
    await pool.query("DELETE FROM cloud_v2_workspace_repositories WHERE workspace_id=$1 AND position>0", [id]);
    await pool.query("UPDATE cloud_v2_workspace_repositories SET folder=NULL WHERE workspace_id=$1", [id]);
    await pool.query("UPDATE cloud_v2_workspaces SET computer_build_id=$2, checkout_path=NULL, folder=NULL WHERE id=$1", [id, pre]);
    checkouts = [checkout]; keepRefs = true;
    const single = { repositories: async () => [] };
    boat.write(vm, `${checkout}/UNPUSHED`, "app work");
    boat.write(vm, `${checkout}/.git/refs/heads/zeros/w`, "unpushed commit");
    await store.transition(id, ["running"], "stopping");
    await lifecycle(single).tick();
    await earlier(CLOUD_V2_BACKUP_DELAY_MS + 60_000);
    await lifecycle(single).tick();
    const saved = await row();
    expect([...archives.get(saved.checkpoint_object)!.keys()].sort()).toEqual([`${checkout}/.git/refs/heads/zeros/w`, `${checkout}/UNPUSHED`]);
    // The switch: the organization's live build is now a base, with no repository; the pre-switch build is its legacy build.
    const base = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_policy_version, snapshot_id, source_targets, base_only, automatic)
      VALUES ($1,$2,3,'{"repositories":[]}','succeeded',NULL,2,'zeros-base-2','[]',true,true)`, [base, org]);
    await pool.query("UPDATE cloud_v2_computers SET active_build_id=$2, snapshot_name='zeros-base-2', legacy_build_id=$3, base_live_at=clock_timestamp() WHERE org_id=$1", [org, base, pre]);
    // Boat loses the machine; opening it restores onto the base.
    boat.machine(vm)!.state = "deleted";
    await store.transition(id, ["stopped"], "starting");
    await lifecycle({ ...single, restoreSource: async () => null }).tick();
    const restored = (await pool.query(`SELECT boat_sandbox_id, computer_build_id, restore_pending, restore_create->>'setupBuildId' AS setup_build, checkout_path
      FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
    expect(restored).toMatchObject({ computer_build_id: base, restore_pending: false, setup_build: pre, checkout_path: null });
    const replacement = boat.machine(restored.boat_sandbox_id)!;
    expect(replacement.files.get(`${checkout}/UNPUSHED`)).toBe("app work");
    expect(replacement.files.get(`${checkout}/.git/refs/heads/zeros/w`)).toBe("unpushed commit");
    // Made from the base (a restore's machine is named for its attempt).
    expect(boat.calls.filter(call => call.op === "create" && (call.args[0] as { key: string }).key.startsWith(`restore:${id}:`))
      .map(call => (call.args[0] as { from?: string }).from)).toEqual(["zeros-base-2"]);
    expect(boat.commands.filter(command => command.machineId === replacement.id).some(command => command.command.includes(checkout))).toBe(true);
    // Its setup is still read from the pre-switch build (whose recipe runs pnpm install in acme/app), not the base's.
    expect(await workspaceSetupBuild(pool, await store.get(id, user))).toEqual({ setupBuildId: pre });
  });
});