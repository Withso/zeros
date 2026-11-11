import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { resetMigratedTestDatabase } from "../../test-database.js";
import { grantTestPro } from "../../test-pro.js";
import { CloudV2Store } from "../store.js";
import { CloudV2Computers } from "../computer.js";
import { createCloudGithubServices } from "../github-composition.js";
import { createCloudV2Routes } from "../routes.js";
import { CloudTeamSharing } from "./store.js";

export async function teamSharingFixture(pool: pg.Pool, options: { eventNow?: () => number } = {}) {
  await resetMigratedTestDatabase(pool);
  const store = new CloudV2Store(pool), organizationId = randomUUID();
  async function actor(): Promise<AuthedUser> {
    const id = randomUUID(), subject = `user_${id}`, sessionId = `session_${randomUUID()}`;
    const row = (await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture') RETURNING auth_revision", [id, `${id}@example.test`])).rows[0];
    await grantTestPro(pool, id);
    await pool.query("INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link) VALUES($1,'workos',$2,$3)", [id, subject, `${id}@example.test`]);
    await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status,provider_session_expires_at)
      VALUES('workos',$1,$2,$3,'desktop','active',now()+interval '1 day')`, [sessionId, subject, id]);
    return { id, identity: { provider: "workos", subject }, email: `${id}@example.test`, displayName: "Fixture", avatarUrl: null,
      accountRevision: Number(row.auth_revision), accountStatus: "active", staffRole: null,
      authentication: { sessionId, clientKind: "desktop", authTime: Math.floor(Date.now()/1000), tokenExpiresAt: Math.floor(Date.now()/1000)+3600 } };
  }
  const creator = await actor(), viewer = await actor(), admin = await actor(), outsider = await actor();
  const actors = new Map([creator,viewer,admin,outsider].map(user => [user.id,user]));
  await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
    VALUES($1,$2,'Fixture',$3,false,true)`, [organizationId, `org-${organizationId}`, creator.id]);
  await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'admin')", [organizationId,creator.id,viewer.id,admin.id]);
  const denied = new Set<string>(), unavailable = new Set<string>();
  const fetcher = vi.fn(async (value: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(value)), person = new Headers(init?.headers).get("authorization")?.replace("Bearer synthetic-", "");
    if (unavailable.has(person ?? "")) return Response.json({ message: "Unavailable" }, { status: 503 });
    if (url.pathname === "/user") return Response.json({ id: 12, login: "fixture" });
    if (url.pathname.endsWith("/branches")) return Response.json([]);
    const id = url.pathname === "/repositories/43" ? "43" : "42";
    if (denied.has(`${person}:${id}`)) return Response.json({ message: "Not found" }, { status: 404 });
    return Response.json({ id: Number(id), name: id === "42" ? "project" : "snapshot", owner: { login: "example" },
      default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
  });
  const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32,27).toString("base64url") } };
  const github = createCloudGithubServices(pool,null,keys,store,fetcher);
  for (const user of [creator,viewer,admin]) {
    const scope = { organizationId,userId: user.id };
    await github.connections.store.save(scope,await github.connections.store.fingerprint(scope),
      { id: "12",login: "fixture" },{ method: "pat",accessToken: `synthetic-${user.id}`,expiresAt: null });
  }
  const workspace = await store.createWorkspace({ id: randomUUID(),organizationId,creatorUserId: creator.id,name: "Team workspace",
    repository: "example/project",sourceRepositoryId: "42",branch: "work",baseBranch: "main",computerBuildId: null });
  const own = await store.createWorkspace({ id: randomUUID(),organizationId,creatorUserId: viewer.id,name: "My workspace",
    repository: "example/project",sourceRepositoryId: "42",branch: "mine",baseBranch: "main",computerBuildId: null });
  for (const item of [workspace,own]) await store.transition(item.id,["creating"],"stopped");
  const app = new Hono();
  const sharing = new CloudTeamSharing(pool,store,github,pool,options.eventNow);
  app.use("*",async (c,next) => { c.set("user",actors.get(c.req.header("x-test-actor") ?? "") ?? viewer); await next(); });
  app.onError((error,c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code } },error.status);
    throw error;
  });
  app.route("/",createCloudV2Routes({ store,computers: new CloudV2Computers(pool),promptOutbox: true,github,teamSharing: sharing,
    authorizeSource: github.authorizeSource,continueSource: github.continueSource,
    remoteHead: async () => null,bridgeBaseUrl: "wss://api.example.test",installedRepositories: async () => [] }));
  const call = (path: string, method = "GET", body?: unknown, user = viewer, optIn = true) => app.request(path, {
    method,headers: { "x-test-actor": user.id,...(optIn ? { "X-Zeros-Team-Sharing": "1" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { pool,store,github,sharing,actors,actor,creator,viewer,admin,outsider,organizationId,workspace,own,app,call,fetcher,denied,unavailable };
}
export type TeamSharingFixture = Awaited<ReturnType<typeof teamSharingFixture>>;
