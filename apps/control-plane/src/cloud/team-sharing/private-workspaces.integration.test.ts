import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("a private repository's workspace on every team route", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    f = await teamSharingFixture(pool, { ownership: true });
    // The viewer's workspace is of a repository only the viewer keeps.
    await pool.query("UPDATE cloud_v2_workspaces SET private_owner_user_id=creator_user_id WHERE id=$1", [f.own.id]);
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
});
