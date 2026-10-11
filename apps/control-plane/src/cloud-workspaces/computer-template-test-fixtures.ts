import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { ComputerTemplateRuntime } from "./computer-template-boat.js";
import type { RuntimeImageChannel } from "./runtime-images.js";

export const templateRuntime: ComputerTemplateRuntime = {
  baseImageId: "zeros-v2-test-base",
  baseCompatibilityId: `bc1-${"b".repeat(64)}`,
  objectKey: "fixture-runtime-object",
  descriptor: {
    runtimeId: `r1-${"a".repeat(64)}`,
    manifestSha256: "a".repeat(64),
    archiveSha256: "c".repeat(64),
    archiveBytes: 123,
    expandedBytes: 456,
    sourceCommit: "d".repeat(40),
    nodeModulesAbi: 127,
    bootstrapProtocolVersion: 1,
    engineProtocolVersion: 20,
  },
};
export async function seedComputerTemplateRuntime(pool: pg.Pool) {
  const value = templateRuntime,
    descriptor = value.descriptor;
  await withSystemTx(pool, async (tx) => {
    await tx.query(
      `INSERT INTO cloud_runtime_base_contracts(base_compatibility_id,contract_sha256,contract)
      VALUES($1,$2,$3)`,
      [
        value.baseCompatibilityId,
        "b".repeat(64),
        JSON.stringify({ schema: "zeros.base-compatibility/v1" }),
      ],
    );
    await tx.query(
      `INSERT INTO cloud_runtime_base_images(base_image_id,provider,image_ref,base_compatibility_id,source_commit,image_build_sha256,architecture,storage_mib,approved_at)
      VALUES($1,'boat','boat:zeros-v2-test-base@sha256:' || $4,$2,$3,$4,'linux/amd64',20480,now())`,
      [
        value.baseImageId,
        value.baseCompatibilityId,
        "d".repeat(40),
        "c".repeat(64),
      ],
    );
    await tx.query(
      `INSERT INTO cloud_runtime_bundles(runtime_id,manifest_sha256,archive_sha256,archive_bytes,expanded_bytes,object_key,source_commit,architecture,
      node_version,node_modules_abi,bootstrap_protocol_version,setup_protocol_version,engine_protocol_version,manifest_header)
      VALUES($1,$2,$3,123,456,$4,$5,'linux/amd64','22.23.1',127,1,2,20,'{"schema":"zeros.runtime-manifest/v1"}')`,
      [
        descriptor.runtimeId,
        descriptor.manifestSha256,
        descriptor.archiveSha256,
        value.objectKey,
        descriptor.sourceCommit,
      ],
    );
  });
}

export async function seedComputerTemplateRuntimeImage(pool: pg.Pool, options: {
  channel?: RuntimeImageChannel; accountScope?: string; billingOrg?: string;
} = {}) {
  const imageId = randomUUID(), channel = options.channel ?? "alpha";
  const snapshotName = `zeros-rtimg-${channel}-${templateRuntime.descriptor.runtimeId.slice(3, 15)}-${randomBytes(4).toString("hex")}`;
  await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_runtime_images
    (image_id,channel,runtime_id,base_image_id,base_compatibility_id,account_scope,billing_org,snapshot_name,state,
      builder_sandbox_id,probe_sandbox_id,snapshot_requested_at,snapshot_id,size_bytes,deadline_at,verified_at,ready_at,cleanup_confirmed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready','bx_23456789','bx_abcdefgh',now(),'fixture-runtime-snapshot',123,
      now()+interval '1 hour',now(),now(),now())`,
  [imageId, channel, templateRuntime.descriptor.runtimeId, templateRuntime.baseImageId, templateRuntime.baseCompatibilityId,
    options.accountScope ?? "fixture-account", options.billingOrg ?? "fixture-wallet", snapshotName]));
  return { imageId, snapshotName };
}
