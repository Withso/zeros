import { z } from "zod";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { BoatApiClient, BOAT_RESOURCE_ID_PATTERN } from "./boat-client.js";
import { CloudProviderError } from "./provider.js";
import {
  configuredBoatAccountAdmission,
  type BoatAccountAdmission,
} from "./boat-account-admission.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
import type {
  ComputerRetirementDriver,
  RetiredComputerImage,
  RetiredComputerSnapshot,
} from "./computer-retirement.js";

const snapshotSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  snapshotId: z.string().min(1).max(256).nullable().optional(),
  sourceSandboxId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  status: z.string(),
});
export function createComputerRetirementDriver(
  config: CloudWorkspaceBackendConfig,
): ComputerRetirementDriver {
  if (!config.boat)
    throw new Error("Managed Boat cleanup configuration is missing");
  return new BoatComputerRetirementDriver(
    new BoatApiClient({
      apiKey: config.apiKey,
      billingOrg: config.boat.billingOrg,
      timeoutMs: 45000,
    }),
    config.boat.billingOrg,
    [
      cloudWorkspaceProvisioningProfile(config, "boat")
        .imageRef.split("@")[0]!
        .replace(/^boat:/, ""),
    ],
    configuredBoatAccountAdmission(
      config.boat.accountScope,
      config.boat.billingOrg,
    ),
  );
}
/** Only reads and receipt-verified deletion; credentials never reach a VM. */
export class BoatComputerRetirementDriver implements ComputerRetirementDriver {
  constructor(
    private readonly client: BoatApiClient,
    private readonly wallet: string,
    private readonly protectedSnapshots: readonly string[] = [],
    private readonly admission: Pick<
      BoatAccountAdmission,
      "release"
    > | null = null,
  ) {}
  async releaseAdmission(
    image: RetiredComputerImage,
    proof: { computeDeleted: boolean; snapshotDeleted: boolean },
  ) {
    if (!this.admission) {
      if (
        proof.computeDeleted &&
        proof.snapshotDeleted &&
        !image.builder_id &&
        !image.verifier_id &&
        !image.snapshot_id &&
        !image.builder_dispatched_at &&
        !image.verifier_dispatched_at &&
        !image.capture_dispatched_at
      )
        return;
      throw new Error("Historical Computer admission cleanup is pending");
    }
    await this.admission.release(image, proof);
  }
  async snapshot(
    image: RetiredComputerImage,
  ): Promise<RetiredComputerSnapshot | null> {
    if (image.snapshot_name !== `zeros-org-${image.id.replaceAll("-", "")}`)
      throw new Error("Historical snapshot identity mismatch");
    try {
      const row = snapshotSchema.parse(
        (await this.client.request(`/named-snapshots/${image.snapshot_name}`))
          .snapshot,
      );
      return {
        name: row.name,
        id: row.snapshotId ?? null,
        source: row.sourceSandboxId,
        ready: row.status === "ready",
        failed: ["failed", "cancelled"].includes(row.status),
      };
    } catch (error) {
      if (
        error instanceof CloudProviderError &&
        error.code === "provider_not_found"
      )
        return null;
      throw error;
    }
  }
  async removeSandbox(
    id: string,
    savedOperation: string | null,
    persist: (operation: string) => Promise<void>,
  ) {
    z.string().regex(BOAT_RESOURCE_ID_PATTERN).parse(id);
    let operationId = savedOperation;
    if (!operationId) {
      try {
        const current = z
          .object({
            id: z.literal(id),
            team: z.object({ id: z.literal(this.wallet) }),
          })
          .parse((await this.client.request(`/sandboxes/${id}`)).sandbox);
        if (current.id !== id)
          throw new Error("Historical allocation identity mismatch");
      } catch (error) {
        // A lost DELETE reply can leave GET absent. Replay only DELETE to recover
        // its exact receipt; absence alone never proves retirement.
        if (
          !(error instanceof CloudProviderError) ||
          error.code !== "provider_not_found"
        )
          throw error;
      }
      const result = await this.client.request(`/sandboxes/${id}`, {
        method: "DELETE",
        confirmDelete: id,
      });
      operationId = z
        .object({
          id: z.string().regex(/^bdop_[a-f0-9]{32}$/),
          targetId: z.literal(id),
        })
        .parse(result.operation).id;
      await persist(operationId);
    }
    z.string()
      .regex(/^bdop_[a-f0-9]{32}$/)
      .parse(operationId);
    const receipt = z
      .object({
        id: z.literal(operationId),
        targetId: z.literal(id),
        status: z.string(),
        completedAt: z.string().nullable(),
      })
      .parse(
        (await this.client.request(`/deletion-operations/${operationId}`))
          .operation,
      );
    return receipt.status === "completed" && receipt.completedAt !== null;
  }
  async removeSnapshot(
    image: RetiredComputerImage,
    persist: () => Promise<void>,
  ) {
    if (this.protectedSnapshots.includes(image.snapshot_name))
      throw new Error("Historical snapshot is protected");
    const current = await this.snapshot(image);
    if (!current) return image.snapshot_deletion_requested_at !== null;
    if (
      current.name !== image.snapshot_name ||
      current.source !== image.builder_id ||
      !image.snapshot_id ||
      current.id !== image.snapshot_id
    )
      throw new Error("Historical snapshot identity mismatch");
    if (!current.ready && !current.failed) return false;
    await persist();
    await this.client.request(`/named-snapshots/${image.snapshot_name}`, {
      method: "DELETE",
      confirmDelete: image.snapshot_name,
    });
    return (await this.snapshot(image)) === null;
  }
}
