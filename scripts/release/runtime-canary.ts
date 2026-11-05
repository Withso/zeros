import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { withSystemTx, type createMigrationPool } from "../../apps/control-plane/src/db";
import { loadRuntimeCanaryPolicy, RuntimeCanaryAuthority, RuntimeCanaryClaimsSchema, RuntimeCanaryStatusSchema, type RuntimeCanaryClaims } from "../../apps/control-plane/src/cloud/runtime-canary";
import { requireCheck } from "./contracts";
import type { RuntimeManifest, RuntimeReleaseConfig } from "./runtime-contracts";

export type ReleaseCanary = { claims: RuntimeCanaryClaims; token: string };
export type RecordedCanary = { claims: RuntimeCanaryClaims; grantSha256: string };
export const recordedCanary = (canary: ReleaseCanary): RecordedCanary => ({ claims: canary.claims, grantSha256: createHash("sha256").update(canary.token).digest("hex") });
export function createReleaseCanary(config: RuntimeReleaseConfig, manifest: RuntimeManifest, env: NodeJS.ProcessEnv, now = Date.now()): ReleaseCanary {
  requireCheck(config.channel === "alpha" && config.action !== "promote", "Canary grants are available only to Alpha qualification");
  try {
    const policy = loadRuntimeCanaryPolicy(env.CLOUD_V2_RUNTIME_CANARY_CONFIG, "alpha");
    const kid = env.CLOUD_RUNTIME_CANARY_KEY_ID;
    const expected = policy?.keys.find(key => key.id === kid);
    const raw = env.CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY ?? "";
    if (!policy || !expected || raw.length > 1024) throw new Error();
    const bytes = Buffer.from(raw, "base64");
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== raw ||
        createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") !== expected.publicKey) throw new Error();
    const iat = Math.floor(now / 1000), jti = randomUUID();
    const claims = RuntimeCanaryClaimsSchema.parse({ version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha",
      iat, exp: iat + 900, jti, runId: config.runId, runAttempt: config.runAttempt, ...policy.fixture,
      runtimeSha256: manifest.sha256, sourceSha: manifest.sourceSha, createKey: `runtime-${config.runId}-${config.runAttempt}-${jti}` });
    const input = [{ alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid }, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    const token = `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
    new RuntimeCanaryAuthority(policy, () => now).verify(token, claims);
    return { token, claims };
  } catch { requireCheck(false, "Alpha canary signing configuration is invalid; details withheld"); }
}

type Pool = ReturnType<typeof createMigrationPool>;
export type ClosedCanary = { kind: "unused" } | { kind: "workspace"; workspaceId: string };
export async function closeReleaseCanary(pool: Pool, canary: ReleaseCanary): Promise<ClosedCanary> {
  return closeRecordedCanary(pool, recordedCanary(canary));
}
export async function closeRecordedCanary(pool: Pool, canary: RecordedCanary): Promise<ClosedCanary> {
  const c = RuntimeCanaryClaimsSchema.parse(canary.claims);
  const hash = canary.grantSha256, createKeyHash = createHash("sha256").update(c.createKey).digest("hex");
  requireCheck(/^[a-f0-9]{64}$/.test(hash), "Canary retirement has no recorded grant identity");
  return withSystemTx(pool, async tx => {
    await tx.query("SET LOCAL lock_timeout='20s'; SET LOCAL statement_timeout='25s'");
    const result = await tx.query(`INSERT INTO cloud_v2_runtime_canaries
      (grant_id,creator_user_id,org_id,repository_id,runtime_sha256,source_sha,grant_sha256,create_key_sha256,run_id,run_attempt,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11),to_timestamp($12))
      ON CONFLICT (grant_id) DO NOTHING RETURNING grant_id`,
    [c.jti,c.creatorUserId,c.organizationId,c.repositoryId,c.runtimeSha256,c.sourceSha,hash,createKeyHash,c.runId,c.runAttempt,c.iat,c.exp]);
    if (result.rowCount === 1) return { kind: "unused" as const };
    const { rows } = await tx.query<{ workspace_id: string | null }>(`SELECT workspace_id FROM cloud_v2_runtime_canaries
      WHERE grant_id=$1 AND creator_user_id=$2 AND org_id=$3 AND repository_id=$4 AND runtime_sha256=$5 AND source_sha=$6
      AND grant_sha256=$7 AND create_key_sha256=$8 AND run_id=$9 AND run_attempt=$10 AND issued_at=to_timestamp($11) AND expires_at=to_timestamp($12)`,
    [c.jti,c.creatorUserId,c.organizationId,c.repositoryId,c.runtimeSha256,c.sourceSha,hash,createKeyHash,c.runId,c.runAttempt,c.iat,c.exp]);
    // An old null pin may have lost a physical workspace row; only this insert proves unused admission.
    requireCheck(rows.length === 1 && rows[0]?.workspace_id, "Canary admission closed without recoverable workspace proof; reconcile cleanup");
    return { kind: "workspace" as const, workspaceId: rows[0].workspace_id };
  });
}

export async function cleanupReleaseCanary(canary: ReleaseCanary, deps: {
  close(): Promise<ClosedCanary>;
  remove(workspaceId: string): Promise<void>;
  status(workspaceId: string): Promise<unknown>;
  pause(): Promise<void>;
}): Promise<{ deleted: true; workspaceId: string | null }> {
  return cleanupRecordedCanary(recordedCanary(canary), deps);
}
export async function cleanupRecordedCanary(canary: RecordedCanary, deps: {
  close(): Promise<ClosedCanary>;
  remove(workspaceId: string): Promise<void>;
  status(workspaceId: string): Promise<unknown>;
  pause(): Promise<void>;
}): Promise<{ deleted: true; workspaceId: string | null }> {
  const closed = await deps.close();
  if (closed.kind === "unused") return { deleted: true, workspaceId: null };
  await deps.remove(closed.workspaceId);
  const deadline = Date.now() + 60_000;
  for (let i = 0; i < 60; i++) {
    requireCheck(Date.now() < deadline, "Canary deletion exceeded its cleanup bound");
    const status = RuntimeCanaryStatusSchema.parse(await deps.status(closed.workspaceId)), c = canary.claims;
    requireCheck(status.grantId === c.jti && status.creatorUserId === c.creatorUserId && status.organizationId === c.organizationId &&
      status.repositoryId === c.repositoryId && status.runId === c.runId && status.runAttempt === c.runAttempt &&
      status.runtimeSha256 === c.runtimeSha256 && status.sourceSha === c.sourceSha && status.workspaceId === closed.workspaceId &&
      status.grantSha256 === canary.grantSha256 && status.createKeySha256 === createHash("sha256").update(c.createKey).digest("hex") &&
      status.deleted === (status.state === "deleted"), "Canary cleanup identity differs from the recorded admission");
    if (status.deleted) return { deleted: true, workspaceId: closed.workspaceId };
    if (i < 59) await deps.pause();
  }
  requireCheck(false, "Canary deletion is unconfirmed; no pin authority was produced");
}
