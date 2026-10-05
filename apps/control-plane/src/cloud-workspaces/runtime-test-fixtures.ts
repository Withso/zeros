import type { Tx } from "../db.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { ensureHostedCloudProviderConnection } from "./provider-connections.js";

// Deliberately distinct base, runtime, archive and receipt identities. These
// fixtures exercise admission, not the publisher's manifest verification.
export const runtimeBase = {
  id: "zeros-v2-test-base",
  compatibilityId: `bc1-${"b".repeat(64)}`,
  imageRef: `boat:zeros-v2-test-base@sha256:${"c".repeat(64)}`,
  sourceCommit: "d".repeat(40),
  architecture: "linux/amd64" as const,
  storageMiB: 20_480,
};

export async function seedRuntimeBase(tx: Tx, base = runtimeBase, approvedAt = new Date()) {
  await tx.query(`INSERT INTO cloud_runtime_base_contracts (base_compatibility_id, contract_sha256, contract)
    VALUES ($1, $2, '{"schema":"zeros.base-compatibility/v1"}') ON CONFLICT DO NOTHING`,
  [base.compatibilityId, base.compatibilityId.slice(4)]);
  await tx.query(`INSERT INTO cloud_runtime_base_images (base_image_id, provider, image_ref, base_compatibility_id,
    source_commit, image_build_sha256, architecture, storage_mib, approved_at)
    VALUES ($1, 'boat', $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
  [base.id, base.imageRef, base.compatibilityId, base.sourceCommit, "c".repeat(64), base.architecture, base.storageMiB, approvedAt]);
  return base;
}

export async function seedRuntimeBundle(tx: Tx, options: {
  digit?: string;
  releaseOrder?: number;
  engineProtocolVersion?: number;
  mode?: "full" | "smoke";
  kinds?: readonly string[];
  enabled?: boolean;
  mcpQualified?: boolean;
  confirmed?: boolean;
  baseCompatibilityId?: string;
} = {}) {
  const manifestSha256 = (options.digit ?? "a").repeat(64);
  const runtimeId = `r1-${manifestSha256}`;
  const descriptor = { runtimeId, manifestSha256, archiveSha256: "e".repeat(64), archiveBytes: 100,
    expandedBytes: 200, sourceCommit: "f".repeat(40), nodeModulesAbi: 127,
    bootstrapProtocolVersion: 1 as const,
    engineProtocolVersion: options.engineProtocolVersion ?? CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION };
  const objectKey = `runtime/v1/${runtimeId}/${descriptor.archiveSha256}.tar.gz`;
  await tx.query(`INSERT INTO cloud_runtime_bundles (runtime_id, manifest_sha256, archive_sha256, archive_bytes,
    expanded_bytes, object_key, source_commit, architecture, node_version, node_modules_abi,
    bootstrap_protocol_version, setup_protocol_version, engine_protocol_version, manifest_header)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'linux/amd64', '22.23.1', $8, 1, 2, $9, '{"schema":"zeros.runtime-manifest/v1"}')`,
  [runtimeId, manifestSha256, descriptor.archiveSha256, descriptor.archiveBytes, descriptor.expandedBytes,
    objectKey, descriptor.sourceCommit, descriptor.nodeModulesAbi, descriptor.engineProtocolVersion]);
  await tx.query(`INSERT INTO cloud_runtime_channel_releases (channel, release_order, runtime_id,
    github_release_run_id, github_release_run_attempt, confirmed_at) VALUES ('alpha', $1, $2, $1, 1, $3)`,
  [options.releaseOrder ?? 1, runtimeId, options.confirmed === false ? null : new Date()]);
  for (const kind of options.kinds ?? ["claude-setup-token", "codex-chatgpt", "cursor-api-key"]) {
    await tx.query(`INSERT INTO cloud_runtime_qualifications (runtime_id, base_compatibility_id, credential_kind,
      profile, enabled, mcp_qualified, evidence, qualified_at)
      VALUES ($1, $2, $3, 'zeros-cloud-worker-v4', $4, $5, $6, now())`,
    [runtimeId, options.baseCompatibilityId ?? runtimeBase.compatibilityId, kind, options.enabled ?? true,
      options.mcpQualified ?? true, JSON.stringify({ mode: options.mode ?? "full", checks: ["manifest_digest"] })]);
  }
  return { descriptor, objectKey, pin: { runtimeId, manifestSha256, baseImageId: runtimeBase.id,
    baseCompatibilityId: options.baseCompatibilityId ?? runtimeBase.compatibilityId,
    profile: "zeros-cloud-worker-v4" as const, engineProtocolVersion: descriptor.engineProtocolVersion } };
}

export const runtimeWitness = {
  runtimeId: `r1-${"a".repeat(64)}`,
  manifestSha256: "a".repeat(64),
  baseCompatibilityId: runtimeBase.compatibilityId,
  installerReceiptSha256: "9".repeat(64),
  bootId: "11111111-1111-4111-8111-111111111111",
  supervisorSessionId: "22222222-2222-4222-8222-222222222222",
};

export async function seedRuntimeGeneration(tx: Tx, input: { workspaceId: string; organizationId: string; ownerUserId: string; imageRef?: string }) {
  await seedRuntimeBase(tx);
  const runtime = await seedRuntimeBundle(tx);
  const connection = await ensureHostedCloudProviderConnection(tx, { organizationId: input.organizationId,
    ownerUserId: input.ownerUserId, actorUserId: input.ownerUserId, isPersonal: false, provider: "boat" });
  await tx.query(`INSERT INTO cloud_workspace_generations (workspace_id, generation, org_id, provider, image_ref,
    architecture, cpu_millicores, memory_mib, storage_mib, source_commit, created_by, provider_connection_id,
    runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id, runtime_profile, runtime_engine_protocol_version)
    VALUES ($1, 1, $2, 'boat', $3, 'linux/amd64', 2000, 4096, $4, $5, $6, $7, $8, $9, $10, $11, 'zeros-cloud-worker-v4', $12)`,
  [input.workspaceId, input.organizationId, input.imageRef ?? runtimeBase.imageRef, runtimeBase.storageMiB, runtimeBase.sourceCommit,
    input.ownerUserId, connection.id, runtime.pin.runtimeId, runtime.pin.manifestSha256, runtimeBase.id,
    runtimeBase.compatibilityId, runtime.pin.engineProtocolVersion]);
  return { ...runtime, providerConnectionId: connection.id };
}
