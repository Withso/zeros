import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import pg from "pg";
import { DevConnectionRuntime } from "../dev-connections/runtime.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ensureUser } from "../auth.js";
import { runMigrations } from "../migrate.js";
import {
  ensureCloudPilotUser,
  seedReadyCloudWorkspace,
} from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { DatabaseCloudGithubWriteGrants } from "./github-write-grants.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import {
  CLOUD_GITHUB_WRITE_PATH,
  createCloudGithubWriteRoutes,
} from "./github-write-routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud native GitHub authority", () => {
  let pool: pg.Pool,
    fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,
    actorSessionId: string;
  let service: DatabaseCloudGithubWriteGrants;
  const engine = () => ({
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    generation: 1,
    engineInstanceId: fixture.engineInstanceId,
    heartbeatToken: fixture.heartbeatToken,
    actorSessionId,
  });
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      actorUserId: fixture.userId,
      sharingMode: "organization",
      expectedRevision: 1,
    });
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `workos|${fixture.userId}`,
      email: `durable-${fixture.userId}@example.test`,
      displayName: "Owner",
      session: {
        id: `session_${randomUUID()}`,
        clientKind: "desktop",
        authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    await pool.query(
      "INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [user.authentication.sessionId, user.identity.subject, user.id],
    );
    await pool.query(
      "UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1",
      [fixture.engineInstanceId],
    );
    const pair = generateKeyPairSync("ed25519"),
      publicKey = Buffer.from(
        pair.publicKey.export({ format: "jwk" }).x!,
        "base64url",
      );
    const device = (
      await pool.query<{ id: string }>(
        "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Test device','macos',$2,$3) RETURNING id",
        [user.id, publicKey, createHash("sha256").update(publicKey).digest()],
      )
    ).rows[0]!;
    const fields = {
      deviceId: device.id,
      keyVersion: 1,
      timestampMs: Date.now(),
      nonce: randomBytes(24).toString("base64url"),
    };
    const proof = {
      ...fields,
      signature: sign(
        null,
        cloudWorkspaceDeviceProofMessage({
          ...fields,
          accountUserId: user.id,
          action: "engine.connect",
          payload: {
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
          },
        }),
        pair.privateKey,
      ).toString("base64url"),
    };
    const sessions = new DatabaseCloudWorkspaceActorSessionService({
      pool,
      enginePort: 39393,
      bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge",
      workosEnabled: false,
    });
    const issued = await sessions.issue({
      ...engine(),
      actorUserId: user.id,
      authenticatedUser: user,
      proof,
    });
    actorSessionId = (
      await sessions.consume({ ...engine(), token: issued.grantToken })
    ).actorSessionId;
    await pool.query(
      "UPDATE repositories SET forge_repository_id='456',identity_state='verified' WHERE id=(SELECT repository_id FROM cloud_workspaces WHERE id=$1)",
      [fixture.workspaceId],
    );
    await pool.query(
      "INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','test-member') ON CONFLICT(owner_user_id,app_variant) DO NOTHING",
      [fixture.userId],
    );
    service = new DatabaseCloudGithubWriteGrants(pool, false);
  });

  async function nativeFixture() {
    await pool.query(
      "UPDATE github_authorizations SET github_user_id=42 WHERE owner_user_id=$1",
      [fixture.userId],
    );
    const row = (
      await pool.query(
        `INSERT INTO github_installations(github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
      SELECT 123,'github.com',$1,repository_owner,'Organization','Organization' FROM cloud_workspaces WHERE id=$2 RETURNING id`,
        [fixture.userId, fixture.workspaceId],
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)",
      [fixture.organizationId, fixture.userId, row.id],
    );
    const requestId = randomUUID();
    return { action: "prepareWrite" as const, organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      operation: "git.push" as const, paramsSha256: createHash("sha256").update(JSON.stringify(["git.push", { nativeRequestId: requestId }])).digest("hex"),
      native: { requestId, generation: 1, engineInstanceId: fixture.engineInstanceId,
        source: { kind: "terminal" as const, actorSessionId }, branch: "topic" } };
  }
  type Request = Awaited<ReturnType<typeof nativeFixture>>;
  const verify = vi.fn(async () => ({ installationId: 123, repositoryId: "456" }));
  const prepare = (request: Request) => service.prepare(request, fixture.userId, verify, "synthetic-connected-user");
  const redeem = (request: Request, grant: string) => service.redeem(engine(), { grant, operation: request.operation,
    paramsSha256: request.paramsSha256, params: { nativeRequestId: request.native.requestId }, branch: request.native.branch, baseBranch: "topic" });
  it("advertises only connected-account Git and exposes no installation mint or native renewal route", async () => {
    const app = createCloudGithubWriteRoutes(service);
    const { actorSessionId: _actor, heartbeatToken, ...identity } = engine();
    const call = (request: unknown) => app.request(CLOUD_GITHUB_WRITE_PATH, { method: "POST",
      headers: { authorization: `Bearer ${heartbeatToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...identity, request }) });
    expect(await (await call({ kind: "native-capabilities" })).json()).toEqual({ nativeGit: 1 });
    expect((await call({ kind: "native-renew", token: `zgn_${"x".repeat(43)}`, source: { kind: "terminal", actorSessionId }, branch: "topic" })).status).toBe(422);
    const request = await nativeFixture();
    expect(await service.nativeContext(engine(), request.native.source)).toMatchObject({ actorUserId: fixture.userId, repositoryId: "456" });
  });
  it("uses the connected user token, bounds each grant and acquires fresh authority for a new command", async () => {
    const request = await nativeFixture();
    const prepared = await prepare(request), credential = await redeem(request, prepared.grant);
    expect(credential.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60000);
    expect(JSON.stringify(credential)).not.toContain("synthetic-connected-user");
    expect((await pool.query("SELECT token_sealed FROM cloud_github_write_grants")).rows[0].token_sealed.includes(Buffer.from("synthetic-connected-user"))).toBe(false);
    expect((await service.authorizeProxy(credential.token)).userToken).toBe("synthetic-connected-user");
    await service.authorizeProxy(credential.token, "git");
    await expect(service.authorizeProxy(credential.token, "git")).rejects.toThrow();
    await expect(service.authorizeProxy(credential.token, "api")).rejects.toThrow();
    await service.release(engine(), prepared.grant);
    await expect(redeem(request, prepared.grant)).rejects.toThrow();
    const requestId = randomUUID(), next = { ...request, native: { ...request.native, requestId },
      paramsSha256: createHash("sha256").update(JSON.stringify(["git.push", { nativeRequestId: requestId }])).digest("hex") };
    const fresh = await redeem(next, (await prepare(next)).grant);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(fresh.token).not.toBe(credential.token);
  });
  it("V9b rejects native preparation completed after disconnect", async () => {
    const request = await nativeFixture();
    await expect(service.prepare(request, fixture.userId, async () => {
      await pool.query("DELETE FROM cloud_github_connections WHERE org_id=$1 AND owner_user_id=$2", [fixture.organizationId, fixture.userId]);
      return { installationId: 123, repositoryId: "456" };
    }, "synthetic-connected-user")).rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
  });
  it("V9b rejects a fresh native grant after disconnect", async () => {
    const request = await nativeFixture();
    await pool.query("DELETE FROM cloud_github_connections WHERE org_id=$1 AND owner_user_id=$2", [fixture.organizationId, fixture.userId]);
    await expect(prepare(request)).rejects.toMatchObject({ status: 403 });
    expect(verify).not.toHaveBeenCalled();
  });
  it("release before redemption cannot be overtaken by a delayed reply", async () => {
    const request = await nativeFixture(), prepared = await prepare(request);
    await service.release(engine(), prepared.grant);
    await service.release(engine(), prepared.grant);
    await expect(redeem(request, prepared.grant)).rejects.toThrow();
    await service.cleanup();
    await expect(redeem(request, prepared.grant)).rejects.toThrow();
  });
  it.each(["actor", "engine", "github", "installation", "expiry", "repository"])("rejects %s changes after native redemption", async cause => {
    const request = await nativeFixture(), credential = await redeem(request, (await prepare(request)).grant);
    if (cause === "actor") await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=now() WHERE id=$1", [actorSessionId]);
    if (cause === "engine") await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [fixture.engineInstanceId]);
    if (cause === "github") await pool.query("UPDATE github_authorizations SET github_user_id=99 WHERE owner_user_id=$1", [fixture.userId]);
    if (cause === "installation") await pool.query("DELETE FROM cloud_github_connections WHERE owner_user_id=$1", [fixture.userId]);
    if (cause === "expiry") await pool.query("UPDATE cloud_github_write_grants SET lease_expires_at=now()-interval '1 second'");
    if (cause === "repository") await pool.query("UPDATE repositories SET forge_repository_id='999' WHERE id=(SELECT repository_id FROM cloud_workspaces WHERE id=$1)", [fixture.workspaceId]);
    await expect(service.authorizeProxy(credential.token)).rejects.toThrow();
  });
  it("drains Dev invalidations before authorizing an existing native proxy lease",async()=>{
    const generation=randomUUID();
    for(const [name,value] of Object.entries({ZEROS_DEPLOY_ENV:'dev',ZEROS_DEV_ENVIRONMENT:'hosted',ZEROS_DEV_CONNECTIONS_ENABLED:'true',ZEROS_DEV_GENERATION:generation,
      DEV_CONNECTIONS_GENERATION:generation,DEV_CONNECTIONS_ORIGIN:'https://connections.example.test',DEV_CONNECTIONS_AUDIENCE:'zeros-dev-connections-v1',DEV_CONNECTIONS_GENERATION_CREDENTIAL:'a'.repeat(43)}))vi.stubEnv(name,value);
    const consume=vi.spyOn(DevConnectionRuntime.prototype,'consumeInvalidations').mockRejectedValue(new Error('Synthetic generation revoked'));
    await expect(service.authorizeProxy(`zgp_${'a'.repeat(43)}`)).rejects.toThrow('Synthetic generation revoked');
    expect(consume).toHaveBeenCalledOnce();
  });
  it("rejects wrong actor, generation, engine, source, branch and repository", async () => {
    const request = await nativeFixture();
    for (const native of [{ ...request.native, generation: 2 }, { ...request.native, engineInstanceId: randomUUID() },
      { ...request.native, source: { kind: "terminal" as const, actorSessionId: randomUUID() } }])
      await expect(prepare({ ...request, native })).rejects.toThrow();
    await expect(service.prepare(request, randomUUID(), verify, "synthetic-connected-user")).rejects.toThrow();
    await expect(service.prepare(request, fixture.userId, async () => ({ installationId: 123, repositoryId: "999" }), "synthetic-connected-user")).rejects.toThrow();
    const grant = (await prepare(request)).grant;
    await expect(service.redeem({ ...engine(), generation: 2 }, { grant, operation: request.operation, paramsSha256: request.paramsSha256,
      params: { nativeRequestId: request.native.requestId }, branch: "topic", baseBranch: "topic" })).rejects.toThrow();
    await expect(redeem({ ...request, native: { ...request.native, branch: "other" } }, grant)).rejects.toThrow();
    await expect(service.prepare(request, fixture.userId, async () => { throw new Error("write permission denied"); }, "synthetic-connected-user")).rejects.toThrow();
  });
  it.each(["viewer", "prompter"] as const)(
    "denies a currently admitted %s before acquiring GitHub write authority",
    async (role) => {
      const request = await nativeFixture();
      const guest = await ensureCloudPilotUser(pool, {
        provider: "workos",
        providerSubject: `guest_${randomUUID()}`,
        email: `guest-${randomUUID()}@example.test`,
        displayName: "Guest",
        session: {
          id: `session_${randomUUID()}`,
          clientKind: "desktop",
          authTime: Math.floor(Date.now() / 1000),
          tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      });
      guest.accountRevision = Number(
        (
          await pool.query("SELECT auth_revision FROM users WHERE id=$1", [
            guest.id,
          ])
        ).rows[0].auth_revision,
      );
      await pool.query(
        "INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
        [guest.authentication.sessionId, guest.identity.subject, guest.id],
      );
      await pool.query(
        "INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",
        [guest.id],
      );
      const collaboration = new DatabaseCloudWorkspaceCollaborationService(
        pool,
      );
      const invitation = await collaboration.invite({
        ...engine(),
        actorUserId: fixture.userId,
        email: guest.email,
        role,
      });
      await collaboration.accept({
        actorUserId: guest.id,
        identity: guest.identity,
        token: invitation.token,
      });
      const pair = generateKeyPairSync("ed25519"),
        publicKey = Buffer.from(
          pair.publicKey.export({ format: "jwk" }).x!,
          "base64url",
        );
      const device = (
        await pool.query<{ id: string }>(
          "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Guest device','macos',$2,$3) RETURNING id",
          [
            guest.id,
            publicKey,
            createHash("sha256").update(publicKey).digest(),
          ],
        )
      ).rows[0]!;
      const fields = {
        deviceId: device.id,
        keyVersion: 1,
        timestampMs: Date.now(),
        nonce: randomBytes(24).toString("base64url"),
      };
      const proof = {
        ...fields,
        signature: sign(
          null,
          cloudWorkspaceDeviceProofMessage({
            ...fields,
            accountUserId: guest.id,
            action: "engine.connect",
            payload: {
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
            },
          }),
          pair.privateKey,
        ).toString("base64url"),
      };
      const sessions = new DatabaseCloudWorkspaceActorSessionService({
        pool,
        enginePort: 39393,
        bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge",
        workosEnabled: false,
      });
      const issued = await sessions.issue({
        ...engine(),
        actorUserId: guest.id,
        authenticatedUser: guest,
        proof,
      });
      const admitted = await sessions.consume({
        ...engine(),
        token: issued.grantToken,
      });
      expect(admitted.role).toBe(role);
      await expect(
        service.nativeContext(engine(), { kind: "terminal", actorSessionId: admitted.actorSessionId }),
      ).rejects.toMatchObject({
        status: 403,
        code: "cloud_workspace_capability_required",
      });
      expect(verify).not.toHaveBeenCalled();
    },
  );
  it("binds native agent credentials to their live execution and provider consent independently of a terminal", async () => {
    const request = await nativeFixture();
    await pool.query(
      "UPDATE cloud_workspace_engine_instances SET agent_runtime_profile='zeros-cloud-worker-v3',agent_runtime_contract_sha256=$2 WHERE id=$1",
      [fixture.engineInstanceId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled)
      VALUES('daytona','snapshot-pinned',$1,'cursor-api-key','zeros-cloud-worker-v3',true)`,
      ["a".repeat(64)],
    );
    const keys = {
      keys: { 1: randomBytes(32).toString("base64url") },
      currentKeyVersion: 1,
    };
    const credentials = new DatabaseCloudAgentCredentialService(pool, keys),
      execution = new DatabaseCloudAgentExecutionService(pool, keys, false);
    const credentialId = randomUUID(),
      delegationId = randomUUID();
    await credentials.put({
      ownerUserId: fixture.userId,
      credentialId,
      operationId: randomUUID(),
      expectedRevision: 0,
      displayName: "Test",
      material: { kind: "cursor-api-key", apiKey: "synthetic-provider" },
    });
    await credentials.delegate(fixture.userId, {
      id: delegationId,
      credentialId,
      expectedRevision: 1,
      workspaceId: fixture.workspaceId,
      granteeUserId: fixture.userId,
      models: ["grok-4.6"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const lease = await execution.admit(engine(), {
      executionId: randomUUID(),
      delegationId,
      provider: "cursor",
      model: "grok-4.6",
      source: { kind: "session", actorSessionId },
    });
    const requestId = randomUUID();
    const agent = { ...request, native: { ...request.native, requestId, source: { kind: "agent" as const, leaseId: lease.leaseId } },
      paramsSha256: createHash("sha256").update(JSON.stringify(["git.push", { nativeRequestId: requestId }])).digest("hex") };
    const terminalCredential = await redeem(request, (await prepare(request)).grant);
    const agentGrant = await service.prepare(agent, fixture.userId, verify, "synthetic-connected-user");
    const agentCredential = await service.redeem(engine(), { grant: agentGrant.grant, operation: agent.operation, paramsSha256: agent.paramsSha256,
      params: { nativeRequestId: requestId }, branch: "topic", baseBranch: "topic" });
    expect((await service.authorizeProxy(agentCredential.token)).userToken).toBe("synthetic-connected-user");
    await execution.release(engine(), lease.leaseId);
    await expect(service.authorizeProxy(agentCredential.token)).rejects.toThrow();
    expect((await service.authorizeProxy(terminalCredential.token)).userToken).toBe("synthetic-connected-user");
  });
});
