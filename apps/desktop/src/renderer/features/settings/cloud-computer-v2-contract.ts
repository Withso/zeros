import { z } from "zod";
import { CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES, CloudComputerV2BuildErrorSchema, CloudComputerV2BuildStageSchema,
  CloudComputerV2BuildStateSchema, CloudComputerV2RepositorySchema, CloudComputerV2ActiveRepositorySchema,
  CloudComputerV2TemplateStateSchema, type CloudComputerV2BuildSummary, type CloudComputerV2State,
  type CloudComputerV2DraftResult, type CloudComputerV2BuildResult, type CloudComputerV2CancelResult,
  type CloudComputerV2ActivateResult, type CloudComputerV2BuildLogs } from "@zeros/protocol/cloud-computer-v2";

// Keep response validation identical in the desktop and Linux harness.
export const uuid = z.string().uuid();
export const revision = z.number().int().nonnegative().safe();
export const positive = z.number().int().positive().safe();
export const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const cloudComputerV2BuildSchema: z.ZodType<CloudComputerV2BuildSummary> =
  z
    .object({
      id: uuid,
      version: positive,
      configId: uuid,
      acceptedRevision: revision,
      state: CloudComputerV2BuildStateSchema,
      stage: CloudComputerV2BuildStageSchema,
      errorCode: CloudComputerV2BuildErrorSchema.nullable(),
      rebuiltFromBuildId: uuid.nullable(),
      templateState: CloudComputerV2TemplateStateSchema.nullable(),
      createdAt: z.string().datetime(),
      startedAt: z.string().datetime().nullable(),
      completedAt: z.string().datetime().nullable(),
      cancelRequestedAt: z.string().datetime().nullable(),
    })
    .strict();

// Reads have no value or binding-version field. Reject unexpected fields at the
// transport boundary, rather than letting secret material enter a shared cache.
export const cloudComputerV2StateSchema: z.ZodType<CloudComputerV2State> = z
  .object({
    state: z.enum(["not_built", "building", "active", "failed"]),
    revision,
    draft: z
      .object({
        configId: uuid.nullable(),
        repositories: z.array(CloudComputerV2RepositorySchema).max(20),
        installScript: z
          .string()
          .refine((value) => bytes(value) <= 16_384 && !value.includes("\0")),
        timeoutSeconds: z.number().int().min(1).max(900),
        environment: z
          .array(
            z
              .object({
                name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
                set: z.boolean(),
              })
              .strict(),
          )
          .max(128),
      })
      .strict(),
    active: cloudComputerV2BuildSchema.nullable(),
    activeRepositories: z.array(CloudComputerV2ActiveRepositorySchema).max(20).default([]),
    previous: cloudComputerV2BuildSchema.nullable(),
    latestBuild: cloudComputerV2BuildSchema.nullable(),
    unbuiltChanges: z.boolean(),
    history: z
      .object({
        builds: z.array(cloudComputerV2BuildSchema).max(100),
        nextCursor: z.string().min(1).max(512).nullable(),
      })
      .strict(),
    canManage: z.boolean(),
  })
  .strict();
export const draftResult: z.ZodType<CloudComputerV2DraftResult> = z
  .object({
    revision,
    configId: uuid,
    unbuiltChanges: z.boolean(),
  })
  .strict();
export const buildResult: z.ZodType<CloudComputerV2BuildResult> = z
  .object({
    revision,
    build: cloudComputerV2BuildSchema,
    replayed: z.boolean(),
  })
  .strict();
export const cancelResult: z.ZodType<CloudComputerV2CancelResult> = z
  .object({
    revision,
    build: cloudComputerV2BuildSchema,
    cancelled: z.boolean(),
    cancelRequested: z.boolean(),
    alreadyCompleted: z.boolean(),
  })
  .strict();
export const activateResult: z.ZodType<CloudComputerV2ActivateResult> = z
  .object({
    revision,
    activeBuildId: uuid,
    activated: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();
export const logSchema: z.ZodType<CloudComputerV2BuildLogs> = z
  .object({
    entries: z
      .array(
        z
          .object({
            seq: positive,
            stream: z.enum(["stdout", "stderr", "system"]),
            stage: CloudComputerV2BuildStageSchema,
            text: z
              .string()
              .refine(
                (value) => bytes(value) <= CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES,
              ),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(100),
    firstSeq: positive.nullable(),
    lastSeq: positive.nullable(),
    nextAfter: revision,
    truncated: z.boolean(),
    complete: z.boolean(),
  })
  .strict()
  .refine((value) =>
    value.entries.every(
      (entry, index) =>
        entry.seq <= value.nextAfter &&
        (index === 0 || entry.seq > value.entries[index - 1]!.seq),
    ),
  );
