import { z } from "zod";
import { CloudGithubUnavailableReasonSchema } from "@zeros/protocol/cloud-github-connection";

// Pure response schemas shared by desktop and the Alpha Linux harness.

export const CloudWorkspaceDocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdBy: z.string().uuid(),
  ownerUserId: z.string().uuid().optional(),
  placement: z.literal("cloud"),
  githubUnavailableReason: CloudGithubUnavailableReasonSchema.optional(),
  status: z.string().min(1).max(64),
  capabilities: z.object({
    promptOutbox: z.literal(1).optional(),
    githubPullRequests: z.literal(1).optional(),
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
  github: z.object({
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    branch: z.string().nullable(), baseBranch: z.string(), headSha: z.string().nullable(),
    prNumber: z.number().int().positive().nullable(),
    prState: z.enum(["draft", "ready", "merged", "closed"]).nullable(),
    prUrl: z.string().url().nullable(),
  }).optional(),
  checkoutPath: z.string().regex(/^\/home\/user\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => value.split("/").every(part => part !== "." && part !== "..")).optional(),
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
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type CloudWorkspaceDocument = z.infer<
  typeof CloudWorkspaceDocumentSchema
>;

