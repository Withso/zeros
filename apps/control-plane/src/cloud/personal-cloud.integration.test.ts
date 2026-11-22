// Cloud in a Personal organization (C3): the access matrix through the routes
// production mounts. Pro and the switch on: the creator's own cloud. The switch
// off or no Pro: as before. Every team path refuses.
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureCloudPersonal } from "../db-context.js";
import { withSystemTx } from "../db.js";
import { CloudV2Computers } from "./computer.js";
import * as runtime from "./runtime-capabilities.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";
import { manageCloudExecution } from "../manage-cloud-execution.js";
import { CLOUD_V2_IDLE_STOP_MS } from "./lifecycle.js";
import { randomUUID } from "node:crypto";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud in a Personal organization", () => {
  let pool: pg.Pool, f: ExecutionFixture | undefined;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); f = undefined; configureCloudPersonal(pool, false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  async function setup(options: { actingUserDefault?: boolean } = {}) {
    vi.spyOn(runtime, "activeRuntimeQualification").mockReturnValue(async () => ({ version: 1, sha256: "b".repeat(64),
      sourceSha256: "c".repeat(64), commit: "d".repeat(40), features: ["acting-user-v1", "sync-context-v1"] }));
    f = await executionFixture(pool, { personal: true, actingUserDefault: options.actingUserDefault ?? false });
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const build = await computers.enqueue(f.organizationId, f.creator.id, { repositories: [{ repository: "example/project", branch: "main", setup: "" }] });
    await computers.claim(); await computers.activate(build.id, "fresh-fixture-snapshot");
    vi.spyOn(f.cp.routes, "remoteHead").mockResolvedValue("a".repeat(40));
    return f;
  }
  const create = (fixture: ExecutionFixture, headers: Record<string, string> = {}) => fixture.call("/v1/cloud-v2/workspaces", "POST",
    { organizationId: fixture.organizationId, repository: "example/project", name: "Personal workspace" }, fixture.creator, headers);
  const mode = async (id: string) => (await pool.query("SELECT execution_mode FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].execution_mode;

  it.each([false, true])("creates the owner's workspace on the creator path, whatever the shared-execution default (%s)", async actingUserDefault => {
    const fixture = await setup({ actingUserDefault });
    const response = await create(fixture);
    expect(response.status).toBe(201);
    const { workspace } = await response.json();
    expect(workspace.creatorUserId).toBe(fixture.creator.id);
    expect(await mode(workspace.id)).toBe("legacy");
    // Waking, restarting and stopping it never convert it: only the operator's activation writes shared execution.
    for (const action of ["start", "restart", "stop", "start"]) {
      const response = await fixture.call(`/v1/cloud-v2/workspaces/${workspace.id}/${action}`, "POST", {});
      expect(response.status, action).toBeLessThan(500);
      expect(await mode(workspace.id), action).toBe("legacy");
    }
  });

  it("offers no public API there: API keys are refused, so no API create reaches a Personal organization", async () => {
    const fixture = await setup({ actingUserDefault: true });
    await expect(fixture.cp.api.credentials.create(fixture.organizationId, fixture.creator.id, "Fixture")).rejects.toMatchObject({ status: 404 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_api_keys WHERE org_id=$1", [fixture.organizationId])).rows[0].n).toBe(0);
  });

  it("refuses as before with the switch off, and without Pro", async () => {
    const fixture = await setup();
    configureCloudPersonal(pool, false);
    expect((await create(fixture)).status).toBe(404);
    expect((await fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}`)).status).toBe(404);
    configureCloudPersonal(pool, true);
    await pool.query("DELETE FROM account_entitlements WHERE user_id=$1", [fixture.creator.id]);
    expect((await create(fixture)).status).toBe(404);
  });

  it("has no team: a team-sharing request answers as a server without team sharing, through the creator routes", async () => {
    const fixture = await setup();
    const team = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" };
    const list = await fixture.call(`/v1/cloud-v2/workspaces?organizationId=${fixture.organizationId}&archived=include&limit=200`, "GET", undefined, fixture.creator, team);
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.teamSharing).toBeUndefined();
    expect(listed.workspaces.map((row: { id: string }) => row.id).sort()).toEqual([fixture.workspace.id, fixture.own.id].sort());
    const read = await fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}`, "GET", undefined, fixture.creator, team);
    expect(read.status).toBe(200);
    const document = await read.json();
    expect(document.teamSharing).toBeUndefined();
    expect(document.workspace.teamSharing).toBeUndefined();
    // Team-only routes are absent.
    for (const [path, method] of [["follow", "POST"], ["pin", "POST"], ["followers", "GET"], ["events", "GET"], ["reassign-candidates", "GET"]] as const)
      expect((await fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}/${path}`, method, method === "POST" ? {} : undefined, fixture.creator, team)).status, path).toBe(404);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspace_pins WHERE workspace_id=$1", [fixture.workspace.id])).rows[0].n).toBe(0);
    // Someone outside the organization learns nothing, with or without the header.
    for (const headers of [team, {}])
      expect((await fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}`, "GET", undefined, fixture.outsider, headers)).status).toBe(404);
  });

  it("refuses shared execution: an active workspace there has no live access and no execution authority", async () => {
    const fixture = await setup();
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active',execution_initiator_user_id=creator_user_id WHERE id=$1", [fixture.workspace.id]);
    const live = await withSystemTx(pool, tx => tx.query(`SELECT ${CLOUD_V2_LIVE_ACCESS} AS live FROM cloud_v2_workspaces w WHERE w.id=$1`, [fixture.workspace.id]));
    expect(live.rows[0].live).toBe(false);
    await expect(withSystemTx(pool, tx => fixture.cp.execution.deps.authority.snapshot(tx, fixture.workspace.id, fixture.creator.id)))
      .rejects.toMatchObject({ code: "member_access_revoked" });
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='legacy' WHERE id=$1", [fixture.workspace.id]);
    const own = await withSystemTx(pool, tx => tx.query(`SELECT ${CLOUD_V2_LIVE_ACCESS} AS live FROM cloud_v2_workspaces w WHERE w.id=$1`, [fixture.workspace.id]));
    expect(own.rows[0].live).toBe(true);
  });

  it("the operator cannot prepare or activate shared execution for a Personal workspace, and nothing is written", async () => {
    const fixture = await setup();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.admin.id]);
    const before = (await pool.query("SELECT execution_mode,access_epoch,stop_generation FROM cloud_v2_workspaces WHERE id=$1", [fixture.workspace.id])).rows[0];
    for (const action of ["prepare", "activate"] as const)
      await expect(manageCloudExecution(pool, { activationId: randomUUID(), action, channel: "development", organizationId: fixture.organizationId,
        workspaceId: fixture.workspace.id, initiatorUserId: fixture.creator.id, operatorUserId: fixture.admin.id,
        runtimeSha256: "b".repeat(64), reason: "Local fixture: Personal stays on the creator path" }, { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "development" }))
        .rejects.toThrow("A Personal organization's cloud workspaces run on the creator path only");
    expect((await pool.query("SELECT execution_mode,access_epoch,stop_generation FROM cloud_v2_workspaces WHERE id=$1", [fixture.workspace.id])).rows[0]).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_execution_activations WHERE workspace_id=$1", [fixture.workspace.id])).rows[0].n).toBe(0);
  });

  it("when Pro ends with no event, the owner's workspace answers pro_required, stays listed, and opens again with Pro", async () => {
    const fixture = await setup();
    const team = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" };
    const read = (user = fixture.creator, headers: Record<string, string> = team) =>
      fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}`, "GET", undefined, user, headers);
    const listed = async () => {
      const response = await fixture.call(`/v1/cloud-v2/workspaces?organizationId=${fixture.organizationId}&archived=include&limit=200`, "GET", undefined, fixture.creator, team);
      expect(response.status).toBe(200);
      return (await response.json()).workspaces.find((row: { id: string }) => row.id === fixture.workspace.id);
    };
    const before = await listed();
    // A window that has already closed, as when Pro ends by itself (cloud-organization-enabled.integration.test.ts proves no write is needed).
    await pool.query("UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [fixture.creator.id]);
    for (const headers of [team, {}]) {
      const response = await read(fixture.creator, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "pro_required", message: "Cloud workspaces need Pro. This workspace opens again when Pro is active." } });
    }
    expect((await fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}/start`, "POST", {}, fixture.creator, team)).status).toBe(403);
    // Listed with the same state, not dropped.
    expect(await listed()).toMatchObject({ id: before.id, state: before.state });
    // Nobody else learns it exists, and with the switch off it is the 404 of before.
    expect((await read(fixture.outsider)).status).toBe(404);
    configureCloudPersonal(pool, false);
    expect((await read()).status).toBe(404);
    configureCloudPersonal(pool, true);
    // Pro again: it opens, with no repair step.
    await pool.query("UPDATE account_entitlements SET valid_until=NULL WHERE user_id=$1", [fixture.creator.id]);
    expect((await read()).status).toBe(200);
  });

  async function runningWithEndedPro(fixture: ExecutionFixture, lastActivityMinutes: number) {
    const id = fixture.workspace.id, bootId = randomUUID();
    await pool.query(`UPDATE cloud_v2_workspaces SET state='running',worker_boot_id=$2,active_at=clock_timestamp()-$3*interval '1 minute' WHERE id=$1`,
      [id, bootId, lastActivityMinutes]);
    const row = (await pool.query("SELECT access_epoch::text,encode(worker_token_hash,'hex') AS hash FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];
    await pool.query("UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [fixture.creator.id]);
    return { workspaceId: id, bootId, accessEpoch: row.access_epoch, workerTokenHash: row.hash };
  }

  it("stops a running machine by the idle stop, 20 minutes after its last activity, which stops advancing when Pro ends", async () => {
    expect(CLOUD_V2_IDLE_STOP_MS).toBe(20 * 60_000);
    const fixture = await setup(), binding = await runningWithEndedPro(fixture, 19);
    // The worker's relay is refused at once and records no activity.
    const before = (await pool.query("SELECT active_at FROM cloud_v2_workspaces WHERE id=$1", [binding.workspaceId])).rows[0].active_at;
    for (const idle of [false, true]) expect(await fixture.cp.store.relayActivity(binding, idle)).toBeNull();
    expect((await pool.query("SELECT active_at FROM cloud_v2_workspaces WHERE id=$1", [binding.workspaceId])).rows[0].active_at).toEqual(before);
    const cutoff = () => new Date(Date.now() - CLOUD_V2_IDLE_STOP_MS);
    expect((await fixture.cp.store.idleSince(cutoff())).map(row => row.id)).not.toContain(binding.workspaceId);
    // Past the bound, the lifecycle's sweep stops it.
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()-interval '21 minutes' WHERE id=$1", [binding.workspaceId]);
    expect((await fixture.cp.store.idleSince(cutoff())).map(row => row.id)).toContain(binding.workspaceId);
    await fixture.cp.store.stopIdle(binding.workspaceId, cutoff());
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [binding.workspaceId])).rows[0].state).toBe("stopping");
  });

  it("issues no worker or model credential once Pro ends: the worker token and a proxy token issued before are refused at once", async () => {
    const fixture = await setup(), id = fixture.workspace.id;
    await pool.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [id]);
    const worker = await fixture.cp.store.rotateWorkerToken(id);
    const proxy = await fixture.cp.store.issueToken({ workspaceId: id, kind: "proxy", userId: null, ttlMs: 60_000 });
    expect(await fixture.cp.store.byWorkerToken(worker)).not.toBeNull();
    expect(await fixture.cp.store.verifyProxyToken(proxy.token)).not.toBeNull();
    await pool.query("UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [fixture.creator.id]);
    expect(await fixture.cp.store.byWorkerToken(worker)).toBeNull();
    expect(await fixture.cp.store.verifyProxyToken(proxy.token)).toBeNull();
    await expect(fixture.cp.store.issueToken({ workspaceId: id, kind: "proxy", userId: null, ttlMs: 60_000 })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the workspaces and the active build but builds nothing once Pro ends; Pro again opens them and builds again", async () => {
    const fixture = await setup();
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const queued = await computers.enqueue(fixture.organizationId, fixture.creator.id, { repositories: [{ repository: "example/project", branch: "main", setup: "" }] });
    await pool.query("UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [fixture.creator.id]);
    const active = (await pool.query("SELECT active_build_id,snapshot_name FROM cloud_v2_computers WHERE org_id=$1", [fixture.organizationId])).rows[0];
    // As for any organization whose requester lost access: the queued build is cancelled, never started.
    expect(await computers.claim()).toBeNull();
    expect((await pool.query("SELECT state FROM cloud_v2_computer_builds WHERE id=$1", [queued.id])).rows[0].state).toBe("cancelled");
    // The Cloud Computer's active build and every workspace are kept.
    expect((await pool.query("SELECT active_build_id,snapshot_name FROM cloud_v2_computers WHERE org_id=$1", [fixture.organizationId])).rows[0]).toEqual(active);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces WHERE org_id=$1 AND state<>'deleted' AND archived_at IS NULL", [fixture.organizationId])).rows[0].n).toBe(2);
    // Pro again: the workspace opens and a build can be asked for again.
    await pool.query("UPDATE account_entitlements SET valid_until=NULL WHERE user_id=$1", [fixture.creator.id]);
    expect((await fixture.call(`/v1/cloud-v2/workspaces/${fixture.workspace.id}`)).status).toBe(200);
    const again = await computers.enqueue(fixture.organizationId, fixture.creator.id, { repositories: [{ repository: "example/project", branch: "main", setup: "" }] });
    expect((await computers.claim())?.id).toBe(again.id);
  });

  it("gives an outsider byte-identical team-route answers for a Personal workspace's id and an id that does not exist", async () => {
    const fixture = await setup();
    const team = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" };
    const routes: [string, string, unknown?][] = [
      ["", "GET"], ["/reassign-candidates", "GET"], ["/reassign", "POST", { requestId: randomUUID(), toUserId: fixture.outsider.id, expectedCreatorUserId: fixture.creator.id, expectedCreatorRevision: "1" }],
      ["/events", "GET"], ["/activity", "POST", {}], ["/history", "POST", { chatIds: [] }], ["/prompts?chatId=chat", "GET"],
      ...["connect", "start", "restart", "prompts", "prompts/stop", "github", "stop", "archive"].map(action => [`/${action}`, "POST", {}] as [string, string, unknown]),
      ["/rename", "POST", { name: "Renamed" }], ["", "DELETE", {}], ["/chats/chat/edit", "POST", { title: "Renamed" }],
      ...["follow", "unfollow", "pin", "unpin"].map(verb => [`/${verb}`, "POST", {}] as [string, string, unknown]), ["/followers", "GET"],
    ];
    const answer = async (id: string, [path, method, body]: [string, string, unknown?]) => {
      const response = await fixture.call(`/v1/cloud-v2/workspaces/${id}${path}`, method, body, fixture.outsider, team);
      return `${response.status} ${await response.text()}`;
    };
    for (const route of routes) {
      const personal = await answer(fixture.workspace.id, route), missing = await answer(randomUUID(), route);
      expect(personal, `${route[1]} ${route[0]}`).toBe(missing);
      expect(personal.startsWith("2"), `${route[1]} ${route[0]}`).toBe(false);
    }
    const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug;
    const byNumber = async (organization: string) => {
      const response = await fixture.call(`/v1/cloud-v2/workspaces/by-number/${organization}/1`, "GET", undefined, fixture.outsider, team);
      return `${response.status} ${await response.text()}`;
    };
    expect(await byNumber(slug)).toBe(await byNumber(`missing-${randomUUID().slice(0, 8)}`));
    const list = async (organizationId: string) => {
      const response = await fixture.call(`/v1/cloud-v2/workspaces?organizationId=${organizationId}&archived=include&limit=200`, "GET", undefined, fixture.outsider, team);
      return `${response.status} ${await response.text()}`;
    };
    expect(await list(fixture.organizationId)).toBe(await list(randomUUID()));
  });
});
