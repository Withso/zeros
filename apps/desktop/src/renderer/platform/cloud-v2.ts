// Cloud workspace v2 API. Responses map into the existing CloudWorkspaceDocument
// so the shared workspace UI renders v2 workspaces without its own copy.
import { z } from "zod";
import { prepareCloudPromptErasure } from "./cloud-prompt-erasure";
import { cloudAccountRequest } from "./cloud-workspaces";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

const uuid = z.string().uuid();
export const CloudV2CapabilitiesSchema = z.object({
  design: z.literal(false), browser: z.literal(false), simulators: z.literal(false),
  terminal: z.boolean(), files: z.boolean(), git: z.boolean(),
  agents: z.array(z.enum(["codex", "claude", "cursor"])),
  promptOutbox: z.literal(1).optional(),
});
export type CloudV2Capabilities = z.infer<typeof CloudV2CapabilitiesSchema>;

export const CloudV2WorkspaceSchema = z.object({
  id: uuid,
  organizationId: uuid,
  creatorUserId: uuid,
  name: z.string().min(1).max(200),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  branch: z.string().min(1).max(255),
  baseBranch: z.string().min(1).max(255),
  state: z.enum(["creating", "running", "stopping", "stopped", "starting", "deleting", "deleted", "failed"]),
  errorCode: z.string().nullable(),
  /** Set while an archived workspace is stopped; starting it clears the mark. */
  archivedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.literal(2),
  capabilities: CloudV2CapabilitiesSchema,
}).passthrough();
export type CloudV2Workspace = z.infer<typeof CloudV2WorkspaceSchema>;

/** The shared UI's existing status vocabulary. */
const STATUS: Record<CloudV2Workspace["state"], string> = {
  creating: "provisioning", running: "ready", starting: "waking", stopping: "stopping",
  stopped: "stopped", deleting: "deleting", deleted: "deleted", failed: "failed",
};

const ERRORS: Record<string, string> = {
  cloud_computer_build_required: "Build this organization's Cloud Computer first.",
  cloud_computer_changed: "The Cloud Computer was just rebuilt. Create the workspace again.",
  worker_boot_timeout: "The workspace computer did not start in time. Delete it and create a new one.",
  sandbox_missing: "This workspace's computer no longer exists. Delete it and create a new one.",
  checkpoint_restore_failed: "This workspace could not be restored from its last checkpoint. Start it to try again.",
  checkpoint_download_failed: "This workspace's last checkpoint could not be downloaded. Start it to try again.",
  checkpoint_prerequisites_missing: "This workspace's last checkpoint needs commits that GitHub could not provide. Start it to try again.",
  checkpoint_repository_missing: "This workspace's repository could not be cloned for its restore. Start it to try again.",
  checkpoint_corrupt: "This workspace's last checkpoint is damaged and cannot be restored.",
};
/** A failed restore keeps its checkpoint; Start tries it again. */
const RETRYABLE = new Set(["checkpoint_restore_failed", "checkpoint_download_failed", "checkpoint_prerequisites_missing", "checkpoint_repository_missing"]);

export function cloudV2Document(workspace: CloudV2Workspace): CloudWorkspaceDocument {
  const [owner, name] = workspace.repository.split("/") as [string, string];
  const iso = (value: string) => new Date(value).toISOString();
  return {
    id: workspace.id,
    organizationId: workspace.organizationId,
    // v2 has no team scoping; the organization is its own owner here.
    teamId: workspace.organizationId,
    name: workspace.name,
    createdBy: workspace.creatorUserId,
    ownerUserId: workspace.creatorUserId,
    placement: "cloud",
    // Archiving a failed workspace marks it without a stop; both read as archived.
    status: workspace.archivedAt && (workspace.state === "stopped" || workspace.state === "failed") ? "archived" : STATUS[workspace.state],
    capabilities: {
      ...(workspace.capabilities.promptOutbox === 1 ? { promptOutbox: 1 as const } : {}),
      canWrite: true, canEdit: true, canManage: true,
      canStart: workspace.state === "stopped" || (workspace.state === "failed" && RETRYABLE.has(workspace.errorCode ?? "")),
      startUnavailableReason: workspace.state === "failed" && !RETRYABLE.has(workspace.errorCode ?? "") ? "This workspace failed. Create a new one." : null,
    },
    repository: { forge: "github.com", owner, name, revision: workspace.baseBranch },
    generation: {
      number: 1,
      architecture: "linux/amd64",
      resources: { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 32768 },
      observedState: workspace.state,
      lastObservedAt: iso(workspace.updatedAt),
    },
    // Monotonic per workspace, so a late read never replaces a newer document.
    version: Date.parse(workspace.updatedAt),
    error: workspace.errorCode ? { code: workspace.errorCode, message: ERRORS[workspace.errorCode] ?? "This cloud workspace is unavailable." } : null,
    createdAt: iso(workspace.createdAt),
    updatedAt: iso(workspace.updatedAt),
    deletedAt: workspace.state === "deleted" ? iso(workspace.updatedAt) : null,
  };
}

/** The worker's native checkout, as the control plane configures it
 * (`CLOUD_V2_HOME/<repository>`). Mirror rows carry this path. */
export function cloudV2CheckoutPath(document: Pick<CloudWorkspaceDocument, "repository">): string {
  return `/home/user/${document.repository.owner}/${document.repository.name}`;
}

const one = z.object({ workspace: CloudV2WorkspaceSchema });
const key = () => crypto.randomUUID();

export async function listCloudV2Workspaces(organizationId: string): Promise<CloudV2Workspace[]> {
  const { workspaces } = await cloudAccountRequest(`/v1/cloud-v2/workspaces?organizationId=${uuid.parse(organizationId)}`,
    z.object({ workspaces: z.array(CloudV2WorkspaceSchema).max(200) }));
  if (workspaces.some(row => row.organizationId !== organizationId)) throw new Error("Cloud catalog returned another organization");
  return workspaces;
}

export async function getCloudV2Workspace(target: CloudWorkspaceTarget): Promise<CloudV2Workspace> {
  const { workspace } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}`, one);
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud workspace response changed identity");
  return workspace;
}

/** The control plane's branch rule, minus full refs: the worker creates the
 * workspace branch from origin/<baseBranch>, so only a plain name works. */
const BASE_BRANCH = /^(?!-)(?!refs\/)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+$/;
export function isCloudV2BaseBranch(value: string): boolean {
  return value.length <= 255 && BASE_BRANCH.test(value);
}

/** Without a base branch the server uses the branch its Cloud Computer installed. */
export async function createCloudV2Workspace(input: {
  organizationId: string; repository: string; baseBranch?: string; name?: string;
}, idempotencyKey: string = key()): Promise<CloudV2Workspace> {
  if (input.baseBranch !== undefined && !isCloudV2BaseBranch(input.baseBranch))
    throw new Error("Choose a branch from GitHub for this cloud workspace.");
  const body = {
    organizationId: uuid.parse(input.organizationId), repository: input.repository,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.name ? { name: input.name } : {}),
  };
  return (await cloudAccountRequest("/v1/cloud-v2/workspaces", one, { body, idempotencyKey })).workspace;
}

export async function changeCloudV2Workspace(target: CloudWorkspaceTarget, action: "start" | "stop" | "archive" | "delete"): Promise<CloudV2Workspace> {
  const id = uuid.parse(target.workspaceId), erase = action === "delete" && prepareCloudPromptErasure(target);
  const { workspace } = action === "delete"
    ? await cloudAccountRequest(`/v1/cloud-v2/workspaces/${id}`, one, { body: {}, idempotencyKey: key(), method: "DELETE" })
    : await cloudAccountRequest(`/v1/cloud-v2/workspaces/${id}/${action}`, one, { body: {}, idempotencyKey: key() });
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud workspace response changed identity");
  if (erase) erase();
  return workspace;
}

export const CloudV2ConnectSchema = z.object({
  url: z.string().url(),
  protocols: z.tuple([z.literal("zeros.cloud.v2"), z.string().regex(/^ticket\.zw2c_[A-Za-z0-9_-]{43}$/)]),
  expiresAt: z.string(),
});
/** `wake: false` asks for a ticket that leaves a stopped VM stopped. Explicit
 * work sent over the bridge still starts it. */
export async function connectCloudV2Workspace(target: CloudWorkspaceTarget, options: { wake: boolean }) {
  return cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/connect`, CloudV2ConnectSchema,
    { body: { wake: options.wake }, idempotencyKey: key() });
}

/** Chat history from the control plane's mirror, readable while the VM sleeps. */
export async function readCloudV2History(target: CloudWorkspaceTarget, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { result } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/history`,
    z.object({ result: z.record(z.string(), z.unknown()) }), { body: { op, params }, idempotencyKey: key() });
  return result;
}

// ── Cloud Computer ──
export const CloudV2RepositorySchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ref: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  setup: z.string().max(8000).optional(),
});
/** What an admin edits: a repository, its branch or tag, and its setup. */
export const CloudV2RepositoryDraftSchema = CloudV2RepositorySchema.pick({ repository: true, ref: true, setup: true });
export type CloudV2RepositoryDraft = z.infer<typeof CloudV2RepositoryDraftSchema>;
export const CloudV2BuildSchema = z.object({
  id: uuid, organizationId: uuid, version: z.number().int().positive(),
  recipe: z.object({ repositories: z.array(CloudV2RepositorySchema), rebuiltFrom: z.number().int().optional() }),
  state: z.enum(["queued", "building", "succeeded", "failed", "cancelled"]),
  snapshotId: z.string().nullable(), errorCode: z.string().nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  /** Absent from older control planes; they only run manual builds. */
  reason: z.enum(["manual", "reactivate", "runtime", "refresh"]).optional(),
}).passthrough();
export type CloudV2Build = z.infer<typeof CloudV2BuildSchema>;
const RecipeSchema = z.object({ repositories: z.array(CloudV2RepositoryDraftSchema) });
const ComputerSchema = z.object({
  activeBuildId: uuid.nullable(), snapshotName: z.string().nullable(), builds: z.array(CloudV2BuildSchema),
  /** The configured repositories and their revision; older control planes
   * have neither, and the app then edits locally and sends the selection. */
  recipe: RecipeSchema.optional(),
  recipeRevision: z.number().int().nonnegative().optional(),
});
export type CloudV2Computer = z.infer<typeof ComputerSchema>;
const SavedRecipeSchema = z.object({ recipe: RecipeSchema, recipeRevision: z.number().int().nonnegative() });

/** A repository on the organization's live Cloud Computer. `id` is the
 * lowercase owner/name, which stays the same across builds. */
export type CloudV2InstalledRepository = { id: string; owner: string; name: string; defaultBranch: string | null };
const InstalledSchema = z.object({
  repositories: z.array(z.object({
    repository: CloudV2RepositorySchema.shape.repository.max(200),
    defaultBranch: z.string().min(1).max(255).nullable().optional(),
  }).passthrough()).max(200).nullable(),
});

/** Readable by every member; null until the organization has a live build. */
export async function getCloudV2InstalledRepositories(organizationId: string): Promise<CloudV2InstalledRepository[] | null> {
  const { repositories } = await cloudAccountRequest(
    `/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/repositories`, InstalledSchema);
  return repositories?.map(row => {
    const [owner, name] = row.repository.split("/") as [string, string];
    return { id: row.repository.toLowerCase(), owner, name, defaultBranch: row.defaultBranch ?? null };
  }) ?? null;
}

export async function getCloudV2Computer(organizationId: string) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer`, ComputerSchema);
}

/** Older control planes: build exactly these repositories. */
export async function buildCloudV2Computer(organizationId: string, repositories: z.infer<typeof CloudV2RepositorySchema>[]) {
  return (await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/builds`,
    z.object({ build: CloudV2BuildSchema }), { body: { repositories }, idempotencyKey: key() })).build;
}

/** Builds the configured repositories as the editor showed them at `revision`. */
export async function buildConfiguredCloudV2Computer(organizationId: string, revision: number) {
  return (await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/builds`,
    z.object({ build: CloudV2BuildSchema }), { body: { revision }, idempotencyKey: key() })).build;
}

/** Saves the configured repositories; a build makes them live. */
export async function saveCloudV2ComputerRecipe(organizationId: string, repositories: CloudV2RepositoryDraft[], revision: number) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/recipe`,
    SavedRecipeSchema, { body: { repositories, revision }, idempotencyKey: key(), method: "PUT" });
}

/** Discards unbuilt changes: the configured repositories return to the live build's. */
export async function discardCloudV2ComputerRecipe(organizationId: string, revision: number) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/recipe/discard`,
    SavedRecipeSchema, { body: { revision }, idempotencyKey: key() });
}

export async function activateCloudV2Build(organizationId: string, buildId: string) {
  return (await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/builds/${uuid.parse(buildId)}/activate`,
    z.object({ build: CloudV2BuildSchema }), { body: {}, idempotencyKey: key() })).build;
}
