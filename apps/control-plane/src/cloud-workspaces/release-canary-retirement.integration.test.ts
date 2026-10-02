import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { DatabaseReleaseCanaryService, releaseCanaryRequest } from "./release-canaries.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const token = "synthetic-protected-retirement-token";
suite("immutable native retirement audit settlement", () => {
  let pool: pg.Pool, service: DatabaseReleaseCanaryService, originalService: DatabaseReleaseCanaryService;
  let request: ReturnType<typeof releaseCanaryRequest>, operation: any, originalAudit: any, credentials: DatabaseCloudAgentCredentialService;
  let admission: any, configuration: any;
  const input = () => ({ version: 1, operationId: request.operationId, deletionOperationId: operation.id,
    leaseToken: "77777777-7777-4777-8777-777777777777" });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const fixture = await seedReadyCloudWorkspace(pool), credentialId = randomUUID(), operationId = randomUUID();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]);
    credentials = new DatabaseCloudAgentCredentialService(pool, { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 });
    await credentials.put({ ownerUserId: fixture.userId, credentialId, operationId: randomUUID(), expectedRevision: 0,
      displayName: "Synthetic release fixture", material: { kind: "cursor-api-key", apiKey: "synthetic-native-fixture-private-key" } });
    const now = Date.now();
    operation = { id: `bdop_${"c".repeat(32)}`, kind: "sandbox", targetId: "bx_native", status: "completed",
      requestedAt: new Date(now - 20_000).toISOString(), completedAt: new Date(now - 10_000).toISOString() };
    admission = { assertCanary: vi.fn(async () => { throw new HttpError(409, "fixture_freshness", "Fresh fixture allocation barrier"); }),
      assertCanaryRetirement: vi.fn(async () => ({ targetId: "bx_native", intentAt: now - 60_000, provenanceSha256: "e".repeat(64),
        physicalCleanup: { operation } })) };
    configuration = { ownerUserId: fixture.userId, organizationId: fixture.organizationId, channel: "alpha", repository: "example/zeros",
      sourceSha: "d".repeat(40), tokenSha256: createHash("sha256").update(token).digest("hex"), keys: { keys: {}, currentKeyVersion: 1 },
      admission, boat: { apiKey: "synthetic-boat-authority", apiUrl: "https://boat.example.test", billingOrg: "test-wallet" } };
    service = new DatabaseReleaseCanaryService(pool, configuration);
    originalService = new DatabaseReleaseCanaryService(pool, { ...configuration, sourceSha: "a".repeat(40) });
    const designation = await service.designate(fixture.userId, credentialId, { operationId: randomUUID(), expectedDesignationId: "0",
      credentialRevision: 1, enabled: true, models: ["composer-2.5"] });
    const original = { version: 1, ownerUserId: fixture.userId, organizationId: fixture.organizationId, channel: "alpha", sourceSha: "a".repeat(40),
      repository: "example/zeros", qualificationProfile: "smoke", operationId, runId: "123", runAttempt: "1", branch: "main",
      kind: "cursor-api-key", credentialId, credentialRevision: 1, designationId: designation.designationId, model: "composer-2.5",
      target: { id: "bx_native", attempt: operationId, snapshotId: "worker-test", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64) } };
    request = releaseCanaryRequest(original, { ...configuration, sourceSha: original.sourceSha });
    const subject = { operationId, requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), credentialId,
      credentialRevision: 1, designationId: designation.designationId, kind: request.kind, model: request.model, qualificationProfile: request.qualificationProfile,
      channel: request.channel, sourceSha: request.sourceSha, repository: request.repository, runId: request.runId, runAttempt: request.runAttempt,
      targetId: request.target.id, imageRef: `boat:worker-test@sha256:${request.target.buildSha256}`, allowanceOwnerUserId: fixture.userId, beforeVersion: 1 };
    originalAudit = (await withSystemTx(pool, tx => tx.query("INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES($1,$2,$3,$4) RETURNING id,subject,action",
      [fixture.organizationId, fixture.userId, "cloud.release_canary.dispatched", JSON.stringify(subject)]))).rows[0];
    vi.stubGlobal("fetch", vi.fn(async (url: any, options: any) => {
      expect(options.method).toBe("GET");
      if (String(url).endsWith(`/deletion-operations/${operation.id}`)) return new Response(JSON.stringify({ operation }));
      if (String(url).endsWith("/sandboxes/bx_native")) return new Response(null, { status: 404 });
      throw new Error("Unexpected synthetic provider observation");
    }));
  });
  const audit = () => withSystemTx(pool, tx => tx.query("SELECT id,action,subject FROM audit_log WHERE subject->>'operationId'=$1 ORDER BY id", [request.operationId]));
  const fresh = () => {
    const id = randomUUID();
    return { ...request, sourceSha: configuration.sourceSha, operationId: id, runId: "124",
      target: { ...request.target, id: "bx_fresh", attempt: id, sourceCommit: configuration.sourceSha } };
  };
  it("settles the real preparing/dispatched SQL fence append-only before allowing a separately fresh admission", async () => {
    const next = fresh();
    await expect(service.admit(next, `Bearer ${token}`)).rejects.toThrow("credential requires reconciliation");
    expect(await service.retire(input(), `Bearer ${token}`)).toEqual({ retired: true });
    const rows = (await audit()).rows;
    expect(rows).toHaveLength(2); expect(rows[0]).toEqual(originalAudit); expect(rows[1].action).toBe("cloud.release_canary.retired");
    expect(rows[1].subject.sourceSha).toBe(request.sourceSha); expect(rows[1].subject.retirement.operation.status).toBe("completed");
    await expect(service.admit(next, `Bearer ${token}`)).rejects.toThrow("Fresh fixture allocation barrier");
    expect(admission.assertCanary).toHaveBeenCalledOnce(); expect(admission.assertCanary.mock.calls[0][0].sourceSha).toBe(configuration.sourceSha);
    expect(await service.retire(input(), `Bearer ${token}`)).toEqual({ retired: true });
    expect((await audit()).rows).toHaveLength(2);
  });
  it("permits truthful cleanup after revocation without decrypting material or granting new consent", async () => {
    await credentials.revoke(request.ownerUserId, request.credentialId);
    expect(await service.retire(input(), `Bearer ${token}`)).toEqual({ retired: true });
    await expect(service.admit(fresh(), `Bearer ${token}`)).rejects.toThrow("designated");
    expect(admission.assertCanary).not.toHaveBeenCalled(); expect((await audit()).rows).toHaveLength(2);
  });
  it("rejects a terminal operation even under the old exact-source API before renewal or dispatch", async () => {
    await service.retire(input(), `Bearer ${token}`);
    await expect(originalService.admit(request, `Bearer ${token}`)).rejects.toThrow("credential preparation requires reconciliation");
    expect(admission.assertCanary).not.toHaveBeenCalled(); expect((await audit()).rows).toHaveLength(2);
  });
  it("does not settle pending storage or bypass the current staff owner boundary", async () => {
    operation.status = "blocked"; operation.stage = "waiting_for_uploads"; operation.completedAt = null;
    await expect(service.retire(input(), `Bearer ${token}`)).rejects.toThrow("physical deletion is unconfirmed");
    expect((await audit()).rows).toHaveLength(1);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [request.ownerUserId]);
    await expect(service.retire(input(), `Bearer ${token}`)).rejects.toThrow("owner allowance");
    expect((await audit()).rows).toHaveLength(1);
  });
});
