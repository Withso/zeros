import type pg from "pg";
import type { Config } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import type { BoatApiClient } from "./boat-client.js";
import { boatComputerDisplayName } from "./boat-display-name.js";
import { BoatCloudBuilderVms, builderVmSourceResolver } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent } from "./cloud-builder-vm-store.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { runtimeBaseForOrganization, type CloudRuntimeBaseRollout } from "./runtime-base-rollout.js";
import { loadPinnedCloudRuntime, selectCloudRuntime } from "./runtime-selection.js";
import type { RuntimeDescriptor } from "./runtime-contract.js";
import { BoatComputerTemplateSnapshots } from "./computer-template-snapshot-boat.js";
import { ComputerTemplateSnapshots } from "./computer-template-snapshots.js";

export type { BuilderVm, BuilderFixedCommand, ClosedDiagnostic, CloudBuilderVms } from "./cloud-builder-vm.js";
export { BuilderVmError } from "./cloud-builder-vm.js";
export type { BuilderVmOperationStore as BuilderVmOperations } from "./cloud-builder-vm-store.js";
export { COMPUTER_TEMPLATE_FIXED_COMMANDS } from "./cloud-builder-commands.js";

/** Claim preparation and every create/replay use the same immutable intent. */
export function computerTemplateBuilderIntent(input: {
  baseImageId: string; imageId?: string | null; name: string; operationKey: string;
}): BuilderVmIntent {
  return { purpose: "computer-build", source: input.imageId === undefined || input.imageId === null
    ? { kind: "base", baseImageId: input.baseImageId } : { kind: "image", imageId: input.imageId },
    name: input.name, operationKey: input.operationKey, ttlSeconds: 1800 };
}
export type ComputerTemplateRuntime = {
  baseImageId: string;
  baseCompatibilityId: string;
  objectKey: string;
  descriptor: RuntimeDescriptor;
};

/** Real B7/B5b dependencies for the worker and operator runbook. Construction
 * performs no I/O and does not start a background worker. */
export function createComputerTemplateBoatAdapters(input: {
  pool: pg.Pool; client: Pick<BoatApiClient, "request">;
  accountScope: string; billingOrg: string; qualificationMode: CloudRuntimeQualificationMode;
  baseRollout?: CloudRuntimeBaseRollout;
  deploymentChannel: Config["deploymentChannel"];
}) {
  const operations = new DatabaseBuilderVmOperationStore(input.pool, input.accountScope);
  const vms = new BoatCloudBuilderVms({ client: input.client, billingOrg: input.billingOrg, operations,
    resolveSource: builderVmSourceResolver(input.pool),
    resolveDisplayName: async intent => {
      const row = await withSystemTx(input.pool, async tx => (await tx.query<{ org_id: string; org_slug: string; version: string }>(
        `SELECT template.org_id,org.slug AS org_slug,build.version
         FROM cloud_computer_templates template JOIN cloud_computer_v2_builds build ON build.id=template.build_id AND build.org_id=template.org_id
         JOIN organizations org ON org.id=template.org_id
         WHERE template.builder_operation_key=$1 AND template.account_scope=$2 AND lower(template.billing_org)=lower($3)`,
        [intent.operationKey, input.accountScope, input.billingOrg])).rows[0]);
      return row ? boatComputerDisplayName({ organizationId: row.org_id, organizationSlug: row.org_slug,
        version: row.version, channel: input.deploymentChannel }) : null;
    } });
  const runtime = {
    async select(tx: Tx, organizationId: string): Promise<ComputerTemplateRuntime | null> {
      const selected = await selectCloudRuntime(tx, input.qualificationMode,
        runtimeBaseForOrganization(input.baseRollout, organizationId));
      return selected ? { baseImageId: selected.pin.baseImageId, baseCompatibilityId: selected.pin.baseCompatibilityId,
        descriptor: selected.descriptor, objectKey: selected.objectKey } : null;
    },
    async load(tx: Tx, pin: { baseImageId: string; runtimeId: string }): Promise<ComputerTemplateRuntime | null> {
      // Registry identities are immutable. Resolve the full saved pin, then
      // apply the same revocation and qualification locks as final admission.
      const identity = (await tx.query<{ base_compatibility_id: string; manifest_sha256: string; engine_protocol_version: number }>(
        `SELECT base.base_compatibility_id,bundle.manifest_sha256,bundle.engine_protocol_version
         FROM cloud_runtime_base_images base CROSS JOIN cloud_runtime_bundles bundle
         WHERE base.base_image_id=$1 AND bundle.runtime_id=$2`, [pin.baseImageId, pin.runtimeId],
      )).rows[0];
      if (!identity) return null;
      const loaded = await loadPinnedCloudRuntime(tx, {
        ...pin, baseCompatibilityId: identity.base_compatibility_id, manifestSha256: identity.manifest_sha256,
        engineProtocolVersion: identity.engine_protocol_version, profile: "zeros-cloud-worker-v4",
      }, input.qualificationMode);
      return loaded ? { ...loaded, baseImageId: pin.baseImageId, baseCompatibilityId: identity.base_compatibility_id } : null;
    },
    async validate(tx: Tx, pinned: ComputerTemplateRuntime): Promise<boolean> {
      return await loadPinnedCloudRuntime(tx, {
        baseImageId: pinned.baseImageId, baseCompatibilityId: pinned.baseCompatibilityId,
        runtimeId: pinned.descriptor.runtimeId, manifestSha256: pinned.descriptor.manifestSha256,
        engineProtocolVersion: pinned.descriptor.engineProtocolVersion, profile: "zeros-cloud-worker-v4",
      }, input.qualificationMode) !== null;
    },
  };
  const snapshots = new ComputerTemplateSnapshots(input.pool, {
    provider: new BoatComputerTemplateSnapshots(input.client, input.billingOrg, input.deploymentChannel), channel: input.deploymentChannel,
    accountScope: input.accountScope, billingOrg: input.billingOrg, qualificationMode: input.qualificationMode,
  });
  return { operations, vms, runtime, snapshots };
}
