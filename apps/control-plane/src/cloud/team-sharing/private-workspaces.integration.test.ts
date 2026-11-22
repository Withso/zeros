import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { withSystemTx } from "../../db.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";
import { cloudV2ActorAccess } from "../workspace-access.js";
import { CloudExecutionAuthority } from "../execution/authority.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("a personal project's workspace on every team route", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    f = await teamSharingFixture(pool, { ownership: true });
    // The viewer's workspace is of a project only the viewer keeps.
    const project = randomUUID();
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,'Notes','personal',$3,$3)",
      [project, f.organizationId, f.viewer.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET private_owner_user_id=creator_user_id, project_id=$2 WHERE id=$1", [f.own.id, project]);
  });
  const call = (path: string, user: AuthedUser, method = "GET", body?: unknown) => f.app.request(path, {
    method, headers: { "x-test-actor": user.id, "x-zeros-team-sharing": "1", "x-zeros-team-ownership": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ids = async (user: AuthedUser) => ((await (await call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}&limit=50`, user)).json())
    .workspaces as { id: string }[]).map(row => row.id);

  it("leaves it out of every team list for the owner, an admin and another member, and lists it for its member", async () => {
    for (const user of [f.creator, f.admin]) expect(await ids(user)).not.toContain(f.own.id);
    expect(await ids(f.viewer)).toContain(f.own.id);
    // A creator filter or an ownerless page reaches it no other way.
    for (const query of [`creator=${f.viewer.id}`, "creator=none", "archived=include"]) {
      const page = await (await call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}&${query}`, f.admin)).json();
      expect((page.workspaces ?? []).map((row: { id: string }) => row.id)).not.toContain(f.own.id);
    }
  });

  /** Every team route on the private workspace, reads and writes. */
  const everyRoute = async (creatorUserId: string | null): Promise<[string, string, unknown?][]> => {
    const number = (await pool.query("SELECT number FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0].number;
    const slug = `org-${f.organizationId}`, path = `/v1/cloud-v2/workspaces/${f.own.id}`;
    return [
      [path, "GET"], [`/v1/cloud-v2/workspaces/by-number/${slug}/${number}`, "GET"], [`${path}/followers`, "GET"],
      [`${path}/prompts?chatId=chat`, "GET"], [`${path}/activity`, "POST", {}], [`${path}/history`, "POST", {}],
      [`${path}/start`, "POST", {}], [`${path}/stop`, "POST", {}], [`${path}/archive`, "POST", {}], [`${path}/rename`, "POST", { name: "Renamed" }],
      [`${path}/follow`, "POST", {}], [`${path}/pin`, "POST", {}], [`${path}/keep`, "PUT"], [`${path}/keep`, "DELETE"], [path, "DELETE"],
      [`${path}/reassign-candidates?limit=10`, "GET"],
      [`${path}/reassign`, "POST", { requestId: randomUUID(), toUserId: f.admin.id, expectedCreatorUserId: creatorUserId, expectedCreatorRevision: "1" }],
    ];
  };

  it("answers not found to the owner and an admin on every workspace route, and refuses reassign to its member", async () => {
    const number = (await pool.query("SELECT number FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0].number;
    const slug = `org-${f.organizationId}`, path = `/v1/cloud-v2/workspaces/${f.own.id}`;
    const routes: [string, string, unknown?][] = [
      [path, "GET"], [`/v1/cloud-v2/workspaces/by-number/${slug}/${number}`, "GET"], [`${path}/followers`, "GET"],
      [`${path}/prompts?chatId=chat`, "GET"], [`${path}/activity`, "POST", {}], [`${path}/history`, "POST", {}],
      [`${path}/stop`, "POST", {}], [`${path}/archive`, "POST", {}], [`${path}/rename`, "POST", { name: "Renamed" }],
      [`${path}/follow`, "POST", {}], [`${path}/pin`, "POST", {}], [path, "DELETE"],
      [`${path}/reassign-candidates?limit=10`, "GET"],
      [`${path}/reassign`, "POST", { requestId: randomUUID(), toUserId: f.admin.id, expectedCreatorUserId: f.viewer.id, expectedCreatorRevision: "1" }],
    ];
    for (const user of [f.creator, f.admin]) for (const [route, method, body] of routes) {
      const response = await call(route, user, method, body);
      expect([route, method, response.status]).toEqual([route, method, 404]);
    }
    const state = (await pool.query("SELECT state, name, archived_at, creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0];
    expect(state).toMatchObject({ state: "stopped", name: "My workspace", archived_at: null, creator_user_id: f.viewer.id });
    // Its member reads it, and the server refuses to hand it to anyone.
    expect((await call(path, f.viewer)).status).toBe(200);
    for (const [route, method, body] of routes.slice(-2)) {
      const response = await call(route, f.viewer, method, body);
      expect([route, (await response.json()).error?.code]).toEqual([route, "private_workspace"]);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1", [f.organizationId])).rows[0].n).toBe(0);
  });

  it("keeps a departed member's private workspace from everyone, admins and owners included, with no way to take it over", async () => {
    // As production: leaving clears an active workspace's Creator.
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.own.id]);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    expect((await pool.query("SELECT creator_user_id, private_owner_user_id, creator_absent_reason FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0])
      .toEqual({ creator_user_id: null, private_owner_user_id: f.viewer.id, creator_absent_reason: "left" });
    const path = `/v1/cloud-v2/workspaces/${f.own.id}`;
    for (const user of [f.creator, f.admin, f.outsider]) {
      for (const query of ["", "&creator=none", "&archived=include"]) {
        const page = await (await call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}${query}`, user)).json();
        expect((page.workspaces ?? []).map((row: { id: string }) => row.id)).not.toContain(f.own.id);
      }
      for (const [route, method, body] of [[path, "GET"], [`${path}/reassign-candidates?limit=10`, "GET"],
        [`${path}/reassign`, "POST", { requestId: randomUUID(), toUserId: f.admin.id, expectedCreatorUserId: null, expectedCreatorRevision: "2" }],
        [`${path}/archive`, "POST", {}], [path, "DELETE"]] as [string, string, unknown?][])
        expect([route, method, (await call(route, user, method, body)).status]).toEqual([route, method, 404]);
    }
    // The departed member reaches nothing of the organization either.
    expect((await call(path, f.viewer)).status).toBe(404);
    expect((await pool.query("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0].creator_user_id).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_reassignments WHERE workspace_id=$1", [f.own.id])).rows[0].n).toBe(0);
  });

  it("archives a departed member's private workspace at once, lets nobody else reach it anywhere, and gives it back to them when re-added (retention S3)", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.own.id]);
    const member = await f.actor();
    // Registered, so its requests act as it (an unknown actor would fall back to the fixture's default, the workspace's own member).
    f.actors.set(member.id, member);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [f.organizationId, member.id]);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    const row = async () => (await pool.query("SELECT creator_user_id, archive_reason, archived_at IS NOT NULL AS archived FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0];
    expect(await row()).toEqual({ creator_user_id: null, archive_reason: "member_left", archived: true });
    const path = `/v1/cloud-v2/workspaces/${f.own.id}`;
    // The owner, an admin, another member: every team route refuses it, and no list or the public API's reads show it.
    const others = [f.creator, f.admin, member];
    for (const user of others) {
      for (const [route, method, body] of await everyRoute(null))
        expect([user.id, route, method, (await call(route, user, method, body)).status]).toEqual([user.id, route, method, 404]);
      for (const query of ["", "&creator=none", "&archived=include"]) {
        const page = await (await call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}${query}`, user)).json();
        expect((page.workspaces ?? []).map((entry: { id: string }) => entry.id)).not.toContain(f.own.id);
      }
      await expect(f.store.get(f.own.id, user.id)).rejects.toMatchObject({ status: 404 });
      expect((await f.store.listApiWorkspaces(f.organizationId, user.id, { limit: 50, archived: true } as never)).map(entry => entry.id)).not.toContain(f.own.id);
    }
    // The departed member reaches nothing either, until they return.
    expect((await call(path, f.viewer)).status).toBe(404);
    await withSystemTx(pool, tx => tx.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [f.organizationId, f.viewer.id]));
    expect(await row()).toEqual({ creator_user_id: f.viewer.id, archive_reason: "member_left", archived: true });
    const opened = await call(path, f.viewer);
    expect(opened.status).toBe(200);
    // With retention off (every deployment at merge), the document is what it was before retention, and Keep has no route.
    const document = (await opened.json()).workspace;
    for (const field of ["keep", "archiveReason", "machineExpectedGoneAt", "backupRemovalAt"]) expect(document).not.toHaveProperty(field);
    expect((await call(`${path}/keep`, f.viewer, "PUT")).status).toBe(404);
    expect([200, 202]).toContain((await call(`${path}/start`, f.viewer, "POST", {})).status);
    expect((await pool.query("SELECT state, archived_at FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0]).toMatchObject({ state: "starting", archived_at: null });
    for (const user of others) expect([user.id, (await call(path, user)).status]).toEqual([user.id, 404]);
  });

  it("keeps it to its member under shared execution in every actor-access check, and lets nobody in once they leave", async () => {
    const allowed = async (userId: string, workspaceId: string) => (await withSystemTx(pool, tx => tx.query(
      `SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=$2 AND ${cloudV2ActorAccess("$1")}`, [userId, workspaceId]))).rowCount === 1;
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id = ANY($1::uuid[])", [[f.own.id, f.workspace.id]]);
    // Shared execution opens an organization's workspace to every member, and a personal project's to its member alone.
    for (const user of [f.creator, f.viewer, f.admin]) expect([user.id, await allowed(user.id, f.workspace.id)]).toEqual([user.id, true]);
    for (const user of [f.creator, f.admin, f.outsider]) expect([user.id, await allowed(user.id, f.own.id)]).toEqual([user.id, false]);
    expect(await allowed(f.viewer.id, f.own.id)).toBe(true);
    // The project shared later: the workspace made before stays private.
    await pool.query("UPDATE cloud_projects SET level='organization', owner_user_id=NULL WHERE id=(SELECT project_id FROM cloud_v2_workspaces WHERE id=$1)", [f.own.id]);
    for (const user of [f.creator, f.admin]) expect(await allowed(user.id, f.own.id)).toBe(false);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    for (const user of [f.creator, f.viewer, f.admin, f.outsider]) expect([user.id, await allowed(user.id, f.own.id)]).toEqual([user.id, false]);
  });

  it("admits nobody else to it under shared execution: no execution admission and no prompt outbox access", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active', state='running', access_epoch=1 WHERE id = ANY($1::uuid[])", [[f.own.id, f.workspace.id]]);
    const authority = new CloudExecutionAuthority(pool, f.github.source, f.github.connections.store);
    const admitted = (workspaceId: string, userId: string) => withSystemTx(pool, tx => authority.snapshot(tx, workspaceId, userId)).then(() => true, () => false);
    for (const user of [f.creator, f.admin]) {
      expect([user.id, await admitted(f.own.id, user.id)]).toEqual([user.id, false]);
      expect(await admitted(f.workspace.id, user.id)).toBe(true);
      await expect(f.store.prompts!.retireLocalSender(f.own.id, user.id, "1", null)).rejects.toMatchObject({ status: 404 });
    }
    expect(await admitted(f.own.id, f.viewer.id)).toBe(true);
  });
});
