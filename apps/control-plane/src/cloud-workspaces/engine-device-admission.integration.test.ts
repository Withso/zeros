import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import {
  CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
  DatabaseCloudWorkspaceEngineClientAdmissionService,
} from "./engine-client-admission.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud engine device admission", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let service: DatabaseCloudWorkspaceEngineClientAdmissionService;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudWorkspaceEngineClientAdmissionService({
      pool,
      endpoint: `https://api.example.test${CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH}`,
      enginePort: 39393,
      ttlSeconds: 60,
      relayEnabled: true,
    });
  });
  const subject = () => ({
    organizationId: fixture.organizationId,
    workspaceId: fixture.workspaceId,
    actorUserId: fixture.userId,
  });
  async function device(platform = "macos") {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(
      pair.publicKey.export({ format: "jwk" }).x!,
      "base64url",
    );
    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO devices (user_id, label, platform, public_key, key_fingerprint) VALUES ($1, 'Qualification device', $2, $3, $4) RETURNING id",
      [
        fixture.userId,
        platform,
        publicKey,
        createHash("sha256").update(publicKey).digest(),
      ],
    );
    const deviceId = inserted.rows[0]!.id;
    return {
      deviceId,
      proof: (
        payload = {
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
        },
      ) => {
        const fields = {
          deviceId,
          keyVersion: 1,
          timestampMs: Date.now(),
          nonce: randomBytes(24).toString("base64url"),
        };
        return {
          ...fields,
          signature: sign(
            null,
            cloudWorkspaceDeviceProofMessage({
              ...fields,
              accountUserId: fixture.userId,
              action: "engine.connect",
              payload,
            }),
            pair.privateKey,
          ).toString("base64url"),
        };
      },
    };
  }
  const redeem = (token: string, renew = false) =>
    service.consume({
      token,
      heartbeatToken: fixture.heartbeatToken,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      renew,
    });

  const retired = { code: "cloud_workspace_client_update_required", message: "Update Zeros to connect to cloud workspaces." };
  const historicalToken = `zws_${"a".repeat(43)}`;

  it("refuses retired portable admission before minting authority", async () => {
    const before = (await pool.query(
      "SELECT count(*)::int AS count FROM cloud_workspace_endpoint_grants WHERE purpose='engine-connect'",
    )).rows[0].count;
    await expect(service.issue(subject())).rejects.toMatchObject(retired);
    const signer = await device();
    const invalid = signer.proof();
    invalid.signature = Buffer.alloc(64).toString("base64url");
    await expect(service.issue({ ...subject(), proof: invalid })).rejects.toMatchObject(retired);
    await expect(service.issue({ ...subject(), proof: signer.proof() })).rejects.toMatchObject(retired);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM cloud_workspace_endpoint_grants WHERE purpose='engine-connect'",
    )).rows[0].count).toBe(before);
  });

  it("refuses retired signed requests regardless of workspace binding or replay", async () => {
    const signer = await device();
    await expect(service.issue({ ...subject(), proof: signer.proof({
      organizationId: fixture.organizationId, workspaceId: fixture.engineInstanceId,
    }) })).rejects.toMatchObject(retired);
    const proof = signer.proof();
    await expect(service.issue({ ...subject(), proof })).rejects.toMatchObject(retired);
    await expect(service.issue({ ...subject(), proof })).rejects.toMatchObject(retired);
  });

  it("does not admit either retired device or authorize its historical relay token", async () => {
    const a = await device(), b = await device("windows");
    await expect(service.issue({ ...subject(), proof: a.proof() })).rejects.toMatchObject(retired);
    await expect(service.issue({ ...subject(), proof: b.proof() })).rejects.toMatchObject(retired);
    await expect(redeem(historicalToken)).rejects.toMatchObject(retired);
    await expect(redeem(historicalToken, true)).rejects.toMatchObject(retired);
    await pool.query("UPDATE devices SET trust_state='revoked',revoked_at=now() WHERE id=$1", [a.deviceId]);
    await expect(redeem(historicalToken, true)).rejects.toMatchObject(retired);
    await expect(service.authorizeRelay(historicalToken, { connected: true })).resolves.toBeNull();
  });

  it("refuses retired renewal before and after device key rotation", async () => {
    const signer = await device();
    await expect(redeem(historicalToken, true)).rejects.toMatchObject(retired);
    await pool.query("UPDATE devices SET key_version=key_version+1 WHERE id=$1", [signer.deviceId]);
    await expect(redeem(historicalToken, true)).rejects.toMatchObject(retired);
    await expect(service.authorizeRelay(historicalToken, { connected: true })).resolves.toBeNull();
  });

  it("keeps retired renewal closed for a pending device", async () => {
    const signer = await device();
    await expect(redeem(historicalToken, true)).rejects.toMatchObject(retired);
    await pool.query("UPDATE devices SET trust_state='pending' WHERE id=$1", [signer.deviceId]);
    await expect(service.issue({ ...subject(), proof: signer.proof() })).rejects.toMatchObject(retired);
    await expect(redeem(historicalToken, true)).rejects.toMatchObject(retired);
  });

  it.each(["ios", "ipados", "android", "web"])(
    "requires an actor-2 client for %s devices", async platform => {
      const signer = await device(platform);
      await expect(service.issue({ ...subject(), proof: signer.proof() })).rejects.toMatchObject(retired);
      await expect(redeem(historicalToken)).rejects.toMatchObject(retired);
    },
  );
});
