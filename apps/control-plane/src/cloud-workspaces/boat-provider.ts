import { createHash, randomUUID } from "node:crypto";
import { COMPUTER_NAMED_REF, isComputerTemplateSnapshotName, type ComputerSnapshotChannel } from "./computer-template-name.js";
import type { ComputerSnapshotIdentity } from "./computer-template-snapshot-boat.js";
import { assertHostedDevAdmission } from "../development-environment.js";
import { z } from "zod";
import { BoatApiClient, BoatCreateRejectedError, BoatSnapshotExpiredError, type BoatApiClientOptions, BOAT_RESOURCE_ID_PATTERN } from "./boat-client.js";
import { setBoatDisplayName, type BoatDisplayName } from "./boat-display-name.js";
import { computeMicroUsd, type CloudProviderComputeUsage, type CloudWorkspaceComputeProvider } from "./provider-compute.js";
import type {
  CloudProviderOperationRecord,
  CloudProviderOperationStore,
} from "./provider-operation-store.js";
import {
  CloudProviderError,
  type CloudProviderCreateInput,
  type CloudProviderIdentity,
  type CloudProviderInventoryItem,
  type CloudProviderObservedState,
  type CloudProviderResource,
  type CloudProviderDeletionRetirement,
  type CloudProviderPreviewAccess,
  type CloudWorkspaceAccessProvider,
  type CloudWorkspaceProvider,
} from "./provider.js";

const SandboxSchema = z.object({
  id: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
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
    "cancelled",
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
  monitoring: z.boolean().optional(),
});
/** Archived means durable only with a completed snapshot; anything else is
 * still archiving or failed. Both the inspect and the paged-inventory paths
 * must agree, or the sweep would re-inspect a matching binding forever. */
function observedState(sandbox: z.infer<typeof SandboxSchema>): CloudProviderObservedState {
  return sandbox.state === "archived" &&
      (sandbox.snapshotAvailable !== true || sandbox.lastSnapshotStatus !== "completed")
    ? (["queued", "in_progress"].includes(sandbox.lastSnapshotStatus ?? "") ? "archiving" : "failed")
    : STATES[sandbox.state];
}

const BillingTeamSchema = z.object({ id: z.string() });
const DeletionSchema = z.object({
  id: z.string().regex(/^bdop_[a-f0-9]{32}$/),
  kind: z.literal("sandbox"),
  targetId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
  status: z.enum(["pending", "processing", "blocked", "completed"]),
  // Unknown provider stages are not retained as arbitrary diagnostic strings.
  stage: z.unknown().optional(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
const StorageDeletionSchema = DeletionSchema.extend({
  status: z.literal("blocked"),
  stage: z.enum(["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"]),
  requestedAt: z.string().datetime({ offset: true }),
  expectedBy: z.string().datetime({ offset: true }).nullable().optional(),
  completedAt: z.null(),
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
  cancelled: "failed",
};
// Provider retention is 24h. Leave a margin for request transit and provider
// clock differences; after this deadline an unknown create requires recovery.
const CREATE_RETRY_WINDOW_MS = 23 * 60 * 60_000;

const UsageSchema = z.object({
  type: z.literal("sandbox.usage"), sandboxId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
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
  /** Organization snapshots must resolve through their immutable artifact and
   * saved generation before dispatch, never through today's active selection. */
  resolveSnapshot?: (input: CloudProviderCreateInput) => Promise<string>;
  /** Resolves the saved generation's C1 source pin, account and org wallet. */
  resolveTemplate?: (input: CloudProviderCreateInput) => Promise<string>;
  /** Resolves a durable Computer artifact through its exact saved generation. */
  resolveNamedTemplate?: (input: CloudProviderCreateInput) => Promise<ComputerSnapshotIdentity>;
  snapshotChannel?: ComputerSnapshotChannel;
  /** Mutable label only; resolved after a confirmed allocation, outside its journal. */
  resolveDisplayName?: (input: CloudProviderCreateInput) => BoatDisplayName;
  now?: () => number;
};

/** Pages of 200 sandboxes one sweep may follow before a provider pagination
 * bug is assumed; the sweep must never spin against Boat's rate limit. */
const MAX_INVENTORY_PAGES = 100;

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
  private readonly snapshotName: string | null;
  private readonly templateSandboxId: string | null;
  private readonly namedTemplate: boolean;
  private readonly client: BoatApiClient;
  private readonly now: () => number;
  constructor(private readonly options: BoatWorkspaceProviderOptions) {
    const image = /^boat:([a-z0-9][a-z0-9-]{0,62})@sha256:([a-f0-9]{64})$/.exec(
      options.imageRef,
    );
    const template = /^boat-template:([A-Za-z0-9_-]{1,128})$/.exec(options.imageRef);
    const computer = COMPUTER_NAMED_REF.exec(options.imageRef);
    if (
      !template && !computer && (!image ||
      [
        "latest",
        "tree",
        "pull",
        "rm",
        "save",
        "current",
        "self",
        "new",
      ].includes(image[1]!))
    )
      throw new Error("Invalid qualified Boat snapshot name");
    this.snapshotName = computer?.[1] ?? image?.[1] ?? null;
    this.namedTemplate = computer !== null;
    this.templateSandboxId = template?.[1] ?? null;
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
    if (!BOAT_RESOURCE_ID_PATTERN.test(resourceId))
      throw failure("provider_identity_mismatch");
    const record = await this.options.operations.get(resourceId);
    if (!record || record.resourceId !== resourceId)
      throw failure("provider_identity_mismatch");
    return record;
  }

  /** Compute, access and new provider work need a live allocation. An
   * attested provider loss is final; its checkpoint recovers elsewhere. */
  private usable(record: CloudProviderOperationRecord): void {
    if (record.lostAt) throw failure("provider_resource_lost");
    if (record.deletionRequestedAt || record.deletedAt)
      throw failure("provider_generation_retired");
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
    const state = observedState(sandbox);
    // Live compute on an unconfirmed wallet is never reported as usable, so no
    // lifecycle or metering path can admit or renew it. Stop still applies.
    const billingScope = this.billingScope(value);
    const sourceMismatch = !this.templateSourceMatches(value);
    return {
      workspaceId: record.workspaceId,
      generation: record.generation,
      resourceId: sandbox.id,
      state: (billingScope !== "match" || sourceMismatch) && (state === "running" || state === "provisioning") ? "failed" : state,
      computeStopped: sandbox.state === "archived" || sandbox.state === "cancelled",
      target: null,
      metadata: {
        ...(billingScope !== "match" ? { billingScope } : {}),
        ...(sourceMismatch ? { templateSource: "mismatch" } : {}),
        ...(sandbox.archiveAfter !== undefined ? { archiveAfter: sandbox.archiveAfter, computeLeaseExpiresAt: sandbox.archiveAfter } : {}),
        ...(sandbox.type ? { machineType: sandbox.type } : {}),
        ...(sandbox.vcpu ? { vcpu: sandbox.vcpu } : {}),
        ...(sandbox.memoryGB ? { memoryGB: sandbox.memoryGB } : {}),
        snapshotAvailable: sandbox.snapshotAvailable ?? false,
        lastSnapshotStatus: sandbox.lastSnapshotStatus ?? null,
        // Explicit absence on an owned, stopped sandbox is recoverable from
        // a checkpoint. Omitted fields, failed captures and pending uploads
        // do not establish loss; never infer expiry from a local age timer.
        ...(sandbox.state === "archived" && sandbox.snapshotAvailable === false &&
          (sandbox.lastSnapshotStatus === "completed" || sandbox.lastSnapshotStatus === null) &&
          billingScope === "match" && !sourceMismatch ? { snapshotMissing: true } : {}),
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
    if (record === null || record.deletedAt !== null || record.createClosedAt !== null || record.lostAt !== null) return true;
    return this.options.operations.closeUnallocatedCreate(identity);
  }

  async create(
    input: CloudProviderCreateInput,
  ): Promise<CloudProviderResource> {
    return this.namedAllocation(input, this.options.ttlSeconds);
  }

  async createWithComputeLease(input: CloudProviderCreateInput, ttlSeconds: number): Promise<CloudProviderResource> {
    this.assertFiniteLease(ttlSeconds);
    return this.namedAllocation(input, ttlSeconds);
  }

  private async namedAllocation(input: CloudProviderCreateInput, ttlSeconds: number | null): Promise<CloudProviderResource> {
    const resource = await this.createAllocation(input, ttlSeconds);
    const resolve = this.options.resolveDisplayName;
    if (resolve) void setBoatDisplayName(this.client, resource.resourceId, () => resolve(input));
    return resource;
  }

  computeWeight(profile: Pick<CloudProviderCreateInput,"cpuMillicores" | "memoryMiB">): { numerator: number; denominator: number } {
    if (profile.cpuMillicores === 2000 && profile.memoryMiB === 4096) return { numerator: 1, denominator: 2 };
    if (profile.cpuMillicores === 4000 && profile.memoryMiB === 8192) return { numerator: 1, denominator: 1 };
    if (profile.cpuMillicores === 8000 && profile.memoryMiB === 16384) return { numerator: 2, denominator: 1 };
    throw failure("provider_profile_unsupported");
  }

  private async createAllocation(input: CloudProviderCreateInput, ttlSeconds: number | null): Promise<CloudProviderResource> {
    assertHostedDevAdmission(process.env, ttlSeconds, this.now());
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
    if (this.templateSandboxId || this.namedTemplate) {
      if (ttlSeconds === null) throw failure("provider_compute_lease_invalid");
      this.assertFiniteLease(ttlSeconds);
    }
    if (this.templateSandboxId) {
      if (!this.options.resolveTemplate || await this.options.resolveTemplate(input) !== this.templateSandboxId)
        throw failure("provider_template_identity_mismatch");
    }
    if (this.namedTemplate && (!this.options.snapshotChannel ||
        !isComputerTemplateSnapshotName(this.snapshotName!, this.options.snapshotChannel)))
      throw failure("provider_template_identity_mismatch");
    // A captured allocation no longer needs its source name. Still validate
    // the exact saved create digest below before returning the owned sandbox.
    const alreadyBound = this.namedTemplate && (await this.options.operations.find(input))?.resourceId;
    const namedSource = this.namedTemplate && !alreadyBound ? await this.options.resolveNamedTemplate?.(input) : null;
    if (this.namedTemplate && !alreadyBound && (!namedSource || namedSource.name !== this.snapshotName ||
        !BOAT_RESOURCE_ID_PATTERN.test(namedSource.sourceSandboxId) || !/^[A-Za-z0-9_-]{1,160}$/.test(namedSource.snapshotId)))
      throw failure("provider_template_identity_mismatch");
    const resolvedName = this.templateSandboxId ? null : namedSource?.name ??
      (this.options.resolveSnapshot ? await this.options.resolveSnapshot(input) : this.snapshotName);
    if (resolvedName !== this.snapshotName || (this.snapshotName?.startsWith("zeros-org-") && !this.options.resolveSnapshot))
      throw failure("provider_snapshot_identity_mismatch");
    const unmonitored = {
      type,
      ...(this.templateSandboxId ? {} : { from: resolvedName }),
      ttlSeconds,
      noEnv: true,
      env: {},
    };
    // Boat's process tracer keeps what processes write to pipes, terminals and
    // sockets, which here carries prompts and admitted provider material.
    // Disable it explicitly rather than relying on the account default.
    const monitored = { ...unmonitored, monitoring: false };
    const prepare = (value: typeof unmonitored) => this.options.operations.prepareCreate({
      workspaceId: input.workspaceId,
      generation: input.generation,
      idempotencyKey: input.idempotencyKey,
      requestSha256: createHash("sha256")
        .update(JSON.stringify({ imageRef: input.imageRef, body: value, createAttemptJournalVersion: 1 }))
        .digest("hex"),
      legacyRequestSha256: createHash("sha256")
        .update(JSON.stringify({ imageRef: input.imageRef, body: value }))
        .digest("hex"),
    });
    // A create journaled before this policy replays its exact original body
    // under the same idempotency key; a different body would be a new request.
    let body: typeof unmonitored = monitored;
    const record = await prepare(monitored).catch(async (error: unknown) => {
      if (!(error instanceof CloudProviderError) || error.code !== "provider_operation_conflict") throw error;
      body = unmonitored;
      return prepare(unmonitored);
    });
    if (record.createClosedAt) throw failure("provider_generation_retired");
    this.usable(record);
    if (record.resourceId) return this.allocatableResource(record, undefined, true);
    const age = this.now() - record.createdAt.getTime();
    if (!Number.isFinite(age) || age < -60_000 || age >= CREATE_RETRY_WINDOW_MS)
      throw failure("provider_create_outcome_unknown");
    if (this.templateSandboxId) {
      const response = await this.client.request(`/sandboxes/${this.templateSandboxId}`);
      const source = SandboxSchema.safeParse(response.sandbox);
      if (!source.success || source.data.id !== this.templateSandboxId || source.data.state !== "archived" ||
        source.data.snapshotAvailable !== true || source.data.lastSnapshotStatus !== "completed")
        throw failure("provider_template_identity_mismatch");
      if (this.billingScope(response.sandbox) !== "match") throw failure("provider_billing_scope_mismatch");
    }
    if (namedSource) {
      const response = await this.client.request(`/named-snapshots/${namedSource.name}`);
      const source = z.object({ name: z.literal(namedSource.name), status: z.literal("ready"),
        snapshotId: z.literal(namedSource.snapshotId), sourceSandboxId: z.literal(namedSource.sourceSandboxId),
      }).safeParse(response.snapshot);
      if (!source.success) throw failure("provider_template_identity_mismatch");
    }
    // Persist every dispatch before I/O. A timeout remains unknown even when
    // another request using the same key receives a definite refusal later.
    const attemptId = randomUUID();
    const dispatch = await this.options.operations.beginCreateAttempt(input, attemptId);
    if (dispatch.resourceId) return this.allocatableResource(dispatch, undefined, true);
    let response: Record<string, unknown>;
    try {
      response = await this.client.request(this.templateSandboxId ? `/sandboxes/${this.templateSandboxId}/fork` : "/sandboxes", {
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
      .object({ id: z.string().regex(BOAT_RESOURCE_ID_PATTERN) })
      .safeParse(response.sandbox);
    if (this.templateSandboxId) {
      const top = response.sandboxId;
      if (top !== undefined && (typeof top !== "string" || !BOAT_RESOURCE_ID_PATTERN.test(top)))
        throw failure("provider_response_invalid");
      const childId = id.success ? id.data.id : top;
      if (typeof childId !== "string" || childId === this.templateSandboxId ||
        (id.success && top !== undefined && top !== childId)) throw failure("provider_template_identity_mismatch");
      const bound = await this.options.operations.bindResource(input, childId);
      if (!this.templateSourceMatches(response) || !this.templateSourceMatches(response.sandbox))
        throw failure("provider_template_identity_mismatch");
      // Fork is a 202 action receipt, not readiness. Read the bound child even
      // when the response includes a sandbox; lost replies replay the same
      // journal key to recover its ID and follow this identical GET path.
      return this.allocatableResource(bound, undefined, true);
    }
    if (!id.success) throw failure("provider_response_invalid");
    const bound = await this.options.operations.bindResource(input, id.data.id);
    return this.allocatableResource(bound, response.sandbox, true);
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

  private templateSourceMatches(value: unknown): boolean {
    if (!this.templateSandboxId || !value || typeof value !== "object") return true;
    // Some action/sandbox responses echo their source. The authoritative source
    // is the saved generation + journaled request path, checked before dispatch;
    // a conflicting provider echo can never authorize the allocation.
    const source = (value as { sourceSandboxId?: unknown }).sourceSandboxId;
    return source === undefined || source === this.templateSandboxId;
  }

  /** Compute is granted only to an allocation positively billed to the
   * configured wallet: create, create retry, resume and renewal. Anything else
   * is read back once. A refusal keeps the bound cleanup identity; inspection,
   * Stop and deletion never depend on the wallet. */
  /** `unmonitored` gates a new allocation, which receives setup admission
   * next: only a sandbox that reports provider process monitoring off is
   * returned. A pre-policy body replay or an omitted setting is refused while
   * the bound identity stays journaled for cleanup. Existing allocations'
   * start and renewal do not use this gate. */
  private async allocatableResource(record: CloudProviderOperationRecord, value?: unknown, unmonitored = false): Promise<CloudProviderResource> {
    let sandbox = value;
    const monitoring = () => (sandbox && typeof sandbox === "object" ? (sandbox as { monitoring?: unknown }).monitoring : undefined);
    if (sandbox === undefined || this.billingScope(sandbox) !== "match" || (unmonitored && monitoring() !== false))
      sandbox = (await this.client.request(`/sandboxes/${record.resourceId}`)).sandbox;
    const scope = this.billingScope(sandbox);
    if (scope !== "match") {
      this.resource(record, sandbox);
      throw failure(`provider_billing_scope_${scope}`);
    }
    if (!this.templateSourceMatches(sandbox)) throw failure("provider_template_identity_mismatch");
    const resource = this.resource(record, sandbox);
    if (unmonitored && monitoring() !== false) throw failure("provider_monitoring_unconfirmed");
    return resource;
  }

  async observeDeletionRetirement(
    resourceId: string, input: { signal: AbortSignal },
  ): Promise<CloudProviderDeletionRetirement> {
    const record = await this.owned(resourceId);
    if (!record.deletionRequestedAt || !record.deletionOperationId || record.deletedAt || record.lostAt)
      throw failure("provider_deletion_unconfirmed");
    input.signal.throwIfAborted();
    const response = await this.client.request(`/deletion-operations/${record.deletionOperationId}`, {
      signal: input.signal, timeoutMs: Math.min(this.options.timeoutMs, 5_000),
    });
    const parsed = StorageDeletionSchema.safeParse(response.operation);
    if (!parsed.success || parsed.data.id !== record.deletionOperationId || parsed.data.targetId !== resourceId)
      throw failure("provider_deletion_unconfirmed");
    const operation = parsed.data;
    const requested = Date.parse(operation.requestedAt);
    const expected = operation.expectedBy == null ? null : Date.parse(operation.expectedBy);
    if (requested < record.deletionRequestedAt.getTime() - 5_000 || requested > this.now() + 5_000 ||
        (operation.stage === "waiting_for_uploads" && expected === null) ||
        (expected !== null && (expected < record.createdAt.getTime() || expected > this.now() + 6 * 3600_000 + 5_000)))
      throw failure("provider_deletion_unconfirmed");
    // A 404 alone is not evidence. It qualifies only after the authenticated
    // journal-bound receipt above proves a documented storage-only stage.
    let absent = false;
    try {
      await this.client.request(`/sandboxes/${resourceId}`, {
        signal: input.signal, timeoutMs: Math.min(this.options.timeoutMs, 5_000),
      });
    } catch (error) {
      if (error instanceof CloudProviderError && error.code === "provider_not_found" && error.httpStatus === 404) absent = true;
      else throw error;
    }
    if (!absent) throw failure("provider_deletion_unconfirmed");
    const current = await this.owned(resourceId);
    if (current.workspaceId !== record.workspaceId || current.generation !== record.generation ||
        current.deletionOperationId !== record.deletionOperationId ||
        current.deletionRequestedAt?.getTime() !== record.deletionRequestedAt.getTime() || current.deletedAt || current.lostAt)
      throw failure("provider_deletion_unconfirmed");
    input.signal.throwIfAborted();
    return {
      workspaceId: record.workspaceId, generation: record.generation, resourceId,
      deletionOperationId: record.deletionOperationId, stage: operation.stage,
      requestedAt: new Date(requested).toISOString(),
      expectedBy: expected === null ? null : new Date(expected).toISOString(),
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  async inspect(resourceId: string): Promise<CloudProviderResource | null> {
    const record = await this.owned(resourceId);
    // Loss is attested only for a bound allocation Zeros never began deleting.
    if (record.deletedAt || record.lostAt) return null;
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
      if (parsed.data.status === "completed" && parsed.data.completedAt === null)
        throw failure("provider_response_invalid");
      // Boat's current `removing` stage is the stored `deleting` stage. Other
      // stages, including `retrying`, retain the coarse provider status.
      const reported = parsed.data.stage === "removing" ? "deleting" : parsed.data.stage;
      const stage = typeof reported === "string" && ["waiting_for_uploads","kept_for_newer_snapshots","waiting_for_restore","deleting"].includes(reported)
        ? reported : parsed.data.status;
      await this.options.operations.recordDeletionProgress?.(resourceId,current.deletionOperationId,stage).catch(() => undefined);
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
    assertHostedDevAdmission(process.env, ttlSeconds, this.now());
    const record = await this.owned(resourceId);
    this.usable(record);
    const current = await this.allocatableResource(record);
    if (current.state === "running" || current.state === "provisioning")
      return current;
    if (current.state === "archiving")
      throw failure("provider_operation_pending", true);
    if (current.state === "failed")
      throw failure(current.metadata.snapshotMissing === true ? "provider_snapshot_missing" : "provider_snapshot_unavailable");
    try {
      await this.client.request(`/sandboxes/${resourceId}/resume`, {
        method: "POST",
        body: { ttlSeconds },
      });
    } catch (error) {
      // The allocation was just confirmed owned, stopped and on the expected
      // wallet and template, so Boat's statement that it deleted the disk is
      // the same evidence as an inspected missing capture.
      if (error instanceof BoatSnapshotExpiredError) throw failure("provider_snapshot_missing");
      throw error;
    }
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
    if (record.lostAt) throw failure("provider_resource_lost");
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
    assertHostedDevAdmission(process.env, ttlSeconds, this.now());
    this.assertFiniteLease(ttlSeconds);
    const record = await this.owned(resourceId);
    this.usable(record);
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
    // A lost allocation has nothing left to delete; its journal is terminal.
    if (owned.deletedAt || owned.lostAt) return;
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

  /** The paged list replaces one inspect per sandbox: identity comes from
   * the local allocation journal, state from the same mapping inspect uses,
   * minus the billing/template checks that only an inspect can certify. */
  async *listInventory(): AsyncIterable<CloudProviderInventoryItem> {
    const records = new Map<string, CloudProviderOperationRecord>();
    for await (const record of this.options.operations.list())
      if (record.resourceId) records.set(record.resourceId, record);
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
      const listed = await this.client.listSandboxes({ cursor });
      for (const value of listed.sandboxes) {
        const parsed = SandboxSchema.safeParse(value);
        // One malformed record must not lose the rest of the page.
        if (!parsed.success) continue;
        const record = records.get(parsed.data.id);
        yield {
          resourceId: parsed.data.id,
          state: observedState(parsed.data),
          computeStopped: parsed.data.state === "archived" || parsed.data.state === "cancelled",
          workspaceId: record?.workspaceId ?? null,
          generation: record?.generation ?? null,
        };
      }
      cursor = listed.nextCursor;
      if (!cursor) return;
      // A provider pagination bug must not spin the sweep against the rate
      // limit: bound the pages and refuse a cursor already followed.
      if (seen.has(cursor))
        throw new CloudProviderError(
          "provider_response_invalid",
          "Boat repeated an inventory cursor",
          false,
        );
      seen.add(cursor);
    }
    throw new CloudProviderError(
      "provider_response_invalid",
      "Boat inventory exceeds the page limit",
      false,
    );
  }

  async createSshAccess(resourceId: string, expiresInMinutes: number) {
    this.usable(await this.owned(resourceId));
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
    this.usable(await this.owned(resourceId));
    return this.options.access.getPreviewEndpoint(resourceId, port, access);
  }
  async getEngineEndpoint(resourceId: string, port: number) {
    this.usable(await this.owned(resourceId));
    if (!this.options.access.getEngineEndpoint)
      throw failure("provider_access_unavailable");
    return this.options.access.getEngineEndpoint(resourceId, port);
  }
}
