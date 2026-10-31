import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { withSystemTx, withUserTx } from "./db.js";
import { organizationMemberSeats, organizationSeats } from "./organization-seats.js";
import { createRoutes } from "./routes.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { grantTestPro } from "./test-pro.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("Pro organization seats", () => {
  let pool: pg.Pool;
  let app: Hono;
  let actor: AuthedUser;
  let org: string;
  const accounts = new Map<string, AuthedUser>();

  const request = (
    path: string,
    init?: { method?: string; body?: Record<string, unknown>; as?: AuthedUser },
  ) =>
    app.request(path, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.as ? { "x-test-actor": init.as.id } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

  async function account(label: string): Promise<AuthedUser> {
    const sub = randomUUID();
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: sub,
      email: `${label}-${sub}@example.test`,
      displayName: label,
      session: {
        id: `session_${sub}`,
        clientKind: "web",
        authTime: Math.floor(Date.now() / 1_000),
        tokenExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      },
    });
    accounts.set(label, user);
    return user;
  }

  const id = (label: string) => accounts.get(label)!.id;

  /** Adds a membership directly, as directory sync or an earlier join would. */
  async function member(label: string, joinedHoursAgo: number, options: { pro?: boolean } = {}) {
    const user = await account(label);
    if (options.pro) await grantTestPro(pool, user.id);
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role, created_at)
       VALUES ($1, $2, 'member', now() - make_interval(hours => $3))`,
      [org, user.id, joinedHoursAgo],
    );
    return user;
  }

  /** Ends live Pro now, as the operator's disable does. */
  const cancelPro = (label: string) =>
    pool.query(
      "UPDATE account_entitlements SET status = 'cancelled', cloud_workspaces_allowed = false WHERE user_id = $1",
      [id(label)],
    );

  /** A grant whose window closed by itself. */
  const expiredPro = (label: string, endedHoursAgo: number) =>
    pool.query(
      `INSERT INTO account_entitlements (user_id, plan, status, cloud_workspaces_allowed, source, valid_from, valid_until)
       VALUES ($1, 'pro', 'active', true, 'operator', now() - interval '2000 hours', now() - make_interval(hours => $2))`,
      [id(label), endedHoursAgo],
    );

  const leave = (label: string) =>
    pool.query("DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2", [org, id(label)]);

  async function seats(): Promise<Record<string, string>> {
    const byUser = await withSystemTx(pool, (tx) => organizationMemberSeats(tx, org));
    const labels = new Map([...accounts].map(([label, user]) => [user.id, label]));
    return Object.fromEntries([...byUser].map(([user, seat]) => [labels.get(user), seat]));
  }

  const usage = async () => (await withSystemTx(pool, (tx) => organizationSeats(tx, org))).usage;

  async function invite(email: string) {
    const response = await request(`/v1/organizations/${org}/invitations`, {
      method: "POST",
      body: { email, role: "member" },
      as: accounts.get("owner"),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        invitation?: { id: string; token: string };
        error?: { code: string };
      },
    };
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
    app = new Hono();
    app.use("*", async (c, next) => {
      const chosen = c.req.header("x-test-actor");
      c.set("user", [...accounts.values()].find((user) => user.id === chosen) ?? actor);
      await next();
    });
    app.route("/", createRoutes(pool, undefined, { inviteLinkBase: "https://app-alpha.zeros.build/invite" }));
    app.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status);
      }
      throw error;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    accounts.clear();
    actor = await account("owner");
    await grantTestPro(pool, actor.id);
    const created = await request("/v1/organizations", { method: "POST", body: { name: "Seats" } });
    expect(created.status).toBe(201);
    const { organization } = (await created.json()) as { organization: { id: string; seat?: string } };
    expect(organization.seat).toBe("pro");
    org = organization.id;
    // The owner joined first; fixtures join in the hours since.
    await pool.query(
      "UPDATE organization_members SET created_at = now() - interval '200 hours' WHERE org_id = $1",
      [org],
    );
  });

  it("gives five members without Pro a free seat in join order and holds the rest", async () => {
    for (let n = 1; n <= 6; n++) await member(`free-${n}`, 100 - n);
    expect(await seats()).toEqual({
      owner: "pro",
      "free-1": "free",
      "free-2": "free",
      "free-3": "free",
      "free-4": "free",
      "free-5": "free",
      "free-6": "hold",
    });
    expect(await usage()).toEqual({
      members: 7,
      pendingInvitations: 0,
      freeMembers: 5,
      heldMembers: 1,
      memberLimit: 10,
      freeMemberLimit: 5,
    });
  });

  it("queues a lapsed member behind members already free and releases them when a seat opens", async () => {
    await member("lapsed", 150, { pro: true });
    for (let n = 1; n <= 5; n++) await member(`free-${n}`, 100 - n);
    expect((await seats()).lapsed).toBe("pro");

    await cancelPro("lapsed");
    expect(await seats()).toMatchObject({ lapsed: "hold", "free-1": "free", "free-5": "free" });

    await leave("free-3");
    expect((await seats()).lapsed).toBe("free");
  });

  it("releases each open seat to whoever has waited longest", async () => {
    for (let n = 1; n <= 5; n++) await member(`free-${n}`, 100 - n);
    await member("waited-longer", 150);
    await member("waited-less", 150);
    await expiredPro("waited-longer", 20);
    await expiredPro("waited-less", 10);
    expect(await seats()).toMatchObject({ "waited-longer": "hold", "waited-less": "hold" });

    await grantTestPro(pool, id("free-2"));
    expect(await seats()).toMatchObject({ "free-2": "pro", "waited-longer": "free", "waited-less": "hold" });

    await leave("free-4");
    expect(await seats()).toMatchObject({ "waited-longer": "free", "waited-less": "free" });
  });

  it("dates a lapse at the write that ended Pro, or where its window closed by itself", async () => {
    for (let n = 1; n <= 4; n++) await member(`free-${n}`, 100 - n);
    await member("expired", 150);
    await expiredPro("expired", 30);
    // Cancelled now, two hours before its period would have ended.
    await member("cancelled", 150, { pro: true });
    await pool.query(
      "UPDATE account_entitlements SET valid_until = now() + interval '2 hours' WHERE user_id = $1",
      [id("cancelled")],
    );
    await cancelPro("cancelled");
    await member("downgraded", 150, { pro: true });
    await pool.query(
      "UPDATE account_entitlements SET plan = 'free', cloud_workspaces_allowed = false WHERE user_id = $1",
      [id("downgraded")],
    );
    // A cancellation that keeps Pro to the end of its period keeps the seat.
    await member("period-end", 150, { pro: true });
    await pool.query(
      "UPDATE account_entitlements SET status = 'cancelled', valid_until = now() + interval '2 hours' WHERE user_id = $1",
      [id("period-end")],
    );
    expect(await seats()).toMatchObject({
      expired: "free",
      cancelled: "hold",
      downgraded: "hold",
      "period-end": "pro",
    });

    await leave("free-1");
    expect(await seats()).toMatchObject({ cancelled: "free", downgraded: "hold" });
  });

  it("never lets a later entitlement write move a member ahead of members already free", async () => {
    for (let n = 1; n <= 4; n++) await member(`free-${n}`, 100 - n);
    await member("expired", 150);
    await expiredPro("expired", 720);
    await member("waiting", 150, { pro: true });
    await cancelPro("waiting");
    const before = await seats();
    expect(before).toMatchObject({ "free-1": "free", expired: "free", waiting: "hold" });

    // A grant that starts tomorrow.
    await pool.query(
      `INSERT INTO account_entitlements (user_id, plan, status, cloud_workspaces_allowed, source, valid_from)
       VALUES ($1, 'pro', 'active', true, 'operator', now() + interval '1 day')`,
      [id("free-1")],
    );
    // The operator records the end of a grant that already expired.
    await pool.query(
      `UPDATE account_entitlements SET status = 'cancelled', cloud_workspaces_allowed = false, valid_until = NULL
       WHERE user_id = $1`,
      [id("expired")],
    );
    // A held member's window is backdated.
    await pool.query(
      `UPDATE account_entitlements
       SET valid_from = now() - interval '2000 hours', valid_until = now() - interval '1900 hours'
       WHERE user_id = $1`,
      [id("waiting")],
    );
    expect(await seats()).toEqual(before);
  });

  it("refuses to compute seats outside a system transaction", async () => {
    await expect(
      withUserTx(pool, id("owner"), (tx) =>
        tx.query("SELECT * FROM organization_member_seats($1, 10, 5)", [org])),
    ).rejects.toMatchObject({ code: "42501" });
    // Pro reads only the caller's own entitlement there.
    const own = await withUserTx(pool, id("owner"), (tx) =>
      tx.query<{ pro: boolean }>("SELECT account_pro_active($1) AS pro", [id("owner")]));
    expect(own.rows).toEqual([{ pro: true }]);
  });

  it("holds members beyond ten, which only directory sync can add, even with Pro", async () => {
    for (let n = 1; n <= 10; n++) await member(`pro-${n}`, 100 - n, { pro: true });
    expect(await seats()).toMatchObject({ "pro-9": "pro", "pro-10": "hold" });
    expect(await usage()).toMatchObject({ members: 11, heldMembers: 1 });
  });

  it("counts pending invitations toward ten seats and lets an admin resend one at the limit", async () => {
    for (let n = 1; n <= 7; n++) await member(`member-${n}`, 100 - n);
    const first = await invite("first@example.test");
    expect(first.status).toBe(201);
    expect((await invite("second@example.test")).status).toBe(201);

    const refused = await invite("third@example.test");
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "organization_member_limit" } } });
    // Resending supersedes the earlier invitation instead of taking another seat.
    expect((await invite("second@example.test")).status).toBe(201);

    const revoked = await request(`/v1/organizations/${org}/invitations/${first.body.invitation!.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    expect((await invite("third@example.test")).status).toBe(201);
    expect(await usage()).toMatchObject({ members: 8, pendingInvitations: 2 });
  });

  it("serializes concurrent invitations and acceptances at each limit", async () => {
    for (let n = 1; n <= 4; n++) await member(`free-${n}`, 100 - n);
    for (let n = 1; n <= 3; n++) await member(`pro-${n}`, 90 - n, { pro: true });
    // Eight members leave room for two invitations, not three.
    const joiners = await Promise.all(["first", "second", "third"].map((label) => account(label)));
    const invited = await Promise.all(joiners.map((joiner) => invite(joiner.email)));
    expect(invited.map((result) => result.status).sort()).toEqual([201, 201, 409]);

    // One free seat is open, and neither invited joiner has Pro.
    const accepted = await Promise.all(
      joiners.flatMap((joiner, index) => {
        const token = invited[index]!.body.invitation?.token;
        return token ? [request("/v1/invitations/accept", { method: "POST", body: { token }, as: joiner })] : [];
      }),
    );
    expect(accepted.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await usage()).toMatchObject({ members: 9, pendingInvitations: 1, freeMembers: 5 });
  });

  it("admits a member without Pro only while a free seat is open", async () => {
    for (let n = 1; n <= 5; n++) await member(`free-${n}`, 100 - n);
    const joiner = await account("joiner");
    const { body } = await invite(joiner.email);
    const accept = () =>
      request("/v1/invitations/accept", { method: "POST", body: { token: body.invitation!.token } });

    actor = joiner;
    const refused = await accept();
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "organization_free_member_limit" },
    });

    await grantTestPro(pool, joiner.id);
    expect((await accept()).status).toBe(200);
    expect((await seats()).joiner).toBe("pro");
  });

  it("reports seats to a member on Hold, who still sees the organization", async () => {
    for (let n = 1; n <= 6; n++) await member(`free-${n}`, 100 - n);
    actor = accounts.get("free-6")!;

    const me = (await (await request("/v1/me")).json()) as {
      capabilities: Record<string, boolean>;
      organizations: Array<{ id: string; isPersonal: boolean; seat?: string }>;
    };
    expect(me.capabilities).toEqual({ createOrganization: false, pro: false });
    expect(me.organizations.find((item) => item.id === org)).toMatchObject({ seat: "hold" });
    expect(me.organizations.find((item) => item.isPersonal)).not.toHaveProperty("seat");

    const members = (await (await request(`/v1/organizations/${org}/members`)).json()) as {
      members: Array<{ id: string; seat: string }>;
      seats: Record<string, number>;
    };
    expect(members.seats).toMatchObject({ members: 7, freeMembers: 5, heldMembers: 1 });
    expect(members.members.find((item) => item.id === id("free-6"))?.seat).toBe("hold");
    expect(members.members.find((item) => item.id === id("owner"))?.seat).toBe("pro");
  });
});
