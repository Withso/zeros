import { randomBytes, createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Auth0BrowserSessionAuthority, createAuth0BrowserSessionRoutes, auth0TokenIsRevoked } from "./auth0-browser-sessions.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { withUserTx } from "./db.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const key = "a".repeat(64);
const data = { sub: "auth0|test", email: "test@example.test", name: null, accessToken: "synthetic-access", refreshToken: "synthetic-refresh", verifiedAt: 0 };
const id = () => randomBytes(32).toString("base64url");
d("Auth0 durable browser authority", () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); await resetMigratedTestDatabase(pool); });
  afterAll(async () => { await pool.end(); });

  it("serializes two regions' refresh admission, and logout wins over a late grant", async () => {
    const first = new Auth0BrowserSessionAuthority(pool, key);
    const second = new Auth0BrowserSessionAuthority(pool, key);
    const sessionId = id();
    await first.execute({ action: "create", sessionId, data, issuedAt: Math.floor(Date.now() / 1000) });
    const results = await Promise.all([first, second].map(authority => authority.execute({ action: "begin", sessionId, revision: 1 })));
    expect(results.map(value => value.status).sort()).toEqual(["busy", "lease"]);
    const admitted = results.find(value => value.status === "lease")!;
    await second.execute({ action: "revoke", sessionId });
    expect(await first.execute({ action: "commit", sessionId, lease: admitted.status === "lease" ? admitted.lease! : "", data: { ...data, accessToken: "late-token" } })).toEqual({ status: "terminal" });
    expect(await first.execute({ action: "read", sessionId })).toEqual({ status: "terminal" });
    expect(await first.execute({ action: "create", sessionId, data, issuedAt: Math.floor(Date.now() / 1000) })).toEqual({ status: "terminal" });
  });

  it("does not extend expiry, reuse expired leases, or expose token payloads at rest", async () => {
    let now = Date.now();
    const authority = new Auth0BrowserSessionAuthority(pool, key, () => now);
    const sessionId = id();
    const created = await authority.execute({ action: "create", sessionId, data, issuedAt: Math.floor(Date.now() / 1000) });
    expect(created.status).toBe("active");
    const stored = (await pool.query("SELECT * FROM auth0_browser_sessions WHERE credential_hash=$1", [createHash("sha256").update(sessionId).digest()])).rows[0];
    expect(stored.sealed_data).not.toContain("synthetic");
    expect(stored.credential_hash.toString()).not.toBe(sessionId);
    expect(await withUserTx(pool, randomUUID(), async tx => (await tx.query("SELECT * FROM auth0_browser_sessions")).rowCount)).toBe(0);
    now += 1000;
    const lease = await authority.execute({ action: "begin", sessionId, revision: 1 });
    if (lease.status !== "lease") throw new Error("Lease not granted");
    const updated = await authority.execute({ action: "commit", sessionId, lease: lease.lease!, data: { ...data, refreshToken: "rotated" } });
    expect(updated).toMatchObject({ revision: 2, expiresAt: created.status === "active" ? created.expiresAt : 0 });
    const stale = await authority.execute({ action: "begin", sessionId, revision: 1 });
    expect(stale).toMatchObject({ status: "active", revision: 2, data: { refreshToken: "rotated" } });
    await authority.execute({ action: "begin", sessionId, revision: 2 });
    now += 30_001;
    expect(await authority.execute({ action: "begin", sessionId, revision: 2 })).toEqual({ status: "terminal" });
  });

  it("restricts the session API to the Pages service credential and bounded bodies", async () => {
    const app = createAuth0BrowserSessionRoutes(new Auth0BrowserSessionAuthority(pool, key), key);
    const sessionId = id();
    const unauthorized = await app.request("/auth/compat/session", { method: "POST", body: JSON.stringify({ action: "create", sessionId, data, issuedAt: Math.floor(Date.now() / 1000) }) });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/auth/compat/session", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "a".repeat(128 * 1024 + 1) })).status).toBe(413);
    const created = await app.request("/auth/compat/session", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ action: "create", sessionId, data, issuedAt: Math.floor(Date.now() / 1000) }) });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ status: "active", revision: 1 });
  });

  it("redeems a ticket atomically and isolates browser logout from a device's refresh", async () => {
    const authority = new Auth0BrowserSessionAuthority(pool, key);
    const otherReplica = new Auth0BrowserSessionAuthority(pool, key);
    const sessionId = id(), ticket = id(), challenge = id();
    await authority.execute({ action: "create", sessionId, data, issuedAt: Math.floor(Date.now() / 1000) });
    await authority.execute({ action: "ticket", sessionId, ticket, challenge });
    expect(await authority.execute({ action: "redeem", sessionId: ticket, challenge: id() })).toEqual({ status: "terminal" });
    const redeemed = await Promise.all([authority, otherReplica].map(service => service.execute({ action: "redeem", sessionId: ticket, challenge })));
    expect(redeemed.map(value => value.status).sort()).toEqual(["active", "terminal"]);
    const device = redeemed.find(value => value.status === "active");
    if (!device || device.status !== "active") throw new Error("Device not created");
    expect(device.desktopCredential).toMatch(/^z0d_[A-Za-z0-9_-]{43}$/);
    const lease = await authority.execute({ action: "begin", sessionId, revision: 1 });
    if (lease.status !== "lease") throw new Error("No lease");
    await otherReplica.execute({ action: "revoke", sessionId });
    expect(await authority.execute({ action: "commit", sessionId, lease: lease.lease!, data: { ...data, refreshToken: "rotated-for-device" } })).toEqual({ status: "terminal" });
    expect(await authority.execute({ action: "read", sessionId })).toEqual({ status: "terminal" });
    expect(await authority.execute({ action: "read", sessionId: device.desktopCredential! })).toMatchObject({ status: "active", revision: 2, data: { refreshToken: "rotated-for-device" } });
    await authority.execute({ action: "revoke", sessionId: device.desktopCredential! });
    expect(await authority.execute({ action: "read", sessionId: device.desktopCredential! })).toEqual({ status: "terminal" });
  });

  it("revokes all of the subject's sessions and existing bearers, with no false success for an unknown handle", async () => {
    const now = Date.now();
    const authority = new Auth0BrowserSessionAuthority(pool, key, () => now);
    const account = { ...data, sub: `auth0|${randomUUID()}` };
    const first = id(), second = id();
    await authority.execute({ action: "create", sessionId: first, data: account, issuedAt: Math.floor(now / 1000) });
    await authority.execute({ action: "create", sessionId: second, data: account, issuedAt: Math.floor(now / 1000) });
    expect(await authority.execute({ action: "revoke", sessionId: first, all: true })).toEqual({ status: "terminal", revokedAll: true });
    expect(await authority.execute({ action: "read", sessionId: second })).toEqual({ status: "terminal" });
    expect(await auth0TokenIsRevoked(pool, account.sub, Math.floor(now / 1000))).toBe(true);
    expect(await auth0TokenIsRevoked(pool, account.sub, undefined)).toBe(true);
    expect(await auth0TokenIsRevoked(pool, account.sub, Math.ceil(now / 1000) + 1)).toBe(false);
    expect(await authority.execute({ action: "revoke", sessionId: id(), all: true })).toEqual({ status: "terminal" });
  });

  it("refuses a delayed login response issued before global sign-out while allowing a fresh login", async () => {
    let now = Date.now();
    const authority = new Auth0BrowserSessionAuthority(pool, key, () => now);
    const account = { ...data, sub: `auth0|${randomUUID()}` };
    const first = id();
    const issuedAt = Math.floor(now / 1000);
    const create = { action: "create" as const, sessionId: first, data: account, issuedAt };
    await authority.execute(create);
    now += 2000;
    await authority.execute({ action: "revoke", sessionId: first, all: true });
    const delayed = { ...create, sessionId: id() };
    expect(await authority.execute(delayed)).toEqual({ status: "terminal" });
    now += 2000;
    expect(await authority.execute({ ...delayed, sessionId: id(), issuedAt: Math.floor(now / 1000) })).toMatchObject({ status: "active" });
  });
});
