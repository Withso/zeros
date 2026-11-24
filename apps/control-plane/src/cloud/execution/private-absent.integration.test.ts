import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// A member's private workspace (their personal project's) must not be told apart from one that does not exist, by
// anyone else, organization owners and admins included: on every workspace route, with or without the team-sharing
// headers, and after the member leaves. Its execution mode is active, as a workspace that has run is.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("another member's private workspace answers as an absent one", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 10_000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    const project = randomUUID();
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,'Notes','personal',$3,$3)",
      [project, f.organizationId, f.viewer.id]);
    await pool.query(`UPDATE cloud_v2_workspaces SET private_owner_user_id=creator_user_id, project_id=$2, execution_mode='active',
      execution_initiator_user_id=creator_user_id, execution_intent_id=$3 WHERE id=$1`, [f.own.id, project, randomUUID()]);
  });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const TEAM = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" };
  /** Every workspace route a person's app calls, with the same body for both ids. */
  const routes = (id: string): [string, string, unknown?][] => {
    const path = `/v1/cloud-v2/workspaces/${id}`;
    return [
      [path, "GET"], [`${path}/followers`, "GET"], [`${path}/prompts?chatId=chat`, "GET"],
      [`${path}/activity`, "POST", {}], [`${path}/history`, "POST", {}],
      [`${path}/start`, "POST", {}], [`${path}/stop`, "POST", {}], [`${path}/restart`, "POST", {}], [`${path}/archive`, "POST", {}],
      [`${path}/connect`, "POST", {}],
      [`${path}/prompts`, "POST", f.prompt()], [`${path}/prompts`, "POST", {}],
      [`${path}/prompts/stop`, "POST", { chatId: "chat", throughEpoch: 1 }], [`${path}/prompts/stop`, "POST", {}],
      [`${path}/rename`, "POST", { name: "Renamed" }], [`${path}/follow`, "POST", {}], [`${path}/pin`, "POST", {}],
      [`${path}/lost-work/dismiss`, "POST", {}], [path, "DELETE"],
      [`${path}/reassign-candidates?limit=10`, "GET"],
      [`${path}/reassign`, "POST", { requestId: randomUUID(), toUserId: f.admin.id, expectedCreatorUserId: f.viewer.id, expectedCreatorRevision: "1" }],
      [`${path}/keep`, "PUT"], [`${path}/keep`, "DELETE"], [`${path}/github`, "POST", { operation: "gh.prView" }], [`${path}/github`, "POST", {}],
      [`${path}/chats/chat/edit`, "POST", {}], [`${path}/events`, "GET"],
      [`${path}/macs`, "GET"], [`${path}/macs/${randomUUID()}/connect`, "POST", {}], [`${path}/macs/${randomUUID()}/disconnect`, "POST", {}],
      [`${path}/macs/${randomUUID()}/sync`, "PUT", { syncing: true }],
      [`${path}/sync/grant`, "POST", {}], [`${path}/github-read-token`, "POST", {}],
    ];
  };
  /** The public API's workspace routes, called with the caller's own API key. */
  const api = (id: string): [string, string, unknown?][] => {
    const path = `/api/v0/workspaces/${id}`;
    return [[path, "GET"], [`${path}/status`, "GET"], [`${path}/sessions`, "GET"], [`${path}/rename`, "POST", { name: "Renamed" }],
      ...["archive", "unarchive", "sleep", "wake"].map(action => [`${path}/${action}`, "POST", {}] as [string, string, unknown])];
  };
  const answer = async (user: AuthedUser, route: string, method: string, body: unknown, headers: Record<string, string>) => {
    const response = await f.call(route, method, body, user, headers);
    if (response.status < 400) { await response.body?.cancel(); return `${response.status}`; }
    const parsed = await response.json().catch(() => null);
    return `${response.status} ${parsed?.error?.code ?? parsed?.error ?? parsed?.code ?? null}`;
  };
  /** The private workspace's answer and an absent id's, route by route, for each caller and header set. */
  const compare = async (users: AuthedUser[]) => {
    const absent = randomUUID(), differences: string[] = [];
    const sets: [AuthedUser, Record<string, string>, (id: string) => [string, string, unknown?][]][] = [];
    for (const user of users) {
      sets.push([user, {}, routes], [user, TEAM, routes]);
      const key = (await f.cp.api.credentials.create(f.organizationId, user.id, "Fixture")).key;
      sets.push([user, { authorization: `Bearer ${key}` }, api]);
    }
    for (const [user, headers, list] of sets) {
      const own = list(f.own.id), none = list(absent);
      for (let i = 0; i < own.length; i++) {
        const [route, method, body] = own[i]!, [absentRoute, , absentBody] = none[i]!;
        const got = await answer(user, route, method, body, headers), expected = await answer(user, absentRoute, method, absentBody, headers);
        if (got !== expected) differences.push(`${user === f.creator ? "owner" : "admin"} ${"authorization" in headers ? "api" : Object.keys(headers).length ? "team" : "plain"} ${method} ${route.replace(f.own.id, ":id")}: ${got} (absent: ${expected})`);
      }
    }
    return differences;
  };

  it("for the organization's owner and an admin, every route, plain and with the team-sharing headers", async () => {
    expect(await compare([f.creator, f.admin])).toEqual([]);
    // Nothing of it changed.
    expect((await pool.query("SELECT state, name, archived_at, creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.own.id])).rows[0])
      .toMatchObject({ state: "stopped", name: "My workspace", archived_at: null, creator_user_id: f.viewer.id });
  });

  it("after its member leaves, for the same callers", async () => {
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    expect(await compare([f.creator, f.admin])).toEqual([]);
    // The member's own lost access still says so.
    expect(await answer(f.viewer, `/v1/cloud-v2/workspaces/${f.own.id}/start`, "POST", {}, {})).toBe("403 member_access_revoked");
  });

  it("an ordinary organization workspace still answers an admin as before, member_access_revoked included", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET private_owner_user_id=NULL, project_id=NULL WHERE id=$1", [f.own.id]);
    const path = `/v1/cloud-v2/workspaces/${f.own.id}`, got: string[] = [];
    for (const [route, method, body, headers] of [[path, "GET", undefined, TEAM], [`${path}/connect`, "POST", {}, {}],
      [`${path}/prompts`, "POST", f.prompt(), {}], [`${path}/prompts`, "POST", {}, {}], [`${path}/prompts/stop`, "POST", {}, TEAM],
      [`${path}/macs`, "GET", undefined, TEAM], [`${path}/start`, "POST", {}, {}]] as [string, string, unknown, Record<string, string>][])
      got.push(`${method} ${route.replace(path, "")}: ${await answer(f.admin, route, method, body, headers)}`);
    expect(got).toEqual(["GET : 200", "POST /connect: 200", "POST /prompts: 409 agent_login_required",
      "POST /prompts: 400 invalid_request", "POST /prompts/stop: 400 invalid_request", "GET /macs: 200", "POST /start: 200"]);
    // A workspace being deleted still reads as access lost to an admin of its organization, not as absent.
    await pool.query("UPDATE cloud_v2_workspaces SET state='deleting' WHERE id=$1", [f.own.id]);
    expect(await answer(f.admin, `${path}/macs`, "GET", undefined, TEAM)).toBe("403 member_access_revoked");
  });

  it("the environment for the project's repository is the caller's own, the same as with no workspace there", async () => {
    // The member saved one for that repository; the route is keyed by the caller and never reads a workspace or project.
    const base = `/v1/cloud-v2/organizations/${f.organizationId}/environment/42?repository=example/project`;
    expect((await f.call(base, "PATCH", { expectedRevision: 0, variables: { MEMBER_VALUE: "synthetic-member" } }, f.viewer)).status).toBe(200);
    const read = async () => {
      const out: string[] = [];
      for (const user of [f.creator, f.admin]) {
        const response = await f.call(base, "GET", undefined, user), body = await response.json().catch(() => null);
        out.push(`${response.status} ${body?.error?.code ?? null} ${JSON.stringify(body?.environment ?? null)}`);
      }
      return out;
    };
    const present = await read();
    expect(present.join("\n")).not.toContain("MEMBER_VALUE");
    await withSystemTx(pool, async tx => {
      await tx.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.own.id]);
      await tx.query("DELETE FROM cloud_projects WHERE owner_user_id=$1", [f.viewer.id]);
    });
    expect(await read()).toEqual(present);
  });
});

database("another member's personal project answers as an absent one", () => {
  let pool: pg.Pool, f: ExecutionFixture, project: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 10_000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { readyCopies: true });
    project = randomUUID();
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1,$2,'Notes','personal',$3,$3)",
      [project, f.organizationId, f.viewer.id]);
  });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("on every project and ready-copy route, for the organization's owner and an admin, before and after the member leaves", async () => {
    const routes = (id: string): [string, string, unknown?][] => {
      const path = `/v1/cloud-v2/organizations/${f.organizationId}/cloud-projects/${id}`;
      return [[path, "GET"], [`${path}/warm`, "POST", {}], [path, "PATCH", { name: "Renamed" }], [path, "PATCH", {}], [`${path}/share`, "POST", {}],
        [`${path}/ready-copy`, "GET"], [`${path}/ready-copy/output`, "GET"], [`${path}/ready-copy/build`, "POST", {}], [`${path}/ready-copy/retry`, "POST", {}],
        [`${path}/build-secrets`, "GET"], [`${path}/build-secrets`, "PUT", { secrets: {} }], [`${path}/build-secrets`, "PATCH", { remove: ["A"] }], [path, "DELETE"]];
    };
    const answer = async (user: AuthedUser, route: string, method: string, body: unknown) => {
      const response = await f.call(route, method, body, user);
      if (response.status < 400) { await response.body?.cancel(); return `${response.status}`; }
      return `${response.status} ${(await response.json().catch(() => null))?.error?.code ?? null}`;
    };
    const compare = async () => {
      const absent = randomUUID(), differences: string[] = [];
      for (const user of [f.creator, f.admin]) {
        const own = routes(project), none = routes(absent);
        for (let i = 0; i < own.length; i++) {
          const got = await answer(user, own[i]![0], own[i]![1], own[i]![2]), expected = await answer(user, none[i]![0], none[i]![1], none[i]![2]);
          if (got !== expected) differences.push(`${user === f.creator ? "owner" : "admin"} ${own[i]![1]} ${own[i]![0].replace(project, ":project")}: ${got} (absent: ${expected})`);
        }
      }
      return differences;
    };
    expect(await compare()).toEqual([]);
    expect((await pool.query("SELECT name, level FROM cloud_projects WHERE id=$1", [project])).rows[0]).toEqual({ name: "Notes", level: "personal" });
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    expect(await compare()).toEqual([]);
  });
});
