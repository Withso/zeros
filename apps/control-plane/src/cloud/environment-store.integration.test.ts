import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { withSystemTx, withUserTx } from "../db.js";
import { HttpError } from "../authz.js";
import { CloudEnvironments, pinCloudEnvironment } from "./environment-store.js";
import { CloudV2Store } from "./store.js";
import { legacyEnvironmentHello } from "./__fixtures__/environment-legacy-hello.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const canary = 'synthetic-environment-canary-"quoted"\nnext';
d("creator cloud environments", () => {
  let pool: pg.Pool, environments: CloudEnvironments, store: CloudV2Store, org: string, owner: string, member: string, outsider: string;
  const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
  const authority = { repositoryId: "42", assertCurrent: vi.fn(async (_tx: pg.PoolClient) => {}), assertReadable: vi.fn(async () => {}) };
  const admit = vi.fn(async () => authority);
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    [org, owner, member, outsider] = Array.from({ length: 4 }, () => randomUUID());
    for (const id of [owner, member, outsider]) {
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
      await grantTestPro(pool, id);
    }
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, owner]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [org, owner, member]);
    authority.repositoryId = "42"; authority.assertCurrent.mockReset().mockResolvedValue(undefined); authority.assertReadable.mockReset().mockResolvedValue(undefined);
    admit.mockReset().mockResolvedValue(authority);
    environments = new CloudEnvironments(pool, keys, admit); store = new CloudV2Store(pool);
  });
  const patch = (expectedRevision = 0, variables: Record<string, string> = { APP_SECRET: canary }) => environments.patch(org, owner, "42", "fixture/repo", { expectedRevision, variables });
  const create = (userId = owner, repositoryId = "42") => store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: userId,
    name: "workspace", repository: "fixture/repo", sourceRepositoryId: repositoryId, branch: "workspace/one", baseBranch: "main", computerBuildId: null });

  it("returns metadata only, encrypts database rows and enforces system-only RLS", async () => {
    const saved = await patch();
    expect(saved).toMatchObject({ revision: 1, repositoryId: "42", variables: [{ name: "APP_SECRET", bytes: Buffer.byteLength(canary) }] });
    expect(JSON.stringify(saved).includes(canary)).toBe(false);
    const read = await environments.get(org, owner, "42", "fixture/repo");
    expect(read).toEqual(saved);
    const stored = await pool.query("SELECT * FROM cloud_environment_versions");
    expect(stored.rowCount).toBe(1); expect(JSON.stringify(stored.rows).includes(canary)).toBe(false);
    for (const table of ["cloud_environment_heads", "cloud_environment_versions", "cloud_workspace_environment_pins"])
      expect((await withUserTx(pool, owner, tx => tx.query(`SELECT 1 FROM ${table}`))).rowCount).toBe(0);
  });

  it("pins create identity, keeps old values through defaults edits, and isolates creators and immutable repositories", async () => {
    const first = await patch(), workspace = await create();
    expect(await environments.resolve(workspace)).toMatchObject({ versionId: first.versionId, repositoryId: "42", variables: { APP_SECRET: canary } });
    await patch(1, { APP_SECRET: "synthetic-new-default" });
    expect((await environments.resolve(workspace))?.variables.APP_SECRET === canary).toBe(true);
    expect(await environments.resolve(await create(member))).toBeUndefined();
    expect(await environments.resolve(await create(owner, "43"))).toBeUndefined();
    await expect(environments.resolve({ ...workspace, creatorUserId: member })).rejects.toMatchObject({ status: 404 });
    expect((await environments.resolve(await create()))?.variables.APP_SECRET === "synthetic-new-default").toBe(true);
  });

  it("preserves untouched values, refuses stale CAS, and retains a clear-all tombstone", async () => {
    await patch();
    const saved = await environments.patch(org, owner, "42", "fixture/repo", { expectedRevision: 1, variables: { APP_OTHER: "synthetic-other" } });
    expect(saved.variables.map(row => row.name)).toEqual(["APP_OTHER", "APP_SECRET"]);
    await expect(patch(1)).rejects.toMatchObject({ code: "cloud_environment_changed" });
    const cleared = await environments.patch(org, owner, "42", "fixture/repo", { expectedRevision: 2, clear: true });
    expect(cleared).toMatchObject({ revision: 3, versionId: null, variables: [], files: [] });
    await expect(patch(0)).rejects.toMatchObject({ code: "cloud_environment_changed" });
    expect(await environments.resolve(await create())).toBeUndefined();
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(0);
  });

  it("fails closed on unreadable material instead of replacing unknown saved values", async () => {
    await patch();
    const wrongKeys = new CloudEnvironments(pool, { currentKeyVersion: 2, keys: { 2: randomBytes(32).toString("base64url") } }, admit);
    await expect(wrongKeys.get(org, owner, "42", "fixture/repo")).rejects.toMatchObject({ code: "cloud_environment_unreadable" });
    await expect(wrongKeys.patch(org, owner, "42", "fixture/repo", { expectedRevision: 1, clear: true })).rejects.toMatchObject({ code: "cloud_environment_unreadable" });
    expect((await environments.get(org, owner, "42", "fixture/repo")).revision).toBe(1);
  });

  it("checks current GitHub proof and membership without releasing values after withdrawal", async () => {
    await patch(); const workspace = await create();
    authority.repositoryId = "43";
    await expect(environments.get(org, owner, "42", "fixture/repo")).rejects.toMatchObject({ status: 404 });
    authority.repositoryId = "42";
    authority.assertCurrent.mockRejectedValueOnce(new HttpError(403, "github_cloud_access_denied", "Access changed."));
    await expect(patch(1)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    authority.assertReadable.mockRejectedValueOnce(new HttpError(403, "github_cloud_access_denied", "Access changed."));
    await expect(environments.get(org, owner, "42", "fixture/repo")).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, owner]);
    await expect(environments.resolve(workspace)).rejects.toMatchObject({ status: 404 });
    await expect(environments.get(org, owner, "42", "fixture/repo")).rejects.toMatchObject({ status: 404 });
    await expect(environments.get(org, outsider, "42", "fixture/repo")).rejects.toMatchObject({ status: 404 });
  });

  it("retains only current heads and live pins, and releases the pin on logical deletion", async () => {
    await patch(); const workspace = await create();
    for (let revision = 1; revision <= 6; revision++) await patch(revision, { APP_SECRET: `synthetic-${revision}` });
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(2);
    await store.transition(workspace.id, ["creating"], "deleted");
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_environment_pins")).rowCount).toBe(0);
  });

  it.each(["logical", "physical"])("prunes an older writer's %s deletion without releasing a live pin or head", async kind => {
    const retired = await patch(), removed = await create();
    const retained = await patch(1, { APP_SECRET: "synthetic-live-pin" }), live = await create();
    const current = await patch(2, { APP_SECRET: "synthetic-head" });
    await pool.query(kind === "logical" ? "UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1"
      : "DELETE FROM cloud_v2_workspaces WHERE id=$1", [removed.id]);
    await environments.prune();
    const versions = (await pool.query<{ id: string }>("SELECT id FROM cloud_environment_versions")).rows.map(row => row.id);
    expect(versions).not.toContain(retired.versionId);
    expect(versions.sort()).toEqual([retained.versionId, current.versionId].sort());
    expect((await pool.query("SELECT workspace_id FROM cloud_workspace_environment_pins")).rows).toEqual([{ workspace_id: live.id }]);
    expect((await environments.resolve(live))?.versionId).toBe(retained.versionId);
    await environments.prune();
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(2);
  });

  it("the real migration refuses the old hello writer for pinned boots but preserves legacy admission", async () => {
    await patch(); const workspace = await create();
    if (!(await pool.query("SELECT 1 FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [workspace.id])).rowCount)
      await withSystemTx(pool, tx => pinCloudEnvironment(tx, workspace, "42"));
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot);
    await expect(legacyEnvironmentHello(pool, token, boot)).rejects.toMatchObject({ code: "23514", constraint: "cloud_environment_ready" });
    expect((await store.get(workspace.id, owner)).state).not.toBe("running");
    const legacy = await create(member), legacyToken = await store.rotateWorkerToken(legacy.id), legacyBoot = randomUUID();
    expect(await legacyEnvironmentHello(pool, legacyToken, legacyBoot)).toMatchObject({ state: "running" });
  });

  it("returns config while starting, commits ready before admission and replays a lost successful report", async () => {
    const saved = await patch(), workspace = await create(), token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot);
    expect(await store.acceptWorkerHello(token, boot)).toMatchObject({ state: "starting" });
    expect(await store.workerSession(token, boot)).toMatchObject({ state: "starting" });
    const report = { versionId: saved.versionId, sequence: 1, state: "ready" };
    await environments.report(token, boot, report);
    const ready = await store.get(workspace.id, owner);
    expect(ready.state).toBe("running");
    await environments.report(token, boot, report);
    expect((await store.get(workspace.id, owner)).updatedAt).toBe(ready.updatedAt);
    await expect(environments.report(token, boot, { ...report, sequence: 2, state: "failed", errorCode: "cloud_environment_path_conflict" }))
      .rejects.toMatchObject({ code: "cloud_environment_report_stale" });
    expect((await store.get(workspace.id, owner)).state).toBe("running");
  });

  it("a replacement boot cannot reuse ready proof or accept stale/foreign reports", async () => {
    const saved = await patch(), workspace = await create(), token = await store.rotateWorkerToken(workspace.id), first = randomUUID(), next = randomUUID();
    await store.beginWorkerHello(token, first); await store.acceptWorkerHello(token, first);
    await environments.report(token, first, { versionId: saved.versionId, sequence: 1, state: "ready" });
    await store.beginWorkerHello(token, next);
    expect(await store.acceptWorkerHello(token, next)).toMatchObject({ state: "starting" });
    await expect(environments.report(token, first, { versionId: saved.versionId, sequence: 2, state: "ready" })).rejects.toMatchObject({ status: 401 });
    await expect(environments.report(token, next, { versionId: randomUUID(), sequence: 1, state: "ready" })).rejects.toMatchObject({ status: 401 });
    await environments.report(token, next, { versionId: saved.versionId, sequence: 2, state: "ready" });
    await expect(environments.report(token, next, { versionId: saved.versionId, sequence: 1, state: "ready" })).rejects.toMatchObject({ status: 409 });
  });
  it("pins a complete concurrent edit and keeps that pin on an idempotent create retry", async () => {
    await patch();
    let entered!: () => void, release!: () => void;
    const locked = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
    authority.assertCurrent.mockImplementationOnce(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cloud-environment:${org}:${owner}`]);
      entered(); await held;
    });
    const updating = patch(1, { APP_SECRET: "synthetic-new", APP_SECOND: "synthetic-second" });
    await locked;
    const input = { id: randomUUID(), organizationId: org, creatorUserId: owner, name: "workspace", repository: "fixture/repo",
      sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null };
    const key = randomUUID(), hash = "a".repeat(64);
    const creating = store.createWorkspaceOnce(input, key, hash, workspace => ({ id: workspace.id }));
    try {
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%cloud-environment-write%'" )).rowCount).toBeGreaterThan(0);
    } finally { release(); }
    const [saved, receipt] = await Promise.all([updating, creating]);
    const workspace = await store.get(input.id, owner);
    const pinned = await environments.resolve(workspace);
    expect(pinned?.versionId).toBe(saved.versionId);
    expect(pinned?.variables.APP_SECRET === "synthetic-new" && pinned.variables.APP_SECOND === "synthetic-second").toBe(true);
    await patch(2, { APP_SECRET: "synthetic-later" });
    expect(await store.createWorkspaceOnce({ ...input, id: randomUUID() }, key, hash, row => ({ id: row.id }))).toEqual(receipt);
    expect((await environments.resolve(workspace))?.versionId).toBe(saved.versionId);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_environment_pins")).rowCount).toBe(1);
  });

  it("does not retrofit defaults onto a legacy workspace", async () => {
    const workspace = await create(); await patch();
    expect(await environments.resolve(workspace)).toBeUndefined();
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot);
    expect((await store.acceptWorkerHello(token, boot))?.state).toBe("running");
  });

  it("rechecks membership after held GitHub admission before committing", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
    admit.mockImplementationOnce(async () => { entered(); await held; return authority; });
    const writing = patch(), outcome = expect(writing).rejects.toMatchObject({ status: 404 });
    try { await waiting; await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, owner]); }
    finally { release(); }
    await outcome;
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(0);
  });

  it("bounds the whole merged material, not just each partial patch", async () => {
    await patch(0, Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`APP_${i}`, "synthetic"])));
    await expect(patch(1, { APP_EXTRA: "synthetic" })).rejects.toMatchObject({ code: "cloud_environment_variable_limit" });
    await environments.patch(org, owner, "42", "fixture/repo", { expectedRevision: 1, clear: true });
    await patch(2, Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`APP_${i}`, "x".repeat(16 * 1024)])));
    await expect(patch(3, { APP_EXTRA: "x".repeat(16 * 1024) })).rejects.toMatchObject({ code: "cloud_environment_total_limit" });
    expect((await environments.get(org, owner, "42", "fixture/repo")).revision).toBe(3);
  });

  it("replays a failed report after response loss without changing the failure or reviving readiness", async () => {
    const saved = await patch(), workspace = await create(), token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot);
    const report = { versionId: saved.versionId, sequence: 1, state: "failed", errorCode: "cloud_environment_path_ignored_required" };
    await environments.report(token, boot, report);
    const failed = await store.get(workspace.id, owner), epoch = await store.accessEpoch(workspace.id);
    expect(failed).toMatchObject({ state: "failed", errorCode: report.errorCode });
    await environments.report(token, boot, report);
    expect((await store.get(workspace.id, owner)).updatedAt).toBe(failed.updatedAt);
    expect(await store.accessEpoch(workspace.id)).toBe(epoch);
    await expect(environments.report(token, boot, { versionId: saved.versionId, sequence: 2, state: "ready" })).rejects.toMatchObject({ status: 409 });
    expect((await store.workerSession(token, boot))?.state).toBe("failed");
  });
});
