import { z } from "zod";
import { CloudComputerAdminWorkspaceSchema } from "@zeros/protocol/cloud-computer-v2";
import { CloudNativeCapabilitiesSchema } from "@zeros/protocol/cloud-agent-execution";
import { CloudAgentInitialAdoptionsSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudWorkspaceCheckpointRestoreSchema, CloudWorkspaceHistoryRecoverySchema } from "@zeros/protocol/cloud-runtime-lifecycle";
import { CloudAcceptedLifecycleOperationSchema } from "@zeros/protocol/cloud-final-save";

// Pure response schemas shared by desktop and the Alpha Linux harness.
export const CloudWorkspaceActorRoleSchema = z.enum(["viewer", "prompter", "developer", "manager", "owner"]);
export type CloudWorkspaceActorRole = z.infer<typeof CloudWorkspaceActorRoleSchema>;

/** Nonsecret state from an explicitly bound cloud boot. Credential refreshes
 * do not change this owner-transfer state or its immutable initial baseline. */
export const CloudWorkspaceAgentCredentialsSchema = z.object({
  mode: z.literal("boot-owner-v1"),
  fundingScope: z.literal("workspace-roles-v1"),
  bootId: z.string().uuid(),
  writerEpoch: z.string().uuid(),
  fundingOwnerUserId: z.string().uuid(),
  fundingOwnerEpoch: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  engineInstanceId: z.string().uuid(),
  status: z.enum(["current", "owner-changed"]),
  initialAdoptions: CloudAgentInitialAdoptionsSchema.optional(),
}).strict();
export type CloudWorkspaceAgentCredentials = z.infer<typeof CloudWorkspaceAgentCredentialsSchema>;

export const CloudWorkspaceDocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdBy: z.string().uuid(),
  createdByDisplayName: z.string().min(1).max(120).nullable().optional(),
  ownerUserId: z.string().uuid().optional(),
  agentCredentials: CloudWorkspaceAgentCredentialsSchema.optional(),
  historyRecovery: CloudWorkspaceHistoryRecoverySchema.optional(),
  lifecycleVersion: z.literal(1).optional(),
  acceptedOperation: CloudAcceptedLifecycleOperationSchema.optional(),
  adminWorkspace: CloudComputerAdminWorkspaceSchema.optional(),
  actorRole: CloudWorkspaceActorRoleSchema.nullable().optional(),
  sharingMode: z.enum(["private", "organization"]).optional(),
  accessRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  recovery: z.object({
    state: z.string().nullable(),
    checkpointId: z.string().uuid().nullable(),
    checkpointAt: z.string().nullable(),
    sourceGeneration: z.number().int().positive(),
    needsAcknowledgement: z.boolean(),
    restored: CloudWorkspaceCheckpointRestoreSchema.nullable().optional(),
  }).nullable().optional(),
  placement: z.literal("cloud"),
  status: z.string().min(1).max(64),
  capabilities: z.object({
    canWrite: z.boolean(),
    // Older servers do not project edit authority. Consumers must fail closed.
    canEdit: z.boolean().optional(),
    canManage: z.boolean(),
    canStart: z.boolean(),
    startUnavailableReason: z.string().nullable(),
  }),
  repository: z.object({
    forge: z.string(),
    owner: z.string(),
    name: z.string(),
    revision: z.string(),
  }),
  generation: z.object({
    number: z.number().int().positive(),
    architecture: z.string(),
    resources: z.object({
      cpuMillicores: z.number().int().positive(),
      memoryMiB: z.number().int().positive(),
      storageMiB: z.number().int().positive(),
    }),
    observedState: z.string(),
    lastObservedAt: z.string().nullable(),
  }),
  version: z.number().int().nonnegative(),
  setupFailure: z.object({ code: z.string().min(1).max(128), hasLog: z.boolean() }).nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type CloudWorkspaceDocument = z.infer<
  typeof CloudWorkspaceDocumentSchema
>;
export const OptionsSchema = z.object({
  configured: z.boolean(),
  repository: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }).optional(),
  installations: z
    .array(z.object({ id: z.string().uuid(), accountLogin: z.string() }))
    .max(100),
});
export type CloudWorkspaceCreateOptions = z.infer<typeof OptionsSchema>;

export const AgentGrantsSchema = z.object({
  delegations: z
    .array(
      z.object({
        id: z.string().uuid(),
        ownerUserId: z.string().uuid(),
        kind: z.string(),
        models: z.array(z.string()),
        allModels: z.boolean().optional(),
        expiresAt: z.string().datetime(),
        runtimeQualified: z.boolean().optional(),
        runtimeUpgradeRequired: z.boolean().optional(),
        mcpQualified: z.boolean().optional(),
        nativeCapabilities: CloudNativeCapabilitiesSchema.optional(),
      }),
    )
    .max(100),
});

// Forward compatible: an unknown status or code is simply not ready.
export const CloudAgentBootAvailabilitySchema = z.discriminatedUnion("mode", [
  z.object({ version: z.literal(1), mode: z.literal("legacy") }),
  z.object({
    version: z.literal(1),
    mode: z.literal("boot-owner-v1"),
    scope: z.object({
      generation: z.number().int().positive().safe(),
      bootId: z.string().uuid(),
      writerEpoch: z.string().uuid(),
      fundingOwnerUserId: z.string().uuid(),
      fundingOwnerEpoch: z.number().int().positive().safe(),
    }),
    status: z.string().max(64),
    providers: z.array(z.object({
      provider: z.string().max(32),
      status: z.string().max(32),
      kind: z.string().max(64).optional(),
      models: z.array(z.string().max(128)).max(64).optional(),
      code: z.string().max(128).optional(),
    })).max(8),
  }),
]);
export type CloudAgentBootAvailability = z.infer<typeof CloudAgentBootAvailabilitySchema>;
