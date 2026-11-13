// Cloud workspace v2 API. Responses map into the existing CloudWorkspaceDocument
// so the shared workspace UI renders v2 workspaces without its own copy.
import { z } from "zod";
import { CloudGithubUnavailableReasonSchema } from "@zeros/protocol/cloud-github-connection";
import { CloudV2AgentCostSchema, CloudV2SetupStatusSchema, RepositorySetupPathSchema } from "@zeros/protocol/cloud-v2-relay";
import { ownershipOf, sharingOf } from "./team-sharing-schema";
import { sharingFor } from "./team-sharing-registry";
import { isCloudWorkspacePageOwner } from "@zeros/protocol/cloud-workspace-link";
import { isWorkspaceNumber, type WorkspaceAddress } from "@zeros/protocol/local-orchestration";
import { prepareCloudPromptErasure } from "./cloud-prompt-erasure";
import { cloudAccountRequest } from "./cloud-workspaces";
import { nativeCloudChatCache } from "./cloud-chat-cache";
import { readNativeCloudHistory } from "./cloud-chat-cache-history";
import { NativeCloudCacheError } from "./cloud-chat-cache-client";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";
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
  /** Null only with team ownership (3B): a workspace whose Creator left, is on Hold or lost their account. */
  creatorUserId: uuid.nullable(),
  name: z.string().min(1).max(200),
  /** Permanent number within the organization (`w-<n>`); absent from an
   * older control plane. */
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
  /** The chat edit route exists (top level only: older desktops parse
   * capabilities strictly). Any other value reads as absent. */
  chatEdits: z.literal(1).optional().catch(undefined),
}).passthrough()
  // A missing Creator is never accepted without well-formed team ownership and a known creator of record.
  .refine(value => value.creatorUserId !== null || (!!ownershipOf(value) && typeof value.createdByUserId === "string" && uuid.safeParse(value.createdByUserId).success),
    "A workspace without a Creator needs team ownership");
export type CloudV2Workspace = z.infer<typeof CloudV2WorkspaceSchema>;

/** The shared UI's existing status vocabulary. */
const STATUS: Record<CloudV2Workspace["state"], string> = {
  creating: "provisioning", running: "ready", starting: "waking", stopping: "stopping",
  stopped: "stopped", deleting: "deleting", deleted: "deleted", failed: "failed",
};

const ERRORS: Record<string, string> = {
  cloud_computer_build_required: "Build this organization's Cloud Computer first.",
  cloud_computer_changed: "The Cloud Computer was just rebuilt. Create the workspace again.",
  // A create that returned before its GitHub checks, which then refused it.
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
  // Default activation: the first boot could not prove a clean start; the next Start boots a new worker and proves it again.
  execution_first_boot_failed: "This cloud workspace couldn't start cleanly. Start it again; if it happens again, ask an organization owner.",
};
/** A failed restore keeps its checkpoint; Start tries it again. */
const RETRYABLE = new Set(["checkpoint_restore_failed", "checkpoint_download_failed", "checkpoint_prerequisites_missing", "checkpoint_repository_missing",
  "execution_first_boot_failed"]);

export function cloudV2Document(workspace: CloudV2Workspace): CloudWorkspaceDocument {
  const [owner, name] = workspace.repository.split("/") as [string, string];
  // Team sharing: a teammate's workspace is read-only for this account; only the Creator and admins manage it.
  const sharing = sharingOf(workspace as Record<string, unknown>);
  const readOnly = sharing?.readOnly === true, canManage = sharing ? sharing.canManage : true;
  const iso = (value: string) => new Date(value).toISOString();
  return {
    id: workspace.id,
    organizationId: workspace.organizationId,
    // v2 has no team scoping; the organization is its own owner here.
    teamId: workspace.organizationId,
    name: workspace.name,
    // Undefined (an older control plane) keeps the legacy name in every label.
    ...(workspace.number !== undefined ? { number: workspace.number } : {}),
    ...(workspace.title !== undefined ? { title: workspace.title } : {}),
    createdBy: workspace.creatorUserId ?? String(workspace.createdByUserId),
    ownerUserId: workspace.creatorUserId,
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
    // Top-level fields the popup reads (setup-status-v1, agent cost). The reply passes them through; the
    // document must carry them too, each dropped alone when malformed.
    ...(sharing ? { sharing } : {}),
    ...topLevel("setup", CloudV2SetupStatusSchema, (workspace as Record<string, unknown>).setup),
    ...topLevel("agentCost", CloudV2AgentCostSchema, (workspace as Record<string, unknown>).agentCost),
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

function topLevel<K extends string, T>(key: K, schema: z.ZodType<T>, value: unknown): Partial<Record<K, T>> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { [key]: parsed.data } as Partial<Record<K, T>> : {};
}

/** The worker's native checkout, as the control plane configures it
 * (`CLOUD_V2_HOME/<repository>`). Mirror rows carry this path. */
export function cloudV2CheckoutPath(document: Pick<CloudWorkspaceDocument, "repository" | "checkoutPath">): string {
  return document.checkoutPath ?? `/home/user/${document.repository.owner}/${document.repository.name}`;
}

const one = z.object({ workspace: CloudV2WorkspaceSchema });
const key = () => crypto.randomUUID();

/** Team sharing phase 1: the organization's workspaces this account may see, in keyset pages. A control plane
 * without sharing ignores the opt-in and answers its creator-only list (teamSharing false). */
export async function listCloudV2Workspaces(organizationId: string): Promise<{ workspaces: CloudV2Workspace[]; teamSharing: boolean; complete: boolean }> {
  const workspaces: CloudV2Workspace[] = [];
  let cursor: string | null = null, teamSharing = false, complete = true;
  for (let page = 0; ; page++) {
    const query = `organizationId=${uuid.parse(organizationId)}&archived=include&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const reply: { workspaces: CloudV2Workspace[]; teamSharing?: unknown; nextCursor?: unknown } = await cloudAccountRequest(`/v1/cloud-v2/workspaces?${query}`,
      z.object({ workspaces: z.array(CloudV2WorkspaceSchema).max(200), teamSharing: z.unknown().optional(), nextCursor: z.unknown().optional() }).passthrough(),
      undefined, { teamSharing: true });
    if (reply.workspaces.some(row => row.organizationId !== organizationId)) throw new Error("Cloud catalog returned another organization");
    workspaces.push(...reply.workspaces);
    teamSharing = reply.teamSharing === 1;
    const next = typeof reply.nextCursor === "string" && reply.nextCursor.length <= 2048 ? reply.nextCursor : null;
    // The creator-only endpoint caps at 200 without continuation; a capped observation proves no omission.
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

/** The workspace a numbered link names (`<organization slug>/w/<n>`), as
 * creator-only as the read by id. */
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

/** Team sharing: rename (the Creator, or an admin). The reply carries the document with its sharing fields. */
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
/** A chat's title or archive mark through the control plane, which applies it
 * at once and hands it to the worker; it never wakes the VM. */
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
  /** R1: what this admission supports (relay-presence-v1); absent from an older control plane. */
  features: z.array(z.string().max(64)).max(32).optional(),
});
/** Only an explicit open/input starts compute. The additive query keeps the
 * strict connect body readable by older control planes. */
/** A focused window keeps a running VM awake; it never wakes a stopped one. */
export async function pingCloudV2WorkspaceActivity(target: CloudWorkspaceTarget): Promise<void> {
  await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/activity`, z.object({ running: z.boolean() }),
    { body: {}, idempotencyKey: crypto.randomUUID() }, sharingFor(target.workspaceId));
}

export async function connectCloudV2Workspace(target: CloudWorkspaceTarget, options: {
  wake: boolean; signal?: AbortSignal;
  /** §14.7: the open peer's instance id, notExpiringBefore and presented-expiry report for token rollover. */
  clientInstance?: string; notExpiringBefore?: number; presentedTokenExpiry?: (expiresAt: number | null) => void;
}) {
  return cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/connect?wakePolicy=explicit`, CloudV2ConnectSchema,
    { body: { wake: options.wake }, idempotencyKey: key() }, { ...sharingFor(target.workspaceId), signal: options.signal,
      ...(options.clientInstance ? { clientInstance: options.clientInstance } : {}),
      ...(options.notExpiringBefore ? { notExpiringBefore: options.notExpiringBefore } : {}),
      ...(options.presentedTokenExpiry ? { presentedTokenExpiry: options.presentedTokenExpiry } : {}) });
}

/** Chat history from the control plane's mirror, readable while the VM sleeps. */
export async function readCloudV2History(target: CloudWorkspaceTarget, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const epoch = nativeCloudChatCache.epoch;
  const native = await readNativeCloudHistory(nativeCloudChatCache, target, op, params);
  if (epoch !== nativeCloudChatCache.epoch) throw new NativeCloudCacheError("owner_changed");
  if (native) return native;
  const { result } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/history`,
    z.object({ result: z.record(z.string(), z.unknown()) }), { body: { op, params }, idempotencyKey: key() },
    // messages.senders exists only under the sharing opt-in, for every viewer (the Creator too); every other history op follows the role rule.
    op === "messages.senders" ? { teamSharing: true } : sharingFor(target.workspaceId));
  return result;
}

// ── Cloud Computer ──
export const CloudV2RepositorySchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ref: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  setup: z.string().max(8000).optional(),
  setupScript: RepositorySetupPathSchema.optional(),
});
/** What an admin edits: a repository, its branch or tag, and its setup. */
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

const WarmedSchema = z.object({ ok: z.literal(true) });
/** Asks the control plane to check (or renew) the creator's GitHub access to
 * one Cloud Computer repository ahead of a create. The result is advisory. */
export async function warmCloudV2RepositoryAccess(organizationId: string, repository: string): Promise<void> {
  await cloudAccountRequest(`/v1/cloud-v2/organizations/${uuid.parse(organizationId)}/computer/repositories/warm`, WarmedSchema,
    { body: { repository }, idempotencyKey: crypto.randomUUID() });
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
