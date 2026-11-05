import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudEnvironments } from "./environment-store.js";
import { CloudV2Store } from "./store.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { RuntimeAdoption } from "./runtime-adoption.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("private runtime handoff", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  async function fixture(environment = true) {
    const org = randomUUID(), creator = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    const environments = new CloudEnvironments(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } },
      async () => ({ repositoryId: "42", assertCurrent: async () => {}, assertReadable: async () => {} }));
    const saved = environment ? await environments.patch(org, creator, "42", "fixture/repo", { expectedRevision: 0, variables: { APP_VALUE: "synthetic-only" } }) : undefined;
    const store = new CloudV2Store(pool), updates = new RuntimeHandoffStore(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator,
      name: "Runtime", repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot);
    if (saved) await environments.report(token, boot, { versionId: saved.versionId!, sequence: 2, state: "ready" });
    await updates.recordRuntime(token, boot, "a".repeat(64));
    const current = (await store.workerSession(token, boot))!;
    const prepared = await updates.prepare(token, boot, { target: "b".repeat(64), instanceId: randomUUID(), revision: current.loginRevision, generation: 7 });
    expect(prepared).not.toBeNull();
    const h = prepared!;
    const commit = () => updates.commit(token, boot, h.id, current.loginRevision, 7, h.target_sha256);
    const state = () => store.get(workspace.id, creator);
    return { org, creator, store, updates, workspace, token, boot, saved, h, commit, state };
  }

  it("keeps the catalog running while fresh seed and services privately settle, then promotes atomically", async () => {
    const f = await fixture(), before = await f.state();
    expect(await f.commit()).toBe(true);
    expect(await f.updates.activate(f.token, f.h.id)).toMatchObject({ state: "activating" });
    expect(await f.updates.privateBoot(f.token, f.h.id, f.h.next_boot_id, f.h.target_sha256)).not.toBeNull();
    expect(await f.store.workerSession(f.token, f.h.next_boot_id)).toBeNull();
    expect(await f.state()).toEqual(before);
    expect(await f.updates.promote(f.token, f.h.id, f.h.next_boot_id)).toBe(false);
    await f.updates.environment(f.token, f.h.id, f.h.next_boot_id, { versionId: f.saved!.versionId!, sequence: 1, state: "ready" });
    expect(await f.state()).toEqual(before);
    expect((await pool.query("SELECT ready_boot_id FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [f.workspace.id])).rows[0].ready_boot_id).toBe(f.boot);
    expect(await f.updates.promote(f.token, f.h.id, f.h.next_boot_id)).toBe(true);
    expect(await f.state()).toEqual(before);
    expect(await f.store.workerSession(f.token, f.boot)).toBeNull();
    expect(await f.store.workerSession(f.token, f.h.next_boot_id)).not.toBeNull();
    expect(await f.updates.promote(f.token, f.h.id, f.h.next_boot_id)).toBe(true);
    expect(await f.updates.runtime(f.token, f.h.next_boot_id)).toBe(f.h.target_sha256);
  });

  it("rolls back a failed private boot without failing the workspace or reusing its seed proof", async () => {
    const f = await fixture(), before = await f.state();
    expect(await f.commit()).toBe(true); await f.updates.activate(f.token, f.h.id);
    await f.updates.environment(f.token, f.h.id, f.h.next_boot_id, { versionId: f.saved!.versionId!, sequence: 1, state: "failed", errorCode: "cloud_environment_seed_uncertain" });
    expect(await f.state()).toEqual(before);
    expect(await f.updates.rollback(f.h.id)).toMatchObject({ state: "rolling_back" });
    expect(await f.updates.privateBoot(f.token, f.h.id, f.h.next_boot_id)).toBeNull();
    expect(await f.updates.promote(f.token, f.h.id, f.h.rollback_boot_id)).toBe(false);
    await f.updates.environment(f.token, f.h.id, f.h.rollback_boot_id, { versionId: f.saved!.versionId!, sequence: 1, state: "ready" });
    expect(await f.updates.promote(f.token, f.h.id, f.h.rollback_boot_id)).toBe(true);
    expect(await f.updates.runtime(f.token, f.h.rollback_boot_id)).toBe(f.h.previous_sha256);
    expect(await f.state()).toEqual(before);
  });

  it("serializes app admission and commit across independent store instances", async () => {
    const f = await fixture(false), peer = new RuntimeHandoffStore(pool), client = randomUUID();
    expect(await peer.admitClient(f.workspace.id, client)).toBe(true);
    expect(await f.commit()).toBe(false);
    await peer.releaseClient(f.workspace.id, client);
    expect(await f.commit()).toBe(true);
    expect(await peer.admitClient(f.workspace.id, client)).toBe(false);
    expect(await f.updates.cancel(f.token, f.h.id, f.boot)).toBe(true);
    expect(await peer.admitClient(f.workspace.id, client)).toBe(true);
  });

  it.each(["login", "access", "stop", "sandbox", "expiry", "source"])("refuses a changed %s fence at commit", async change => {
    const f = await fixture(false);
    const mutations: Record<string, string> = {
      login: "UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1",
      access: "UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1",
      stop: "UPDATE cloud_v2_workspaces SET stop_generation=stop_generation+1 WHERE id=$1",
      sandbox: "UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_other1234' WHERE id=$1",
      expiry: "UPDATE cloud_worker_runtime_handoffs SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
      source: "UPDATE cloud_v2_github_sources SET repository_id='43' WHERE workspace_id=$1",
    };
    await pool.query(mutations[change]!, [f.workspace.id]);
    expect(await f.commit()).toBe(false);
    expect(await f.updates.activate(f.token, f.h.id)).toBeNull();
  });

  it("a queued durable send refuses commit and an old hello cannot publish through the barrier", async () => {
    const f = await fixture(false);
    await f.store.prompts.enqueue(f.workspace.id, f.creator, { chatId: "chat", userMessageId: randomUUID(), agentId: "codex", startedAt: 1234,
      prompt: [{ type: "text", text: "fixture" }] });
    expect(await f.commit()).toBe(false);
    await f.store.prompts.stop(f.workspace.id, f.creator, "chat", "0");
    await f.store.prompts.ackStop(f.token, f.boot, { chatId: "chat", epoch: "1" });
    expect(await f.commit()).toBe(true);
    await expect(f.store.beginWorkerHello(f.token, randomUUID())).rejects.toThrow("cloud_runtime_handoff_private");
    expect((await f.state()).state).toBe("running");
  });

  it("refuses foreign token/boot/digest and stale or late seed reports", async () => {
    const f = await fixture(); expect(await f.commit()).toBe(true); await f.updates.activate(f.token, f.h.id);
    expect(await f.updates.privateBoot(f.token, f.h.id, randomUUID())).toBeNull();
    expect(await f.updates.privateBoot(f.token, f.h.id, f.h.next_boot_id, "c".repeat(64))).toBeNull();
    expect(await f.updates.privateBoot(`${f.token}x`, f.h.id, f.h.next_boot_id)).toBeNull();
    const ready = { versionId: f.saved!.versionId!, sequence: 2, state: "ready" as const };
    await f.updates.environment(f.token, f.h.id, f.h.next_boot_id.toUpperCase(), ready);
    await f.updates.environment(f.token, f.h.id, f.h.next_boot_id, ready);
    await expect(f.updates.environment(f.token, f.h.id, f.h.next_boot_id, { ...ready, sequence: 1 })).rejects.toThrow();
    await expect(f.updates.environment(f.token, f.h.id, f.h.next_boot_id, { ...ready, sequence: 3, state: "failed", errorCode: "cloud_environment_seed_uncertain" })).rejects.toThrow();
  });

  it("releases an unactivated commitment when login authority changes before activate", async () => {
    const f = await fixture(false); expect(await f.commit()).toBe(true);
    await pool.query("UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1", [f.workspace.id]);
    const execLong = vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false }));
    const adoption = new RuntimeAdoption({ handoffs: f.updates, store: f.store, compute: { execLong }, authorizeSource: async () => {},
      runtimeForWorkspace: async () => ({ sha256: f.h.target_sha256, url: async () => "https://fixture.example.test/runtime.tar.gz" }) });
    try {
      expect(await adoption.request(f.token, f.boot, { op: "activate", id: f.h.id })).toEqual({ status: "cancelled", id: f.h.id });
      expect(await f.updates.blocked(f.workspace.id)).toBe(false); expect(execLong).not.toHaveBeenCalled();
    } finally { adoption.close(); }
  });

  it("refuses cancellation from another boot even with the same workspace token", async () => {
    const f = await fixture(false); expect(await f.commit()).toBe(true);
    expect(await f.updates.cancel(f.token, f.h.id, randomUUID())).toBe(false);
    expect(await f.updates.blocked(f.workspace.id)).toBe(true);
    expect(await f.updates.cancel(f.token, f.h.id, f.boot)).toBe(true);
  });

  it("rechecks the resolver immediately before promoting a private target", async () => {
    const f = await fixture(false); expect(await f.commit()).toBe(true); await f.updates.activate(f.token, f.h.id);
    const before = await f.state(); let target = "c".repeat(64);
    const adoption = new RuntimeAdoption({ handoffs: f.updates, store: f.store, compute: { execLong: async () => ({ exitCode: 0, stdout: "", timedOut: false }) },
      authorizeSource: async () => {}, runtimeForWorkspace: async () => ({ sha256: target, url: async () => "https://fixture.example.test/runtime.tar.gz" }) });
    try {
      expect(await adoption.request(f.token, f.h.next_boot_id, { op: "ready", id: f.h.id })).toEqual({ status: "unavailable" });
      expect(await f.store.workerSession(f.token, f.boot)).not.toBeNull(); expect(await f.state()).toEqual(before);
      target = f.h.target_sha256;
      expect(await adoption.request(f.token, f.h.next_boot_id, { op: "ready", id: f.h.id })).toEqual({ status: "completed", id: f.h.id });
    } finally { adoption.close(); }
  });

  it("treats an expired desktop lease as unknown through same-boot reconnects", async () => {
    const f = await fixture(false), client = randomUUID(); expect(await f.updates.admitClient(f.workspace.id, client)).toBe(true);
    await pool.query("UPDATE cloud_worker_runtime_clients SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1", [f.workspace.id]);
    expect(await f.commit()).toBe(false);
    const other = randomUUID(); expect(await f.updates.admitClient(f.workspace.id, other)).toBe(true);
    await f.updates.releaseClient(f.workspace.id, other);
    await f.updates.recordRuntime(f.token, f.boot, f.h.previous_sha256);
    expect(await f.commit()).toBe(false);
    const newBoot = randomUUID(); await f.store.beginWorkerHello(f.token, newBoot); await f.store.acceptWorkerHello(f.token, newBoot);
    await f.updates.recordRuntime(f.token, newBoot, f.h.previous_sha256);
    expect((await pool.query("SELECT worker_runtime_unknown_activity FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].worker_runtime_unknown_activity).toBe(false);
  });

  it("gives a failed rollback a fresh bounded private boot without reusing its proof", async () => {
    const f = await fixture(); expect(await f.commit()).toBe(true); await f.updates.activate(f.token, f.h.id);
    const first = (await f.updates.rollback(f.h.id))!;
    expect(first).not.toBeNull();
    expect(await f.updates.rollback(f.h.id)).toBeNull();
    await f.updates.environment(f.token, f.h.id, first.rollback_boot_id, { versionId: f.saved!.versionId!, sequence: 1, state: "failed", errorCode: "cloud_environment_seed_uncertain" });
    const second = (await f.updates.rollback(f.h.id))!;
    expect(second).not.toBeNull();
    expect(second.rollback_boot_id).not.toBe(first.rollback_boot_id);
    expect(await f.updates.privateBoot(f.token, f.h.id, first.rollback_boot_id)).toBeNull();
    expect(await f.updates.promote(f.token, f.h.id, second.rollback_boot_id)).toBe(false);
    await f.updates.environment(f.token, f.h.id, second.rollback_boot_id, { versionId: f.saved!.versionId!, sequence: 1, state: "ready" });
    expect(await f.updates.promote(f.token, f.h.id, second.rollback_boot_id)).toBe(true);
    expect((await f.state()).state).toBe("running");
  });

  it("retires stale handoff barriers after an explicit Stop and a new natural boot", async () => {
    const f = await fixture(false); expect(await f.commit()).toBe(true); await f.updates.activate(f.token, f.h.id);
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET state='starting' WHERE id=$1", [f.workspace.id]);
    const token = await f.store.rotateWorkerToken(f.workspace.id), boot = randomUUID();
    await f.store.beginWorkerHello(token, boot); await f.store.acceptWorkerHello(token, boot);
    await f.updates.recordRuntime(token, boot, f.h.target_sha256);
    expect(await f.updates.admitClient(f.workspace.id, randomUUID())).toBe(true);
    expect(await f.updates.privateBoot(f.token, f.h.id, f.h.next_boot_id)).toBeNull();
  });

  it("rechecks the private boot deadline after a blocked seed-proof lock", async () => {
    const f = await fixture(); expect(await f.commit()).toBe(true); await f.updates.activate(f.token, f.h.id);
    await f.updates.environment(f.token, f.h.id, f.h.next_boot_id, { versionId: f.saved!.versionId!, sequence: 1, state: "ready" });
    const blocker = await pool.connect(); let promoting: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT workspace_id FROM cloud_workspace_environment_pins WHERE workspace_id=$1 FOR UPDATE", [f.workspace.id]);
      await pool.query("UPDATE cloud_worker_runtime_handoffs SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.h.id]);
      promoting = f.updates.promote(f.token, f.h.id, f.h.next_boot_id);
      await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT version_id FROM cloud_workspace_environment_pins%' AND pid<>pg_backend_pid()")).rows[0].n).toBeGreaterThan(0);
      await expect.poll(async () => (await pool.query("SELECT clock_timestamp()>expires_at AS expired FROM cloud_worker_runtime_handoffs WHERE id=$1", [f.h.id])).rows[0].expired, { timeout: 2000 }).toBe(true);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await promoting).toBe(false);
    expect(await f.store.workerSession(f.token, f.boot)).not.toBeNull();
  });
});
