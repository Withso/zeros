import { z } from "zod";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { assertHostedDevAdmission } from "../development-environment.js";
import { BoatApiClient, BOAT_RESOURCE_ID_PATTERN } from "./boat-client.js";
import { CloudProviderError } from "./provider.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
import { configuredBoatAccountAdmission, type BoatAccountAdmission } from "./boat-account-admission.js";
import {
  ComputerImageError,
  type ComputerImage,
  type ComputerImageDriver,
  type ComputerSnapshot,
} from "./computer-image.js";
import {
  computerImageCommand,
  releaseImageSanitation,
  releaseImageAttestation,
  releaseImageAttestationStatus,
} from "./computer-image-scripts.js";

// Snapshot saves and command startup waits can exceed a short read deadline.
const LONG_OPERATION_TIMEOUT_MS = 120_000;

const snapshot = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  snapshotId: z.string().min(1).max(256).nullable().optional(),
  sourceSandboxId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  status: z.string(),
});
function decode(value: unknown): ComputerSnapshot {
  const row = snapshot.parse(value);
  return {
    name: row.name,
    id: row.snapshotId ?? null,
    source: row.sourceSandboxId,
    ready: row.status === "ready",
    failed: ["failed", "cancelled"].includes(row.status),
  };
}
export function createComputerImageDriver(
  config: CloudWorkspaceBackendConfig,
): ComputerImageDriver {
  if (!config.boat) throw new ComputerImageError("image_builder_unavailable");
  return new BoatComputerImageDriver(
    new BoatApiClient({
      apiKey: config.apiKey,
      billingOrg: config.boat.billingOrg,
      timeoutMs: 45000,
    }),
    config.boat.billingOrg,
    [cloudWorkspaceProvisioningProfile(config, "boat").imageRef.split("@")[0]!.replace(/^boat:/, "")],
    configuredBoatAccountAdmission(config.boat.accountScope, config.boat.billingOrg),
  );
}
/** Separate infrastructure role. No normal workspace/setup/agent service is
 * called here; only credential-free create, bounded commands and snapshots. */
export class BoatComputerImageDriver implements ComputerImageDriver {
  constructor(
    private readonly client: BoatApiClient,
    private readonly wallet: string,
    private readonly protectedSnapshots: readonly string[] = [],
    private readonly admission: Pick<BoatAccountAdmission, "reserve" | "release" | "capacity"> | null = null,
  ) {}
  async assertCapacity(inventory: string[]) {
    if (!this.admission) throw new ComputerImageError("image_capacity_reached");
    try { await this.admission.capacity(inventory); }
    catch (error) { if (error instanceof CloudProviderError) throw error; throw new ComputerImageError("image_capacity_reached"); }
  }
  async releaseAdmission(image: ComputerImage, proof: { computeDeleted: boolean; snapshotDeleted: boolean }) {
    if (!this.admission) {
      if (proof.computeDeleted && proof.snapshotDeleted && !image.builder_id && !image.verifier_id && !image.snapshot_id &&
        !image.builder_dispatched_at && !image.verifier_dispatched_at && !image.capture_dispatched_at) return;
      throw new ComputerImageError("image_capacity_reached");
    }
    await this.admission.release(image, proof);
  }
  async inventory() {
    const rows: ComputerSnapshot[] = [], names = new Set<string>(), cursors = new Set<string>(), signal = AbortSignal.timeout(30000);
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const reply = await this.client.request(`/named-snapshots${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
      const parsed = z.object({ snapshots: z.array(snapshot), nextCursor: z.string().min(1).max(1024).nullish(), hasMore: z.boolean().optional() }).safeParse(reply);
      if (!parsed.success || parsed.data.hasMore && !parsed.data.nextCursor) throw new ComputerImageError("image_capacity_reached");
      for (const row of parsed.data.snapshots) {
        if (names.has(row.name)) throw new ComputerImageError("image_capacity_reached");
        names.add(row.name); rows.push(decode(row));
      }
      const next = parsed.data.nextCursor;
      if (!next) return rows;
      if (cursors.has(next)) throw new ComputerImageError("image_capacity_reached");
      cursors.add(next); cursor = next;
    }
    throw new ComputerImageError("image_capacity_reached");
  }
  async create(image: ComputerImage, role: "builder" | "verifier", beforeDispatch: () => Promise<void>) {
    if (!this.admission) throw new ComputerImageError("image_capacity_reached");
    const ttlSeconds = 1800;
    try {
      assertHostedDevAdmission(process.env, ttlSeconds);
    } catch {
      throw new ComputerImageError("image_build_admission_expired");
    }
    if (Date.now() - new Date(image.created_at).getTime() >= 23 * 60 * 60_000)
      throw new ComputerImageError("image_create_outcome_unknown");
    const name =
      role === "builder"
        ? /^boat:([a-z0-9-]+)@sha256:[a-f0-9]{64}$/.exec(
            image.base_image_ref,
          )?.[1]
        : image.snapshot_name;
    if (!name) throw new ComputerImageError("image_base_invalid");
    if (role === "verifier") {
      const current = await this.snapshot(image);
      if (
        !current?.ready ||
        current.id !== image.snapshot_id ||
        current.source !== image.builder_id
      )
        throw new ComputerImageError("image_snapshot_identity_mismatch");
    }
    try { await this.admission.reserve(image, (await this.inventory()).map(row => row.name)); }
    catch (error) { if (error instanceof CloudProviderError) throw error; throw new ComputerImageError("image_capacity_reached"); }
    await beforeDispatch();
    const reply = await this.client.request("/sandboxes", {
      method: "POST",
      timeoutMs: LONG_OPERATION_TIMEOUT_MS,
      idempotencyKey: `computer-image.${image.id}.${role}`,
      body: {
        from: name,
        type:
          image.profile.cpuMillicores === 2000
            ? "small"
            : image.profile.cpuMillicores === 8000
              ? "large"
              : "default",
        ttlSeconds,
        noEnv: true,
        env: {},
      },
    });
    const parsed = z
      .object({ id: z.string().regex(BOAT_RESOURCE_ID_PATTERN) })
      .parse(reply.sandbox);
    // Return identity even if wallet is wrong; ready() rejects it while keeping
    // the durable identity available for receipt-verified cleanup.
    return parsed.id;
  }
  async ready(id: string) {
    const reply = await this.client.request(`/sandboxes/${id}`);
    const row = z
      .object({
        id: z.literal(id),
        state: z.string(),
        team: z.object({ id: z.string() }),
      })
      .parse(reply.sandbox);
    if (row.team.id !== this.wallet)
      throw new ComputerImageError("image_billing_scope_mismatch");
    if (row.state === "error" || row.state === "archived" || row.state === "cancelled")
      throw new ComputerImageError("image_builder_stopped");
    return ["ready", "idle", "running"].includes(row.state);
  }
  private async command(id: string, command: string) {
    const result = await this.client.request(`/sandboxes/${id}/commands`, {
      method: "POST",
      timeoutMs: LONG_OPERATION_TIMEOUT_MS,
      body: { command, timeoutSeconds: 30 },
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      typeof result.stdout !== "string"
    )
      throw new ComputerImageError("image_command_failed");
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new ComputerImageError("image_command_failed");
    }
  }
  async install(
    image: ComputerImage,
    recipe: { installScript: string; timeoutSeconds: number },
  ) {
    const status = await this.command(
      image.builder_id!,
      computerImageCommand("status"),
    );
    if (status.complete === true) {
      if (status.code !== 0)
        throw new ComputerImageError(
          status.code === 124 ? "build_timed_out" : "image_recipe_failed",
        );
      return true;
    }
    if (!status.started)
      await this.command(
        image.builder_id!,
        computerImageCommand("start", {
          recipe: recipe.installScript,
          timeout: recipe.timeoutSeconds,
          baseImage: image.base_image_ref,
        }),
      );
    return false;
  }
  async sanitize(image: ComputerImage) {
    const result = await this.command(
      image.builder_id!,
      computerImageCommand("sanitize", {
        id: image.id,
        baseImage: image.base_image_ref,
        recipeSha256: image.recipe_sha256,
      }),
    );
    const build = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(result.buildSha256);
    const proof = await this.command(
      image.builder_id!,
      releaseImageSanitation
        .replaceAll("{{BUILD_SHA256}}", build)
        .replaceAll("{{SOURCE_COMMIT}}", image.base_source_commit),
    );
    if (
      proof.qualified !== true ||
      proof.buildSha256 !== build ||
      typeof proof.observedAt !== "string" ||
      Date.now() - Date.parse(proof.observedAt) > 60000
    )
      throw new ComputerImageError("image_sanitation_failed");
    return { buildSha256: build };
  }
  async capture(image: ComputerImage) {
    const result = await this.client.request("/named-snapshots", {
      method: "POST",
      timeoutMs: LONG_OPERATION_TIMEOUT_MS,
      body: { sandboxId: image.builder_id, name: image.snapshot_name },
    });
    const captured = decode(result.snapshot);
    if (
      captured.name !== image.snapshot_name ||
      captured.source !== image.builder_id
    )
      throw new ComputerImageError("image_snapshot_identity_mismatch");
  }
  async snapshot(image: ComputerImage) {
    try {
      return decode(
        (await this.client.request(`/named-snapshots/${image.snapshot_name}`))
          .snapshot,
      );
    } catch (error) {
      if (
        error instanceof CloudProviderError &&
        error.code === "provider_not_found"
      )
        return null;
      throw error;
    }
  }
  async attest(image: ComputerImage) {
    const output = await this.command(
      image.verifier_id!,
      computerImageCommand("verify", {
        id: image.id,
        recipeSha256: image.recipe_sha256,
      }),
    );
    if (output.verified !== true)
      throw new ComputerImageError("image_output_verification_failed");
    const fill = (value: string) =>
      value
        .replaceAll("{{ATTEMPT_HEX}}", image.id.replaceAll("-", ""))
        .replaceAll("{{SOURCE_COMMIT}}", image.base_source_commit);
    // The release kit's status primitive tolerates an absent result, but an
    // absent directory must start the owned attester once.
    const existence = await this.command(
      image.verifier_id!,
      `/usr/bin/sudo -n /usr/bin/python3 -c 'import pathlib,json;print(json.dumps({"exists":pathlib.Path("/srv/zeros-qualification/image-attestation-${image.id.replaceAll("-", "")}").exists()}))'`,
    );
    if (!existence.exists) {
      await this.command(image.verifier_id!, fill(releaseImageAttestation));
      return null;
    }
    const status = await this.command(
      image.verifier_id!,
      fill(releaseImageAttestationStatus),
    );
    if (status.exit === null) return null;
    const exit = z
      .object({
        code: z.literal(0),
        retirement: z.literal(0),
        scopePresent: z.literal(false),
      })
      .safeParse(status.exit);
    if (!exit.success || typeof status.report !== "string")
      throw new ComputerImageError("image_attestation_failed");
    return JSON.parse(status.report) as unknown;
  }
  async removeSandbox(
    id: string,
    savedOperation: string | null,
    persist: (operation: string) => Promise<void>,
  ) {
    // Boat replays DELETE to recover its operation receipt. A naked 404 never
    // proves cleanup, matching the normal workspace deletion contract.
    let operationId = savedOperation;
    if (!operationId) {
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
    const reply = await this.client.request(
      `/deletion-operations/${operationId}`,
    );
    const receipt = z
      .object({
        id: z.literal(operationId),
        targetId: z.literal(id),
        status: z.string(),
        completedAt: z.string().nullable(),
      })
      .parse(reply.operation);
    return receipt.status === "completed" && receipt.completedAt !== null;
  }
  async removeSnapshot(image: ComputerImage, persist: () => Promise<void>) {
    if (this.protectedSnapshots.includes(image.snapshot_name))
      throw new ComputerImageError("image_snapshot_protected");
    if (!/^zeros-org-[a-f0-9]{32}$/.test(image.snapshot_name))
      throw new ComputerImageError("image_snapshot_identity_mismatch");
    const current = await this.snapshot(image);
    if (!current)
      return (
        image.capture_dispatched_at === null ||
        image.snapshot_deletion_requested_at !== null
      );
    if (
      current.source !== image.builder_id ||
      (image.snapshot_id && current.id !== image.snapshot_id)
    )
      throw new ComputerImageError("image_snapshot_identity_mismatch");
    if (!current.ready && !current.failed) return false;
    await persist();
    await this.client.request(`/named-snapshots/${image.snapshot_name}`, {
      method: "DELETE",
      confirmDelete: image.snapshot_name,
    });
    return (await this.snapshot(image)) === null;
  }
}
