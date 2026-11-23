import { z } from "zod";
import { CloudGithubUnavailableReasonSchema } from "@zeros/protocol/cloud-github-connection";
import { CloudV2AgentCostSchema, CloudV2SetupStatusSchema } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorkspaceSharingSchema } from "./team-sharing-schema";

// An optional field this build cannot parse drops only itself, not the workspace document.
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
/** Retention S3: Keep (only on a workspace that is not archived), and while archived why and what goes when. */
export const CloudWorkspaceRetentionSchema = z.object({
  keep: z.boolean(),
  archiveReason: lenient(z.enum(["manual", "inactive", "member_left"])),
  /** When its machine is removed: `estimate` true for Boat's usual 14 days; absent once an estimate is past. */
  machineExpectedGoneAt: lenient(z.object({ at: z.string().datetime(), estimate: z.boolean() })),
  /** When its backup is deleted: only with a backup, once retention's clock has started. */
  backupRemovalAt: lenient(z.string().datetime()),
  /** While archived, what opening brings back: "all" (a backup, a clean last stop, or the machine still there), or
   * "pushed" (rebuilt from GitHub; unpushed work is gone). Absent from a server before it: say neither. */
  restores: lenient(z.enum(["all", "pushed"])),
});
export type CloudWorkspaceRetention = z.infer<typeof CloudWorkspaceRetentionSchema>;

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

/** `none`: rebuilt from GitHub; `earlier`: restored from an earlier backup. `stoppedAt`: since when work could be lost. */
export const CloudLostWorkSchema = z.object({ restored: z.enum(["none", "earlier"]), stoppedAt: z.string().datetime() });
export type CloudLostWork = z.infer<typeof CloudLostWorkSchema>;
/** Submodules a restore could not put back, kept on the machine until a later start can: each one's folder, why (a
 * closed reason such as repository_unavailable) and since when. */
export const CloudUnrestoredSubmodulesSchema = z.array(z.object({
  path: z.string().max(4096).regex(/^\/home\/user\/[^\0\n]+$/).refine(safeSegments),
  reason: z.string().regex(/^[a-z_]{1,64}$/),
  since: z.string().datetime(),
})).min(1).max(320);
export type CloudUnrestoredSubmodules = z.infer<typeof CloudUnrestoredSubmodulesSchema>;

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
    /** A later repository's environment files: seeded, refused, or not available in shared workspaces yet. */
    environment: lenient(z.object({ state: z.enum(["ready", "failed", "unavailable"]), errorCode: z.string().max(100).optional() })),
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
  /** Retention: a restore came back without some work; its own member sees it until they dismiss it. */
  lostWork: lenient(CloudLostWorkSchema),
  /** C4B: submodules a restore could not put back yet; absent when there are none, and from a server before it. */
  unrestoredSubmodules: lenient(CloudUnrestoredSubmodulesSchema),
  /** Ready copies: created while its organization's Cloud Computer was being prepared, and waiting for it. */
  preparing: lenient(z.literal("computer")),
  /** Retention (CLOUD_V2_RETENTION_ENABLED): present only from a server that runs it; absent means no Keep and no dates. */
  retention: lenient(CloudWorkspaceRetentionSchema),
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

