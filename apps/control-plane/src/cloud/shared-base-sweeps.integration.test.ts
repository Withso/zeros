import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { cloudV2SnapshotName } from "./resource-names.js";
import { checkMissingSharedBases, claimSharedBaseBuild, CloudV2SharedBases, CloudV2SharedBaseSweeper, dailySnapshotInventory,
  deleteSupersededSharedBases, repointOrganizations, sharedBaseState, type SharedBaseSweepDeps } from "./shared-base.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const A = "aaaaaaaaaaaa".padEnd(64, "1"), B = "bbbbbbbbbbbb".padEnd(64, "2"), C = "cccccccccccc".padEnd(64, "3");
const name = (sha: string, rebuild = 0) => `zeros-alpha-base-${sha.slice(0, 12)}${rebuild ? `-r${rebuild}` : ""}`;
const runtimeOf = (sha256: string) => ({ sha256, url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" });

d("cloud v2 shared base sweeps", () => {
  let pool: pg.Pool, bases: CloudV2SharedBases, boat: FakeBoat, admin: string;
  const lines: string[] = [];
  const logger = { warn: (line: string) => { lines.push(line); }, info: (line: string) => { lines.push(line); } };
  const deps = (sha256: string, extra: Partial<SharedBaseSweepDeps> = {}): SharedBaseSweepDeps => ({
    pool, bases, compute: boat, logger, scope: { channel: "alpha" }, runtime: runtimeOf(sha256), ...extra });

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    bases = new CloudV2SharedBases(pool);
    boat = new FakeBoat();
    lines.length = 0;
    admin = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [admin, `u-${admin}@example.test`]);
  });

  /** A built and ready base, as claimSharedBaseBuild leaves it. */
  async function built(sha256: string): Promise<string> {
    expect(await claimSharedBaseBuild(deps(sha256))).toMatchObject({ code: "shared_base_ready" });
    return name(sha256);
  }
  /** An organization whose live build is the shared base `base`, as activateShared writes it. */
  async function onShared(base: string): Promise<{ org: string; build: string }> {
    const org = randomUUID(), build = randomUUID();
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)",
      [org, `org-${org}`, admin]);
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, source_targets, source_policy_version,
        base_only, base_shared, snapshot_id, runtime_sha256, started_at, finished_at)
      VALUES ($1, $2, 1, '{"repositories":[]}', 'succeeded', $3, 'manual', '[]', 2, true, true, $4, $5, clock_timestamp(), clock_timestamp())`,
      [build, org, admin, `${base}@${build}`, A]);
    await pool.query("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1, $2, $3)", [org, build, `${base}@${build}`]);
    return { org, build };
  }
  const live = async (org: string) => (await pool.query<{ active_build_id: string; snapshot_name: string }>(
    "SELECT active_build_id, snapshot_name FROM cloud_v2_computers WHERE org_id = $1", [org])).rows[0]!;
  const supersededDaysAgo = (base: string, days: number) =>
    pool.query(`UPDATE cloud_v2_shared_bases SET superseded_at = clock_timestamp() - $2 * interval '1 day' WHERE name = $1`, [base, days]);

  describe("build claim", () => {
    it("builds the pinned runtime's base once, whatever ready copies say, nothing when off, and supersedes the older base", async () => {
      expect(await claimSharedBaseBuild(deps(A, { override: { kind: "off" } }))).toMatchObject({ code: "shared_base_off" });
      expect(boat.calls).toEqual([]);
      const a = await built(A);
      expect(await claimSharedBaseBuild(deps(A))).toMatchObject({ code: "shared_base_exists", name: a });
      // A pinned name still builds the runtime's own base, ready for when the pin goes.
      expect(await claimSharedBaseBuild(deps(B, { override: { kind: "name", name: "zeros-base-1" } }))).toMatchObject({ code: "shared_base_ready", name: name(B) });
      expect(boat.calls.filter(call => call.op === "create")).toHaveLength(2);
      expect(await bases.row(a)).toMatchObject({ superseded_at: expect.any(Date) });
      expect(await bases.row(name(B))).toMatchObject({ superseded_at: null });
      // A rollback makes A current again.
      await claimSharedBaseBuild(deps(A));
      expect(await bases.row(a)).toMatchObject({ superseded_at: null });
      expect(await bases.row(name(B))).toMatchObject({ superseded_at: expect.any(Date) });
    });

    it("removes a builder an interrupted build left behind, and a save it may have made", async () => {
      const claim = await bases.claim({ channel: "alpha" }, A);
      if (claim.kind !== "claimed") throw new Error("not claimed");
      const { sandboxId } = await boat.create({ key: `shared-base:${claim.row.build_id}`, name: "zeros-alpha-build-x", env: {} });
      await bases.builderCreated(claim.row.name, sandboxId);
      await bases.saveRequested(claim.row.name);
      await boat.saveSnapshot(sandboxId, claim.row.name);
      await pool.query("UPDATE cloud_v2_shared_bases SET heartbeat_at = clock_timestamp() - interval '10 minutes'");
      // An interruption (a deploy) is not a failure: what it left is removed, and the next claim builds again at once.
      expect(await claimSharedBaseBuild(deps(A))).toMatchObject({ code: "shared_base_ready", name: name(A, 1) });
      expect(boat.machine(sandboxId)?.state).toBe("deleted");
      expect(boat.snapshots.has(claim.row.name)).toBe(false);
      expect(await bases.row(claim.row.name)).toMatchObject({ state: "failed", error_code: "shared_base_interrupted", failures: 0, interruptions: 1,
        builder_deleted_at: expect.any(Date), deleted_at: expect.any(Date) });
    });

    it("retries up to three interruptions in a row at once, and backs off at the fourth", async () => {
      const interrupt = async () => {
        await pool.query("UPDATE cloud_v2_shared_bases SET heartbeat_at = clock_timestamp() - interval '10 minutes' WHERE state = 'building'");
        await bases.interrupted({ channel: "alpha" });
      };
      for (let attempt = 0; attempt < 4; attempt++) {
        expect(await bases.claim({ channel: "alpha" }, A)).toMatchObject({ kind: "claimed" });
        await interrupt();
      }
      const rows = (await pool.query<{ rebuild: number; interruptions: number; failures: number; due: boolean }>(
        "SELECT rebuild, interruptions, failures, coalesce(next_attempt_at <= clock_timestamp(), true) AS due FROM cloud_v2_shared_bases ORDER BY rebuild")).rows;
      expect(rows).toEqual([
        { rebuild: 0, interruptions: 1, failures: 0, due: true }, { rebuild: 1, interruptions: 2, failures: 0, due: true },
        { rebuild: 2, interruptions: 3, failures: 0, due: true }, { rebuild: 3, interruptions: 4, failures: 1, due: false }]);
      expect(await bases.claim({ channel: "alpha" }, A)).toMatchObject({ kind: "backoff" });
    });
  });

  describe("resolver", () => {
    it("serves the newest ready base, prefers the pinned runtime's, and reports building and backoff", async () => {
      expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: A })).toEqual({ state: "building" });
      const a = await built(A);
      expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: A })).toMatchObject({ state: "ready", name: a, source: "database" });
      // While B builds, A serves (the worker installs B at boot).
      await bases.claim({ channel: "alpha" }, B);
      expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: B })).toMatchObject({ state: "ready", name: a, runtimeSha256: A });
      expect(await sharedBaseState(bases, { channel: "alpha", runtimeSha256: B, override: { kind: "off" } })).toEqual({ state: "off" });
      // Another deployment's rows are never read.
      expect(await sharedBaseState(bases, { channel: "production", runtimeSha256: A })).toEqual({ state: "building" });
      expect(await sharedBaseState(bases, { channel: "development", localOwner: "a".repeat(24), runtimeSha256: A })).toEqual({ state: "building" });
    });
  });

  describe("re-point", () => {
    it("moves organizations on an older shared base, bounded, with reason runtime, and pinned workspaces keep the old build", async () => {
      const a = await built(A);
      const orgs = await Promise.all([1, 2, 3].map(() => onShared(a)));
      const b = await built(B);
      const workspace = randomUUID();
      await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id)
        VALUES ($1, $2, $3, 'w', 'withso/zeros', 'zeros/w', 'main', 'creating', $4)`, [workspace, orgs[0]!.org, admin, orgs[0]!.build]);
      const onRepointed = vi.fn(async (_org: string) => {});
      const first = await repointOrganizations(pool, boat, { current: { name: b, runtimeSha256: B }, limit: 2, onRepointed });
      expect(first.repointed).toHaveLength(2);
      expect(onRepointed).toHaveBeenCalledTimes(2);
      expect((await repointOrganizations(pool, boat, { current: { name: b, runtimeSha256: B }, limit: 2 })).repointed).toHaveLength(1);
      expect((await repointOrganizations(pool, boat, { current: { name: b, runtimeSha256: B } })).repointed).toEqual([]);
      for (const { org, build } of orgs) {
        const pointer = await live(org);
        expect(pointer.snapshot_name).toBe(`${b}@${pointer.active_build_id}`);
        const row = (await pool.query("SELECT * FROM cloud_v2_computer_builds WHERE id = $1", [pointer.active_build_id])).rows[0];
        expect(row).toMatchObject({ reason: "runtime", state: "succeeded", created_by: null, base_only: true, base_shared: true,
          runtime_sha256: B, base_snapshot: `${a}@${build}`, version: 2 });
        // The old build keeps its reference until ordinary cleanup clears it.
        expect((await pool.query("SELECT snapshot_id FROM cloud_v2_computer_builds WHERE id = $1", [build])).rows[0].snapshot_id).toBe(`${a}@${build}`);
      }
      expect((await pool.query("SELECT computer_build_id FROM cloud_v2_workspaces WHERE id = $1", [workspace])).rows[0].computer_build_id).toBe(orgs[0]!.build);
      // No ready copy is touched by a re-point.
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE stale")).rows[0].n).toBe(0);
    });

    it("moves nobody while a build is queued or Boat lacks the current base", async () => {
      const a = await built(A), b = await built(B);
      const { org } = await onShared(a);
      await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason) VALUES ($1, $2, 2, '{"repositories":[]}', 'queued', $3, 'manual')`,
        [randomUUID(), org, admin]);
      expect((await repointOrganizations(pool, boat, { current: { name: b, runtimeSha256: B } })).repointed).toEqual([]);
      await pool.query("DELETE FROM cloud_v2_computer_builds WHERE org_id = $1 AND state = 'queued'", [org]);
      boat.snapshots.delete(b);
      expect((await repointOrganizations(pool, boat, { current: { name: b, runtimeSha256: B } })).repointed).toEqual([]);
      expect((await live(org)).snapshot_name.startsWith(`${a}@`)).toBe(true);
    });
  });

  describe("deletion", () => {
    async function oldBase(): Promise<{ a: string; org: string; build: string }> {
      const a = await built(A);
      const { org, build } = await onShared(a);
      await built(B);
      await built(C);
      await supersededDaysAgo(a, 8);
      return { a, org, build };
    }
    const sweep = () => deleteSupersededSharedBases(deps(C, { previousRuntimeSha256: B }));

    it("refuses each kind of reference, and deletes once none is left", async () => {
      const { a, org, build } = await oldBase();
      // The live pointer.
      expect((await sweep()).deleted).toEqual([]);
      await repointOrganizations(pool, boat, { current: { name: name(C), runtimeSha256: C } });
      expect((await live(org)).snapshot_name.startsWith(name(C))).toBe(true);
      // The old build row still holds it (a workspace or recovery may pin it).
      expect((await sweep()).deleted).toEqual([]);
      await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id = NULL, snapshot_deleted_at = clock_timestamp() WHERE id = $1", [build]);
      // A ready copy being built from it.
      const copy = randomUUID();
      await pool.query(`INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, built_from_base)
        VALUES ($1, $2, $3, 1, 'building', $4, $5)`, [copy, org, randomUUID(), `ready-copy:${copy}`, `snapshot:${a}@${build}`]);
      expect((await sweep()).deleted).toEqual([]);
      await pool.query("UPDATE cloud_v2_ready_copies SET state = 'ready' WHERE id = $1", [copy]);
      expect((await sweep()).deleted).toEqual([a]);
      expect(boat.snapshots.has(a)).toBe(false);
      expect(await bases.row(a)).toMatchObject({ state: "deleted", deleted_at: expect.any(Date) });
      expect(boat.calls.filter(call => call.op === "deleteSnapshot").map(call => call.args[0])).toEqual([a]);
    });

    it("waits 24 hours from the supersession and never deletes the current or the previous runtime's base", async () => {
      const { a, org } = await oldBase();
      await pool.query("DELETE FROM cloud_v2_computers WHERE org_id = $1", [org]);
      await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id = NULL, snapshot_deleted_at = clock_timestamp() WHERE org_id = $1", [org]);
      await supersededDaysAgo(a, 0.9);
      expect((await sweep()).deleted).toEqual([]);
      for (const base of [name(B), name(C)]) await supersededDaysAgo(base, 30);
      await supersededDaysAgo(a, 1.1);
      expect((await sweep()).deleted).toEqual([a]);
      expect(boat.snapshots.has(name(B)) && boat.snapshots.has(name(C))).toBe(true);
      // With no previous runtime configured, the newest base of another runtime is kept instead.
      expect((await deleteSupersededSharedBases(deps(C))).deleted).toEqual([]);
      // A pinned override is never deleted either.
      expect((await deleteSupersededSharedBases(deps(C, { previousRuntimeSha256: A, override: { kind: "name", name: name(B) } }))).deleted).toEqual([]);
      expect((await deleteSupersededSharedBases(deps(C, { previousRuntimeSha256: A }))).deleted).toEqual([name(B)]);
    });

    it("keeps the row when Boat still reads the snapshot after its delete", async () => {
      const { a, org } = await oldBase();
      await pool.query("DELETE FROM cloud_v2_computers WHERE org_id = $1", [org]);
      await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id = NULL, snapshot_deleted_at = clock_timestamp() WHERE org_id = $1", [org]);
      vi.spyOn(boat, "deleteSnapshot").mockResolvedValue();
      expect((await sweep()).deleted).toEqual([]);
      expect(await bases.row(a)).toMatchObject({ state: "ready", deleted_at: null });
      expect(lines).toContain(`[cloud-v2] shared base deletion unconfirmed name=${a}`);
    });
  });

  describe("missing base", () => {
    it("fails a base Boat lost, rebuilds it under a new name, and moves its organizations to a base Boat has", async () => {
      const a = await built(A), b = await built(B);
      const onA = await onShared(a), onB = await onShared(b);
      boat.snapshots.delete(b);
      // One 404 is only a sighting; the second scan in a row acts.
      expect(await checkMissingSharedBases(deps(B))).toMatchObject({ missing: [], repointed: [], cleared: [] });
      expect(lines).toContain(`[cloud-v2] shared base not found once name=${b}; checking again at the next scan`);
      const result = await checkMissingSharedBases(deps(B));
      expect(result).toMatchObject({ missing: [b], repointed: [onB.org], cleared: [] });
      expect(lines).toContain(`[cloud-v2] shared base missing name=${b}`);
      expect(await bases.row(b)).toMatchObject({ state: "failed", error_code: "shared_base_missing", missing_at: expect.any(Date) });
      expect((await live(onB.org)).snapshot_name.startsWith(`${a}@`)).toBe(true);
      expect((await live(onA.org)).snapshot_name.startsWith(`${a}@`)).toBe(true);
      // The next claim rebuilds it at once, as -r1.
      expect(await claimSharedBaseBuild(deps(B))).toMatchObject({ code: "shared_base_ready", name: name(B, 1) });
    });

    it("leaves organizations without a live base when Boat has no other", async () => {
      const a = await built(A);
      const { org } = await onShared(a);
      boat.snapshots.delete(a);
      await checkMissingSharedBases(deps(A));
      expect(await checkMissingSharedBases(deps(A))).toMatchObject({ missing: [a], repointed: [], cleared: [org] });
      expect(await live(org)).toEqual({ active_build_id: null, snapshot_name: null });
      // A name Boat cannot answer for now is not called missing.
      vi.spyOn(boat, "snapshotState").mockRejectedValue(new Error("unavailable"));
      expect((await checkMissingSharedBases(deps(A))).missing).toEqual([]);
    });

    it("acts only on an explicit 404 on two scans in a row: a status other than ready, one 404, or a 404 then present do nothing", async () => {
      const a = await built(A);
      const { org } = await onShared(a);
      const unchanged = async () => {
        expect(await bases.row(a)).toMatchObject({ state: "ready", missing_at: null });
        expect((await live(org)).snapshot_name.startsWith(`${a}@`)).toBe(true);
      };
      // Listed but not ready: unknown, never counted.
      boat.notReady.add(a);
      for (let scan = 0; scan < 3; scan++) expect((await checkMissingSharedBases(deps(A))).missing).toEqual([]);
      expect((await bases.row(a))!.missing_seen_at).toBeNull();
      await unchanged();
      boat.notReady.delete(a);
      // One 404: a sighting and nothing else.
      const kept = new Map(boat.snapshots.get(a) ?? []);
      boat.snapshots.delete(a);
      expect((await checkMissingSharedBases(deps(A))).missing).toEqual([]);
      expect((await bases.row(a))!.missing_seen_at).toEqual(expect.any(Date));
      await unchanged();
      // Present again: the sighting is cleared, so the next 404 starts over.
      boat.snapshots.set(a, kept);
      expect((await checkMissingSharedBases(deps(A))).missing).toEqual([]);
      expect((await bases.row(a))!.missing_seen_at).toBeNull();
      boat.snapshots.delete(a);
      expect((await checkMissingSharedBases(deps(A))).missing).toEqual([]);
      await unchanged();
      // Two in a row: as before.
      expect((await checkMissingSharedBases(deps(A))).missing).toEqual([a]);
    });
  });

  describe("daily inventory", () => {
    it("reports this deployment's names no row accounts for, never deletes them, and notes use beyond the allowance", async () => {
      const a = await built(A);
      const { org } = await onShared(a);
      const own = cloudV2SnapshotName("alpha", org, 2);
      await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, snapshot_id)
        VALUES ($1, $2, 2, '{"repositories":[]}', 'succeeded', $3, 'manual', $4)`, [randomUUID(), org, admin, own]);
      const erased = randomUUID();
      await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, cleanup_requested_at)
        VALUES ($1, $2, 3, '{"repositories":[]}', 'failed', $3, 'manual', clock_timestamp())`, [erased, org, admin]);
      boat.snapshots.set(own, new Map()).set(cloudV2SnapshotName("alpha", org, 3), new Map());
      const leaked = cloudV2SnapshotName("alpha", randomUUID(), 1);
      boat.foreignSnapshots.add(leaked).add("zeros-production-base-aaaaaaaaaaaa").add(`zeros-local-${"a".repeat(24)}-base-aaaaaaaaaaaa`).add("someone-else");
      boat.includedSnapshots = 5;
      const inventory = await dailySnapshotInventory(deps(A));
      expect(inventory).toEqual({ listed: 4, accounted: 3, unaccounted: [leaked], allowance: { included: 5, used: 7, extra: 2 } });
      expect(boat.snapshots.size + boat.foreignSnapshots.size).toBe(7);
      expect(boat.calls.some(call => call.op === "deleteSnapshot")).toBe(false);
      expect(lines).toContain("[cloud-v2] named snapshot inventory channel=alpha listed=4 accounted=3 unaccounted=1");
      expect(lines).toContain("[cloud-v2] named snapshot allowance used=7 included=5 extra=2");
      expect(lines.join("\n")).not.toContain(leaked);
      // A shared base row marked deleted no longer accounts for a name Boat still lists...
      await pool.query("UPDATE cloud_v2_shared_bases SET state = 'deleted', deleted_at = clock_timestamp() WHERE name = $1", [a]);
      expect((await dailySnapshotInventory(deps(A)))?.unaccounted).toEqual([leaked]);
      // ...while a build row still holds it; once that reference is gone too, it is reported.
      await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id = NULL, snapshot_deleted_at = clock_timestamp() WHERE snapshot_id LIKE $1", [`${a}@%`]);
      expect((await dailySnapshotInventory(deps(A)))?.unaccounted).toEqual([leaked, a].sort());
    });

    it("tells a Local database's names from the channel's", async () => {
      const owner = "a".repeat(24);
      boat.foreignSnapshots.add(`zeros-local-${owner}-base-aaaaaaaaaaaa`).add(`zeros-local-${"b".repeat(24)}-base-aaaaaaaaaaaa`).add("zeros-alpha-base-aaaaaaaaaaaa");
      boat.includedSnapshots = 10;
      const lines0 = lines.length;
      expect(await dailySnapshotInventory(deps(A, { scope: { channel: "development", localOwner: owner } })))
        .toMatchObject({ listed: 1, unaccounted: [`zeros-local-${owner}-base-aaaaaaaaaaaa`], allowance: { extra: 0 } });
      expect(lines.slice(lines0).some(line => line.includes("allowance"))).toBe(false);
    });
  });

  it("on a Local control plane builds no shared base unless asked, and runs its other hooks only once it has rows", async () => {
    const local = { channel: "development", localOwner: "a".repeat(24) };
    const quiet = new CloudV2SharedBaseSweeper({ ...deps(A), scope: local });
    await quiet.tick(); await quiet.settled();
    expect(boat.calls).toEqual([]);
    expect(await bases.rows(local)).toEqual([]);
    // Asked (auto, or a pinned name): it builds its own, under its own name.
    const asked = new CloudV2SharedBaseSweeper({ ...deps(A), scope: local, override: { kind: "auto" } });
    await asked.tick(); await asked.settled();
    expect((await bases.rows(local)).map(row => [row.name, row.state])).toEqual([[`zeros-local-${"a".repeat(24)}-base-${A.slice(0, 12)}`, "ready"]]);
    // With rows of its own, the quiet one now checks them (Boat is read), but still never claims a build.
    const before = boat.calls.filter(call => call.op === "create").length;
    const later = new CloudV2SharedBaseSweeper({ ...deps(B), scope: local });
    await later.tick(); await later.settled();
    expect(boat.calls.filter(call => call.op === "create").length).toBe(before);
    expect(boat.calls.some(call => call.op === "snapshotState")).toBe(true);
    // Hosted Dev (the development channel with a generation: no local owner) builds as Alpha does.
    const hosted = new CloudV2SharedBaseSweeper({ ...deps(C), scope: { channel: "development" } });
    await hosted.tick(); await hosted.settled();
    expect((await bases.rows({ channel: "development" })).some(row => row.name === `zeros-development-base-${C.slice(0, 12)}` && row.state === "ready")).toBe(true);
  });

  it("runs every hook at its cadence from one tick", async () => {
    let clock = 0;
    const a = await built(A);
    const { org } = await onShared(a);
    const sweeper = new CloudV2SharedBaseSweeper({ ...deps(B), now: () => clock });
    await sweeper.tick(); await sweeper.settled();
    expect(await bases.row(name(B))).toMatchObject({ state: "ready" });
    // The re-point ran before B was ready; a minute later it moves the organization.
    clock += 60_000; await sweeper.tick(); await sweeper.settled();
    expect((await live(org)).snapshot_name.startsWith(`${name(B)}@`)).toBe(true);
    expect(boat.calls.filter(call => call.op === "listNamedSnapshots")).toHaveLength(1);
  });
});
