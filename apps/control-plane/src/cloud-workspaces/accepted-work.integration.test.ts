import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../auth.js";
import { AuthSessionProofService } from "../auth-session-proof.js";
import { withSystemTx, withUserTx } from "../db.js";
import { flagEffective, type RolloutFlagName } from "../rollout-flags.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudAcceptedWorkService, type AcceptedWorkOptions } from "./accepted-work.js";
import { type CloudAcceptedWorkEnrollRequest, CloudAcceptedWorkReceiptSchema, cloudAcceptedWorkProofMessage } from "./accepted-work-contract.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { DatabaseCapabilityActorSessionService } from "./capability-actor-sessions.js";
import { installCapabilityActorSessionFlags } from "./actor-session-authority.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { CloudAgentBootCredentialResponseSchema, CloudAgentBootScopeSchema } from "./agent-boot-contract.js";
import { issueClientCapabilities } from "./capability-issuer.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { ServiceCapabilityVerifier, ENGINE_CLIENT_CAPABILITY_PIN } from "./capability-service-verifier.js";
import { capabilityProofMessage } from "./capability-verifier.js";
import { signTestCapability, testEd25519Key, testSigningJwk, testEngineClaims } from "./capability-verifier-test-utils.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { assertNativeGithubActor } from "./github-native-grants.js";
import { createCloudWorkspaceInternalRoutes, type CloudWorkspaceInternalSetupService } from "./internal-routes.js";

const ISSUER = "https://cp.example.test", KID = "cap-2026-10-accepted";
const issuerKey = testEd25519Key(KID), deviceKey = testEd25519Key("accepted-work-device");
const publicKeys = [testSigningJwk(KID)];
const keys = { signer: () => ({ kid: KID, key: issuerKey.privateKey }) } as unknown as CapabilitySigningKeyStore;
const flags = new Set(["capabilities", "realtime_uplink", "credential_push", "turn_journal", "detached_turns"]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("exact accepted-work enrollment", () => {
  let pool: pg.Pool;
  const proofs: AuthSessionProofService[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterEach(() => { for (const proof of proofs.splice(0)) proof.dispose(); installCapabilityActorSessionFlags(); });

  async function fixture(withCredential = false) {
    const f = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,accepted_work_version=1 WHERE id=$1", [f.engineInstanceId]);
    const engine = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken };
    const credentialKeys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
    const bootService = new DatabaseCloudAgentExecutionService(pool, credentialKeys, false);
    if (withCredential) {
      const credentials = new DatabaseCloudAgentCredentialService(pool, credentialKeys), credentialId = randomUUID();
      await credentials.put({ credentialId, ownerUserId: f.userId, organizationId: f.organizationId, operationId: randomUUID(),
        expectedRevision: 0, displayName: "Accepted Cursor", material: { kind: "cursor-api-key", apiKey: "synthetic-accepted-provider-key" } });
      await credentials.setOrganizationConnection(f.userId, f.organizationId, "cursor", { expectedRevision: 0, credentialId,
        credentialRevision: 1, models: ["grok-4.6"], consent: "zeros-managed" });
    }
    const bootInput = { version: 1, mode: "boot-owner-v1", workspaceId: f.workspaceId, organizationId: f.organizationId,
      generation: 1, engineInstanceId: f.engineInstanceId };
    const boot = CloudAgentBootCredentialResponseSchema.parse(await bootService.boot(engine, "bootstrap", bootInput));
    await bootService.boot(engine, "activate", { ...bootInput, bootId: boot.bootId, writerEpoch: boot.writerEpoch, expectedCacheRevision: boot.cacheRevision });
    const scope = CloudAgentBootScopeSchema.parse(Object.fromEntries(Object.keys(CloudAgentBootScopeSchema.shape)
      .map(key => [key, boot[key as keyof typeof boot]])));
    const runtimeId = (await pool.query<{ runtime_id: string }>("SELECT runtime_id FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0]!.runtime_id;
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${f.userId}`,
      email: `accepted-${f.userId}@example.test`, displayName: "Owner",
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    const sourceId = (await pool.query<{ id: string }>(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [user.authentication.sessionId, user.identity.subject, user.id])).rows[0]!.id;
    const publicKey = Buffer.from(deviceKey.x, "base64url");
    const deviceId = (await pool.query<{ id: string }>(`INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint)
      VALUES($1,'Accepted work','macos',$2,$3) RETURNING id`, [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
    await pool.query(`INSERT INTO cloud_capability_signing_keys(kid,public_jwk,key_version,nonce,ciphertext,auth_tag,state,activated_at)
      VALUES($1,$2,1,$3,$4,$5,'current',clock_timestamp())`, [KID, { kty: "OKP", crv: "Ed25519", x: issuerKey.x }, randomBytes(12), randomBytes(32), randomBytes(16)]);
    const capability = (await withSystemTx(pool, tx => issueClientCapabilities(tx, keys, ISSUER,
      { workspaceId: f.workspaceId, organizationId: f.organizationId, actorUserId: user.id, deviceId, sessionId: sourceId }, ["zeros:engine"]))).capabilities["zeros:engine"].token;
    const claims = JSON.parse(Buffer.from(capability.split(".")[1]!, "base64url").toString("utf8"));
    const actors = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393, bridgeUrl: "wss://cp.example.test/bridge", workosEnabled: false });
    const admission = await actors.admitCapability({ ...engine, claims });
    let clockOffset = 0;
    const clock = () => Date.now() + clockOffset;
    const verifier = new ServiceCapabilityVerifier({ pin: ENGINE_CLIENT_CAPABILITY_PIN, issuer: ISSUER, keys: () => publicKeys,
      placement: async () => ({ generation: 1, engineInstanceId: f.engineInstanceId }), now: clock });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const list = vi.fn(async () => ({ data: [{ id: user.authentication.sessionId!, userId: user.identity.subject,
      status: "active", createdAt: new Date().toISOString(), expiresAt }], listMetadata: { after: null } }));
    const proof = new AuthSessionProofService(pool, { listSessions: list }); proofs.push(proof);
    const on = new Set(flags);
    const options = { pool, proof, verifier, workosEnabled: false, now: clock,
      flags: { enabled: (org: string, flag: RolloutFlagName) => org === f.organizationId && on.has(flag), anyEnabled: (flag: RolloutFlagName) => on.has(flag) } };
    const make = (overrides: Partial<AcceptedWorkOptions> = {}) => new DatabaseCloudAcceptedWorkService({ ...options, ...overrides });
    const freshProof = (token = capability) => {
      const c = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
      const timestampMs = clock(), nonce = randomBytes(16).toString("base64url");
      return { timestampMs, nonce, signature: sign(null, capabilityProofMessage({ aud: c.aud, wsp: c.wsp, jti: c.jti,
        timestampMs, nonce, route: "direct" }), deviceKey.privateKey).toString("base64url") };
    };
    const command = { commandId: randomUUID(), conversationId: randomUUID(), turnId: randomUUID(), executionId: randomUUID(),
      payloadSha256: createHash("sha256").update("synthetic immutable command").digest("hex"), provider: "cursor" as const,
      model: "grok-4.6", cwd: "/srv/zeros/workspace" };
    const request = (overrides: Partial<CloudAcceptedWorkEnrollRequest> = {}): CloudAcceptedWorkEnrollRequest => {
      const value = { version: 1 as const, scope, runtimeId, actorSessionId: admission.actorSessionId, command, capability,
        proof: freshProof(overrides.capability), route: "direct" as const, ...overrides };
      const c = JSON.parse(Buffer.from(value.capability.split(".")[1]!, "base64url").toString("utf8"));
      const commandSignature = sign(null, Buffer.from(cloudAcceptedWorkProofMessage({ aud: c.aud, wsp: c.wsp, jti: c.jti,
        scope: value.scope, commandId: value.command.commandId, conversationId: value.command.conversationId,
        payloadSha256: value.command.payloadSha256, timestampMs: value.proof.timestampMs, nonce: value.proof.nonce, route: value.route })),
        deviceKey.privateKey).toString("base64url");
      return { ...value, commandSignature: overrides.commandSignature ?? commandSignature };
    };
    const count = async () => Number((await pool.query("SELECT count(*) AS count FROM cloud_accepted_work_enrollments")).rows[0]!.count);
    return { ...f, engine, scope, runtimeId, sourceId, user, deviceId, admission, claims, capability, verifier, freshProof, request, command, bootService,
      proof, list, make, on, count, clock, advance: (ms: number) => { clockOffset += ms; }, setClock: (ms: number) => { clockOffset = ms - Date.now(); } };
  }

  it("enrolls only exact owner work with finite original deadlines and no reusable token", async () => {
    const f = await fixture(), service = f.make(), input = f.request();
    const receipt = CloudAcceptedWorkReceiptSchema.parse(await service.enroll(f.engine, input));
    expect(receipt).toMatchObject({ scope: f.scope, runtimeId: f.runtimeId, actorSessionId: f.admission.actorSessionId,
      sourceSessionId: f.sourceId, kid: KID, capabilityId: f.claims.jti, actor: { userId: f.user.id, deviceId: f.deviceId, role: "owner" },
      command: f.command, epochs: f.claims.ep, capabilityExpiresAtMs: f.claims.exp * 1000, providerProofVersion: 1 });
    expect(receipt.providerExpiresAtMs).toBeGreaterThan(receipt.capabilityExpiresAtMs);
    const stored = JSON.stringify((await pool.query("SELECT * FROM cloud_accepted_work_enrollments")).rows);
    expect(stored).not.toContain(input.capability); expect(stored).not.toContain(input.proof.signature);
    expect(stored).not.toContain(f.user.authentication.sessionId);
    expect(await f.count()).toBe(1);
  });

  it("enrolls the immutable capability session source without borrowing legacy auth columns", async () => {
    const f = await fixture();
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::text,'active')",
      [f.organizationId, `org_${randomUUID()}`]);
    const enabled = new Set(["capabilities", "runtime_connect", "realtime_uplink", "capability_actor_sessions"]);
    installCapabilityActorSessionFlags({ enabled: (org, flag) => org === f.organizationId && enabled.has(flag), anyEnabled: flag => enabled.has(flag) });
    const admission = await new DatabaseCapabilityActorSessionService(pool, true).admit({ ...f.engine, claims: f.claims,
      keyId: KID, tokenSha256: createHash("sha256").update(f.capability).digest("hex"), route: "direct" });
    const receipt = await f.make().enroll(f.engine, f.request({ actorSessionId: admission.actorSessionId }));
    expect(receipt).toMatchObject({ actorSessionId: admission.actorSessionId, sourceSessionId: f.sourceId });
    expect((await pool.query("SELECT auth_provider,auth_subject,auth_session_id FROM cloud_workspace_actor_sessions WHERE id=$1",
      [admission.actorSessionId])).rows[0]).toEqual({ auth_provider: null, auth_subject: null, auth_session_id: null });
  });

  it("exposes only an engine-authenticated closed enrollment request with no-store responses", async () => {
    const f = await fixture(), service = f.make();
    const app = createCloudWorkspaceInternalRoutes({} as CloudWorkspaceInternalSetupService, { acceptedWork: service });
    const post = (body: unknown, credential = f.heartbeatToken) => app.request("/internal/v2/cloud-workspaces/engine/accepted-work", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body) });
    const response = await post(f.request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(CloudAcceptedWorkReceiptSchema.safeParse(await response.json()).success).toBe(true);
    expect((await post(f.request(), "not-an-engine-credential")).status).toBe(401);
    expect((await post({ ...f.request(), genericGrant: true })).status).toBe(422);
    expect(await f.count()).toBe(1);
  });

  it("keeps context and terminal closure engine-authenticated, bounded and private even with flags off", async () => {
    const f = await fixture(true), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    const app = createCloudWorkspaceInternalRoutes({ agentExecutions: f.bootService } as CloudWorkspaceInternalSetupService, { acceptedWork: service });
    const root = "/internal/v2/cloud-workspaces/engine/accepted-work";
    const context = { version: 1, scope: f.scope, runtimeId: f.runtimeId, acceptedWorkId: receipt.acceptedWorkId,
      command: f.command, operation: "context", repositoryServers: [] };
    const closure = { version: 1, scope: f.scope, acceptedWorkId: receipt.acceptedWorkId, commandId: f.command.commandId };
    const post = (path: string, body: unknown, token = f.heartbeatToken) => app.request(root + path, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const response = await post("/context", context);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("actor");
    for (const [path, body] of [["/context", context], ["/close", closure]] as const) {
      expect((await post(path, body, "bad")).status).toBe(401);
      expect((await post(path, { ...body, genericGrant: true })).status).toBe(422);
    }
    f.on.clear();
    expect((await post("/context", context)).status).toBe(403);
    expect((await post("/close", { ...closure, commandId: randomUUID() })).status).toBe(403);
    for (let i = 0; i < 2; i++) {
      const closed = await post("/close", closure);
      expect(closed.status).toBe(200); expect(await closed.json()).toEqual({ closed: true });
      expect(closed.headers.get("cache-control")).toBe("no-store");
    }
    for (const [path, limit] of [["/close", 64 * 1024], ["/context", 1024 * 1024]] as const)
      expect((await post(path, { padding: "x".repeat(limit) })).status).toBe(413);
    expect((await pool.query("SELECT closed_at IS NOT NULL AS closed FROM cloud_accepted_work_enrollments WHERE id=$1",
      [receipt.acceptedWorkId])).rows[0].closed).toBe(true);
  });

  it("same_id_changed_payload_conflicts; fresh-proof retries keep the first receipt and expiry", async () => {
    const f = await fixture(), service = f.make(), first = await service.enroll(f.engine, f.request());
    f.advance(1_000);
    const renewed = signTestCapability({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: KID },
      { ...f.claims, jti: randomBytes(16).toString("base64url"), iat: f.claims.iat + 1, exp: f.claims.exp + 1 });
    expect(await service.enroll(f.engine, f.request({ capability: renewed }))).toEqual(first);
    await expect(service.enroll(f.engine, f.request({ command: { ...f.command, payloadSha256: "a".repeat(64) } })))
      .rejects.toMatchObject({ code: "accepted_work_conflict" });
    expect(await f.count()).toBe(1);
  });

  it("expired_token_cannot_accept_new_command even inside the verifier clock allowance", async () => {
    const f = await fixture(); f.setClock(f.claims.exp * 1000);
    await expect(f.make().enroll(f.engine, f.request())).rejects.toMatchObject({ code: "accepted_work_rejected" });
    expect(f.list).not.toHaveBeenCalled(); expect(await f.count()).toBe(0);
  });

  it("acceptance_expiring_during_enrollment_is_rejected", async () => {
    const f = await fixture();
    const provider = deferred<Awaited<ReturnType<typeof f.list>>>(), ordinary = await f.list(); f.list.mockClear().mockReturnValue(provider.promise);
    const result = f.make().enroll(f.engine, f.request()).catch(error => error);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    f.setClock(f.claims.exp * 1000); provider.resolve(ordinary);
    expect(await result).toMatchObject({ code: "accepted_work_rejected" }); expect(await f.count()).toBe(0);
  });

  it("engine_token_alone_cannot_enroll; neither an expired actor nor a consumed proof substitutes", async () => {
    const f = await fixture(), service = f.make();
    const engineToken = signTestCapability({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: KID }, testEngineClaims({ iss: ISSUER,
      org: f.organizationId, wsp: f.workspaceId, gen: 1, ein: f.engineInstanceId, sub: `engine:${f.engineInstanceId}`,
      iat: f.claims.iat, nbf: f.claims.nbf, exp: f.claims.exp }));
    await expect(service.enroll(f.engine, f.request({ capability: engineToken }))).rejects.toMatchObject({ code: "accepted_work_rejected" });
    const used = f.request();
    expect((await f.verifier.verify(used.capability, { workspaceId: f.workspaceId, organizationId: f.organizationId,
      route: used.route, proof: used.proof, scope: "ws:prompt" })).ok).toBe(true);
    await expect(service.enroll(f.engine, used)).rejects.toMatchObject({ code: "accepted_work_rejected" });
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=clock_timestamp()-interval '31 seconds' WHERE id=$1", [f.admission.actorSessionId]);
    await expect(service.enroll(f.engine, f.request())).rejects.toMatchObject({ code: "accepted_work_rejected" });
    expect(f.list).not.toHaveBeenCalled(); expect(await f.count()).toBe(0);
  });

  it.each(["source", "device", "key", "epoch", "writer"])("a %s revocation during provider I/O wins the enrollment race", async change => {
    const f = await fixture(), provider = deferred<Awaited<ReturnType<typeof f.list>>>(), ordinary = await f.list();
    f.list.mockClear().mockReturnValue(provider.promise);
    const result = f.make().enroll(f.engine, f.request()).catch(error => error);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    if (change === "source") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1", [f.sourceId]);
    if (change === "device") await pool.query("UPDATE devices SET revoked_at=clock_timestamp(),trust_state='revoked' WHERE id=$1", [f.deviceId]);
    if (change === "key") await pool.query("UPDATE cloud_capability_signing_keys SET state='revoked' WHERE kid=$1", [KID]);
    if (change === "epoch") await pool.query("UPDATE cloud_workspaces SET access_revision=access_revision+1 WHERE id=$1", [f.workspaceId]);
    if (change === "writer") await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=clock_timestamp() WHERE workspace_id=$1", [f.workspaceId]);
    provider.resolve(ordinary);
    expect(await result).toMatchObject({ code: "accepted_work_rejected" }); expect(await f.count()).toBe(0);
  });

  it("the accepted reference survives socket retirement but cannot authorize a generic grant or changed execution", async () => {
    const f = await fixture(), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=clock_timestamp(),last_renewed_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.admission.actorSessionId]);
    await pool.query("UPDATE auth_sessions SET last_token_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.sourceId]);
    const input = { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope: f.scope, runtimeId: f.runtimeId, command: f.command, operation: "context" };
    expect(await service.authorize(f.engine, input)).toEqual(receipt);
    for (const change of [{ operation: "generic-grant" }, { operation: "workspace-admin" }, { command: { ...f.command, executionId: randomUUID() } }])
      await expect(service.authorize(f.engine, { ...input, ...change })).rejects.toMatchObject({ code: "accepted_work_rejected" });
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1", [f.sourceId]);
    await expect(service.authorize(f.engine, input)).rejects.toMatchObject({ code: "accepted_work_rejected" });
  });

  it("an exact accepted operation outlives client expiry but not its original provider deadline", async () => {
    const f = await fixture(), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    const request = { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope: f.scope, runtimeId: f.runtimeId, command: f.command, operation: "context" };
    f.setClock(receipt.capabilityExpiresAtMs + 1);
    expect(await service.authorize(f.engine, request)).toEqual(receipt);
    await expect(service.enroll(f.engine, f.request())).rejects.toMatchObject({ code: "accepted_work_rejected" });
    f.setClock(receipt.providerExpiresAtMs);
    await expect(service.authorize(f.engine, request)).rejects.toMatchObject({ code: "accepted_work_rejected" });
  });

  it("renews only an enrolled command's ten-second context and native source after the desktop actor ends", async () => {
    const f = await fixture(true), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [f.admission.actorSessionId]);
    f.setClock(receipt.capabilityExpiresAtMs + 1);
    const request = { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope: f.scope, runtimeId: f.runtimeId,
      command: f.command, operation: "context", repositoryServers: [] };
    const response = await f.bootService.acceptedContext(f.engine, request, service) as {
      contextId: string; acceptedWork: { acceptedWorkId: string; confirmedUntilMs: number } };
    expect(response).toMatchObject({ provider: "cursor", conversationId: f.command.conversationId,
      acceptedWork: { acceptedWorkId: receipt.acceptedWorkId } });
    expect(response).not.toHaveProperty("actor");
    expect(response.acceptedWork.confirmedUntilMs).toBeGreaterThan(Date.now());
    expect(response.acceptedWork.confirmedUntilMs).toBeLessThanOrEqual(Date.now() + 10_000);
    await expect(f.bootService.acceptedContext(f.engine, { ...request, command: { ...f.command, executionId: randomUUID() } }, service)).rejects.toThrow();
    const source = { kind: "boot-agent" as const, contextId: response.contextId };
    await expect(withSystemTx(pool, tx => assertNativeGithubActor(tx, f.engine, source, false))).rejects.toThrow();
    expect(await withSystemTx(pool, tx => assertNativeGithubActor(tx, f.engine, source, false, service)))
      .toMatchObject({ actorUserId: f.user.id });
    await pool.query("UPDATE cloud_accepted_work_enrollments SET closed_at=clock_timestamp() WHERE id=$1", [receipt.acceptedWorkId]);
    await expect(f.bootService.acceptedContext(f.engine, request, service)).rejects.toThrow();
    await expect(withSystemTx(pool, tx => assertNativeGithubActor(tx, f.engine, source, false, service))).rejects.toThrow();
  });

  it("flags and explicit runtime support fail closed and are not enabled by a partial prerequisite set", async () => {
    const f = await fixture();
    for (const missing of flags) {
      const partial = new Set(flags); partial.delete(missing);
      expect(flagEffective(partial, "detached_turns")).toBe(false);
    }
    expect(flagEffective(flags, "detached_turns")).toBe(true);
    expect(flagEffective(flags, "detached_turns", false)).toBe(false);
    f.on.delete("detached_turns");
    await expect(f.make().enroll(f.engine, f.request())).rejects.toMatchObject({ code: "accepted_work_rejected" });
    f.on.add("detached_turns");
    await pool.query("UPDATE cloud_workspace_engine_instances SET accepted_work_version=NULL WHERE id=$1", [f.engineInstanceId]);
    await expect(f.make().enroll(f.engine, f.request())).rejects.toMatchObject({ code: "accepted_work_rejected" });
    expect(f.list).not.toHaveBeenCalled();
  });

  it("does not deadlock account retirement behind an accepted native source check", async () => {
    const f = await fixture(true), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    const response = await f.bootService.acceptedContext(f.engine, { version: 1, acceptedWorkId: receipt.acceptedWorkId,
      scope: f.scope, runtimeId: f.runtimeId, command: f.command, operation: "context", repositoryServers: [] }, service) as { contextId: string };
    const blocker = await pool.connect();
    let operation: Promise<unknown> | undefined, finished = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.user.id]);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      operation = withSystemTx(pool, tx => assertNativeGithubActor(tx, f.engine,
        { kind: "boot-agent", contextId: response.contextId }, false, service))
        .then(value => { finished = true; return value; }, error => { finished = true; return error; });
      await vi.waitFor(async () => expect(finished || (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount! > 0).toBe(true));
      // Account lifecycle owns the account first, then its workspaces. A
      // native request already owns the workspace and must not wait backward.
      await blocker.query("SET LOCAL lock_timeout='200ms'");
      await expect(blocker.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId])).resolves.toMatchObject({ rowCount: 1 });
      expect(await operation).toMatchObject({ code: "github_cloud_write_denied" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await operation; }
  });

  it("rolling back any prerequisite refuses an existing accepted operation", async () => {
    const f = await fixture(), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    const input = { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope: f.scope, runtimeId: f.runtimeId,
      command: f.command, operation: "context" };
    for (const flag of flags) {
      f.on.delete(flag);
      await expect(service.authorize(f.engine, input)).rejects.toMatchObject({ code: "accepted_work_rejected" });
      f.on.add(flag);
    }
  });

  it.each(["expiry", "source", "flag"])("%s is rechecked after an accepted operation waits for a row lock", async change => {
    const f = await fixture(), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    const blocker = await pool.connect();
    let operation: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await blocker.query("SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE", [f.sourceId]);
      operation = service.authorize(f.engine, { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope: f.scope,
        runtimeId: f.runtimeId, command: f.command, operation: "context" }).catch(error => error);
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount).toBeGreaterThan(0));
      if (change === "expiry") f.setClock(receipt.providerExpiresAtMs);
      if (change === "source") await blocker.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1", [f.sourceId]);
      if (change === "flag") f.on.delete("detached_turns");
      await blocker.query("COMMIT");
      expect(await operation).toMatchObject({ code: "accepted_work_rejected" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await operation; }
  });

  it("key revocation serializes with the narrow operation and refuses every later use", async () => {
    const f = await fixture(), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    const input = { version: 1, acceptedWorkId: receipt.acceptedWorkId, scope: f.scope, runtimeId: f.runtimeId,
      command: f.command, operation: "native-git" };
    const entered = deferred<number>(), finish = deferred<void>();
    const operation = withSystemTx(pool, async tx => {
      await service.authorizeInTx(tx, f.engine, input);
      entered.resolve((await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      await finish.promise;
    });
    let revocation: Promise<unknown> | undefined;
    try {
      const pid = await entered.promise;
      revocation = pool.query("UPDATE cloud_capability_signing_keys SET state='revoked' WHERE kid=$1", [KID]);
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount).toBeGreaterThan(0));
      finish.resolve(); await operation; await revocation;
      await expect(service.authorize(f.engine, input)).rejects.toMatchObject({ code: "accepted_work_rejected" });
    } finally { finish.resolve(); await operation; await revocation; }
  });

  it("actor expiry during the final key lock refuses enrollment", async () => {
    const f = await fixture(), blocker = await pool.connect();
    const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const service = f.make({ proof: { prove: async (input, signal) => {
      const proof = await f.proof.prove(input, signal);
      await blocker.query("BEGIN");
      await blocker.query("SELECT kid FROM cloud_capability_signing_keys WHERE kid=$1 FOR UPDATE", [KID]);
      await pool.query(`UPDATE cloud_workspace_actor_sessions
        SET admission_expires_at=statement_timestamp()+interval '500 milliseconds',
          session_expires_at=statement_timestamp()+interval '500 milliseconds'
        WHERE id=$1`, [f.admission.actorSessionId]);
      return proof;
    } } });
    const enrolling = service.enroll(f.engine, f.request()).catch(error => error);
    try {
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount).toBeGreaterThan(0));
      // Observe the actual DB deadline while keeping the key lock held. A
      // timer/sleep alone would not prove that final authorization waited.
      await vi.waitFor(async () => expect((await pool.query(`SELECT session_expires_at<=clock_timestamp() AS expired
        FROM cloud_workspace_actor_sessions WHERE id=$1`, [f.admission.actorSessionId])).rows[0]!.expired).toBe(true), { timeout: 2_000 });
      await blocker.query("COMMIT");
      expect(await enrolling).toMatchObject({ code: "accepted_work_rejected" });
      expect(await f.count()).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await enrolling; }
  });

  it("keeps receipts immutable, terminal and invisible to ordinary RLS callers", async () => {
    const f = await fixture(), service = f.make(), receipt = await service.enroll(f.engine, f.request());
    expect((await withUserTx(pool, f.user.id, tx => tx.query("SELECT * FROM cloud_accepted_work_enrollments"))).rows).toHaveLength(0);
    await expect(pool.query("UPDATE cloud_accepted_work_enrollments SET receipt=receipt||'{\"revision\":2}'::jsonb WHERE id=$1", [receipt.acceptedWorkId]))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE cloud_accepted_work_enrollments SET closed_at=clock_timestamp() WHERE id=$1", [receipt.acceptedWorkId]);
    await expect(pool.query("UPDATE cloud_accepted_work_enrollments SET closed_at=NULL WHERE id=$1", [receipt.acceptedWorkId])).rejects.toMatchObject({ code: "23514" });
    await expect(service.enroll(f.engine, f.request())).rejects.toMatchObject({ code: "accepted_work_rejected" });
  });

  it("the signing-key fence requires positively true system context", async () => {
    const f = await fixture();
    expect((await withUserTx(pool, f.user.id, tx => tx.query("SELECT cloud_accepted_work_key_live($1) AS live", [KID])))
      .rows[0]!.live).toBe(false);
    // A fresh connection has never set the custom GUC: absence is SQL NULL,
    // not the false value that withUserTx explicitly writes.
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE zeros_app");
      expect((await client.query("SELECT app_is_system() AS system")).rows[0]!.system).toBeNull();
      expect((await client.query("SELECT cloud_accepted_work_key_live($1) AS live", [KID])).rows[0]!.live).toBe(false);
    } finally { await client.query("ROLLBACK"); await client.end(); }
  });

  it.each(["session", "renewal"])("refuses fresh enrollment when actor %s cutoff passes during the receipt INSERT", async cutoff => {
    const f = await fixture(), blocker = await pool.connect();
    const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const service = f.make({ proof: { prove: async (input, signal) => {
      const proof = await f.proof.prove(input, signal);
      await blocker.query("BEGIN");
      // Ordinary migration/maintenance SHARE lock: reads still work; the
      // enrollment INSERT must wait after its actor confirmation.
      await blocker.query("LOCK TABLE cloud_accepted_work_enrollments IN SHARE MODE");
      if (cutoff === "session") await pool.query(`UPDATE cloud_workspace_actor_sessions
        SET admission_expires_at=statement_timestamp()+interval '800 milliseconds',
          session_expires_at=statement_timestamp()+interval '800 milliseconds'
        WHERE id=$1`, [f.admission.actorSessionId]);
      else await pool.query(`UPDATE cloud_workspace_actor_sessions
        SET last_renewed_at=clock_timestamp()-interval '29.2 seconds' WHERE id=$1`, [f.admission.actorSessionId]);
      return proof;
    } } });
    const enrolling = service.enroll(f.engine, f.request()).catch(error => error);
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ query: string }>(`SELECT query FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid]);
        expect(waiting.rows.some(row => row.query.startsWith("INSERT INTO cloud_accepted_work_enrollments"))).toBe(true);
      });
      await vi.waitFor(async () => expect((await pool.query(`SELECT CASE WHEN $2='session'
        THEN session_expires_at<=clock_timestamp()
        ELSE last_renewed_at<=clock_timestamp()-interval '30 seconds' END AS expired
        FROM cloud_workspace_actor_sessions WHERE id=$1`, [f.admission.actorSessionId, cutoff])).rows[0]!.expired).toBe(true), { timeout: 2_000 });
      await blocker.query("COMMIT");
      const result = await enrolling;
      // Avoid rendering a receipt/user identity if the probe finds a miss.
      expect(result && typeof result === "object" && "code" in result ? result.code : "receipt_returned").toBe("accepted_work_rejected");
      expect(await f.count()).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await enrolling; }
  });
});
