import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { DatabaseCloudWorkspaceAccessService } from "./access.js";
import { DatabaseCloudRuntimeAccessAdmissionService } from "./runtime-access-admission.js";
import type { CloudWorkspaceAccessProvider } from "./provider.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("native device-owned previews", () => {
  let pool: pg.Pool,
    fixture: ReadyCloudWorkspaceFixture,
    service: DatabaseCloudWorkspaceAccessService;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudWorkspaceAccessService({
      pool,
      previewBaseDomain: "preview.example.test",
      provider: {
        getPreviewEndpoint: vi.fn(async (_id, _port, access) => ({
          url: "https://runtime-39393.on.boat.dev/",
          headerName: "x-zeros-runtime-access",
          headerValue: access!.credential,
        })),
      } as unknown as CloudWorkspaceAccessProvider,
    });
  });
  async function device() {
    const pair = generateKeyPairSync("ed25519"),
      id = randomUUID();
    const key = Buffer.from(
      pair.publicKey.export({ format: "jwk" }).x!,
      "base64url",
    );
    await pool.query(
      "INSERT INTO devices(id,user_id,label,platform,public_key,key_fingerprint) VALUES($1,$2,'Native preview test','macos',$3,$4)",
      [id, fixture.userId, key, createHash("sha256").update(key).digest()],
    );
    return {
      id,
      request: (target?: { executionId: string; portId: string }) => {
        const input = {
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
          accountUserId: fixture.userId,
          kind: "preview" as const,
          remotePort: 5173,
          expiresInMinutes: 15,
          idempotencyKey: randomUUID(),
          ...(target ? { previewTarget: target } : {}),
        };
        const fields = {
          deviceId: id,
          keyVersion: 1,
          timestampMs: Date.now(),
          nonce: randomBytes(24).toString("base64url"),
        };
        const payload = {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          port: input.remotePort,
          target: target ?? null,
          expiresInMinutes: input.expiresInMinutes,
          idempotencyKey: input.idempotencyKey,
        };
        return {
          ...input,
          proof: {
            ...fields,
            signature: sign(
              null,
              cloudWorkspaceDeviceProofMessage({
                ...fields,
                accountUserId: fixture.userId,
                action: "preview.issue",
                payload,
              }),
              pair.privateKey,
            ).toString("base64url"),
          },
        };
      },
    };
  }
  const admit = (token: string) =>
    new DatabaseCloudRuntimeAccessAdmissionService({
      pool,
      workosEnabled: false,
    }).admit({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      token,
    });
  async function nativeFixture() {
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    await pool.query(
      "UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'",
    );
  }

  it("requires a device proof for a native scalar preview even without native or target hints", async () => {
    await nativeFixture();
    const owner = await device();
    const { proof: _proof, ...legacyShape } = owner.request();
    await expect(service.issue(legacyShape)).rejects.toMatchObject({
      code: "device_proof_rejected",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM cloud_workspace_client_access_grants WHERE workspace_id=$1",
          [fixture.workspaceId],
        )
      ).rows[0].count,
    ).toBe(0);
    const issued = await service.issue(owner.request());
    const row = (
      await pool.query(
        "SELECT preview_device_id,preview_device_key_version FROM cloud_workspace_client_access_grants WHERE id=$1",
        [issued.grant.id],
      )
    ).rows[0];
    expect(row).toEqual({
      preview_device_id: owner.id,
      preview_device_key_version: 1,
    });
    await pool.query(
      "UPDATE devices SET trust_state='revoked',revoked_at=now() WHERE id=$1",
      [owner.id],
    );
    await expect(admit(issued.preview!.capability)).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
    expect(
      (
        await service.handlePreviewRequest(
          new Request(issued.preview!.origin, {
            headers: {
              "x-zeros-preview-capability": issued.preview!.capability,
            },
          }),
        )
      )?.status,
    ).toBe(401);
  });

  it("rejects pre-existing unbound scalar grants on native ingress and runtime admission", async () => {
    await nativeFixture();
    const owner = await device();
    const issued = await service.issue(owner.request());
    await pool.query(
      "UPDATE cloud_workspace_client_access_grants SET preview_device_id=NULL,preview_device_key_version=NULL WHERE id=$1",
      [issued.grant.id],
    );
    await expect(admit(issued.preview!.capability)).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
    expect(
      (
        await service.handlePreviewRequest(
          new Request(issued.preview!.origin, {
            headers: {
              "x-zeros-preview-capability": issued.preview!.capability,
            },
          }),
        )
      )?.status,
    ).toBe(401);
  });

  it("retains proof-free scalar issuance for a verified legacy provider runtime", async () => {
    const legacy = new DatabaseCloudWorkspaceAccessService({
      pool,
      previewBaseDomain: "preview.example.test",
      provider: {
        getPreviewEndpoint: vi.fn(async () => ({
          url: "https://5173-legacy.proxy.daytona.work/",
          headerName: "x-daytona-preview-token",
          headerValue: "legacy-fixture-preview-token",
        })),
      } as unknown as CloudWorkspaceAccessProvider,
    });
    const { proof: _proof, ...legacyShape } = (await device()).request();
    await expect(legacy.issue(legacyShape)).resolves.toMatchObject({
      grant: { kind: "preview", remotePort: 5173 },
    });
  });

  it("binds opaque identity to the signed device and rejects a changed target", async () => {
    const owner = await device(),
      target = { executionId: "execution-native", portId: "A".repeat(32) };
    const bad = owner.request(target);
    await expect(
      service.issue({
        ...bad,
        previewTarget: { ...target, portId: "B".repeat(32) },
      }),
    ).rejects.toMatchObject({ code: "device_proof_rejected" });
    const issued = await service.issue(owner.request(target));
    expect(issued.preview?.target).toEqual(target);
    await expect(admit(issued.preview!.capability)).resolves.toMatchObject({
      previewTarget: target,
      remotePort: 5173,
    });
    const row = (
      await pool.query(
        "SELECT preview_device_id,preview_device_key_version,preview_target FROM cloud_workspace_client_access_grants WHERE id=$1",
        [issued.grant.id],
      )
    ).rows[0];
    expect(row).toEqual({
      preview_device_id: owner.id,
      preview_device_key_version: 1,
      preview_target: target,
    });
    await expect(
      pool.query(
        "UPDATE cloud_workspace_client_access_grants SET preview_device_key_version=NULL WHERE id=$1",
        [issued.grant.id],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "cloud_access_preview_device_shape",
    });
    await expect(
      pool.query(
        "UPDATE cloud_workspace_client_access_grants SET preview_target=$2 WHERE id=$1",
        [issued.grant.id, { ...target, targetPort: 45123 }],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "cloud_access_preview_target_shape",
    });
  });
  it("keeps two devices independent and denies revoked or rotated device keys", async () => {
    const a = await device(),
      b = await device();
    const first = await service.issue(a.request()),
      second = await service.issue(b.request());
    expect(first.preview!.origin).not.toBe(second.preview!.origin);
    await service.revoke({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      accountUserId: fixture.userId,
      grantId: first.grant.id,
      credential: first.preview!.capability,
    });
    await expect(admit(first.preview!.capability)).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
    await expect(admit(second.preview!.capability)).resolves.toMatchObject({
      grantId: second.grant.id,
    });
    await pool.query("UPDATE devices SET key_version=2 WHERE id=$1", [b.id]);
    await expect(admit(second.preview!.capability)).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
    const response = await service.handlePreviewRequest(
      new Request(second.preview!.origin, {
        headers: { "x-zeros-preview-capability": second.preview!.capability },
      }),
    );
    expect(response?.status).toBe(401);
  });
});
