import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudV2Store } from "./store.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("cloud v2 store", () => {
  let pool: pg.Pool;
  let store: CloudV2Store;
  let org: string;
  let creator: string;
  let member: string;

  async function user(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'User')`, [id, `u-${id}@example.test`]);
    return id;
  }

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool);
    creator = await user();
    member = await user();
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1, $2, 'Org', $3, false, true)`, [org, `org-${org}`, creator]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [org, creator, member]);
  });

  const create = () => store.createWorkspace({
    id: randomUUID(), organizationId: org, creatorUserId: creator, name: "zeros", repository: "withso/zeros", branch: "zeros/w", baseBranch: "main",
    computerBuildId: null,
  });

  it("excludes in-flight workspaces before applying the claim limit even when their lease has expired", async () => {
    const first = await create(), second = await create();
    expect((await store.claimPending(1, 0, [first.id])).map(row => row.id)).toEqual([second.id]);
    expect((await store.claimPending(4, 0, [first.id, second.id]))).toEqual([]);
    expect((await store.claimPending(1, 0)).map(row => row.id)).toEqual([first.id]);
  });

  it("returns hello latency from the state entry exactly once, retaining the first boot deadline", async () => {
    const w = await create(), token = await store.rotateWorkerToken(w.id), bootId = randomUUID();
    await pool.query("UPDATE cloud_v2_workspaces SET updated_at=clock_timestamp()-interval '5 seconds' WHERE id=$1", [w.id]);
    const hello = await store.acceptWorkerHello(token, bootId);
    expect(hello?.helloTiming?.state).toBe("creating");
    expect(hello?.helloTiming?.durationMs).toBeGreaterThanOrEqual(5000);
    expect(hello?.helloTiming?.durationMs).toBeLessThan(10_000);
    expect((await store.acceptWorkerHello(token, bootId))?.helloTiming).toBeUndefined();
  });

  it("renews only due running leases and fences the result by sandbox and lifecycle state", async () => {
    const a = await create(), b = await create();
    await store.transition(a.id, ["creating"], "running", { boatSandboxId: "bx_first" });
    await store.transition(b.id, ["creating"], "running", { boatSandboxId: "bx_other" });
    const due = new Date(Date.now() - 13 * 60 * 60_000), recent = new Date();
    expect(await store.markLeaseRenewed(a.id, "bx_first", due)).toBe(true);
    expect(await store.markLeaseRenewed(b.id, "bx_other", recent)).toBe(true);
    expect((await store.leasesDue(new Date(Date.now() - 12 * 60 * 60_000), 4)).map(w => w.id)).toEqual([a.id]);
    expect(await store.markLeaseRenewed(a.id, "bx_replaced", recent)).toBe(false);
    await store.transition(a.id, ["running"], "stopping");
    expect(await store.markLeaseRenewed(a.id, "bx_first", recent)).toBe(false);
    expect(await store.leasesDue(recent, 4)).toEqual([]);
    expect(await store.get(a.id, creator)).not.toHaveProperty("leaseRenewedAt");
  });

  const attemptRequest = () => { const attempt = randomUUID(); return { attempt, name: `zeros-alpha-ws-r${attempt.slice(0, 8)}`, env: { CLOUD_V2_RUNTIME_SHA256: "0".repeat(64) } }; };
  let request = attemptRequest();
  const checkpoint = (workspaceId: string, bytes = 4096) =>
    ({ object: `cloud-v2/checkpoints/${workspaceId}/${randomUUID()}.zck`, key: { version: 1, sealed: true }, sha256: "a".repeat(64), bytes });

  const generation = async (id: string) => (await pool.query<{ g: string }>("SELECT stop_generation::text AS g FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]!.g;
  const save = async (id: string, sandboxId: string, value: ReturnType<typeof checkpoint>) => store.saveCheckpoint(id, sandboxId, await generation(id), value);

  async function stopping(sandboxId: string) {
    const w = await create();
    await store.transition(w.id, ["creating"], "running", { boatSandboxId: sandboxId });
    await store.transition(w.id, ["running"], "stopping");
    return w;
  }

  async function activeComputer(snapshot = `zeros-alpha-${org.replace(/-/g, "").slice(0, 12)}-v1`) {
    const buildId = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,builder_sandbox_id,snapshot_id,created_by,source_policy_version)
      VALUES($1,$2,1,'{}','succeeded','bx_33333333',$3,$4,2)`, [buildId, org, snapshot, creator]);
    await pool.query("INSERT INTO cloud_v2_computers(org_id,active_build_id,snapshot_name) VALUES($1,$2,$3)", [org, buildId, snapshot]);
    return { buildId, snapshot };
  }

  it("records a checkpoint only for the stop still stopping that VM, and returns the one it replaced", async () => {
    const w = await stopping("bx_first"), first = checkpoint(w.id), second = checkpoint(w.id, 8192);
    expect(await save(w.id, "bx_other", first)).toBe(false);
    expect(await save(w.id, "bx_first", first)).toEqual({ replaced: null });
    expect(await save(w.id, "bx_first", second)).toEqual({ replaced: first.object });
    await store.checkpointFailed(w.id, "bx_first", await generation(w.id), "checkpoint_too_large");
    const claimed = (await store.claimPending(4, 0)).find(row => row.id === w.id)!;
    expect(claimed.checkpoint).toEqual({ ...second, savedAt: expect.any(String), stopGeneration: claimed.stopGeneration });
    expect((await pool.query("SELECT checkpoint_error FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0].checkpoint_error).toBe("checkpoint_too_large");
    // Internal metadata never reaches the public document.
    const document = await store.get(w.id, creator);
    for (const field of ["checkpoint", "restorePending", "baseCommit"]) expect(document).not.toHaveProperty(field);
    await store.transition(w.id, ["stopping"], "stopped");
    expect(await save(w.id, "bx_first", checkpoint(w.id))).toBe(false);
    // A stored key and digest only ever describe a complete checkpoint.
    await expect(pool.query("UPDATE cloud_v2_workspaces SET checkpoint_key=NULL WHERE id=$1", [w.id])).rejects.toThrow(/cloud_v2_checkpoint_complete/);
    await expect(pool.query("UPDATE cloud_v2_workspaces SET checkpoint_object='cloud-v2/checkpoints/../x.zck' WHERE id=$1", [w.id])).rejects.toThrow();
  });

  it("refuses a legacy shared image for both workspace creation and checkpoint restore", async () => {
    const image = await activeComputer();
    await pool.query("UPDATE cloud_v2_computer_builds SET source_policy_version=1 WHERE id=$1", [image.buildId]);
    expect(await store.activeComputer(org)).toBeNull();
    await expect(store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator,
      name: "Blocked", repository: "withso/zeros", branch: "work", baseBranch: "main", computerBuildId: image.buildId }))
      .rejects.toMatchObject({ code: "cloud_computer_changed" });
    const w = await stopping("bx_legacy");
    const saved = checkpoint(w.id);
    await save(w.id, "bx_legacy", saved);
    await store.transition(w.id, ["stopping"], "stopped");
    await store.transition(w.id, ["stopped"], "starting");
    expect(await store.beginRestore(w.id, "bx_legacy", attemptRequest())).toBe("no_computer");
    expect((await pool.query("SELECT checkpoint_object,source_repositories FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0])
      .toEqual({ checkpoint_object: saved.object, source_repositories: ["withso/zeros"] });
  });

  it("refuses a late save from an earlier stop, so it can never replace a newer checkpoint", async () => {
    const w = await stopping("bx_gen"), first = await generation(w.id);
    // Stop 1's save is held; its retry completes the stop without it.
    await store.transition(w.id, ["stopping"], "stopped");
    await store.transition(w.id, ["stopped"], "starting");
    await store.transition(w.id, ["starting"], "running");
    // Stop 2, through the idle path, saves B.
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [w.id]);
    await store.stopIdle(w.id, new Date());
    const second = await generation(w.id);
    expect(BigInt(second)).toBe(BigInt(first) + 1n);
    const b = checkpoint(w.id);
    expect(await store.saveCheckpoint(w.id, "bx_gen", second, b)).toEqual({ replaced: null });
    // Stop 1's held save arrives while stop 2 is still stopping.
    expect(await store.saveCheckpoint(w.id, "bx_gen", first, checkpoint(w.id))).toBe(false);
    expect(await store.checkpointUpload(w.id, "bx_gen", first, checkpoint(w.id).object, new Date(Date.now() + 60_000))).toBe(false);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)?.checkpoint?.object).toBe(b.object);
    // An archive during the stop changes the document's time, not the stop.
    await store.requestLifecycle(w.id, creator, "archive");
    expect(await generation(w.id)).toBe(second);
    // The earlier stop can neither keep the VM's stop nor complete this one.
    expect(await store.stopCurrent(w.id, first)).toBe(false);
    expect(await store.stopCurrent(w.id, second)).toBe(true);
    expect(await store.transition(w.id, ["stopping"], "stopped", { stopGeneration: first })).toBeNull();
    expect(await store.transition(w.id, ["stopping"], "stopped", { stopGeneration: second })).toMatchObject({ state: "stopped" });
  });

  it("revokes a worker only when its own stop completes, never a worker a newer wake started", async () => {
    const w = await stopping("bx_revoke"), stop = await generation(w.id);
    // The stop's retry completes it; the workspace wakes and its new worker connects.
    await store.transition(w.id, ["stopping"], "stopped", { stopGeneration: stop, revoke: true });
    await store.transition(w.id, ["stopped"], "starting");
    const fresh = await store.rotateWorkerToken(w.id), boot = randomUUID();
    expect(await store.acceptWorkerHello(fresh, boot)).toMatchObject({ state: "running" });
    // The original stop's held reply finally completes: it moves nothing and revokes nothing.
    expect(await store.transition(w.id, ["stopping"], "stopped", { stopGeneration: stop, revoke: true })).toBeNull();
    expect(await store.workerSession(fresh, boot)).not.toBeNull();
    // A backoff from that stop cannot reschedule a newer one either.
    await store.transition(w.id, ["running"], "stopping");
    await store.defer(w.id, "stopping", 60_000, { failure: true, stopGeneration: stop });
    expect((await pool.query("SELECT next_attempt_at FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0].next_attempt_at).toBeNull();
  });

  it("restores only a starting workspace with a checkpoint, pinning the active Cloud Computer against cleanup", async () => {
    const w = await stopping("bx_lost");
    await save(w.id, "bx_lost", checkpoint(w.id));
    await store.transition(w.id, ["stopping"], "stopped");
    expect(await store.beginRestore(w.id, "bx_lost", request = attemptRequest())).toBeNull();
    await store.transition(w.id, ["stopped"], "starting");
    expect(await store.beginRestore(w.id, "bx_lost", request = attemptRequest())).toBe("no_computer");
    const computer = await activeComputer();
    expect(await store.beginRestore(w.id, "bx_other", request = attemptRequest())).toBeNull();
    const begun = await store.beginRestore(w.id, "bx_lost", request = attemptRequest());
    const { attempt: _attempt, ...requested } = request;
    expect(begun).toEqual({ attempt: request.attempt, create: { from: computer.snapshot, ...requested, requestedAt: expect.any(String) } });
    const pending = (await store.claimPending(4, 0)).find(row => row.id === w.id)!;
    expect(pending).toMatchObject({ restorePending: true, boatSandboxId: null, computerBuildId: computer.buildId,
      restoreAttempt: request.attempt, restoreCreate: { from: computer.snapshot, name: request.name, env: request.env } });
    // Cleanup sees the pin until the replacement exists.
    const { CloudV2Computers } = await import("./computer.js");
    const computers = new CloudV2Computers(pool);
    await pool.query("UPDATE cloud_v2_computers SET active_build_id=NULL WHERE org_id=$1", [org]);
    expect((await computers.resources(computer.buildId))?.pinned).toBe(true);
    // A late reply from another attempt cannot take this attempt's slot.
    expect(await store.replaceSandbox(w.id, randomUUID(), "bx_late", new Date())).toBeNull();
    expect(await store.replaceSandbox(w.id, request.attempt, "bx_new1", new Date())).toBe("starting");
    expect((await computers.resources(computer.buildId))?.pinned).toBe(false);
    expect(await store.replaceSandbox(w.id, request.attempt, "bx_new2", new Date())).toBeNull();
    expect(await store.finishRestore(w.id, "bx_other")).toBe(false);
    expect(await store.finishRestore(w.id, "bx_new1")).toBe(true);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)).toMatchObject({ restorePending: false, boatSandboxId: "bx_new1" });
  });

  it("keeps a replacement findable when a stop or deletion wins the race, and forgets the checkpoint once deleted", async () => {
    await activeComputer();
    const w = await stopping("bx_lost");
    await save(w.id, "bx_lost", checkpoint(w.id));
    await store.transition(w.id, ["stopping"], "stopped");
    await store.transition(w.id, ["stopped"], "starting");
    expect(await store.beginRestore(w.id, "bx_lost", request = attemptRequest())).toMatchObject({ attempt: request.attempt, create: { from: expect.any(String) } });
    await store.transition(w.id, ["starting"], "deleting");
    expect(await store.replaceSandbox(w.id, request.attempt, "bx_new1", new Date())).toBe("deleting");
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)).toMatchObject({ state: "deleting", boatSandboxId: "bx_new1", restorePending: true });
    // A replacement that never received the checkpoint can never replace it.
    expect(await save(w.id, "bx_new1", checkpoint(w.id))).toBe(false);
    await store.transition(w.id, ["deleting"], "deleted");
    const row = (await pool.query("SELECT checkpoint_object, checkpoint_key, restore_pending FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0];
    expect(row).toEqual({ checkpoint_object: null, checkpoint_key: null, restore_pending: false });
  });

  it("records the base commit once while creating and serves it to the first worker's configuration", async () => {
    const w = await create(), head = "c".repeat(40);
    await store.setBaseCommit(w.id, "not-a-commit");
    expect(await store.baseCommit(w.id)).toBeNull();
    await store.setBaseCommit(w.id, head);
    await store.setBaseCommit(w.id, "d".repeat(40));
    expect(await store.baseCommit(w.id)).toBe(head);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)?.baseCommit).toBe(head);
    // The worker's hello makes it running before its configuration is built.
    await store.defer(w.id, "creating", 0, { boatSandboxId: "bx_base" });
    expect(await store.acceptWorkerHello(await store.rotateWorkerToken(w.id), randomUUID())).toMatchObject({ state: "running" });
    expect(await store.baseCommit(w.id)).toBe(head);
    await store.setBaseCommit(w.id, "e".repeat(40));
    expect(await store.baseCommit(w.id)).toBe(head);
    // A restored workspace's branch already exists; the creation-time pin is never offered again.
    await store.transition(w.id, ["running"], "stopping");
    await save(w.id, "bx_base", checkpoint(w.id));
    await store.transition(w.id, ["stopping"], "stopped");
    await store.transition(w.id, ["stopped"], "starting");
    await store.transition(w.id, ["starting"], "running");
    expect(await store.baseCommit(w.id)).toBeNull();
  });

  it("restores with a new attempt identity each time, and keeps its recorded request through build cleanup", async () => {
    const computer = await activeComputer();
    const w = await stopping("bx_lost");
    await save(w.id, "bx_lost", checkpoint(w.id));
    await store.transition(w.id, ["stopping"], "stopped");
    await store.transition(w.id, ["stopped"], "starting");
    const first = await store.beginRestore(w.id, "bx_lost", request = attemptRequest());
    if (!first || first === "no_computer") throw new Error("restore did not begin");
    expect(first.attempt).toBe(request.attempt);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)?.restoreAttempt).toBe(first.attempt);
    expect(await store.replaceSandbox(w.id, first.attempt, "bx_first", new Date())).toBe("starting");
    // The replacement is lost as well: a second restore never reuses the first's identity.
    const second = await store.beginRestore(w.id, "bx_first", request = attemptRequest());
    if (!second || second === "no_computer") throw new Error("second restore did not begin");
    expect(second.attempt).not.toBe(first.attempt);
    // Organization deletion asks for cleanup: the recorded request still names the
    // pinned snapshot, which cleanup keeps while the replacement is unknown.
    await pool.query("UPDATE cloud_v2_computer_builds SET cleanup_requested_at=clock_timestamp() WHERE id=$1", [computer.buildId]);
    const pending = (await store.claimPending(4, 0)).find(row => row.id === w.id)!;
    expect(pending).toMatchObject({ restorePending: true, boatSandboxId: null, restoreAttempt: second.attempt, restoreCreate: { from: computer.snapshot, name: request.name } });
    const { CloudV2Computers } = await import("./computer.js");
    expect((await new CloudV2Computers(pool).resources(computer.buildId))?.pinned).toBe(true);
    // The replacement has its own boot deadline once the checkpoint is on it.
    await pool.query("UPDATE cloud_v2_workspaces SET updated_at=clock_timestamp()-interval '20 minutes' WHERE id=$1", [w.id]);
    expect(await store.replaceSandbox(w.id, second.attempt, "bx_second", new Date())).toBe("starting");
    expect(await store.finishRestore(w.id, "bx_second")).toBe(true);
    const restarted = (await store.claimPending(4, 0)).find(row => row.id === w.id)!;
    expect(Date.now() - Date.parse(restarted.updatedAt)).toBeLessThan(60_000);
  });

  it("admits an upload only while its stop owns the VM, and settling one keeps another's horizon", async () => {
    const w = await stopping("bx_upload"), a = checkpoint(w.id).object, b = checkpoint(w.id).object;
    const early = new Date(Date.now() + 25 * 60_000), later = new Date(early.getTime() + 60_000);
    expect(await store.checkpointUpload(w.id, "bx_other", await generation(w.id), a, early)).toBe(false);
    expect(await store.checkpointUpload(w.id, "bx_upload", await generation(w.id), a, early)).toBe(true);
    expect(await store.checkpointUpload(w.id, "bx_upload", await generation(w.id), b, later)).toBe(true);
    // B settles first: A's outcome is still unknown, so its horizon stays.
    await store.checkpointUploadDone(w.id, b);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)?.checkpointUploadUntil).toBe(early.toISOString());
    expect(await store.checkpointUploadHorizon(w.id)).toBe(early.toISOString());
    await store.checkpointUploadDone(w.id, a);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)?.checkpointUploadUntil).toBeNull();
    // An expired entry is dropped when the next is recorded; deletion never admits one.
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_uploads=jsonb_build_object('gone', clock_timestamp()-interval '1 minute') WHERE id=$1`, [w.id]);
    expect(await store.checkpointUpload(w.id, "bx_upload", await generation(w.id), a, early)).toBe(true);
    expect((await pool.query("SELECT checkpoint_uploads FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0].checkpoint_uploads).not.toHaveProperty("gone");
    await store.transition(w.id, ["stopping"], "deleting");
    expect(await store.checkpointUpload(w.id, "bx_upload", await generation(w.id), b, later)).toBe(false);
  });

  it.each(["creator", "relay"] as const)("fences the suspended process before a %s wake can race runtime installation", async source => {
    const w = await create(), oldToken = await store.rotateWorkerToken(w.id), oldBoot = randomUUID();
    await store.acceptWorkerHello(oldToken, oldBoot);
    await store.transition(w.id, ["running"], "stopped");
    if (source === "creator") await store.requestLifecycle(w.id, creator, "start");
    else await store.transition(w.id, ["stopped"], "starting");
    // Boat can restart the old service immediately on resume, before hostPort
    // and token delivery. Its old hello must not mark the workspace ready.
    expect(await store.acceptWorkerHello(oldToken, randomUUID())).toBeNull();
    expect(await store.workerSession(oldToken, oldBoot)).toBeNull();
    expect((await store.get(w.id, creator)).state).toBe("starting");
    expect((await store.workerRoute(w.id))?.bootId).toBeNull();
    const freshToken = await store.rotateWorkerToken(w.id);
    expect(await store.acceptWorkerHello(freshToken, randomUUID())).toMatchObject({ state: "running" });
  });

  it("revokes the stopped worker credential while retaining mirrored history", async () => {
    const w = await create(), token = await store.rotateWorkerToken(w.id);
    await store.acceptWorkerHello(token, randomUUID());
    await store.writeHistory(w.id, { chats: [{ id: "retained" }] });
    await store.revoke(w.id, false);
    expect(await store.byWorkerToken(token)).toBeNull();
    expect((await store.listChats(w.id)).chats).toEqual([{ id: "retained" }]);
  });

  it("stores private routing separately and fences ordered history by boot after a lost response", async () => {
    const w = await create(), token = await store.rotateWorkerToken(w.id), bootId = randomUUID();
    await store.defer(w.id, "creating", 0, { boatSandboxId: "bx_test" });
    await store.setWorkerRoute(w.id, "bx_test", "https://fixture-41783.on.boat.dev", { encrypted: true });
    expect(await store.acceptWorkerHello(token, bootId)).toMatchObject({ state: "running" });
    expect(await store.workerRoute(w.id)).toMatchObject({ url: "https://fixture-41783.on.boat.dev", bootId, portToken: { encrypted: true } });
    expect(await store.get(w.id, creator)).not.toHaveProperty("portToken");
    const history = { chats: [{ id: "chat", title: "first" }] };
    await store.writeWorkerHistory(token, bootId, 1, history);
    // A committed response was lost. The same request is acknowledged once;
    // its first-insert ordering and row timestamps are retained.
    const before = await pool.query("SELECT updated_at FROM cloud_v2_chats WHERE workspace_id=$1", [w.id]);
    await store.writeWorkerHistory(token, bootId, 1, history);
    expect((await pool.query("SELECT updated_at FROM cloud_v2_chats WHERE workspace_id=$1", [w.id])).rows).toEqual(before.rows);
    await expect(store.writeWorkerHistory(token, bootId, 3, history)).rejects.toMatchObject({ code: "history_sequence_gap" });
    await expect(store.writeWorkerHistory(token, bootId, 1, { chats: [{ id: "other" }] })).rejects.toMatchObject({ code: "history_sequence_conflict" });
    const nextBoot = randomUUID();
    await store.acceptWorkerHello(token, nextBoot);
    await expect(store.writeWorkerHistory(token, bootId, 2, history)).rejects.toMatchObject({ code: "worker_boot_changed" });
    await store.writeWorkerHistory(token, nextBoot, 1, { chats: [{ id: "chat", title: "second" }] });
    expect((await store.listChats(w.id)).chats).toMatchObject([{ id: "chat", title: "second" }]);
  });

  it("creates a workspace only its creator can read, and returns the worker token once", async () => {
    const workspace = await create();
    expect(workspace.state).toBe("creating");
    const workerToken = await store.rotateWorkerToken(workspace.id);
    expect(workerToken).toMatch(/^zw2w_/);
    expect((await store.get(workspace.id, creator)).id).toBe(workspace.id);
    await expect(store.get(workspace.id, member)).rejects.toMatchObject({ status: 404 });
    expect(await store.list(org, member)).toEqual([]);
    expect((await store.byWorkerToken(workerToken))?.id).toBe(workspace.id);
    const stored = await pool.query(`SELECT worker_token_hash FROM cloud_v2_workspaces WHERE id = $1`, [workspace.id]);
    expect(stored.rows[0].worker_token_hash.toString("utf8")).not.toContain(workerToken);
  });

  it("refuses non-members, personal organizations and organizations without cloud", async () => {
    const outsider = await user();
    await expect(store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: outsider, name: "x", repository: "o/r",
      branch: "main", baseBranch: "main", computerBuildId: null })).rejects.toMatchObject({ status: 404 });
    await pool.query(`UPDATE organizations SET cloud_workspaces_allowed = false WHERE id = $1`, [org]);
    await expect(create()).rejects.toMatchObject({ status: 404 });
  });

  it("moves state only from the expected states and forgets the worker on delete", async () => {
    const workspace = await create();
    const workerToken = await store.rotateWorkerToken(workspace.id);
    expect(await store.transition(workspace.id, ["stopped"], "starting")).toBeNull();
    expect((await store.transition(workspace.id, ["creating"], "running", { boatSandboxId: "bx_abc" }))?.boatSandboxId).toBe("bx_abc");
    expect((await store.transition(workspace.id, ["running"], "deleted"))?.state).toBe("deleted");
    expect(await store.byWorkerToken(workerToken)).toBeNull();
    await expect(store.get(workspace.id, creator)).rejects.toMatchObject({ status: 404 });
  });

  it("starts a fresh idle window each time the workspace runs; waiting keeps the state's start and resets failures", async () => {
    const workspace = await create();
    await store.transition(workspace.id, ["creating"], "running");
    await pool.query(`UPDATE cloud_v2_workspaces SET active_at = now() - interval '1 hour' WHERE id = $1`, [workspace.id]);
    for (const [from, to] of [["running", "stopping"], ["stopping", "stopped"], ["stopped", "starting"]] as const) await store.transition(workspace.id, [from], to);
    const entered = (await store.get(workspace.id, creator)).updatedAt;
    expect((await store.claimPending(10, 0))[0]!.attempts).toBe(1);
    await store.defer(workspace.id, "starting", 0, { failure: true });
    expect((await store.claimPending(10, 0))[0]!.attempts).toBe(2);
    await store.defer(workspace.id, "starting", 0);
    expect((await store.claimPending(10, 0))[0]!.attempts).toBe(1);
    expect((await store.get(workspace.id, creator)).updatedAt).toBe(entered);
    await store.transition(workspace.id, ["starting"], "running");
    expect(await store.idleSince(new Date(Date.now() - 10 * 60_000))).toEqual([]);
  });

  it("consumes a connect ticket exactly once, and only for its workspace and creator", async () => {
    const workspace = await create();
    const other = await create();
    const { token } = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator, ttlMs: 60_000 });
    expect(await store.consumeConnectTicket(token, other.id)).toBeNull();
    expect(await store.consumeConnectTicket(token, workspace.id)).toEqual({ userId: creator, accessEpoch: "0", wake: true, sessionId: null });
    expect(await store.consumeConnectTicket(token, workspace.id)).toBeNull();
    const expired = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator, ttlMs: -1 });
    expect(await store.consumeConnectTicket(expired.token, workspace.id)).toBeNull();
  });

  it("mirrors chats and rows in Local's order, keeping first-insert position on update", async () => {
    const workspace = await create();
    await store.writeHistory(workspace.id, { chats: [{ id: "c1", title: "One" } as { id: string }] });
    const row = (msgId: string, text: string) => ({ msgId, kind: "agent", payload: JSON.stringify({ id: msgId, text }), createdAt: 1 });
    await store.writeHistory(workspace.id, { messages: { chatId: "c1", rows: [row("m1", "a"), row("m2", "b")] } });
    await store.writeHistory(workspace.id, { messages: { chatId: "c1", rows: [row("m1", "a, edited")] } });
    expect((await store.windowMessages(workspace.id, "c1", 10)).map(r => [r.msgId, JSON.parse(r.payload).text])).toEqual([["m1", "a, edited"], ["m2", "b"]]);
    expect((await store.windowMessages(workspace.id, "c1", 1)).map(r => r.msgId)).toEqual(["m2"]);
    await store.writeHistory(workspace.id, { chatDeletions: ["c1"] });
    expect(await store.listChats(workspace.id)).toEqual({ chats: [], chatDeletions: ["c1"] });
    expect(await store.windowMessages(workspace.id, "c1", 10)).toEqual([]);
  });

  it.each([false, true, undefined])("persists HTTP connect wake intent without restarting passive workspaces (%s)", async wake => {
    const created = await create();
    await store.transition(created.id, ["creating"], "stopped");
    await store.requestLifecycle(created.id, creator, "archive");
    const before = await store.get(created.id, creator);
    await pool.query(`INSERT INTO user_identities (user_id, provider, provider_sub, email_at_link)
      VALUES ($1::uuid, 'workos', ($1::uuid)::text, 'fixture@example.test')`, [creator]);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: creator, accountRevision: 1,
      identity: { provider: "workos", subject: creator }, authentication: { sessionId: null, tokenExpiresAt: null } } as never); await next(); });
    app.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://dev.example.test" } as CloudV2RouteDeps));
    const response = await app.request(`/v1/cloud-v2/workspaces/${created.id}/connect`, { method: "POST",
      ...(wake === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ wake }) }) });
    expect(response.status).toBe(200);
    const after = await store.get(created.id, creator);
    if (wake === false) expect(after).toEqual(before);
    else expect(after).toMatchObject({ state: "starting", archivedAt: null });
    const { protocols } = await response.json();
    const token = protocols[1].slice("ticket.".length);
    expect(await store.consumeConnectTicket(token, created.id)).toEqual({ userId: creator, accessEpoch: "0", wake: wake !== false, sessionId: null });
    expect(await store.consumeConnectTicket(token, created.id)).toBeNull();
  });

  it("verifies proxy tokens only while the workspace runs", async () => {
    const workspace = await create();
    const { token } = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: 60_000 });
    expect(await store.verifyProxyToken(token)).toBeNull();
    await store.transition(workspace.id, ["creating"], "running");
    expect((await store.verifyProxyToken(token))?.id).toBe(workspace.id);
  });

  it.each(["organization.access_revoked", "workspace.authorization_changed", "account.revoked", "account.authorization_changed"])("revokes worker, proxy and outstanding tickets atomically for %s", async kind => {
    const w = await create();
    await store.transition(w.id, ["creating"], "running");
    const worker = await store.rotateWorkerToken(w.id);
    const proxy = await store.issueToken({ workspaceId: w.id, kind: "proxy", userId: null, ttlMs: 60_000 });
    const ticket = await store.issueToken({ workspaceId: w.id, kind: "connect", userId: creator, ttlMs: 60_000 });
    await pool.query(`INSERT INTO security_events (kind, user_id, org_id, workspace_id) VALUES ($1, $2, $3, $4)`,
      [kind, creator, org, kind === "workspace.authorization_changed" ? w.id : null]);
    expect(await store.byWorkerToken(worker)).toBeNull();
    expect(await store.verifyProxyToken(proxy.token)).toBeNull();
    expect(await store.consumeConnectTicket(ticket.token, w.id)).toBeNull();
    expect((await store.get(w.id, creator)).state).toBe("stopping");
  });

  it("never treats a session event without a sid as account-wide sign-out", async () => {
    const w = await create();
    await store.transition(w.id, ["creating"], "running");
    const worker = await store.rotateWorkerToken(w.id);
    const proxy = await store.issueToken({ workspaceId: w.id, kind: "proxy", userId: null, ttlMs: 60_000 });
    const ticket = await store.issueToken({ workspaceId: w.id, kind: "connect", userId: creator, ttlMs: 60_000 });
    const epoch = await store.accessEpoch(w.id);
    await pool.query("INSERT INTO security_events (kind, user_id) VALUES ('session.revoked', $1)", [creator]);
    expect(await store.byWorkerToken(worker)).toMatchObject({ id: w.id, state: "running" });
    expect(await store.verifyProxyToken(proxy.token)).toMatchObject({ id: w.id });
    expect(await store.accessEpoch(w.id)).toBe(epoch);
    expect(await store.consumeConnectTicket(ticket.token, w.id)).toMatchObject({ userId: creator, sessionId: null });
  });

  it("refuses existing worker and proxy credentials when membership disappears without a notification", async () => {
    const w = await create();
    await store.transition(w.id, ["creating"], "running");
    const worker = await store.rotateWorkerToken(w.id);
    const proxy = await store.issueToken({ workspaceId: w.id, kind: "proxy", userId: null, ttlMs: 60_000 });
    await pool.query(`DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`, [org, creator]);
    expect(await store.byWorkerToken(worker)).toBeNull();
    expect(await store.verifyProxyToken(proxy.token)).toBeNull();
  });

  it("archives every accepted state, retains the timestamp on retry, and persists it in list/get", async () => {
    for (const state of ["running", "starting", "stopping", "stopped", "failed"] as const) {
      const created = await create();
      expect(created.archivedAt).toBeNull();
      await store.transition(created.id, ["creating"], state);
      const moved = state === "running" || state === "starting";
      const archived = await store.requestLifecycle(created.id, creator, "archive");
      expect(archived.moved).toBe(moved);
      expect(archived.workspace.state).toBe(moved ? "stopping" : state);
      const timestamp = archived.workspace.archivedAt!;
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
      expect((await store.get(created.id, creator)).archivedAt).toBe(timestamp);
      expect((await store.list(org, creator)).find(row => row.id === created.id)?.archivedAt).toBe(timestamp);
      expect(await store.requestLifecycle(created.id, creator, "archive"))
        .toMatchObject({ moved: false, workspace: { archivedAt: timestamp } });
      if (archived.workspace.state === "stopping") {
        expect(await store.transition(created.id, ["stopping"], "stopped"))
          .toMatchObject({ state: "stopped", archivedAt: timestamp });
      }
    }
  });

  it("refuses archive during creation/deletion and for another member or a departed creator", async () => {
    const created = await create();
    for (const state of ["creating", "deleting"] as const) {
      await store.transition(created.id, ["creating"], state);
      await expect(store.requestLifecycle(created.id, creator, "archive"))
        .rejects.toMatchObject({ status: 409, code: "workspace_unavailable" });
      expect((await store.get(created.id, creator)).archivedAt).toBeNull();
    }
    await store.transition(created.id, ["deleting"], "stopped");
    await expect(store.requestLifecycle(created.id, member, "archive")).rejects.toMatchObject({ status: 404 });
    await pool.query(`DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`, [org, creator]);
    await expect(store.requestLifecycle(created.id, creator, "archive")).rejects.toMatchObject({ status: 404 });
    const { rows } = await pool.query(`SELECT state, archived_at FROM cloud_v2_workspaces WHERE id = $1`, [created.id]);
    expect(rows[0]).toMatchObject({ state: "stopped", archived_at: null });
  });

  it("restores archived stopped/failed workspaces and clears archive while a stop is pending", async () => {
    for (const state of ["stopped", "failed", "stopping"] as const) {
      const created = await create();
      await store.transition(created.id, ["creating"], state);
      await store.requestLifecycle(created.id, creator, "archive");
      const moved = state !== "stopping";
      const restored = await store.requestLifecycle(created.id, creator, "start");
      expect(restored).toMatchObject({ moved, workspace: { state: moved ? "starting" : state, archivedAt: null } });
      expect((await store.get(created.id, creator)).archivedAt).toBeNull();
    }
  });

  it("keeps ordinary/idle stop unarchived and clears archive on a successful connect wake only", async () => {
    const created = await create();
    await store.transition(created.id, ["creating"], "running");
    expect(await store.requestLifecycle(created.id, creator, "stop"))
      .toMatchObject({ moved: true, workspace: { state: "stopping", archivedAt: null } });
    expect(await store.transition(created.id, ["stopping"], "stopped"))
      .toMatchObject({ state: "stopped", archivedAt: null });
    await store.transition(created.id, ["stopped"], "running");
    expect(await store.transition(created.id, ["running"], "stopping"))
      .toMatchObject({ state: "stopping", archivedAt: null });
    await store.transition(created.id, ["stopping"], "stopped");
    await store.requestLifecycle(created.id, creator, "archive");
    expect(await store.transition(created.id, ["running"], "starting")).toBeNull();
    expect((await store.get(created.id, creator)).archivedAt).not.toBeNull();

    const app = new Hono();
    await pool.query(`INSERT INTO user_identities (user_id, provider, provider_sub, email_at_link) VALUES ($1::uuid, 'workos', ($1::uuid)::text, 'fixture@example.test')`, [creator]);
    app.use("*", async (c, next) => { c.set("user", { id: creator, accountRevision: 1,
      identity: { provider: "workos", subject: creator }, authentication: { sessionId: null, tokenExpiresAt: null } } as never); await next(); });
    app.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://dev.example.test" } as CloudV2RouteDeps));
    expect((await app.request(`/v1/cloud-v2/workspaces/${created.id}/connect`, { method: "POST" })).status).toBe(200);
    expect(await store.get(created.id, creator)).toMatchObject({ state: "starting", archivedAt: null });
  });

  it("versions archive metadata without rescheduling a stop already in progress", async () => {
    const created = await create();
    await store.transition(created.id, ["creating"], "stopping");
    await store.defer(created.id, "stopping", 60_000, { failure: true });
    await pool.query(`UPDATE cloud_v2_workspaces SET updated_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [created.id]);
    const scheduling = async () => (await pool.query(
      `SELECT attempts, next_attempt_at, updated_at FROM cloud_v2_workspaces WHERE id = $1`, [created.id],
    )).rows[0];
    const before = await scheduling();
    const archived = await store.requestLifecycle(created.id, creator, "archive");
    expect(archived.moved).toBe(false);
    expect(Date.parse(archived.workspace.updatedAt)).toBeGreaterThan(before.updated_at.getTime());
    const after = await scheduling();
    expect(after).toMatchObject({ attempts: before.attempts, next_attempt_at: before.next_attempt_at });
    expect((await store.requestLifecycle(created.id, creator, "archive")).workspace.updatedAt).toBe(archived.workspace.updatedAt);
    expect((await store.requestLifecycle(created.id, creator, "start")).moved).toBe(false);
    expect(await scheduling()).toMatchObject({ attempts: before.attempts, next_attempt_at: before.next_attempt_at });
  });

  it("rechecks the state after a concurrent deletion wins the workspace lock", async () => {
    const created = await create();
    await store.transition(created.id, ["creating"], "running");
    const blocker = await pool.connect();
    let result: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      await blocker.query(`UPDATE cloud_v2_workspaces SET state = 'deleting' WHERE id = $1`, [created.id]);
      result = store.requestLifecycle(created.id, creator, "archive").catch(error => error);
      await expect.poll(async () => (await pool.query(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting`, [pid],
      )).rows[0].waiting).toBe(true);
      await blocker.query("COMMIT");
      await expect(result).resolves.toMatchObject({ status: 409 });
      expect(await store.get(created.id, creator)).toMatchObject({ state: "deleting", archivedAt: null });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await result;
    }
  });
});
