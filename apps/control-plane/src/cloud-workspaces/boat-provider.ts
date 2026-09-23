import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BoatApiClient, BoatCreateRejectedError, type BoatApiClientOptions, BOAT_RESOURCE_ID_PATTERN } from "./boat-client.js";
import { computeMicroUsd, type CloudProviderComputeUsage, type CloudWorkspaceComputeProvider } from "./provider-compute.js";
import type {
  CloudProviderOperationRecord,
  CloudProviderOperationStore,
} from "./provider-operation-store.js";
import {
  CloudProviderError,
  type CloudProviderCreateInput,
  type CloudProviderIdentity,
  type CloudProviderObservedState,
  type CloudProviderResource,
  type CloudProviderPreviewAccess,
  type CloudWorkspaceAccessProvider,
  type CloudWorkspaceProvider,
} from "./provider.js";

const RESOURCE_ID = BOAT_RESOURCE_ID_PATTERN;
const SandboxSchema = z.object({
  id: z.string().regex(RESOURCE_ID),
  state: z.enum([
    "init",
    "provisioning",
    "provisioned",
    "cloning",
    "ready",
    "idle",
    "running",
    "archiving",
    "archived",
    "error",
  ]),
  type: z.enum(["small", "default", "large"]).optional(),
  vcpu: z.number().int().positive().optional(),
  memoryGB: z.number().int().positive().optional(),
  snapshotAvailable: z.boolean().optional(),
  archiveAfter: z.string().datetime({ offset: true }).nullable().optional(),
  lastSnapshotStatus: z
    .enum(["queued", "in_progress", "completed", "failed", "cancelled"])
    .nullable()
    .optional(),
});
const BillingTeamSchema = z.object({ id: z.string() });
const DeletionSchema = z.object({
  id: z.string().regex(/^bdop_[a-f0-9]{32}$/),
  kind: z.literal("sandbox"),
  targetId: z.string().regex(RESOURCE_ID),
  status: z.enum(["pending", "processing", "blocked", "completed"]),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
const STATES: Record<
  z.infer<typeof SandboxSchema>["state"],
  CloudProviderObservedState
> = {
  init: "provisioning",
  provisioning: "provisioning",
  provisioned: "provisioning",
  cloning: "provisioning",
  ready: "running",
  idle: "running",
  running: "running",
  archiving: "archiving",
  archived: "archived",
  error: "failed",
};
// Provider retention is 24h. Leave a margin for request transit and provider
// clock differences; after this deadline an unknown create requires recovery.
const CREATE_RETRY_WINDOW_MS = 23 * 60 * 60_000;

const UsageSchema = z.object({
  type: z.literal("sandbox.usage"), sandboxId: z.string().regex(RESOURCE_ID),
  sandboxType: z.enum(["small", "default", "large"]), billingMultiplier: z.number(),
  since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }),
  seconds: z.number().int().nonnegative().safe(), secondsPerDollar: z.number().int().positive().safe(),
  running: z.boolean(),
});

export type BoatWorkspaceProviderOptions = BoatApiClientOptions & {
  /** Managed compute is always billed to, and verified against, this wallet. */
  billingOrg: string;
  operations: CloudProviderOperationStore;
  /** Zeros-owned access revocation is required before stopping an allocation. */
  access: CloudWorkspaceAccessProvider;
  /** Explicit on every create/resume; never inherit the provider's 1h default. */
  ttlSeconds: number | null;
  /** An immutable, clean named snapshot qualified by the Linux image suite. */
  imageRef: string;
  /** Advertised capacity of the qualified image/profile. Boat's create API
   * cannot resize disk; readiness must independently verify this capacity. */
  qualifiedStorageMiB: number;
  now?: () => number;
};

function failure(code: string, retryable = false): CloudProviderError {
  return new CloudProviderError(
    code,
    "Boat workspace operation requires reconciliation",
    retryable,
  );
}

/** Boat supplies allocation and persistence. Agent execution remains in the
 * Zeros runtime; no Boat prompt/agent APIs are used by this adapter. */
export class BoatWorkspaceProvider
  implements CloudWorkspaceProvider, CloudWorkspaceAccessProvider, CloudWorkspaceComputeProvider
{
  readonly name = "boat";
  private readonly snapshotName: string;
  private readonly client: BoatApiClient;
  private readonly now: () => number;
  constructor(private readonly options: BoatWorkspaceProviderOptions) {
    const image = /^boat:([a-z0-9][a-z0-9-]{0,62})@sha256:([a-f0-9]{64})$/.exec(
      options.imageRef,
    );
    if (
      !image ||
      [
        "latest",
        "tree",
        "pull",
        "rm",
        "save",
        "current",
        "self",
        "new",
      ].includes(image[1]!)
    )
      throw new Error("Invalid qualified Boat snapshot name");
    this.snapshotName = image[1]!;
    if (
      !Number.isSafeInteger(options.qualifiedStorageMiB) ||
      options.qualifiedStorageMiB < 1024 ||
      options.qualifiedStorageMiB > 2_147_483_647
    )
      throw new Error("Invalid qualified Boat storage capacity");
    if (
      options.ttlSeconds !== null &&
      (!Number.isSafeInteger(options.ttlSeconds) ||
        options.ttlSeconds < 1 ||
        options.ttlSeconds > 2_592_000)
    )
      throw new Error("Invalid Boat archival TTL");
    this.client = new BoatApiClient(options);
    this.now = options.now ?? Date.now;
  }

  private async owned(
    resourceId: string,
  ): Promise<CloudProviderOperationRecord> {
    if (!RESOURCE_ID.test(resourceId))
      throw failure("provider_identity_mismatch");
    const record = await this.options.operations.get(resourceId);
    if (!record || record.resourceId !== resourceId)
      throw failure("provider_identity_mismatch");
    return record;
  }

  async verifyManagedResourceOwnership(resource: CloudProviderResource): Promise<boolean> {
    const record = await this.owned(resource.resourceId);
    return record.workspaceId === resource.workspaceId && record.generation === resource.generation;
  }

  private resource(
    record: CloudProviderOperationRecord,
    value: unknown,
  ): CloudProviderResource {
    const parsed = SandboxSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== record.resourceId)
      throw failure("provider_response_invalid");
    const sandbox = parsed.data;
    const state =
      sandbox.state === "archived" &&
      (sandbox.snapshotAvailable !== true ||
        sandbox.lastSnapshotStatus !== "completed")
        ? (["queued", "in_progress"].includes(sandbox.lastSnapshotStatus ?? "") ? "archiving" : "failed")
        : STATES[sandbox.state];
    // Live compute on an unconfirmed wallet is never reported as usable, so no
    // lifecycle or metering path can admit or renew it. Stop still applies.
    const billingScope = this.billingScope(value);
    return {
      workspaceId: record.workspaceId,
      generation: record.generation,
      resourceId: sandbox.id,
      state: billingScope !== "match" && (state === "running" || state === "provisioning") ? "failed" : state,
      computeStopped: sandbox.state === "archived",
      target: null,
      metadata: {
        ...(billingScope !== "match" ? { billingScope } : {}),
        ...(sandbox.archiveAfter !== undefined ? { archiveAfter: sandbox.archiveAfter, computeLeaseExpiresAt: sandbox.archiveAfter } : {}),
        ...(sandbox.type ? { machineType: sandbox.type } : {}),
        ...(sandbox.vcpu ? { vcpu: sandbox.vcpu } : {}),
        ...(sandbox.memoryGB ? { memoryGB: sandbox.memoryGB } : {}),
        snapshotAvailable: sandbox.snapshotAvailable ?? false,
        lastSnapshotStatus: sandbox.lastSnapshotStatus ?? null,
      },
    };
  }

  async find(
    identity: CloudProviderIdentity,
  ): Promise<CloudProviderResource[]> {
    const record = await this.options.operations.find(identity);
    if (!record?.resourceId) return [];
    const resource = await this.inspect(record.resourceId);
    return resource ? [resource] : [];
  }

  async verifyAbsence(identity: CloudProviderIdentity): Promise<boolean> {
    const record = await this.options.operations.find(identity);
    if (record === null || record.deletedAt !== null || record.createClosedAt !== null) return true;
    return this.options.operations.closeUnallocatedCreate(identity);
  }

  async create(
    input: CloudProviderCreateInput,
  ): Promise<CloudProviderResource> {
    return this.createAllocation(input, this.options.ttlSeconds);
  }

  async createWithComputeLease(input: CloudProviderCreateInput, ttlSeconds: number): Promise<CloudProviderResource> {
    this.assertFiniteLease(ttlSeconds);
    return this.createAllocation(input, ttlSeconds);
  }

  computeWeight(profile: Pick<CloudProviderCreateInput,"cpuMillicores" | "memoryMiB">): { numerator: number; denominator: number } {
    if (profile.cpuMillicores === 2000 && profile.memoryMiB === 4096) return { numerator: 1, denominator: 2 };
    if (profile.cpuMillicores === 4000 && profile.memoryMiB === 8192) return { numerator: 1, denominator: 1 };
    if (profile.cpuMillicores === 8000 && profile.memoryMiB === 16384) return { numerator: 2, denominator: 1 };
    throw failure("provider_profile_unsupported");
  }

  private async createAllocation(input: CloudProviderCreateInput, ttlSeconds: number | null): Promise<CloudProviderResource> {
    const type =
      input.cpuMillicores === 2000 && input.memoryMiB === 4096
        ? "small"
        : input.cpuMillicores === 4000 && input.memoryMiB === 8192
          ? "default"
          : input.cpuMillicores === 8000 && input.memoryMiB === 16384
            ? "large"
            : null;
    if (
      !type ||
      input.architecture !== "linux/amd64" ||
      input.imageRef !== this.options.imageRef ||
      !Number.isSafeInteger(input.storageMiB) ||
      input.storageMiB !== this.options.qualifiedStorageMiB
    )
      throw failure("provider_profile_unsupported");
    const body = {
      type,
      from: this.snapshotName,
      ttlSeconds,
      noEnv: true,
      env: {},
    };
    const record = await this.options.operations.prepareCreate({
      workspaceId: input.workspaceId,
      generation: input.generation,
      idempotencyKey: input.idempotencyKey,
      requestSha256: createHash("sha256")
        .update(JSON.stringify({ imageRef: input.imageRef, body, createAttemptJournalVersion: 1 }))
        .digest("hex"),
      legacyRequestSha256: createHash("sha256")
        .update(JSON.stringify({ imageRef: input.imageRef, body }))
        .digest("hex"),
    });
    if (record.deletionRequestedAt || record.deletedAt || record.createClosedAt)
      throw failure("provider_generation_retired");
    if (record.resourceId) return this.allocatableResource(record);
    const age = this.now() - record.createdAt.getTime();
    if (!Number.isFinite(age) || age < -60_000 || age >= CREATE_RETRY_WINDOW_MS)
      throw failure("provider_create_outcome_unknown");
    // Persist every dispatch before I/O. A timeout remains unknown even when
    // another request using the same key receives a definite refusal later.
    const attemptId = randomUUID();
    const dispatch = await this.options.operations.beginCreateAttempt(input, attemptId);
    if (dispatch.resourceId) return this.allocatableResource(dispatch);
    let response: Record<string, unknown>;
    try {
      response = await this.client.request("/sandboxes", {
        method: "POST", body, idempotencyKey: record.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof BoatCreateRejectedError)
        await this.options.operations.recordCreateRejection(input, attemptId, error.createRejectionCode);
      throw error;
    }
    // Record a syntactically valid resource id even if the remaining response
    // is malformed: cleanup must retain the allocation's identity.
    const id = z
      .object({ id: z.string().regex(RESOURCE_ID) })
      .safeParse(response.sandbox);
    if (!id.success) throw failure("provider_response_invalid");
    const bound = await this.options.operations.bindResource(input, id.data.id);
    return this.allocatableResource(bound, response.sandbox);
  }

  /** Boat reports an organization-billed sandbox's wallet as `team`; null is
   * the personal wallet. An absent or malformed wallet is unconfirmed. */
  private billingScope(value: unknown): "match" | "mismatch" | "unconfirmed" {
    const team = value && typeof value === "object" ? (value as { team?: unknown }).team : undefined;
    if (team === null) return "mismatch";
    const parsed = BillingTeamSchema.safeParse(team);
    if (!parsed.success) return "unconfirmed";
    return parsed.data.id.toLowerCase() === this.options.billingOrg ? "match" : "mismatch";
  }

  /** Compute is granted only to an allocation positively billed to the
   * configured wallet: create, create retry, resume and renewal. Anything else
   * is read back once. A refusal keeps the bound cleanup identity; inspection,
   * Stop and deletion never depend on the wallet. */
  private async allocatableResource(record: CloudProviderOperationRecord, value?: unknown): Promise<CloudProviderResource> {
    let sandbox = value;
    if (sandbox === undefined || this.billingScope(sandbox) !== "match")
      sandbox = (await this.client.request(`/sandboxes/${record.resourceId}`)).sandbox;
    const scope = this.billingScope(sandbox);
    if (scope !== "match") {
      this.resource(record, sandbox);
      throw failure(`provider_billing_scope_${scope}`);
    }
    return this.resource(record, sandbox);
  }

  async inspect(resourceId: string): Promise<CloudProviderResource | null> {
    const record = await this.owned(resourceId);
    if (record.deletedAt) return null;
    if (record.deletionRequestedAt) {
      // A lost DELETE reply is retried only to recover its receipt. A 404 is
      // never converted into successful deletion.
      if (!record.deletionOperationId) await this.requestDeletion(record);
      const current = await this.owned(resourceId);
      if (!current.deletionOperationId)
        throw failure("provider_deletion_unconfirmed");
      const response = await this.client.request(
        `/deletion-operations/${current.deletionOperationId}`,
      );
      const parsed = DeletionSchema.safeParse(response.operation);
      if (
        !parsed.success ||
        parsed.data.id !== current.deletionOperationId ||
        parsed.data.targetId !== resourceId
      )
        throw failure("provider_response_invalid");
      if (parsed.data.status === "completed") {
        if (parsed.data.completedAt === null)
          throw failure("provider_response_invalid");
        await this.options.operations.completeDeletion(
          resourceId,
          current.deletionOperationId,
        );
        return null;
      }
      if (parsed.data.status === "blocked")
        throw failure("provider_deletion_blocked", true);
      return {
        workspaceId: record.workspaceId,
        generation: record.generation,
        resourceId,
        state: "deleting",
        target: null,
        metadata: { deletionStatus: parsed.data.status },
      };
    }
    const response = await this.client.request(`/sandboxes/${resourceId}`);
    return this.resource(record, response.sandbox);
  }

  async start(resourceId: string): Promise<CloudProviderResource> {
    return this.startAllocation(resourceId, this.options.ttlSeconds);
  }

  async startWithComputeLease(resourceId: string, ttlSeconds: number): Promise<CloudProviderResource> {
    this.assertFiniteLease(ttlSeconds);
    return this.startAllocation(resourceId, ttlSeconds);
  }

  private assertFiniteLease(ttlSeconds: number): void {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2_592_000)
      throw failure("provider_lease_invalid");
  }

  private async startAllocation(resourceId: string, ttlSeconds: number | null): Promise<CloudProviderResource> {
    const record = await this.owned(resourceId);
    if (record.deletionRequestedAt || record.deletedAt)
      throw failure("provider_generation_retired");
    const current = await this.allocatableResource(record);
    if (current.state === "running" || current.state === "provisioning")
      return current;
    if (current.state === "archiving")
      throw failure("provider_operation_pending", true);
    if (current.state === "failed")
      throw failure("provider_snapshot_unavailable");
    await this.client.request(`/sandboxes/${resourceId}/resume`, {
      method: "POST",
      body: { ttlSeconds },
    });
    return (
      (await this.inspect(resourceId)) ??
      (() => {
        throw failure("provider_generation_retired");
      })()
    );
  }

  async readComputeUsage(resourceId: string, window?: { since: Date; until?: Date }): Promise<CloudProviderComputeUsage> {
    const requestedSince = window?.since.getTime(), requestedUntil = window?.until?.getTime();
    if (window && (!Number.isFinite(requestedSince) || requestedSince! > this.now() ||
        (window.until !== undefined && (!Number.isFinite(requestedUntil) || requestedUntil! < requestedSince! || requestedUntil! > this.now()))))
      throw failure("provider_usage_invalid");
    const record = await this.owned(resourceId);
    if (record.deletedAt) throw failure("provider_usage_unavailable");
    const query = new URLSearchParams();
    if (window) query.set("since", window.since.toISOString());
    if (window?.until) query.set("until", window.until.toISOString());
    const response = await this.client.request(`/sandboxes/${resourceId}/usage${query.size ? `?${query}` : ""}`);
    const parsed = UsageSchema.safeParse(response);
    if (!parsed.success) throw failure("provider_usage_invalid");
    const value = parsed.data, since = Date.parse(value.since), until = Date.parse(value.until);
    const multiplier = { small: 0.5, default: 1, large: 2 }[value.sandboxType];
    if (value.sandboxId !== resourceId || until < since || until > this.now() + 5000 ||
        value.billingMultiplier !== multiplier ||
        (requestedSince !== undefined && since !== requestedSince) ||
        (requestedUntil !== undefined && until !== requestedUntil) ||
        // The response describes the current size, not the size throughout
        // this historical window. Bound by the largest supported profile;
        // otherwise a valid downsize would make previous usage unreadable.
        value.seconds > Math.ceil((until - since) * 2 / 1000))
      throw failure("provider_usage_invalid");
    let listPriceMicroUsd: number;
    try { listPriceMicroUsd = computeMicroUsd(value.seconds, value.secondsPerDollar); }
    catch { throw failure("provider_usage_invalid"); }
    return { resourceId, since: new Date(since).toISOString(), until: new Date(until).toISOString(),
      billableSeconds: value.seconds, secondsPerDollar: value.secondsPerDollar, listPriceMicroUsd, running: value.running };
  }

  async renewComputeLease(resourceId: string, ttlSeconds: number): Promise<{ expiresAt: string }> {
    this.assertFiniteLease(ttlSeconds);
    const record = await this.owned(resourceId);
    if (record.deletionRequestedAt || record.deletedAt) throw failure("provider_generation_retired");
    const response = await this.client.request(`/sandboxes/${resourceId}`, { method: "PATCH", body: { ttlSeconds } });
    // Metering renews only a sandbox inspected as running, which requires a
    // confirmed wallet; confirm it again on the renewed allocation.
    await this.allocatableResource(record, response.sandbox);
    const parsed = SandboxSchema.safeParse(response.sandbox);
    const expiresAt = parsed.success && parsed.data.archiveAfter ? Date.parse(parsed.data.archiveAfter) : NaN;
    if (!parsed.success || parsed.data.id !== resourceId || STATES[parsed.data.state] !== "running" ||
        !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + ttlSeconds * 1000 + 5000)
      throw failure("provider_lease_unconfirmed", true);
    return { expiresAt: new Date(expiresAt).toISOString() };
  }

  async stop(resourceId: string): Promise<CloudProviderResource> {
    return this.archive(resourceId);
  }

  async archive(resourceId: string): Promise<CloudProviderResource> {
    const current = await this.inspect(resourceId);
    if (!current || current.state === "deleting")
      throw failure("provider_generation_retired");
    await this.revokeSshAccess(resourceId);
    if (current.computeStopped !== true && current.state !== "archived" && current.state !== "archiving") {
      await this.client.request(`/sandboxes/${resourceId}/stop`, {
        method: "POST",
      });
    }
    return (
      (await this.inspect(resourceId)) ??
      (() => {
        throw failure("provider_generation_retired");
      })()
    );
  }

  private async requestDeletion(
    record: CloudProviderOperationRecord,
  ): Promise<void> {
    if (!record.resourceId || !record.deletionRequestedAt)
      throw failure("provider_operation_conflict");
    const response = await this.client.request(
      `/sandboxes/${record.resourceId}`,
      {
        method: "DELETE",
        confirmDelete: record.resourceId,
      },
    );
    const parsed = DeletionSchema.safeParse(response.operation);
    if (!parsed.success || parsed.data.targetId !== record.resourceId)
      throw failure("provider_response_invalid");
    await this.options.operations.bindDeletion(
      record.resourceId,
      parsed.data.id,
    );
  }

  async delete(resourceId: string): Promise<void> {
    const owned = await this.owned(resourceId);
    if (owned.deletedAt) return;
    // Record intent before sending DELETE, but only after access revocation.
    // Retrying after a lost response must not need a running VM to drain again.
    if (!owned.deletionRequestedAt) await this.revokeSshAccess(resourceId);
    const record = await this.options.operations.beginDelete(resourceId);
    if (!record.deletionOperationId) await this.requestDeletion(record);
    if (await this.inspect(resourceId))
      throw failure("provider_deletion_pending", true);
  }

  async *listManaged(): AsyncIterable<CloudProviderResource> {
    // Provider display names are mutable and are not ownership evidence.
    for await (const record of this.options.operations.list()) {
      if (!record.resourceId) continue;
      try {
        const resource = await this.inspect(record.resourceId);
        if (resource) yield resource;
      } catch (error) {
        if (!(error instanceof CloudProviderError) || error.code !== "provider_deletion_blocked" || !record.deletionRequestedAt)
          throw error;
        // The exact deletion receipt is valid but incomplete. Inventory must
        // continue so one retained allocation cannot hide all later resources.
        // Lifecycle inspect still raises the actionable blocked error.
        yield { workspaceId: record.workspaceId, generation: record.generation, resourceId: record.resourceId,
          state: "deleting", target: null, metadata: { deletionStatus: "blocked" } };
      }
    }
  }

  async createSshAccess(resourceId: string, expiresInMinutes: number) {
    const record = await this.owned(resourceId);
    if (record.deletionRequestedAt || record.deletedAt)
      throw failure("provider_generation_retired");
    return this.options.access.createSshAccess(resourceId, expiresInMinutes);
  }
  async revokeSshAccess(resourceId: string): Promise<void> {
    await this.owned(resourceId);
    await this.options.access.revokeSshAccess(resourceId);
  }
  async getPreviewEndpoint(
    resourceId: string,
    port: number,
    access?: CloudProviderPreviewAccess,
  ) {
    const record = await this.owned(resourceId);
    if (record.deletionRequestedAt || record.deletedAt)
      throw failure("provider_generation_retired");
    return this.options.access.getPreviewEndpoint(resourceId, port, access);
  }
  async getEngineEndpoint(resourceId: string, port: number) {
    const record = await this.owned(resourceId);
    if (record.deletionRequestedAt || record.deletedAt)
      throw failure("provider_generation_retired");
    if (!this.options.access.getEngineEndpoint)
      throw failure("provider_access_unavailable");
    return this.options.access.getEngineEndpoint(resourceId, port);
  }
}
