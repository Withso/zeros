import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
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
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
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

  it("requires a trusted signed device for portable admission", async () => {
    const before = (
      await pool.query(
        "SELECT count(*)::int AS count FROM cloud_workspace_endpoint_grants WHERE purpose = 'engine-connect'",
      )
    ).rows[0].count;
    await expect(service.issue(subject())).rejects.toMatchObject({
      code: "engine_client_admission_invalid",
    });
    const signer = await device();
    const proof = signer.proof();
    proof.signature = Buffer.alloc(64).toString("base64url");
    await expect(service.issue({ ...subject(), proof })).rejects.toMatchObject({
      code: "engine_client_admission_rejected",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM cloud_workspace_endpoint_grants WHERE purpose = 'engine-connect'",
        )
      ).rows[0].count,
    ).toBe(before);
  });

  it("binds device signatures to this workspace and rejects replay", async () => {
    const signer = await device();
    await expect(
      service.issue({
        ...subject(),
        proof: signer.proof({
          organizationId: fixture.organizationId,
          workspaceId: fixture.engineInstanceId,
        }),
      }),
    ).rejects.toMatchObject({ code: "engine_client_admission_rejected" });
    const proof = signer.proof();
    await service.issue({ ...subject(), proof });
    await expect(service.issue({ ...subject(), proof })).rejects.toMatchObject({
      code: "engine_client_admission_rejected",
    });
  });

  it("keeps two devices' pending connections independent and revokes only the removed device", async () => {
    const a = await device();
    const b = await device("windows");
    const first = await service.issue({ ...subject(), proof: a.proof() });
    const second = await service.issue({ ...subject(), proof: b.proof() });
    await expect(redeem(first.grantToken)).resolves.toMatchObject({
      admitted: true,
    });
    await expect(redeem(second.grantToken)).resolves.toMatchObject({
      admitted: true,
    });
    await expect(redeem(first.grantToken, true)).resolves.toMatchObject({
      admitted: true,
    });
    await pool.query(
      "UPDATE devices SET trust_state = 'revoked', revoked_at = now() WHERE id = $1",
      [a.deviceId],
    );
    await expect(redeem(first.grantToken, true)).rejects.toMatchObject({
      code: "engine_client_admission_rejected",
    });
    await expect(
      service.authorizeRelay(first.grantToken, { connected: true }),
    ).resolves.toBeNull();
    await expect(redeem(second.grantToken, true)).resolves.toMatchObject({
      admitted: true,
    });
    await expect(
      service.authorizeRelay(second.grantToken, { connected: true }),
    ).resolves.not.toBeNull();
  });

  it("renewal cannot redeem an unused grant or survive device key rotation", async () => {
    const signer = await device();
    const grant = await service.issue({ ...subject(), proof: signer.proof() });
    await expect(redeem(grant.grantToken, true)).rejects.toMatchObject({
      code: "engine_client_admission_rejected",
    });
    await redeem(grant.grantToken);
    await pool.query(
      "UPDATE devices SET key_version = key_version + 1 WHERE id = $1",
      [signer.deviceId],
    );
    await expect(redeem(grant.grantToken, true)).rejects.toMatchObject({
      code: "engine_client_admission_rejected",
    });
    await expect(
      service.authorizeRelay(grant.grantToken, { connected: true }),
    ).resolves.toBeNull();
  });

  it("renews a consumed grant after admission expiry but never for a pending device", async () => {
    const signer = await device();
    const grant = await service.issue({ ...subject(), proof: signer.proof() });
    await redeem(grant.grantToken);
    await pool.query(
      "UPDATE cloud_workspace_endpoint_grants SET expires_at = now() - interval '1 second', created_at = now() - interval '2 minutes' WHERE token_hash = $1",
      [createHash("sha256").update(grant.grantToken).digest()],
    );
    await expect(redeem(grant.grantToken, true)).resolves.toMatchObject({
      admitted: true,
    });
    await pool.query(
      "UPDATE devices SET trust_state = 'pending' WHERE id = $1",
      [signer.deviceId],
    );
    await expect(redeem(grant.grantToken, true)).rejects.toMatchObject({
      code: "engine_client_admission_rejected",
    });
  });

  it.each(["ios", "ipados", "android", "web"])(
    "admits the same authenticated protocol for %s devices",
    async (platform) => {
      const signer = await device(platform);
      const grant = await service.issue({
        ...subject(),
        proof: signer.proof(),
      });
      await expect(redeem(grant.grantToken)).resolves.toMatchObject({
        admitted: true,
      });
    },
  );
});
