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

  async function retainedCandidate(days = 12) {
    const w = await create();
    await store.transition(w.id, ["creating"], "stopped", { boatSandboxId: `bx_${w.id.slice(0, 8)}` });
    await pool.query("UPDATE cloud_v2_workspaces SET stopped_at=clock_timestamp()-make_interval(days=>$2) WHERE id=$1", [w.id, days]);
    const rows = await store.retentionDue(new Date(Date.now() - 12 * 86_400_000), 10);
    return rows.find(row => row.id === w.id)!;
  }

  it("starts retention age only on a completed stop and preserves it through archive metadata changes", async () => {
    const w = await create();
    const stoppedAt = async () => (await pool.query("SELECT stopped_at FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0].stopped_at;
    expect(await stoppedAt()).toBeNull();
    await store.transition(w.id, ["creating"], "running");
    await store.transition(w.id, ["running"], "stopping");
    expect(await stoppedAt()).toBeNull();
    await store.transition(w.id, ["stopping"], "stopped");
    const first = await stoppedAt();
    expect(first).toBeInstanceOf(Date);
    await store.requestLifecycle(w.id, creator, "archive");
    expect(await stoppedAt()).toEqual(first);
    expect(await store.retentionDue(new Date(Date.now() - 12 * 86_400_000), 10)).toEqual([]);
  });

  it("claims one retention save durably across lifecycle replicas and fences wake until it finishes", async () => {
    const a = await retainedCandidate(13), b = await retainedCandidate(13);
    const claimed = await Promise.all([store.beginRetention(a, "zeros-alpha-ret-a"), store.beginRetention(b, "zeros-alpha-ret-b")]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const w = claimed[0] ? a : b, name = claimed[0] ? "zeros-alpha-ret-a" : "zeros-alpha-ret-b";
    await store.requestLifecycle(w.id, creator, "start");
    expect((await store.claimPending(4, 0)).some(row => row.id === w.id)).toBe(false);
    const intent = (await pool.query("SELECT retention_snapshot,retention_saved_at,retention_operation_until FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0];
    expect(intent.retention_snapshot).toBe(name); expect(intent.retention_saved_at).toBeNull();
    expect(intent.retention_operation_until.getTime()).toBeGreaterThan(Date.now());
    await store.finishRetention(w.id, w.boatSandboxId!, name);
    expect((await store.claimPending(4, 0)).find(row => row.id === w.id)).toMatchObject({ retentionSnapshot: name, retentionSavedAt: expect.any(String), state: "starting" });
    expect(await store.get(w.id, creator)).not.toHaveProperty("retentionSnapshot");
  });

  it("keeps failed retention intent through its remote deadline and rejects stale save receipts", async () => {
    const w = await retainedCandidate(13);
    expect(await store.beginRetention(w, "zeros-alpha-ret-keep")).toBe(true);
    await store.deferRetention(w.id, "zeros-alpha-ret-keep");
    expect(await store.retentionDue(new Date(), 10)).toEqual([]);
    await store.finishRetention(w.id, "bx_obsolete", "zeros-alpha-ret-keep");
    expect((await pool.query("SELECT retention_saved_at FROM cloud_v2_workspaces WHERE id=$1", [w.id])).rows[0].retention_saved_at).toBeNull();
    await pool.query("UPDATE cloud_v2_workspaces SET retention_operation_until=clock_timestamp()-interval '1 second',next_attempt_at=NULL WHERE id=$1", [w.id]);
    expect((await store.retentionDue(new Date(), 10))[0]).toMatchObject({ retentionSnapshot: "zeros-alpha-ret-keep", retentionSavedAt: null });
    await store.transition(w.id, ["stopped"], "starting");
    expect(await store.beginRetention(w, "zeros-alpha-ret-other")).toBe(false);
  });

  it("can recover a named save from a claimed wake after the original save's acknowledgement was lost", async () => {
    const w = await retainedCandidate(15), name = "zeros-alpha-ret-unacknowledged";
    await store.beginRetention(w, name);
    await pool.query("UPDATE cloud_v2_workspaces SET retention_operation_until=clock_timestamp()-interval '1 second' WHERE id=$1", [w.id]);
    await store.requestLifecycle(w.id, creator, "start");
    const claimed = (await store.claimPending(4, 120_000))[0]!;
    expect(await store.beginRetention(claimed, name)).toBe(true);
    await store.finishRetention(w.id, w.boatSandboxId!, name);
    expect(await store.beginRestore(w.id, w.boatSandboxId, name)).toBe(true);
  });

  it("cleans retention after hello or a later stop, while preserving a sleeping workspace's current snapshot", async () => {
    const w = await retainedCandidate(13), name = "zeros-alpha-ret-clean";
    await store.beginRetention(w, name); await store.finishRetention(w.id, w.boatSandboxId!, name);
    expect(await store.retentionCleanupDue()).toEqual([]);
    await store.transition(w.id, ["stopped"], "starting");
    expect(await store.retentionCleanupDue()).toEqual([]);
    const token = await store.rotateWorkerToken(w.id); await store.acceptWorkerHello(token, randomUUID());
    expect((await store.retentionCleanupDue()).map(row => row.id)).toEqual([w.id]);
    // A rapid second stop before cleanup cannot keep using the previous stop's image.
    await store.transition(w.id, ["running"], "stopping"); await store.transition(w.id, ["stopping"], "stopped");
    expect((await store.retentionCleanupDue()).map(row => row.id)).toEqual([w.id]);
    expect(await store.beginRetentionCleanup(w.id, name)).toBe(true);
    await store.requestLifecycle(w.id, creator, "start");
    expect(await store.claimPending(4, 0)).toEqual([]);
    await store.finishRetentionCleanup(w.id, name);
    expect((await store.claimPending(4, 0))[0]).toMatchObject({ retentionSnapshot: null, retentionSavedAt: null });
  });

  it("retains a pending restore allocation through a deletion race and records its new sandbox for erasure", async () => {
    const w = await retainedCandidate(13), name = "zeros-alpha-ret-restore";
    await store.beginRetention(w, name); await store.finishRetention(w.id, w.boatSandboxId!, name);
    await store.transition(w.id, ["stopped"], "starting");
    expect(await store.beginRestore(w.id, w.boatSandboxId, name)).toBe(true);
    expect(await store.claimPending(4, 0)).toEqual([]);
    await store.transition(w.id, ["starting"], "deleting");
    expect(await store.claimPending(4, 0)).toEqual([]);
    expect(await store.finishRestore(w.id, w.boatSandboxId, name, "bx_restored", new Date())).toBe("deleting");
    expect((await store.claimPending(4, 0))[0]).toMatchObject({ state: "deleting", boatSandboxId: "bx_restored", restorePending: false, retentionSnapshot: name });
    expect(await store.finishRestore(w.id, w.boatSandboxId, name, "bx_wrong", new Date())).toBeNull();
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
