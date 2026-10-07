import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../auth.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, ensureCloudPilotUser } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { DatabaseCloudGithubReads } from "./github-read-proxy.js";
import { CLOUD_GITHUB_READ_PATH, createCloudGithubReadRoutes } from "./github-read-routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("computer repository GitHub reads", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, actorSessionId: string;
  let service: DatabaseCloudGithubReads;
  const broker = { mintWorkspaceRead: vi.fn(async () => ({ token: "synthetic-installation", expiresAtMs: Date.now() + 3_600_000 })), revoke: vi.fn(async () => {}) };
  const upstream = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("/zeros") ? { id: 456 } : { number: 7 }));
  const engine = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken, actorSessionId });
  const request = { method: "GET", path: "/repos/withso/zeros/pulls/7" };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetMigratedTestDatabase(pool);
    // Author the exact repository/source/pin together, with one registry seed.
    const installationId = randomUUID();
    fixture = await seedReadyCloudWorkspace(pool, { computerSource: { installationId,
      repositories: [{ id: "456", owner: "withso", name: "zeros", sha: "1".repeat(40) }] } });
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      actorUserId: fixture.userId, sharingMode: "organization", expectedRevision: 1 });
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `durable-${fixture.userId}@example.test`, displayName: "Owner",
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [user.authentication.sessionId, user.identity.subject, user.id]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1", [fixture.engineInstanceId]);
    const pair = generateKeyPairSync("ed25519"), publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    const device = (await pool.query<{ id: string }>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Test device','macos',$2,$3) RETURNING id",
      [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const proof = { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id, action: "engine.connect",
      payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") };
    const sessions = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393, bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: false });
    await pool.query("UPDATE repositories SET forge_repository_id='456',identity_state='verified' WHERE id=(SELECT repository_id FROM cloud_workspaces WHERE id=$1)", [fixture.workspaceId]);
    await pool.query("INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','test-member') ON CONFLICT(owner_user_id,app_variant) DO NOTHING", [fixture.userId]);
    await pool.query(`INSERT INTO github_installations(id,github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
      SELECT $3,123,'github.com',$1,repository_owner,'Organization','Organization' FROM cloud_workspaces WHERE id=$2`,
    [fixture.userId, fixture.workspaceId, installationId]);
    const issued = await sessions.issue({ ...engine(), actorUserId: user.id, authenticatedUser: user, proof });
    actorSessionId = (await sessions.consume({ ...engine(), token: issued.grantToken })).actorSessionId;
    service = new DatabaseCloudGithubReads(pool, false, broker, { fetch: upstream });
  });
  it("uses the bound computer installation with no human connection or read grant rows", async () => {
    await pool.query("DELETE FROM github_authorizations WHERE owner_user_id=$1", [fixture.userId]);
    const { heartbeatToken, ...scope } = engine();
    const response = await createCloudGithubReadRoutes(service).request(CLOUD_GITHUB_READ_PATH, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, request }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ number: 7 });
    expect(broker.mintWorkspaceRead).toHaveBeenCalledWith({ installationId: 123, repositoryId: 456 });
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_github_connections")).rowCount).toBe(0);
  });
  it.each(["actor", "engine", "installation", "repository", "generation"])("fences cached reads after %s revocation", async change => {
    await service.read(engine(), request);
    if (change === "actor") await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=now() WHERE id=$1", [actorSessionId]);
    if (change === "engine") await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [fixture.engineInstanceId]);
    if (change === "installation") await pool.query("UPDATE github_installations SET suspended_at=now()");
    if (change === "repository") await pool.query("UPDATE repositories SET forge_repository_id='999' WHERE id=(SELECT repository_id FROM cloud_workspaces WHERE id=$1)", [fixture.workspaceId]);
    await expect(service.read({ ...engine(), ...(change === "generation" ? { generation: 2 } : {}) }, request)).rejects.toBeDefined();
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("allows a non-owner viewer without a connected GitHub account", async () => {
    const guest = await ensureCloudPilotUser(pool, { provider: "workos", providerSubject: `user_${randomUUID()}`, email: `guest-${randomUUID()}@example.test`, displayName: "Viewer",
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now()/1000), tokenExpiresAt: Math.floor(Date.now()/1000)+3600 } });
    guest.accountRevision = Number((await pool.query("SELECT auth_revision FROM users WHERE id=$1", [guest.id])).rows[0].auth_revision);
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')", [guest.authentication.sessionId, guest.identity.subject, guest.id]);
    const collaboration = new DatabaseCloudWorkspaceCollaborationService(pool);
    const invitation = await collaboration.invite({ ...engine(), actorUserId: fixture.userId, email: guest.email, role: "viewer" });
    await collaboration.accept({ actorUserId: guest.id, identity: guest.identity, token: invitation.token });
    const pair = generateKeyPairSync("ed25519"), publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    const device = (await pool.query("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Viewer','macos',$2,$3) RETURNING id", [guest.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0];
    const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const proof = { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: guest.id, action: "engine.connect", payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") };
    const sessions = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393, bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: false });
    const issued = await sessions.issue({ ...engine(), actorUserId: guest.id, authenticatedUser: guest, proof });
    const admitted = await sessions.consume({ ...engine(), token: issued.grantToken });
    expect(admitted.role).toBe("viewer");
    await expect(service.read({ ...engine(), actorSessionId: admitted.actorSessionId }, request)).resolves.toMatchObject({ status: 200 });
  });
});
