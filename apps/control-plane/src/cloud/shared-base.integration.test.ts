import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import { buildSharedBase, CloudV2SharedBases, installBase, sharedBaseState } from "./shared-base.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const sha256 = "1a2b3c4d5e6f".padEnd(64, "0"), other = "9f8e7d6c5b4a".padEnd(64, "0");
const runtime = { sha256, url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" };
const NAME = "zeros-alpha-base-1a2b3c4d5e6f";
const repositoryId = (repository: string) => BigInt(`0x${createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12)}`).toString();
const resolveRepository: CloudV2ComputerSourceResolver = async (_org, _user, target) => ({
  repository: target.repository, repositoryId: target.repositoryId ?? repositoryId(target.repository),
});

d("cloud v2 shared base builds", () => {
  let pool: pg.Pool, bases: CloudV2SharedBases, boat: FakeBoat;
  const lines: string[] = [];
  const logger = { warn: (line: string) => { lines.push(line); }, info: (line: string) => { lines.push(line); } };
  const deps = () => ({ bases, compute: boat, logger });
  const execute = (extra: { runtime?: typeof runtime; now?: Date } = {}) =>
    buildSharedBase(deps(), { channel: "alpha", runtime, mode: "execute", ...extra });

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    bases = new CloudV2SharedBases(pool);
    boat = new FakeBoat();
    lines.length = 0;
  });

  it("plans without creating anything", async () => {
    const plan = await buildSharedBase(deps(), { channel: "alpha", runtime, mode: "plan" });
    expect(plan).toMatchObject({ code: "shared_base_planned", name: NAME, runtime12: "1a2b3c4d5e6f", exists: false });
    expect(plan.steps?.length).toBeGreaterThan(0);
    expect(boat.calls.map(call => call.op)).toEqual(["snapshotExists"]);
    expect(await bases.rows({ channel: "alpha" })).toEqual([]);
  });

  it("records the name before the save, builds on one builder from the stock image and deletes it, then reads the snapshot back", async () => {
    const save = vi.spyOn(boat, "saveSnapshot").mockImplementation(async function (this: FakeBoat, sandboxId: string, name: string) {
      // Recorded before Boat is asked to save.
      expect(await bases.row(name)).toMatchObject({ state: "building", save_requested_at: expect.any(Date) });
      return FakeBoat.prototype.saveSnapshot.call(boat, sandboxId, name);
    });
    expect(await execute()).toEqual({ code: "shared_base_ready", name: NAME, runtime12: "1a2b3c4d5e6f" });
    expect(save).toHaveBeenCalledOnce();
    const creates = boat.calls.filter(call => call.op === "create");
    expect(creates).toHaveLength(1);
    const input = creates[0]!.args[0] as { from?: string; env: Record<string, string>; name: string };
    expect(input.from).toBeUndefined();
    expect(input.name).toMatch(/^zeros-alpha-build-[0-9a-f]{8}$/);
    const builder = [...boat.machines.values()][0]!;
    expect(builder.state).toBe("deleted");
    expect(boat.calls.map(call => call.op).filter(op => op !== "create")).toEqual(["saveSnapshot", "snapshotExists", "delete"]);
    expect(boat.snapshots.has(NAME)).toBe(true);
    expect(await bases.row(NAME)).toMatchObject({ state: "ready", ready_at: expect.any(Date), builder_deleted_at: expect.any(Date),
      builder_sandbox_id: builder.id, failures: 0, rebuild: 0 });
    expect(lines).toEqual([`[cloud-v2] shared base ready channel=alpha runtime=1a2b3c4d5e6f name=${NAME}`]);
    // One per runtime: the next run finds it.
    expect(await execute()).toMatchObject({ code: "shared_base_exists", name: NAME });
    expect(boat.calls.filter(call => call.op === "create")).toHaveLength(1);
  });

  it("gives the builder an empty environment and nothing private: no token, no source, no install script", async () => {
    // buildSharedBase takes no token source at all (SharedBaseBuildDeps); what reaches the machine is checked here.
    await execute();
    const [input] = boat.calls.find(call => call.op === "create")!.args as [{ env: Record<string, string> }];
    expect(input.env).toEqual({});
    expect(boat.commands.every(command => command.input === undefined)).toBe(true);
    const text = boat.commands.map(command => command.command).join("\n");
    for (const forbidden of ["x-access-token", "Authorization", "ZEROS_GITHUB_AUTH_HEADER", "git clone", "github.com", "cd /home/user"])
      expect(text).not.toContain(forbidden);
    expect(boat.commands.filter(command => command.command.startsWith("bash -lc"))).toEqual([]);
  });

  it("issues exactly the commands a Cloud Computer base without an install script issues today", async () => {
    const admin = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [admin, `u-${admin}@example.test`]);
    await grantTestPro(pool, admin);
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)",
      [org, `org-${org}`, admin]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org, admin]);
    const computers = new CloudV2Computers(pool, pool, resolveRepository, resolveRepository, { readyCopies: true });
    await computers.enqueue(org, admin, { repositories: [] }, { configure: true });
    const computerBoat = new FakeBoat();
    await new CloudV2ComputerBuilder({ computers, compute: computerBoat, channel: "alpha", runtime, cloneToken: async () => { throw new Error("no token"); } }).tick();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "succeeded" });
    const upToSync = (fake: FakeBoat) => {
      const commands = fake.commands.map(command => command.command);
      return commands.slice(0, commands.indexOf("sync"));
    };
    await execute();
    expect(upToSync(boat)).toEqual(upToSync(computerBoat));
    expect(upToSync(boat)).toHaveLength(2);
    // And installBase is the definition both follow.
    const direct = new FakeBoat(), { sandboxId } = await direct.create({ key: "k", name: "b", env: {} });
    await installBase(direct, sandboxId, { runtime: { sha256, url: await runtime.url() } }, { log: async () => {}, assertHeld: () => {} });
    expect(direct.commands.map(command => command.command)).toEqual(upToSync(computerBoat));
  });

  it("fails with a closed code, keeps the earlier base, deletes the builder and backs off 15 minutes, doubling", async () => {
    expect(await execute({ runtime: { ...runtime, sha256: other } })).toMatchObject({ code: "shared_base_ready" });
    const earlier = "zeros-alpha-base-9f8e7d6c5b4a";
    boat.script = (_machine, command) => command.includes(sha256) ? { exitCode: 1, stdout: "", timedOut: false } : undefined;
    const failed = await execute();
    expect(failed).toMatchObject({ code: "worker_runtime_install_failed", name: NAME, nextAttemptAt: expect.any(String) });
    const row = (await bases.row(NAME))!;
    expect(row).toMatchObject({ state: "failed", error_code: "worker_runtime_install_failed", failures: 1, builder_deleted_at: expect.any(Date) });
    expect(row.next_attempt_at!.getTime() - row.finished_at!.getTime()).toBeCloseTo(15 * 60_000, -3);
    expect(lines).toContain("[cloud-v2] shared base build failed channel=alpha runtime=1a2b3c4d5e6f code=worker_runtime_install_failed");
    expect([...boat.machines.values()].every(machine => machine.state === "deleted")).toBe(true);
    // The earlier base still serves.
    expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: sha256 })).toMatchObject({ state: "ready", name: earlier });
    // Within the backoff nothing starts; after it, the next attempt takes the next name and its failure doubles the wait.
    expect(await execute()).toMatchObject({ code: "shared_base_backoff", name: NAME });
    const later = new Date(row.next_attempt_at!.getTime() + 1000);
    boat.failNextSave = "computer_snapshot_timeout";
    boat.script = null;
    expect(await execute({ now: later })).toMatchObject({ code: "computer_snapshot_timeout", name: `${NAME}-r1` });
    const second = (await bases.row(`${NAME}-r1`))!;
    expect(second).toMatchObject({ state: "failed", failures: 2, rebuild: 1 });
    expect(second.next_attempt_at!.getTime() - second.finished_at!.getTime()).toBeCloseTo(30 * 60_000, -3);
    // A save that failed may have left the name at Boat: it is deleted, read back gone, and recorded.
    expect(boat.snapshots.has(`${NAME}-r1`)).toBe(false);
    expect(second.deleted_at).toEqual(expect.any(Date));
    expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: sha256 })).toMatchObject({ state: "ready", name: earlier });
  });

  it("reports each failure by its closed code", async () => {
    const at = (minutes: number) => new Date(Date.now() + minutes * 60 * 60_000);
    boat.refuseNextCreate = true;
    expect(await execute()).toMatchObject({ code: "shared_base_builder_refused" });
    boat.failNextSave = "computer_snapshot_failed";
    expect(await execute({ now: at(7) })).toMatchObject({ code: "computer_snapshot_failed", name: `${NAME}-r1` });
    vi.spyOn(boat, "snapshotExists").mockResolvedValue(false);
    expect(await execute({ now: at(14) })).toMatchObject({ code: "shared_base_readback_failed", name: `${NAME}-r2` });
    expect((await bases.rows({ channel: "alpha" })).map(row => [row.name, row.state, row.error_code])).toEqual([
      [NAME, "failed", "shared_base_builder_refused"], [`${NAME}-r1`, "failed", "computer_snapshot_failed"],
      [`${NAME}-r2`, "failed", "shared_base_readback_failed"],
    ]);
    expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: sha256 })).toMatchObject({ state: "failed", nextAttemptAt: expect.any(String) });
  });

  it("claims nothing while the runtime build drain is held", async () => {
    await pool.query(`UPDATE cloud_runtime_build_drain SET lease_id=$1, run_id='test-run', live_cp_sha=$2, prior_runtime_sha256=$3, ttl_ms=60000,
      expires_at=clock_timestamp()+interval '1 minute', ended_at=NULL WHERE singleton`, [randomUUID(), "a".repeat(40), "b".repeat(64)]);
    expect(await execute()).toMatchObject({ code: "shared_base_drain_held", name: null });
    expect(boat.calls).toEqual([]);
    expect(await bases.rows({ channel: "alpha" })).toEqual([]);
    await pool.query("UPDATE cloud_runtime_build_drain SET ended_at=clock_timestamp() WHERE singleton");
    expect(await execute()).toMatchObject({ code: "shared_base_ready" });
  });

  it("builds one at a time per runtime, and fails a build whose process stopped beating", async () => {
    const claim = await bases.claim({ channel: "alpha" }, sha256);
    expect(claim).toMatchObject({ kind: "claimed" });
    expect(await execute()).toMatchObject({ code: "shared_base_building", name: NAME });
    await pool.query("UPDATE cloud_v2_shared_bases SET heartbeat_at = clock_timestamp() - interval '6 minutes' WHERE name = $1", [NAME]);
    expect(await execute()).toMatchObject({ code: "shared_base_backoff", name: NAME });
    expect(await bases.row(NAME)).toMatchObject({ state: "failed", error_code: "shared_base_interrupted", failures: 1 });
    // A Local database names its own.
    expect(await bases.plan({ channel: "development", localOwner: "a".repeat(24) }, sha256))
      .toMatchObject({ kind: "claimed", row: { name: `zeros-local-${"a".repeat(24)}-base-1a2b3c4d5e6f` } });
  });
});
