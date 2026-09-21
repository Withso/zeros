import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../migrate.js";
import { withUserTx } from "../db.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { DatabaseCloudRuntimeServiceAccess, runtimeServiceProofPayload, type CloudRuntimeServiceIssue, type CloudRuntimeServiceDocument } from "./runtime-services.js";
import { DatabaseCloudRuntimeAccessAdmissionService } from "./runtime-access-admission.js";
import type { CloudWorkspaceProviderResolver } from "./provider-resolver.js";
import {DatabaseCloudWorkspaceCollaborationService} from "./actors.js";
import {ensureUser} from "../auth.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("device-bound native cloud services", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, service: DatabaseCloudRuntimeServiceAccess;
  let admission: DatabaseCloudRuntimeAccessAdmissionService;
  const endpoint = vi.fn(async () => ({ url: "https://runtime.example.test/" }));
  const resolve = vi.fn(async () => ({ provider: { getEngineEndpoint: endpoint } }));
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool); fixture = await seedReadyCloudWorkspace(pool);
    endpoint.mockReset().mockImplementation(async () => ({ url: "https://runtime.example.test/" }));
    resolve.mockClear();
    service = new DatabaseCloudRuntimeServiceAccess({ pool, providerResolver: { resolve } as unknown as CloudWorkspaceProviderResolver,
      publicOrigin: "https://api.example.test", enginePort: 39393, forbiddenPorts: [43001], workosEnabled: false });
    admission = new DatabaseCloudRuntimeAccessAdmissionService({ pool, workosEnabled: false });
  });
  async function device(platform = "macos",accountUserId=fixture.userId) {
    const pair = generateKeyPairSync("ed25519");
    const key = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url"), id = randomUUID();
    await pool.query(`INSERT INTO devices (id, user_id, label, platform, public_key, key_fingerprint)
      VALUES ($1,$2,'Service test device',$3,$4,$5)`, [id, accountUserId, platform, key, createHash("sha256").update(key).digest()]);
    return { id, request: (changes: Partial<Omit<CloudRuntimeServiceIssue, "proof">> = {}) => {
      const request = { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, accountUserId,
        kind: "ssh" as const, expiresInMinutes: 5, idempotencyKey: randomUUID(), ...changes };
      const fields = { deviceId: id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
      return { ...request, proof: { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields,
        accountUserId, action: "runtime-service.issue", payload: runtimeServiceProofPayload(request as CloudRuntimeServiceIssue) }), pair.privateKey).toString("base64url") } };
    } };
  }
  const request = (document: CloudRuntimeServiceDocument) => new Request(document.transport.url.replace(/^wss:/, "https:"), {
    headers: { [document.transport.headerName]: document.transport.capability },
  });
  const admit = (document: CloudRuntimeServiceDocument) => admission.admit({ workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId, generation: 1, engineInstanceId: fixture.engineInstanceId,
    heartbeatToken: fixture.heartbeatToken, token: document.transport.capability });

  it("admits a shared owner and developer separately from the engine's compute sponsor",async()=>{
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1",[fixture.engineInstanceId]);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,sharingMode:"organization",expectedRevision:1});
    const ownerDevice=await device(),ownerGrant=await service.issue(ownerDevice.request());await expect(admit(ownerGrant)).resolves.toMatchObject({accountUserId:fixture.userId});
    const other=await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[fixture.organizationId,other.userId]);
    await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,assigned_by) VALUES($1,$2,$3)",[fixture.organizationId,other.userId,fixture.userId]);
    const d=await device("ipados",other.userId),doc=await service.issue(d.request());
    await expect(admit(doc)).resolves.toMatchObject({accountUserId:other.userId});await expect(service.resolve(request(doc))).resolves.toMatchObject({grantId:doc.grant.id});
    expect((await pool.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2",[fixture.teamId,other.userId])).rowCount).toBe(0);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=1 WHERE id=$1",[fixture.engineInstanceId]);
    await expect(service.issue(d.request())).rejects.toBeDefined();await expect(admit(doc)).rejects.toMatchObject({code:"runtime_access_rejected"});
  });

  it("does not revive native service grants after staff authority is removed and restored",async()=>{
    const d=await device(),doc=await service.issue(d.request());
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1",[fixture.userId]);
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1",[fixture.userId]);
    await expect(service.resolve(request(doc))).resolves.toBeNull();await expect(admit(doc)).rejects.toMatchObject({code:"runtime_access_rejected"});
    const fresh=await service.issue(d.request());await expect(admit(fresh)).resolves.toMatchObject({grantId:fresh.grant.id});
  });

  it("admits only the exact invited developer and retires that access without stopping the sponsor",async()=>{
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1",[fixture.engineInstanceId]);
    const collaboration=new DatabaseCloudWorkspaceCollaborationService(pool),scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    await collaboration.setSharing({...scope,sharingMode:"organization",expectedRevision:1});
    const other=await seedReadyCloudWorkspace(pool),guest=await ensureUser(pool,{provider:"workos",providerSubject:`workos|${other.userId}`,email:`durable-${other.userId}@example.test`,displayName:"Guest"});
    const d=await device("ios",guest.id);await expect(service.issue(d.request())).rejects.toBeDefined();
    const invitation=await collaboration.invite({...scope,email:guest.email,role:"developer"});
    await collaboration.accept({actorUserId:guest.id,identity:guest.identity,token:invitation.token!});
    const doc=await service.issue(d.request());await expect(admit(doc)).resolves.toMatchObject({accountUserId:guest.id});
    expect((await pool.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,guest.id])).rowCount).toBe(0);
    await collaboration.revokeGuest({...scope,guestUserId:guest.id});
    await expect(admit(doc)).rejects.toMatchObject({code:"runtime_access_rejected"});
    await service.revoke({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,accountUserId:guest.id,grantId:doc.grant.id});
    const readerInvite=await collaboration.invite({...scope,email:guest.email,role:"viewer"});await collaboration.accept({actorUserId:guest.id,identity:guest.identity,token:readerInvite.token!});
    await expect(service.issue(d.request())).rejects.toMatchObject({status:403});await expect(admit(doc)).rejects.toMatchObject({code:"runtime_access_rejected"});
    const ownerDevice=await device();await expect(admit(await service.issue(ownerDevice.request()))).resolves.toMatchObject({accountUserId:fixture.userId});
  });

  it("issues portable SSH and port grants without creating provider administration credentials", async () => {
    for (const platform of ["macos", "windows", "ios", "ipados"]) {
      const d = await device(platform), doc = await service.issue(d.request());
      expect(doc.ssh).toEqual({ username: "zeros", hostKey: "stream-introduction" });
      expect(doc.transport.url).toBe(`wss://api.example.test/v1/cloud-workspaces/services/ssh/${doc.grant.id}`);
      expect(doc.grant.deviceId).toBe(d.id);
      expect(resolve).not.toHaveBeenCalled();
      await expect(admit(doc)).resolves.toMatchObject({ kind: "ssh", remotePort: null, grantId: doc.grant.id });
    }
    const d = await device(), doc = await service.issue(d.request({ kind: "tunnel", remotePort: 3000 }));
    expect(doc.ssh).toBeUndefined();
    await expect(admit(doc)).resolves.toMatchObject({ kind: "tunnel", remotePort: 3000 });
    const grant = await service.resolve(request(doc));
    expect(grant).toMatchObject({ grantId: doc.grant.id, remotePort: 3000, upstreamPath: "/services/v1/tunnel" });
    expect(endpoint).toHaveBeenCalledWith(`sandbox-${fixture.workspaceId}`, 39393);
    expect(JSON.stringify((await pool.query("SELECT * FROM cloud_workspace_runtime_service_grants")).rows)).not.toContain(doc.transport.capability);
    await withUserTx(pool, fixture.userId, async tx => {
      expect((await tx.query("SELECT * FROM cloud_workspace_runtime_service_grants")).rows).toHaveLength(0);
    });
  });

  it("binds the proof to the exact action and refuses reserved ports before provider I/O", async () => {
    const d = await device(), input = d.request({ kind: "tunnel", remotePort: 3000 });
    await expect(service.issue({ ...input, remotePort: 3001 })).rejects.toMatchObject({ code: "device_proof_rejected" });
    for (const port of [22, 22222, 39393, 43001, 65536])
      await expect(service.issue(d.request({ kind: "tunnel", remotePort: port }))).rejects.toMatchObject({ code: "invalid_runtime_service" });
    await expect(service.issue(d.request({ remotePort: 3000 }))).rejects.toMatchObject({ code: "invalid_runtime_service" });
    expect(resolve).not.toHaveBeenCalled();
    const document = await service.issue(input);
    await expect(service.issue(input)).rejects.toMatchObject({ code: "device_proof_replayed" });
    await expect(service.issue(d.request({ kind: "tunnel", remotePort: 3000, idempotencyKey: input.idempotencyKey })))
      .rejects.toMatchObject({ code: "runtime_service_response_not_replayable" });
    await expect(admit(document)).resolves.toMatchObject({ grantId: document.grant.id });
  });

  it("requires the owning paid account and rejects tokens for a different path, host or port kind", async () => {
    const d = await device(), doc = await service.issue(d.request());
    for (const url of [request(doc).url.replace("api.example.test", "wrong.example.test"), request(doc).url + "?token=ignored",
      request(doc).url.replace("/ssh/", "/tunnel/"), request(doc).url.replace(doc.grant.id, randomUUID())]) {
      await expect(service.resolve(new Request(url, { headers: request(doc).headers }))).resolves.toBeNull();
    }
    expect(resolve).not.toHaveBeenCalled();
    await pool.query("UPDATE organization_seat_assignments SET state = 'released', released_at = now() WHERE org_id = $1", [fixture.organizationId]);
    await expect(service.resolve(request(doc))).resolves.toBeNull();
    await expect(admit(doc)).rejects.toMatchObject({ code: "runtime_access_rejected" });
    await expect(service.issue(d.request())).rejects.toBeDefined();
  });

  it("closes admission after device key rotation, without affecting a second device", async () => {
    const first = await device(), second = await device("ipados");
    const a = await service.issue(first.request()), b = await service.issue(second.request({ kind: "tunnel", remotePort: 3000 }));
    const lease = await service.resolve(request(a)); expect(lease).not.toBeNull();
    await pool.query("UPDATE devices SET key_version = key_version + 1 WHERE id = $1", [first.id]);
    await expect(service.revalidate(request(a), lease!)).resolves.toBeNull();
    await expect(admit(a)).rejects.toMatchObject({ code: "runtime_access_rejected" });
    await expect(admit(b)).resolves.toMatchObject({ kind: "tunnel" });
    await pool.query("UPDATE devices SET trust_state = 'pending' WHERE id = $1", [second.id]);
    await expect(admit(b)).rejects.toMatchObject({ code: "runtime_access_rejected" });
  });

  it("rechecks authority after provider resolution before connecting a stream", async () => {
    const doc = await service.issue((await device()).request());
    endpoint.mockImplementationOnce(async () => {
      await pool.query("UPDATE cloud_workspaces SET authority_epoch = authority_epoch + 1 WHERE id = $1", [fixture.workspaceId]);
      return { url: "https://runtime.example.test/" };
    });
    await expect(service.resolve(request(doc))).resolves.toBeNull();
    await expect(admit(doc)).rejects.toMatchObject({ code: "runtime_access_rejected" });
  });

  it("revokes just the selected grant and allows revocation after workspace stop", async () => {
    const d = await device(), a = await service.issue(d.request()), b = await service.issue(d.request());
    const input = { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, accountUserId: fixture.userId, grantId: a.grant.id };
    await expect(service.revoke({ ...input, accountUserId: randomUUID() })).rejects.toMatchObject({ code: "runtime_service_unavailable" });
    await service.revoke(input);
    await expect(admit(a)).rejects.toMatchObject({ code: "runtime_access_rejected" });
    await expect(admit(b)).resolves.toMatchObject({ grantId: b.grant.id });
    expect(resolve).not.toHaveBeenCalled();
    await pool.query("UPDATE cloud_workspaces SET desired_state = 'stopped' WHERE id = $1", [fixture.workspaceId]);
    await service.revoke({ ...input, grantId: b.grant.id });
    await expect(admit(b)).rejects.toMatchObject({ code: "runtime_access_rejected" });
  });

  it("limits concurrent grants and admits no replacement engine with an old bearer", async () => {
    const d = await device();
    const documents = await Promise.all(Array.from({ length: 16 }, () => service.issue(d.request())));
    await expect(service.issue(d.request())).rejects.toMatchObject({ code: "runtime_service_limit" });
    await pool.query("UPDATE cloud_workspaces SET authority_epoch = authority_epoch + 1 WHERE id = $1", [fixture.workspaceId]);
    // Stale grants cannot consume the new authority's service capacity.
    await expect(service.issue(d.request())).resolves.toMatchObject({ grant: { kind: "ssh" } });
    await pool.query("UPDATE cloud_workspace_engine_instances SET state = 'revoked', revoked_at = now() WHERE id = $1", [fixture.engineInstanceId]);
    for (const doc of documents.slice(0, 2)) {
      await expect(service.resolve(request(doc))).resolves.toBeNull();
      await expect(admit(doc)).rejects.toMatchObject({ code: "runtime_access_rejected" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
