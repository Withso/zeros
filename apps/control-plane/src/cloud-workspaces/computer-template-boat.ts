import type pg from "pg";
import type { Tx } from "../db.js";
import type { BoatApiClient } from "./boat-client.js";
import { BoatCloudBuilderVms, builderVmSourceResolver } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent } from "./cloud-builder-vm-store.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { loadPinnedCloudRuntime, selectCloudRuntime } from "./runtime-selection.js";
import type { RuntimeDescriptor } from "./runtime-contract.js";

export type { BuilderVm, BuilderFixedCommand, ClosedDiagnostic, CloudBuilderVms } from "./cloud-builder-vm.js";
export type { BuilderVmOperationStore as BuilderVmOperations } from "./cloud-builder-vm-store.js";
export { COMPUTER_TEMPLATE_FIXED_COMMANDS } from "./cloud-builder-commands.js";

/** Claim preparation and every create/replay use the same immutable intent. */
export function computerTemplateBuilderIntent(input: {
  baseImageId: string; name: string; operationKey: string;
}): BuilderVmIntent {
  return { purpose: "computer-build", source: { kind: "base", baseImageId: input.baseImageId },
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
}) {
  const operations = new DatabaseBuilderVmOperationStore(input.pool, input.accountScope);
  const vms = new BoatCloudBuilderVms({ client: input.client, billingOrg: input.billingOrg, operations,
    resolveSource: builderVmSourceResolver(input.pool) });
  const runtime = {
    async select(tx: Tx): Promise<ComputerTemplateRuntime | null> {
      const selected = await selectCloudRuntime(tx, input.qualificationMode);
      return selected ? { baseImageId: selected.pin.baseImageId, baseCompatibilityId: selected.pin.baseCompatibilityId,
        descriptor: selected.descriptor, objectKey: selected.objectKey } : null;
    },
    async validate(tx: Tx, pinned: ComputerTemplateRuntime): Promise<boolean> {
      return await loadPinnedCloudRuntime(tx, {
        baseImageId: pinned.baseImageId, baseCompatibilityId: pinned.baseCompatibilityId,
        runtimeId: pinned.descriptor.runtimeId, manifestSha256: pinned.descriptor.manifestSha256,
        engineProtocolVersion: pinned.descriptor.engineProtocolVersion, profile: "zeros-cloud-worker-v4",
      }, input.qualificationMode) !== null;
    },
  };
  return { operations, vms, runtime };
}
