import { z } from "zod";
import { CloudGithubUnavailableReasonSchema } from "@zeros/protocol/cloud-github-connection";
import { CloudV2AgentCostSchema, CloudV2SetupStatusSchema } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorkspaceSharingSchema } from "./team-sharing-schema";

// An optional field this build cannot parse drops only itself, not the workspace document.
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

// Pure response schemas shared by desktop and the Alpha Linux harness.

const GithubStateSchema = z.object({
  repositoryId: z.string().regex(/^[1-9][0-9]*$/),
  branch: z.string().nullable(), baseBranch: z.string(), headSha: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  prState: z.enum(["draft", "ready", "merged", "closed"]).nullable(),
  prUrl: z.string().url().nullable(),
});
const safeSegments = (value: string) => value.split("/").every(part => part !== "." && part !== "..");
/** A checkout, two segments under the home folder (released desktops read the first's). */
const CloudCheckoutPathSchema = z.string().regex(/^\/home\/user\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(safeSegments);
/** A project folder: one segment under the home folder. */
const CloudHomeFolderSchema = z.string().regex(/^\/home\/user\/[A-Za-z0-9_.-]+$/).refine(safeSegments);

export const CloudWorkspaceDocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  /** Permanent number within the organization (`w-<n>`). */
  number: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  /** The first title one of its chats received; null is "Untitled". */
  title: z.string().min(1).max(200).nullable().optional(),
  createdBy: z.string().uuid(),
  // A team-owned workspace can have no Creator.
  ownerUserId: z.string().uuid().nullable().optional(),
  /** A private repository's workspace: its member's alone; never shared or reassigned. */
  privateOwnerUserId: z.string().uuid().optional(),
  placement: z.literal("cloud"),
  githubUnavailableReason: CloudGithubUnavailableReasonSchema.optional(),
  status: z.string().min(1).max(64),
  capabilities: z.object({
    promptOutbox: z.literal(1).optional(),
    githubPullRequests: z.literal(1).optional(),
    /** Chat rename and archive go to the control plane route. */
    chatEdits: z.literal(1).optional(),
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
  github: GithubStateSchema.optional(),
  checkoutPath: CloudCheckoutPathSchema.optional(),
  /** The project the workspace was created from, by its current name. */
  project: lenient(z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) })),
  /** A workspace of several repositories: the project folder holding one folder per repository. */
  root: lenient(CloudHomeFolderSchema),
  /** A workspace of several repositories, the first being the workspace's own `repository`; absent with one. */
  repositories: lenient(z.array(z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    checkoutPath: CloudCheckoutPathSchema,
    branch: z.string().min(1).max(255),
    baseBranch: z.string().min(1).max(255),
    github: GithubStateSchema.optional(),
  })).min(2).max(10)),
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
  /** setup-status-v1, from the worker's report; absent when setup never ran. */
  setup: lenient(z.object(CloudV2SetupStatusSchema.shape)),
  /** Running total of mirrored turns that reported a cost; absent before any did. */
  agentCost: lenient(z.object(CloudV2AgentCostSchema.shape)),
  sharing: lenient(CloudWorkspaceSharingSchema),
  version: z.number().int().nonnegative(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type CloudWorkspaceDocument = z.infer<
  typeof CloudWorkspaceDocumentSchema
>;

