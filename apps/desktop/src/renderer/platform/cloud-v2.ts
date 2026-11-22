import { z } from "zod";
import { CloudGithubUnavailableReasonSchema } from "@zeros/protocol/cloud-github-connection";
import { CloudV2AgentCostSchema, CloudV2SetupStatusSchema, RepositorySetupPathSchema, WORKSPACE_REPOSITORIES_FEATURE } from "@zeros/protocol/cloud-v2-relay";

/** Declared on connect: the control plane refuses a workspace of several repositories to a desktop without it. */
export const WORKSPACE_REPOSITORIES_CLIENT_FEATURE = WORKSPACE_REPOSITORIES_FEATURE;
import { ownershipOf, sharingOf } from "./team-sharing-schema";
import { sharingFor } from "./team-sharing-registry";
import { isCloudWorkspacePageOwner } from "@zeros/protocol/cloud-workspace-link";
import { isWorkspaceNumber, type WorkspaceAddress } from "@zeros/protocol/local-orchestration";
import { prepareCloudPromptErasure } from "./cloud-prompt-erasure";
import { cloudAccountRequest } from "./cloud-workspaces";
import { nativeCloudChatCache } from "./cloud-chat-cache";
import { readNativeCloudHistory } from "./cloud-chat-cache-history";
import type { CloudCacheKnown } from "../../../shared/cloud-chat-cache";
import { NativeCloudCacheError } from "./cloud-chat-cache-client";
import { CloudLostWorkSchema, type CloudWorkspaceDocument } from "./cloud-workspace-contract";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

const uuid = z.string().uuid();
export const CloudV2CapabilitiesSchema = z.object({
  design: z.literal(false), browser: z.literal(false), simulators: z.literal(false),
  terminal: z.boolean(), files: z.boolean(), git: z.boolean(),
  agents: z.array(z.enum(["codex", "claude", "cursor"])),
  promptOutbox: z.literal(1).optional(),
  githubPullRequests: z.literal(1).optional(),
});
export type CloudV2Capabilities = z.infer<typeof CloudV2CapabilitiesSchema>;

export const CloudV2WorkspaceSchema = z.object({
  id: uuid,
  organizationId: uuid,
  /** Only a team-owned workspace may lack a current Creator; creator attribution still survives. */
  creatorUserId: uuid.nullable(),
  name: z.string().min(1).max(200),
  /** Permanent within the organization; older control planes omit it. */
  number: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  /** The first title one of its chats received; null is "Untitled". */
  title: z.string().min(1).max(200).nullable().optional(),
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
  githubUnavailableReason: CloudGithubUnavailableReasonSchema.optional(),
  github: z.object({ repositoryId: z.string().regex(/^[1-9][0-9]*$/), branch: z.string().nullable(), baseBranch: z.string(), headSha: z.string().nullable(),
    prNumber: z.number().int().positive().nullable(), prState: z.enum(["draft", "ready", "merged", "closed"]).nullable(), prUrl: z.string().url().nullable() }).optional(),
  checkoutPath: z.string().optional(),
  /** Keep chat-edit opt-in at the top level for older strict capability decoders. */
  chatEdits: z.literal(1).optional().catch(undefined),
  /** A private repository's workspace: its member's alone; never shared or reassigned. */
  privateOwnerUserId: uuid.optional().catch(undefined),
  /** The project it was created from, by its current name. */
  project: z.object({ id: uuid, name: z.string().min(1).max(100) }).optional().catch(undefined),
  /** A workspace of several repositories: the project folder, and each repository with its checkout and pull request. */
  root: z.string().optional().catch(undefined),
  repositories: z.array(z.object({
    repository: z.string().regex(/^[^/]+\/[^/]+$/), checkoutPath: z.string(), branch: z.string().min(1).max(255), baseBranch: z.string().min(1).max(255),
    github: z.object({ repositoryId: z.string().regex(/^[1-9][0-9]*$/), branch: z.string().nullable(), baseBranch: z.string(), headSha: z.string().nullable(),
      prNumber: z.number().int().positive().nullable(), prState: z.enum(["draft", "ready", "merged", "closed"]).nullable(), prUrl: z.string().url().nullable() }).optional(),
  })).min(2).max(10).optional().catch(undefined),
}).passthrough()
  // A missing Creator is never accepted without well-formed team ownership and a known creator of record.
  .refine(value => value.creatorUserId !== null || (!!ownershipOf(value) && typeof value.createdByUserId === "string" && uuid.safeParse(value.createdByUserId).success),
    "A workspace without a Creator needs team ownership");
export type CloudV2Workspace = z.infer<typeof CloudV2WorkspaceSchema>;

const STATUS: Record<CloudV2Workspace["state"], string> = {
  creating: "provisioning", running: "ready", starting: "waking", stopping: "stopping",
  stopped: "stopped", deleting: "deleting", deleted: "deleted", failed: "failed",
};

const ERRORS: Record<string, string> = {
  cloud_computer_build_required: "Build the Cloud Computer first.",
  cloud_computer_changed: "The Cloud Computer was just rebuilt. Create the workspace again.",
  cloud_source_access_denied: "Your GitHub connection can no longer read this repository. Check repository access in Settings → GitHub, then create a new workspace.",
  repository_branch_not_found: "The base branch no longer exists on GitHub. Choose another branch and create a new workspace.",
  repository_not_installed: "This repository was removed from the Cloud Computer. Add it again, then create a new workspace.",
  cloud_source_review_required: "This repository's identity changed on GitHub. Create a new workspace from it.",
  github_connection_required: "Connect GitHub in Settings → GitHub, then create a new workspace.",
  github_authorization_expired: "Your GitHub connection expired. Reconnect it in Settings → GitHub, then create a new workspace.",
  pro_required: "Creating a cloud workspace requires Pro.",
  cloud_source_checkout_failed: "The repository or base branch could not be checked out. Existing files were retained. Check repository access and the base branch before creating a new workspace.",
  cloud_environment_path_conflict: "An environment file conflicts with an existing file or directory. Choose a different destination in Settings → Environment, then create a new workspace.",
  cloud_environment_path_untracked_required: "Environment file destinations must be untracked. Choose an untracked path in Settings → Environment, then create a new workspace.",
  cloud_environment_path_ignored_required: "Environment file destinations must be ignored by Git. Update the repository's ignore rules or choose an ignored path, then create a new workspace.",
  cloud_environment_seed_uncertain: "The saved environment could not be prepared safely. Existing files were retained. Check your environment defaults, then create a new workspace.",
  cloud_environment_pin_changed: "This workspace's saved environment could not be verified. Check your environment defaults, then create a new workspace.",
  cloud_environment_runtime_required: "This workspace needs a newer cloud runtime to prepare its environment. Update the runtime, then create a new workspace.",
  worker_boot_timeout: "The workspace computer did not start in time. Delete it and create a new one.",
  sandbox_missing: "This workspace's computer no longer exists. Delete it and create a new one.",
  checkpoint_restore_failed: "This workspace could not be restored from its last checkpoint. Start it to try again.",
  checkpoint_download_failed: "This workspace's last checkpoint could not be downloaded. Start it to try again.",
  checkpoint_prerequisites_missing: "This workspace's last checkpoint needs commits that GitHub could not provide. Start it to try again.",
  checkpoint_repository_missing: "This workspace's repository could not be cloned for its restore. Start it to try again.",
  checkpoint_corrupt: "This workspace's last checkpoint is damaged and cannot be restored.",
  execution_first_boot_failed: "This cloud workspace couldn't start cleanly. Start it again; if it happens again, ask an organization owner.",
};
/** A failed restore keeps its checkpoint; Start tries it again. */
const RETRYABLE = new Set(["checkpoint_restore_failed", "checkpoint_download_failed", "checkpoint_prerequisites_missing", "checkpoint_repository_missing",
  "execution_first_boot_failed"]);

export function cloudV2Document(workspace: CloudV2Workspace): CloudWorkspaceDocument {
  const [owner, name] = workspace.repository.split("/") as [string, string];
  const sharing = sharingOf(workspace as Record<string, unknown>);
  const readOnly = sharing?.readOnly === true, canManage = sharing ? sharing.canManage : true;
  const iso = (value: string) => new Date(value).toISOString();
  return {
    id: workspace.id,
    organizationId: workspace.organizationId,
    // The shared document uses the organization ID in its legacy team slot.
    teamId: workspace.organizationId,
    name: workspace.name,
    // Older servers omit the number; labels then use the legacy name.
    ...(workspace.number !== undefined ? { number: workspace.number } : {}),
    ...(workspace.title !== undefined ? { title: workspace.title } : {}),
    createdBy: workspace.creatorUserId ?? String(workspace.createdByUserId),
    ownerUserId: workspace.creatorUserId,
    ...(workspace.privateOwnerUserId ? { privateOwnerUserId: workspace.privateOwnerUserId } : {}),
    placement: "cloud",
    // Archiving a failed workspace marks it without a stop; both read as archived.
    status: workspace.archivedAt && (workspace.state === "stopped" || workspace.state === "failed") ? "archived" : STATUS[workspace.state],
    capabilities: {
      ...(workspace.capabilities.promptOutbox === 1 ? { promptOutbox: 1 as const } : {}),
      ...(workspace.capabilities.githubPullRequests === 1 ? { githubPullRequests: 1 as const } : {}),
      ...(workspace.chatEdits === 1 ? { chatEdits: 1 as const } : {}),
      canWrite: !readOnly, canEdit: !readOnly || canManage, canManage,
      canStart: !readOnly && (workspace.state === "stopped" || (workspace.state === "failed" && RETRYABLE.has(workspace.errorCode ?? ""))),
      startUnavailableReason: workspace.state === "failed" && !RETRYABLE.has(workspace.errorCode ?? "") ? "This workspace failed. Create a new one." : null,
    },
    repository: { forge: "github.com", owner, name, revision: workspace.baseBranch },
    ...(workspace.github ? { github: workspace.github } : {}),
    ...(workspace.githubUnavailableReason ? { githubUnavailableReason: workspace.githubUnavailableReason } : {}),
    ...(workspace.checkoutPath ? { checkoutPath: workspace.checkoutPath } : {}),
    ...(workspace.project ? { project: workspace.project } : {}),
    ...(workspace.root && workspace.repositories ? { root: workspace.root, repositories: workspace.repositories } : {}),
    // Malformed optional setup or agent cost must not invalidate the workspace document.
    ...(sharing ? { sharing } : {}),
    ...topLevel("setup", CloudV2SetupStatusSchema, (workspace as Record<string, unknown>).setup),
    ...topLevel("agentCost", CloudV2AgentCostSchema, (workspace as Record<string, unknown>).agentCost),
    ...topLevel("lostWork", CloudLostWorkSchema, (workspace as Record<string, unknown>).lostWork),
    generation: {
      number: 1,
      architecture: "linux/amd64",
      resources: { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 32768 },
      observedState: workspace.state,
      lastObservedAt: iso(workspace.updatedAt),
    },
    // The catalog orders observations by the server's workspace update time.
    version: Date.parse(workspace.updatedAt),
    error: workspace.errorCode ? { code: workspace.errorCode, message: ERRORS[workspace.errorCode] ?? "This cloud workspace is unavailable." } : null,
    createdAt: iso(workspace.createdAt),
    updatedAt: iso(workspace.updatedAt),
    deletedAt: workspace.state === "deleted" ? iso(workspace.updatedAt) : null,
  };
}

function topLevel<K extends string, T>(key: K, schema: z.ZodType<T>, value: unknown): Partial<Record<K, T>> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { [key]: parsed.data } as Partial<Record<K, T>> : {};
}

/** Older documents omit the worker path; fall back to its default checkout layout. */
export function cloudV2CheckoutPath(document: Pick<CloudWorkspaceDocument, "repository" | "checkoutPath">): string {
  return document.checkoutPath ?? `/home/user/${document.repository.owner}/${document.repository.name}`;
}

export const CloudV2WorkspaceReplySchema = z.object({ workspace: CloudV2WorkspaceSchema });
const one = CloudV2WorkspaceReplySchema;
const key = () => crypto.randomUUID();
export const CloudV2WorkspaceListReplySchema = z.object({ workspaces: z.array(CloudV2WorkspaceSchema).max(200), teamSharing: z.unknown().optional(),
  nextCursor: z.unknown().optional() }).passthrough();

/** A pre-sharing server ignores the opt-in and returns only the Creator's workspaces. */
export async function listCloudV2Workspaces(organizationId: string): Promise<{ workspaces: CloudV2Workspace[]; teamSharing: boolean; complete: boolean }> {
  const workspaces: CloudV2Workspace[] = [];
  let cursor: string | null = null, teamSharing = false, complete = true;
  for (let page = 0; ; page++) {
    const query = `organizationId=${uuid.parse(organizationId)}&archived=include&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const reply: { workspaces: CloudV2Workspace[]; teamSharing?: unknown; nextCursor?: unknown } = await cloudAccountRequest(`/v1/cloud-v2/workspaces?${query}`,
      CloudV2WorkspaceListReplySchema, undefined, { teamSharing: true });
    if (reply.workspaces.some(row => row.organizationId.toLowerCase() !== organizationId.toLowerCase())) throw new Error("Cloud catalog returned another organization");
    workspaces.push(...reply.workspaces);
    teamSharing = reply.teamSharing === 1;
    const next = typeof reply.nextCursor === "string" && reply.nextCursor.length <= 2048 ? reply.nextCursor : null;
    // The legacy creator-only list has no continuation; a full page cannot prove omission.
    if (!teamSharing) { if (reply.workspaces.length >= 200) complete = false; break; }
    if (!next) break;
    if (page >= 49) { complete = false; break; }
    cursor = next;
  }
  return { workspaces, teamSharing, complete };
}

export async function getCloudV2Workspace(target: CloudWorkspaceTarget): Promise<CloudV2Workspace> {
  const { workspace } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}`, one, undefined, { teamSharing: true });
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud workspace response changed identity");
  return workspace;
}

export async function getCloudV2WorkspaceByNumber(address: WorkspaceAddress): Promise<CloudV2Workspace> {
  if (!isCloudWorkspacePageOwner(address.owner) || !isWorkspaceNumber(address.number))
    throw new Error("Invalid cloud workspace address");
  const { workspace } = await cloudAccountRequest(
    `/v1/cloud-v2/workspaces/by-number/${address.owner}/${address.number}`,
    one, undefined, { teamSharing: true },
  );
  if (workspace.number !== address.number) throw new Error("Cloud workspace response changed identity");
  return workspace;
}

/** The worker checks out origin/<baseBranch>; send a plain branch name, not a full ref. */
const BASE_BRANCH = /^(?!-)(?!refs\/)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+$/;
export function isCloudV2BaseBranch(value: string): boolean {
  return value.length <= 255 && BASE_BRANCH.test(value);
}

/** Without a base branch the server uses the branch its Cloud Computer installed. */
export async function createCloudV2Workspace(input: {
  organizationId: string; repository: string; baseBranch?: string; name?: string;
  /** Projects: the project to create from (`repository` is its first), and a base branch for any of its other repositories. */
  projectId?: string; repositories?: readonly { repository: string; baseBranch: string }[];
}, idempotencyKey: string = key()): Promise<CloudV2Workspace> {
  if ([input.baseBranch, ...(input.repositories ?? []).map(entry => entry.baseBranch)].some(branch => branch !== undefined && !isCloudV2BaseBranch(branch)))
    throw new Error("Choose a branch from GitHub for this cloud workspace.");
  const body = {
    organizationId: uuid.parse(input.organizationId), repository: input.repository,
    ...(input.projectId ? { projectId: uuid.parse(input.projectId) } : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.repositories?.length ? { repositories: input.repositories.map(entry => ({ repository: entry.repository, baseBranch: entry.baseBranch })) } : {}),
    ...(input.name ? { name: input.name } : {}),
  };
  return (await cloudAccountRequest("/v1/cloud-v2/workspaces", one, { body, idempotencyKey })).workspace;
}

/** Retention: the person has seen that a restore came back without some work. */
export async function dismissCloudV2LostWork(target: CloudWorkspaceTarget): Promise<CloudV2Workspace> {
  const id = uuid.parse(target.workspaceId);
  const { workspace } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${id}/lost-work/dismiss`, one, { body: {}, idempotencyKey: key() }, sharingFor(id));
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud workspace response changed identity");
  return workspace;
}

export async function changeCloudV2Workspace(target: CloudWorkspaceTarget, action: "start" | "stop" | "restart" | "archive" | "delete"): Promise<CloudV2Workspace> {
  const id = uuid.parse(target.workspaceId), erase = action === "delete" && prepareCloudPromptErasure(target);
  const { workspace } = action === "delete"
    ? await cloudAccountRequest(`/v1/cloud-v2/workspaces/${id}`, one, { body: {}, idempotencyKey: key(), method: "DELETE" }, sharingFor(id))
    : await cloudAccountRequest(`/v1/cloud-v2/workspaces/${id}/${action}`, one, { body: {}, idempotencyKey: key() }, sharingFor(id));
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud workspace response changed identity");
  if (erase) erase();
  return workspace;
}

export async function renameCloudV2Workspace(target: CloudWorkspaceTarget, name: string): Promise<CloudV2Workspace> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new Error("A workspace name is 1 to 120 characters.");
  const { workspace } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/rename`, one,
    { body: { name: trimmed }, idempotencyKey: key() }, { teamSharing: true });
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud workspace response changed identity");
  return workspace;
}

const ChatEditReplySchema = z.object({ chat: z.object({ id: z.string().min(1).max(256), title: z.string().max(200), archived: z.boolean() }) });
/** The control plane applies the edit without starting the worker. */
export async function editCloudV2Chat(target: CloudWorkspaceTarget, chatId: string, change: { title: string } | { archived: boolean }) {
  const { chat } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/chats/${encodeURIComponent(chatId)}/edit`,
    ChatEditReplySchema, { body: change, idempotencyKey: key() }, sharingFor(target.workspaceId));
  if (chat.id !== chatId) throw new Error("Chat edit response changed identity");
  return chat;
}

export const CloudV2ConnectSchema = z.object({
  url: z.string().url(),
  protocols: z.tuple([z.literal("zeros.cloud.v2"), z.string().regex(/^ticket\.zw2c_[A-Za-z0-9_-]{43}$/)]),
  expiresAt: z.string(),
  /** Older control planes omit admission features. */
  features: z.array(z.string().max(64)).max(32).optional(),
});
/** Activity extends a running lease without waking a stopped VM. */
export async function pingCloudV2WorkspaceActivity(target: CloudWorkspaceTarget): Promise<void> {
  await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/activity`, z.object({ running: z.boolean() }),
    { body: {}, idempotencyKey: crypto.randomUUID() }, sharingFor(target.workspaceId));
}

// Pass wake policy in the query to preserve older strict connect bodies.
export async function connectCloudV2Workspace(target: CloudWorkspaceTarget, options: {
  wake: boolean; signal?: AbortSignal;
  clientInstance?: string; notExpiringBefore?: number; presentedTokenExpiry?: (expiresAt: number | null) => void;
}) {
  return cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/connect?wakePolicy=explicit`, CloudV2ConnectSchema,
    { body: { wake: options.wake }, idempotencyKey: key() }, { ...sharingFor(target.workspaceId), signal: options.signal,
      // This desktop opens a workspace of several repositories at its project folder.
      clientFeatures: [WORKSPACE_REPOSITORIES_CLIENT_FEATURE],
      ...(options.clientInstance ? { clientInstance: options.clientInstance } : {}),
      ...(options.notExpiringBefore ? { notExpiringBefore: options.notExpiringBefore } : {}),
      ...(options.presentedTokenExpiry ? { presentedTokenExpiry: options.presentedTokenExpiry } : {}) });
}

/** Only use cache skip or continuation from a chats.list snapshot that proved access. */
export interface CloudHistoryReadOptions { known?: CloudCacheKnown }

/** Mirrored history stays readable while the worker is stopped. */
export async function readCloudV2History(target: CloudWorkspaceTarget, op: string, params: Record<string, unknown>,
  options?: CloudHistoryReadOptions): Promise<Record<string, unknown>> {
  const epoch = nativeCloudChatCache.epoch;
  const native = await readNativeCloudHistory(nativeCloudChatCache, target, op, params, options?.known);
  if (epoch !== nativeCloudChatCache.epoch) throw new NativeCloudCacheError("owner_changed");
  if (native) return native;
  const { result } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/history`,
    z.object({ result: z.record(z.string(), z.unknown()) }), { body: { op, params }, idempotencyKey: key() },
    // The server requires sharing opt-in for sender reads, even for the Creator.
    op === "messages.senders" ? { teamSharing: true } : sharingFor(target.workspaceId));
  return result;
}

export const CloudV2RepositorySchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ref: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  setup: z.string().max(8000).optional(),
  setupScript: RepositorySetupPathSchema.optional(),
});
export const CloudV2RepositoryDraftSchema = CloudV2RepositorySchema.pick({ repository: true, ref: true, setup: true, setupScript: true });
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
export const CloudV2ComputerReplySchema = z.object({
  activeBuildId: uuid.nullable(), snapshotName: z.string().nullable(), builds: z.array(CloudV2BuildSchema),
  /** If recipe and revision are absent, the app keeps edits locally and sends the selection at build time. */
  recipe: RecipeSchema.optional(),
  recipeRevision: z.number().int().nonnegative().optional(),
  /** Ready copies are on: builds make the base, and repositories are not listed. */
  readyCopies: z.literal(true).optional(),
  installScript: z.string().max(16_000).nullable().optional(),
  /** Ready copies: each organization project's latest failed copy, the repository and step; detail is a path at most. */
  readyCopyFailures: z.array(z.object({ projectId: uuid, project: z.string().max(100), repository: z.string().max(201).nullable(),
    step: z.string().max(32).nullable(), generation: z.number().int(), reason: z.string().max(64),
    detail: z.string().max(1100).nullable(), finishedAt: z.string(), failures: z.number().int().optional(),
    nextRetryAt: z.string().nullable().optional() }).passthrough()).max(200).optional().catch(undefined),
});
export type CloudV2Computer = z.infer<typeof CloudV2ComputerReplySchema>;
const SavedRecipeSchema = z.object({ recipe: RecipeSchema, recipeRevision: z.number().int().nonnegative() });

/** Lowercase owner/name is the repository ID across builds. */
export type CloudV2InstalledRepository = { id: string; owner: string; name: string; defaultBranch: string | null;
  /** Ready copies only: "building" while the repository's first copy is being made. */
  readyCopy?: "ready" | "building" | null;
  /** Two GitHub levels: the organization's, or only the caller's. */
  level?: "shared" | "private";
  /** Its organization connection's GitHub edge state, when not healthy. */
  connection?: "suspended" | "uninstalled" };
export const CloudV2InstalledRepositoriesReplySchema = z.object({
  repositories: z.array(z.object({
    repository: CloudV2RepositorySchema.shape.repository.max(200),
    defaultBranch: z.string().min(1).max(255).nullable().optional(),
    readyCopy: z.enum(["ready", "building"]).nullable().optional().catch(undefined),
    level: z.enum(["shared", "private"]).optional().catch(undefined),
    connection: z.enum(["suspended", "uninstalled"]).optional().catch(undefined),
  }).passthrough()).max(200).nullable(),
});

/** Null means no live build; an empty list means no accessible repositories. */
export async function getCloudV2InstalledRepositories(organizationId: string): Promise<CloudV2InstalledRepository[] | null> {
  const { repositories } = await cloudAccountRequest(
    `/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/repositories`, CloudV2InstalledRepositoriesReplySchema);
  return repositories?.map(row => {
    const [owner, name] = row.repository.split("/") as [string, string];
    return { id: row.repository.toLowerCase(), owner, name, defaultBranch: row.defaultBranch ?? null,
      ...(row.readyCopy !== undefined ? { readyCopy: row.readyCopy } : {}), ...(row.level ? { level: row.level } : {}),
      ...(row.connection ? { connection: row.connection } : {}) };
  }) ?? null;
}

const WarmedSchema = z.object({ ok: z.literal(true) });
/** Warm GitHub access on create intent; create still checks access. */
export async function warmCloudV2RepositoryAccess(organizationId: string, repository: string): Promise<void> {
  await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/repositories/warm`, WarmedSchema,
    { body: { repository }, idempotencyKey: crypto.randomUUID() });
}

export async function getCloudV2Computer(organizationId: string) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer`, CloudV2ComputerReplySchema);
}

/** Older control planes need the repository selection in the request. */
export async function buildCloudV2Computer(organizationId: string, repositories: z.infer<typeof CloudV2RepositorySchema>[]) {
  return (await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/builds`,
    z.object({ build: CloudV2BuildSchema }), { body: { repositories }, idempotencyKey: key() })).build;
}

/** The revision binds a build to the recipe shown in the editor. */
export async function buildConfiguredCloudV2Computer(organizationId: string, revision: number) {
  return (await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/builds`,
    z.object({ build: CloudV2BuildSchema }), { body: { revision }, idempotencyKey: key() })).build;
}

/** Saving the recipe does not change the live build. */
export async function saveCloudV2ComputerRecipe(organizationId: string, repositories: CloudV2RepositoryDraft[], revision: number) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/recipe`,
    SavedRecipeSchema, { body: { repositories, revision }, idempotencyKey: key(), method: "PUT" });
}

/** Restore the configured recipe to the live build without starting another build. */
export async function discardCloudV2ComputerRecipe(organizationId: string, revision: number) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/recipe/discard`,
    SavedRecipeSchema, { body: { revision }, idempotencyKey: key() });
}

const InstallScriptSchema = z.object({ installScript: z.string().max(16_000).nullable(), recipeRevision: z.number().int().nonnegative() });
/** Ready copies: every member reads the install script. */
export async function getCloudV2InstallScript(organizationId: string) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/install-script`, InstallScriptSchema);
}
/** Owners and admins; the next build runs it. */
export async function saveCloudV2InstallScript(organizationId: string, installScript: string | null, revision: number) {
  return cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/install-script`,
    InstallScriptSchema, { body: { installScript, revision }, idempotencyKey: key(), method: "PUT" });
}

export async function activateCloudV2Build(organizationId: string, buildId: string) {
  return (await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/builds/${uuid.parse(buildId)}/activate`,
    z.object({ build: CloudV2BuildSchema }), { body: {}, idempotencyKey: key() })).build;
}
