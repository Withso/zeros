import type { AttachmentTransferOptions } from "@zeros/protocol/attachment-policy";
import { CloudV2HistoryStateSchema, type CloudV2HistoryState } from "@zeros/protocol/cloud-v2-relay";
import type {
  ChangesHistory,
  TurnHistoryCursor,
} from "@zeros/protocol/changes-history";

import type { RuntimeClient } from "./ws-client";
import { cloudTargetForValue, cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId } from "./cloud-workspace-key";
import { DESIGN_INSTANCE_SLOT_TEXT_CAPABILITY, DESIGN_INSTANCE_SLOT_TEXT_PARAM, DESIGN_OPTIONS_SHOW_NOTHING_CAPABILITY, DESIGN_OPTIONS_SHOW_NOTHING_PARAM } from "@zeros/protocol/design-catalog";
import { CLOUD_GITHUB_PR_OPERATIONS } from "@zeros/protocol/cloud-github-pr";
import { isWorkspaceNumber } from "@zeros/protocol/local-orchestration";
import { requestCloudGithubPr, cloudGithubPrAuthority } from "../cloud-github-pr";
import { cloudRepositoryRoute } from "./cloud-repository-routing";
import { prepareCloudPromptErasure } from "../cloud-prompt-erasure";
import { WorkspaceRuntimeClient, type ChatSnapshotRefresh } from "./workspace-runtime-client";
import type {
  Workspace,
  WorkspaceRecoveryInfo,
  StatusResult,
  ChangeCounts,
  ChangeLineCounts,
  Hunk,
  DiffFileSummary,
  Commit,
  Branch,
  DiffMode,
  ShowCommitResult,
  PR,
  PrChecksResult,
  PrCommitSummary,
  PrTimelineItem,
  AuthStatusResult,
  CreatedWorkspace,
  DetectedTool,
  RepoBranchCatalog,
} from "../git";
import type { ReadFileResult, WriteFileResult } from "../files";
import type {
  ContextGraphItemWire,
  ContextGraphListWire,
} from "../context-graph";
import type {
  TurnCommitLink,
  TurnInfo,
  TurnResetResult,
  TurnUndoResult,
  TurnResetMode,
} from "../turns";
import type { Project } from "../../state/projects-store";
import type {
  ChatRowWire,
  PersistedMessageWire,
  ChatSummaryWire,
} from "../../features/agent/agent-history-client";
import { trackGitOp } from "../observability/analytics/agent-events";

interface WorkspaceResponseLike {
  type: "WORKSPACE_RESPONSE";
  op: string;
  result: unknown;
}
interface WorkspaceErrorLike {
  type: "WORKSPACE_ERROR";
  op: string;
  code: string;
  message: string;
  /** Remediation hint the engine attaches to structured GitErrors. */
  remediation?: string;
}

/** Preserve the engine's code and remediation so isGitErrorShape and humanError can surface the recovery hint. */
export class WorkspaceOpError extends Error {
  readonly code: string;
  readonly remediation?: string;
  constructor(resp: WorkspaceErrorLike) {
    super(resp.message || `workspace op '${resp.op}' failed`);
    this.name = "WorkspaceOpError";
    this.code = resp.code;
    if (resp.remediation) this.remediation = resp.remediation;
  }
}

/** PR creation is tracked by the review tab, and shell commits never cross this bridge. */
const GIT_OP_ANALYTICS: Record<
  string,
  "commit" | "push" | "pull" | "stage" | "unstage" | "discard"
> = {
  "git.commit": "commit",
  "git.push": "push",
  "git.pull": "pull",
  "git.stage": "stage",
  "git.unstage": "unstage",
  "git.discard": "discard",
};

/** Remote Git can outlive even this budget; LONG_LIFECYCLE_OPS echoes DB_CHANGED to refresh the writer. */
const NETWORK_GIT_TIMEOUT_MS = 60_000;

/** A large working tree or slow hooks can stretch local index writes beyond the default. */
const LOCAL_GIT_TIMEOUT_MS = 30_000;

/** Give slow observations time to settle so queued refreshes do not compete with Git still running in the engine. */
const GIT_READ_TIMEOUT_MS = 60_000;

/** Match create's Design-owner queue budget; a transcript read can join that queue to migrate a legacy image. */
const CONTEXT_GRAPH_QUEUE_TIMEOUT_MS = 60_000;

/** Both response and error envelopes carry requestId; classify the correlated error here. */
export async function workspaceOp(
  bridge: RuntimeClient,
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
  connectedOnly = false,
): Promise<unknown> {
  // A workspace of several repositories: name the repository a request is for.
  const original = params.workspaceId;
  const route = cloudRepositoryRoute(op, params);
  if (route.kind === "one") params = route.params;
  else if (route.kind === "each")
    return route.merge(await Promise.all(route.requests.map(request => workspaceOp(bridge, op, request.params, timeoutMs, connectedOnly))));
  if (CLOUD_GITHUB_PR_OPERATIONS.has(op)) {
    const target = cloudTargetForValue(params.workspaceId);
    if (target) {
      // Its pull request state is kept under the repository's own key.
      const repository = route.kind === "one" && typeof original === "string" && typeof params.repository === "string"
        ? { key: original, repository: params.repository } : undefined;
      const named = repository ? [repository] as const : [] as const;
      if (op === "gh.prCreate") {
        await requestCloudGithubPr(target, "gh.repoAccess", {}, ...named);
        const before = cloudGithubPrAuthority(target, ...named);
        if (!before) throw new Error("Refresh this workspace's GitHub connection before publishing.");
        await workspaceOp(bridge, "workspace.prepareGithub", { workspaceId: original, branch: before.branch, baseBranch: before.baseBranch }, 150_000);
        await requestCloudGithubPr(target, "gh.repoAccess", {}, ...named);
        const after = cloudGithubPrAuthority(target, ...named);
        if (!after || before.connectionGeneration !== after.connectionGeneration || before.repositoryId !== after.repositoryId ||
          before.repository !== after.repository || before.branch !== after.branch || before.baseBranch !== after.baseBranch)
          throw new Error("Your GitHub connection or branch changed after publishing. Refresh before creating the pull request.");
      }
      return requestCloudGithubPr(target, op, params, ...named);
    }
  }
  const tracked = GIT_OP_ANALYTICS[op];
  const request = { type: "WORKSPACE_REQUEST" as const, op, params };
  const resp = (await (connectedOnly
    ? bridge.requestConnected(request, timeoutMs)
    : bridge.request(request, timeoutMs))) as WorkspaceResponseLike | WorkspaceErrorLike;
  if (resp.type === "WORKSPACE_ERROR") {
    const err = new WorkspaceOpError(resp);
    if (tracked) trackGitOp({ op: tracked, outcome: "error", error: err });
    throw err;
  }
  if (tracked) trackGitOp({ op: tracked, outcome: "ok" });
  return resp.result;
}


export async function bridgeTurnsList(
  bridge: RuntimeClient,
  workspaceId: string,
  options?: {
    limit?: number;
    offset?: number;
    before?: number;
    after?: TurnHistoryCursor;
  },
): Promise<TurnInfo[]> {
  const r = (await workspaceOp(bridge, "turns.list", {
    workspaceId,
    ...options,
  })) as { turns?: TurnInfo[] } | undefined;
  return r?.turns ?? [];
}

/** Which of this workspace's turns made each commit (full SHAs, ≤250). */
export async function bridgeTurnsCommits(
  bridge: RuntimeClient,
  workspaceId: string,
  shas: string[],
): Promise<TurnCommitLink[]> {
  const r = (await workspaceOp(bridge, "turns.commits", { workspaceId, shas })) as
    | { commits?: TurnCommitLink[] }
    | undefined;
  return r?.commits ?? [];
}

export async function bridgeTurnsGet(
  bridge: RuntimeClient,
  chatId: string,
  turnId: string,
): Promise<TurnInfo | null> {
  const r = (await workspaceOp(bridge, "turns.get", { chatId, turnId })) as
    | { turn?: TurnInfo | null }
    | undefined;
  return r?.turn ?? null;
}

export async function bridgeTurnsDiff(
  bridge: RuntimeClient,
  args: { chatId: string; turnId: string; path?: string },
): Promise<string> {
  const r = (await workspaceOp(bridge, "turns.diff", args)) as
    | { patch?: string }
    | undefined;
  return r?.patch ?? "";
}

export async function bridgeTurnsReset(
  bridge: RuntimeClient,
  args: { chatId: string; turnId: string; mode?: TurnResetMode },
): Promise<TurnResetResult> {
  // Reset can touch many files (snapshot + per-path merge) — allow more time.
  return (await workspaceOp(
    bridge,
    "turns.reset",
    args,
    60_000,
  )) as TurnResetResult;
}

export async function bridgeTurnsUndoReset(
  bridge: RuntimeClient,
  args: { resetId: string },
): Promise<TurnUndoResult> {
  const r = (await workspaceOp(bridge, "turns.undoReset", args, 60_000)) as
    | Partial<TurnUndoResult>
    | undefined;
  return {
    restored: r?.restored ?? [],
    transcriptRestored: r?.transcriptRestored ?? false,
    messagesRestored: r?.messagesRestored ?? 0,
  };
}

/** The engine accepts team settings only from its Local client so paired devices cannot plant them. */
export async function bridgeTeamSetContext(
  bridge: RuntimeClient,
  args: {
    teamId: string | null;
    doc: Record<string, unknown> | null;
  },
): Promise<void> {
  await workspaceOp(bridge, "team.setContext", args);
}

/** List the engine's workspaces over the bridge. Returns the engine's
 * `{ workspaces }` payload, including the synthetic `local-main`
 * primary-checkout entry. */
export async function requestWorkspaceList(
  bridge: RuntimeClient,
): Promise<Workspace[]> {
  const result = (await workspaceOp(bridge, "workspace.list")) as
    | { workspaces?: Workspace[] }
    | undefined;
  // Code and Design still share the native checkout and agent cwd; keep both in host workspace lookups.
  return result?.workspaces ?? [];
}

/** The engine prepends synthetic local-main for web clients; the desktop facade strips it. */
export async function bridgeWorkspaceList(
  bridge: RuntimeClient,
  args: {
    status?: string;
    repoSlug?: string;
    archived?: boolean;
    withChanges?: boolean;
  } = {},
): Promise<Workspace[]> {
  return (await bridgeWorkspaceListSnapshot(bridge, args)).workspaces;
}

export interface WorkspaceListSnapshot {
  workspaces: Workspace[];
  confirmedLocalWorkspaces: boolean;
  confirmedCloudWorkspaces?: boolean;
}

export async function bridgeWorkspaceListSnapshot(
  bridge: RuntimeClient,
  args: Exclude<Parameters<typeof bridgeWorkspaceList>[1], undefined> = {},
): Promise<WorkspaceListSnapshot> {
  const result = (await workspaceOp(bridge, "workspace.list", { ...args })) as
    | { workspaces?: Workspace[]; confirmedLocalWorkspaces?: boolean; confirmedCloudWorkspaces?: boolean }
    | undefined;
  return {
    workspaces: result?.workspaces ?? [],
    confirmedLocalWorkspaces: result?.confirmedLocalWorkspaces !== false,
    ...(result?.confirmedCloudWorkspaces === undefined ? {} : { confirmedCloudWorkspaces: result.confirmedCloudWorkspaces }),
  };
}

/** List the engine's projects (Repository panel repos) over the bridge — the
 *  source of truth for clients without the desktop's local boot cache.
 *  The engine seeds these from its known workspaces. */
export async function requestProjectList(
  bridge: RuntimeClient,
): Promise<Project[]> {
  const result = (await workspaceOp(bridge, "project.list")) as
    | { projects?: Project[] }
    | undefined;
  return result?.projects ?? [];
}

// Desktop pushes its curated projects (keyed on repoRoot) so the engine and
// remote clients see repos without a worktree. Host-approved for remote
// clients; a local desktop client is not prompted.

interface ProjectPush {
  repoRoot: string;
  repoSlug?: string;
  name?: string;
  originUrl?: string | null;
  originRevision?: number;
}

export async function bridgeProjectUpsert(
  bridge: RuntimeClient,
  p: ProjectPush,
): Promise<Project | null> {
  const result = await workspaceOp(bridge, "project.upsert", { ...p }) as { project?: Project } | undefined;
  return result?.project ?? null;
}

/** Explicit background maintenance; ordinary PR/catalog reads never mutate Git. */
export async function bridgeReconcileGithubRemote(bridge: RuntimeClient, repoRoot: string): Promise<{ project: Project | null; changed: boolean }> {
  return await workspaceOp(bridge, "project.reconcileGithubRemote", { repoRoot }, NETWORK_GIT_TIMEOUT_MS) as { project: Project | null; changed: boolean };
}

export async function bridgeProjectRemove(
  bridge: RuntimeClient,
  repoRoot: string,
): Promise<void> {
  await workspaceOp(bridge, "project.remove", { repoRoot });
}

export async function bridgeProjectRename(
  bridge: RuntimeClient,
  repoRoot: string,
  name: string,
): Promise<void> {
  await workspaceOp(bridge, "project.rename", { repoRoot, name });
}

export async function bridgeProjectBulkUpsert(
  bridge: RuntimeClient,
  projects: ProjectPush[],
): Promise<void> {
  await workspaceOp(bridge, "project.bulkUpsert", { projects });
}

// Only the Local owner can change relay visibility; a restricted workspace hides its chats as well.

export async function bridgeListRemoteRestricted(
  bridge: RuntimeClient,
): Promise<string[]> {
  const r = (await workspaceOp(
    bridge,
    "workspace.listRemoteRestricted",
    {},
  )) as {
    ids?: string[];
  };
  return Array.isArray(r?.ids) ? r.ids : [];
}

export async function bridgeSetRemoteRestricted(
  bridge: RuntimeClient,
  workspaceId: string,
  restricted: boolean,
): Promise<void> {
  await workspaceOp(bridge, "workspace.setRemoteRestricted", {
    workspaceId,
    restricted,
  });
}

// Per-worktree sparse checkout, LOCAL-ONLY like the restriction list.
// Deselecting a folder removes it for the agent, terminal and Files tab at once;
// reselecting restores it from the object store.

/** Mirror the engine union without importing engine code into the renderer bundle. */
export type WorkingDirectoriesUnsupportedReason =
  | "no-commits"
  | "non-cone"
  | "unrepresentable-name";

const UNSUPPORTED_REASONS = new Set<string>([
  "no-commits",
  "non-cone",
  "unrepresentable-name",
]);

export const WORKING_DIRECTORIES_UNSUPPORTED_COPY: Record<
  WorkingDirectoriesUnsupportedReason,
  string
> = {
  "no-commits": "Needs a git repository with at least one commit.",
  "non-cone":
    "This worktree uses hand-written sparse-checkout patterns. Zeros won't overwrite them.",
  "unrepresentable-name":
    "A tracked folder has a name git can't express as a sparse pattern, so hiding folders here isn't safe.",
};

export interface WorkingDirectoriesWire {
  /** Every top-level tracked directory — the full candidate set. */
  all: string[];
  /** Design folders stay materialized: the engine force-includes them even for legacy pickers. */
  locked: string[];
  /** The subset currently materialized on disk. */
  included: string[];
  sparse: boolean;
  /** False when the checkout can't support this (no commits / not a repo). */
  supported: boolean;
  /** Present exactly when `supported` is false — which of the three obstacles
   *  it is, so the empty state can name the real one. */
  unsupportedReason?: WorkingDirectoriesUnsupportedReason;
  /** Only set reports locally edited paths Git could not remove; the resulting checkout may differ from the selection. */
  leftBehind?: string[];
}

const EMPTY_WORKING_DIRS: WorkingDirectoriesWire = {
  all: [],
  locked: [],
  included: [],
  sparse: false,
  supported: false,
  unsupportedReason: "no-commits",
};

function toWorkingDirs(r: unknown): WorkingDirectoriesWire {
  const v = r as Partial<WorkingDirectoriesWire> | null;
  if (!v || !Array.isArray(v.all) || !Array.isArray(v.included)) {
    return EMPTY_WORKING_DIRS;
  }
  const reason =
    typeof v.unsupportedReason === "string" &&
    UNSUPPORTED_REASONS.has(v.unsupportedReason)
      ? (v.unsupportedReason as WorkingDirectoriesUnsupportedReason)
      : undefined;
  return {
    all: v.all.filter((d): d is string => typeof d === "string"),
    // Legacy engines omit the lock set but still force-include Design directories.
    locked: Array.isArray(v.locked)
      ? v.locked.filter((d): d is string => typeof d === "string")
      : [],
    included: v.included.filter((d): d is string => typeof d === "string"),
    sparse: v.sparse === true,
    supported: v.supported === true,
    // Supply a legacy fallback so unsupported pickers never render an empty explanation.
    ...(v.supported === true
      ? {}
      : { unsupportedReason: reason ?? "no-commits" }),
    ...(Array.isArray(v.leftBehind)
      ? {
          leftBehind: v.leftBehind.filter(
            (d): d is string => typeof d === "string",
          ),
        }
      : {}),
  };
}

export async function bridgeListWorkingDirectories(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<WorkingDirectoriesWire> {
  return toWorkingDirs(
    await workspaceOp(bridge, "workspace.listWorkingDirectories", {
      workspaceId,
    }),
  );
}

export async function bridgeSetWorkingDirectories(
  bridge: RuntimeClient,
  workspaceId: string,
  directories: string[],
): Promise<WorkingDirectoriesWire> {
  return toWorkingDirs(
    await workspaceOp(
      bridge,
      "workspace.setWorkingDirectories",
      { workspaceId, directories },
      // Materializing files can outlast the request; a completed change broadcasts DB_CHANGED to the writer too.
      60_000,
    ),
  );
}

export interface HostDirListing {
  /** The directory that was listed (realpath-resolved). */
  path: string;
  /** Parent directory for "up" navigation, or null at the fs root. */
  parent: string | null;
  /** Immediate child directories (dotfolders excluded), name-sorted. */
  entries: { name: string; path: string }[];
}

/** Browse host directories over the bridge for an optional remote folder
 * picker. `dirPath` empty → the host home directory. */
export async function bridgeListDir(
  bridge: RuntimeClient,
  dirPath?: string,
): Promise<HostDirListing> {
  const r = (await workspaceOp(bridge, "fs.listDir", {
    path: dirPath ?? "",
  })) as Partial<HostDirListing> | undefined;
  return {
    path: typeof r?.path === "string" ? r.path : "",
    parent: typeof r?.parent === "string" ? r.parent : null,
    entries: Array.isArray(r?.entries)
      ? (r.entries as HostDirListing["entries"])
      : [],
  };
}

export async function bridgeWorkspaceCreate(
  bridge: RuntimeClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  // A full checkout can outlive the default, and the engine continues even after the client times out.
  return workspaceOp(bridge, "workspace.create", { ...args }, 60_000);
}

export interface PreparedWorkspaceCreateWire {
  workspaceId: string;
  path: string;
  repoSlug: string;
  branch: string;
  /** Absent from an engine that predates workspace numbers. */
  number?: number;
}

/** Reserve identity and final path for navigation; prepare creates no files, so disconnecting cannot leave a checkout. */
export async function bridgeWorkspacePrepareCreate(
  bridge: RuntimeClient,
  args: {
    repoRoot: string;
    kind?: "code" | "design";
    repoSlug?: string;
    prompt?: string;
  },
): Promise<PreparedWorkspaceCreateWire> {
  const r = (await workspaceOp(
    bridge,
    "workspace.prepareCreate",
    { ...args },
    10_000,
  )) as Partial<PreparedWorkspaceCreateWire> | undefined;
  if (
    typeof r?.workspaceId !== "string" ||
    typeof r?.path !== "string" ||
    typeof r?.repoSlug !== "string" ||
    typeof r?.branch !== "string"
  ) {
    throw new Error("workspace.prepareCreate: malformed engine response");
  }
  return {
    workspaceId: r.workspaceId,
    path: r.path,
    repoSlug: r.repoSlug,
    branch: r.branch,
    ...(isWorkspaceNumber(r.number) ? { number: r.number } : {}),
  };
}

// Web reads the chat list here; desktop writes through into it. Not
// host-approved: a chat is the user's own metadata.

export async function bridgeChatList(
  bridge: RuntimeClient,
): Promise<ChatRowWire[]> {
  return (await bridgeChatSnapshot(bridge)).chats;
}

export interface ChatSnapshotWire {
  chats: ChatRowWire[];
  /** Complete engine tombstone set, used to reject stale boot-cache rows. */
  chatDeletions: string[];
  confirmedCloudWorkspaces?: string[];
  /** False for a partial cloud publication while Local is cold/reconnecting. */
  confirmedLocalChats?: boolean;
}

export async function bridgeChatSnapshot(
  bridge: RuntimeClient,
  refresh?: ChatSnapshotRefresh,
): Promise<ChatSnapshotWire> {
  const r = (await (refresh && bridge instanceof WorkspaceRuntimeClient
    ? bridge.chatSnapshot(refresh) : workspaceOp(bridge, "chats.list"))) as
    | { chats?: ChatRowWire[]; chatDeletions?: unknown; confirmedCloudWorkspaces?: unknown; confirmedLocalChats?: boolean }
    | undefined;
  // Failure/malformed data cannot establish an empty workspace or authorize
  // default-chat creation. Keep the last confirmed snapshot and retry later.
  if (!Array.isArray(r?.chats)) throw new Error("Could not read the conversation list");
  return {
    chats: r.chats,
    ...(r.confirmedLocalChats === undefined ? {} : { confirmedLocalChats: r.confirmedLocalChats }),
    confirmedCloudWorkspaces: Array.isArray(r?.confirmedCloudWorkspaces)
      ? r.confirmedCloudWorkspaces.filter((folder): folder is string => typeof folder === "string")
      : [],
    chatDeletions: Array.isArray(r?.chatDeletions)
      ? r.chatDeletions.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [],
  };
}

export async function bridgeChatUpsert(
  bridge: RuntimeClient,
  chat: ChatRowWire,
): Promise<void> {
  await workspaceOp(bridge, "chats.upsert", { chat });
}

export async function bridgeChatDelete(
  bridge: RuntimeClient,
  id: string,
): Promise<void> {
  const cloud = parseCloudScopedId(id), erase = cloud && prepareCloudPromptErasure({
    organizationId: cloud.organizationId, workspaceId: cloud.workspaceId, chatId: cloud.id,
  });
  await workspaceOp(bridge, "chats.delete", { id });
  if (erase) erase();
}

export async function bridgeChatClearProviderIdentity(
  bridge: RuntimeClient,
  input: { chatId: string; agentId: string; resumeId: string },
): Promise<boolean> {
  const result = (await workspaceOp(
    bridge,
    "chats.clearProviderIdentity",
    input,
  )) as { ok?: boolean } | undefined;
  return result?.ok === true;
}

export async function bridgeChatBulkUpsert(
  bridge: RuntimeClient,
  chats: ChatRowWire[],
): Promise<void> {
  await workspaceOp(bridge, "chats.bulkUpsert", { chats });
}

/** Prior chats in a folder with a summary (first user message) — the empty-
 *  composer handoff picker, served from the engine. */
export async function bridgeChatSummaries(
  bridge: RuntimeClient,
  folder: string,
  excludeChatId?: string,
): Promise<ChatSummaryWire[]> {
  const r = (await workspaceOp(bridge, "chats.summariesForFolder", {
    folder,
    ...(excludeChatId ? { excludeChatId } : {}),
  })) as { summaries?: ChatSummaryWire[] } | undefined;
  // Coerce only aggregates: an older engine's messageCount does not substitute for userMessageCount; missing strings stay visible.
  return (r?.summaries ?? []).map((s) => ({
    ...s,
    userMessageCount: Number(s.userMessageCount) || 0,
    lastMessageAt: Number(s.lastMessageAt) || 0,
  }));
}

/** What names an Untitled Local chat: its first real prompt and whether the
 *  agent answered it (`chats.titleSeeds`, desktop engine only). */
export interface ChatTitleSeedWire {
  chatId: string;
  messageId: string;
  prompt: string;
  answered: boolean;
}

export async function bridgeChatTitleSeeds(
  bridge: RuntimeClient,
  chatIds: readonly string[],
  workspaceId?: string,
): Promise<ChatTitleSeedWire[]> {
  if (chatIds.length === 0) return [];
  const r = (await workspaceOp(bridge, "chats.titleSeeds", {
    chatIds: chatIds.slice(0, 50), ...(workspaceId ? { workspaceId } : {}),
  })) as
    | { seeds?: unknown }
    | undefined;
  // An older engine does not know the op (it throws); a shape it never sent
  // degrades to nothing rather than a request with a missing prompt.
  return (Array.isArray(r?.seeds) ? r.seeds : []).filter(
    (seed): seed is ChatTitleSeedWire =>
      !!seed &&
      typeof (seed as ChatTitleSeedWire).chatId === "string" &&
      typeof (seed as ChatTitleSeedWire).messageId === "string" &&
      typeof (seed as ChatTitleSeedWire).prompt === "string" &&
      typeof (seed as ChatTitleSeedWire).answered === "boolean",
  );
}

/** Resolve titles with the owning engine; a stopped cloud workspace waits until its next connection. */
export async function bridgeChatTitleSeedsByOwner(
  bridge: RuntimeClient,
  chatIds: readonly string[],
): Promise<ChatTitleSeedWire[]> {
  const local: string[] = [];
  const cloud = new Map<string, string[]>();
  for (const id of chatIds) {
    const owner = parseCloudScopedId(id);
    if (!owner) { local.push(id); continue; }
    const key = cloudWorkspaceKey(owner);
    cloud.set(key, [...(cloud.get(key) ?? []), id]);
  }
  const reads = [bridgeChatTitleSeeds(bridge, local)];
  for (const [key, ids] of cloud) reads.push(bridgeChatTitleSeeds(bridge, ids, key).catch(() => []));
  return (await Promise.all(reads)).flat();
}

/** A transcript row changed since the pull cursor (the message half of delta
 *  sync), tagged with its owning chatId + ord so the client routes + orders it. */
export interface ChatMessageDelta {
  chatId: string;
  msgId: string;
  ord: number;
  kind: string;
  payload: string;
  createdAt: number;
}

/** What `db.pull(since)` returns: the new cursor + the chat rows changed since
 *  the old cursor + the ids of chats deleted since (tombstones) + the messages
 *  changed since + the chatIds whose transcript was cleared/truncated. */
export interface DbPullResult {
  rev: number;
  chats: ChatRowWire[];
  chatDeletions: string[];
  messages: ChatMessageDelta[];
  messageResets: string[];
}

/** Current global rev — a client's cursor right after a full bootstrap load. */
export async function bridgeDbHead(bridge: RuntimeClient): Promise<number> {
  const r = (await workspaceOp(bridge, "db.head")) as
    | { rev?: number }
    | undefined;
  return r?.rev ?? 0;
}

/** Pull only what changed after `since` (chat upserts + deletions). */
export async function bridgeDbPull(
  bridge: RuntimeClient,
  since: number,
): Promise<DbPullResult> {
  const r = (await workspaceOp(bridge, "db.pull", { since })) as
    | Partial<DbPullResult>
    | undefined;
  return {
    rev: typeof r?.rev === "number" ? r.rev : since,
    chats: Array.isArray(r?.chats) ? r.chats : [],
    chatDeletions: Array.isArray(r?.chatDeletions) ? r.chatDeletions : [],
    messages: Array.isArray(r?.messages) ? r.messages : [],
    messageResets: Array.isArray(r?.messageResets) ? r.messageResets : [],
  };
}

export async function bridgeMessageWindow(
  bridge: RuntimeClient,
  chatId: string,
  limit: number,
  before?: number,
  timeoutMs = CONTEXT_GRAPH_QUEUE_TIMEOUT_MS,
): Promise<PersistedMessageWire[]> {
  return (await bridgeMessageWindowSnapshot(bridge, chatId, limit, before, timeoutMs)).messages;
}

export type MessageWindowSnapshot = {
  messages: PersistedMessageWire[];
  source: "local" | "unknown" | "worker" | "control-plane";
  historyState?: CloudV2HistoryState;
  /** Renderer-derived: an unfiltered tail shorter than the requested window. */
  complete?: boolean;
  /** The opening prompt of the turn `messages[0]` belongs
   *  to, when that turn is longer than the contiguous window. */
  turnOpening?: PersistedMessageWire;
};

type MessageWindowResponse = { messages?: PersistedMessageWire[]; projection?: unknown; historyHeads?: unknown; turnOpening?: unknown; historyState?: unknown } | undefined;

function persistedMessageWire(value: unknown): PersistedMessageWire | undefined {
  const row = value as Partial<PersistedMessageWire> | null | undefined;
  return row && typeof row.msgId === "string" && row.msgId.length > 0 && typeof row.kind === "string" &&
    typeof row.payload === "string" && typeof row.createdAt === "number"
    ? { msgId: row.msgId, kind: row.kind, payload: row.payload, createdAt: row.createdAt }
    : undefined;
}


function messageWindowSnapshot(bridge: RuntimeClient, chatId: string, r: MessageWindowResponse): MessageWindowSnapshot {
  const target = parseCloudScopedId(chatId);
  const turnOpening = persistedMessageWire(r?.turnOpening);
  const source = target ? r && bridge instanceof WorkspaceRuntimeClient ? bridge.historySource(r) ?? "unknown" : "unknown" : "local";
  const historyState = target && r?.historyState !== undefined ? CloudV2HistoryStateSchema.parse(r.historyState) : undefined;
  return { messages: r?.messages ?? [], source, ...(historyState ? { historyState } : {}), ...(turnOpening ? { turnOpening } : {}) };
}

export async function bridgeMessageWindowSnapshot(
  bridge: RuntimeClient,
  chatId: string,
  limit: number,
  before?: number,
  timeoutMs = CONTEXT_GRAPH_QUEUE_TIMEOUT_MS,
): Promise<MessageWindowSnapshot> {
  const r = (await workspaceOp(
    bridge,
    "messages.window",
    {
      chatId,
      limit,
      ...(before !== undefined ? { before } : {}),
    },
    timeoutMs,
  )) as MessageWindowResponse;
  const snapshot = messageWindowSnapshot(bridge, chatId, r);
  if (snapshot.source === "worker" || snapshot.source === "control-plane")
    snapshot.complete = before === undefined && !snapshot.turnOpening && Array.isArray(r?.messages) && r.messages.length < Math.min(1000, Math.max(1, limit));
  return snapshot;
}

export async function bridgeMessageWindowOlder(
  bridge: RuntimeClient,
  chatId: string,
  limit: number,
  beforeMsgId: string,
  timeoutMs = CONTEXT_GRAPH_QUEUE_TIMEOUT_MS,
): Promise<PersistedMessageWire[]> {
  const r = (await workspaceOp(
    bridge,
    "messages.windowOlder",
    {
      chatId,
      limit,
      beforeMsgId,
    },
    timeoutMs,
  )) as MessageWindowResponse;
  return messageWindowSnapshot(bridge, chatId, r).messages;
}

export async function bridgeMessageClear(
  bridge: RuntimeClient,
  chatId: string,
): Promise<void> {
  await workspaceOp(bridge, "messages.clear", { chatId });
}

export async function bridgeMessageTruncateFrom(
  bridge: RuntimeClient,
  chatId: string,
  fromMsgId: string,
): Promise<void> {
  await workspaceOp(bridge, "messages.truncateFrom", { chatId, fromMsgId });
}

/** A full-text search hit. `chatId` lets the UI navigate to the
 *  matching chat; `payload` is the JSON AgentMessage for preview. */
export interface MessageSearchHit {
  chatId: string;
  msgId: string;
  payload: string;
  createdAt: number;
}

/** Cross-chat and cross-agent full-text search over transcripts. */
export async function bridgeMessageSearch(
  bridge: RuntimeClient,
  query: string,
  limit?: number,
): Promise<MessageSearchHit[]> {
  const r = (await workspaceOp(bridge, "messages.search", {
    query,
    ...(limit !== undefined ? { limit } : {}),
  })) as { hits?: MessageSearchHit[] } | undefined;
  return r?.hits ?? [];
}

export interface WorkspaceFileListing {
  files: string[];
  /** Absent on older engines; an empty array is a confirmed lack of Design roots. */
  designDirectories?: string[];
}

export async function bridgeWorkspaceFileListing(
  bridge: RuntimeClient,
  workspaceId: string,
  limit?: number,
  connectedOnly = false,
): Promise<WorkspaceFileListing> {
  const result = (await workspaceOp(bridge, "file.tree", {
    workspaceId,
    limit,
    includeDesignDirectories: true,
  }, 10_000, connectedOnly)) as WorkspaceFileListing;
  if (!Array.isArray(result?.files))
    throw new Error("Invalid workspace file listing");
  return result;
}

/** Repo-relative file list under a workspace (gitignore-aware). The engine
 *  filters secret paths for remote clients. */
export async function bridgeFileTree(
  bridge: RuntimeClient,
  workspaceId: string,
  limit?: number,
  options: {
    includeIgnored?: boolean;
    query?: string;
    mentionRevision?: string;
  } = {},
): Promise<string[]> {
  const r = (await workspaceOp(bridge, "file.tree", {
    workspaceId,
    limit,
    ...options,
  })) as { files?: string[] } | undefined;
  if (options.includeIgnored && !Array.isArray(r?.files))
    throw new Error("Invalid workspace mention listing");
  return r?.files ?? [];
}

/** Without dir return collapsed ignored roots; with dir list one level. This reveals ignored paths, so relay callers are refused. */
export async function bridgeIgnoredEntries(
  bridge: RuntimeClient,
  workspaceId: string,
  dir?: string,
  connectedOnly = false,
): Promise<string[]> {
  const r = (await workspaceOp(bridge, "file.ignored", {
    workspaceId,
    ...(dir ? { dir } : {}),
  }, 10_000, connectedOnly)) as { entries?: string[] } | undefined;
  return r?.entries ?? [];
}

/** Read one file's content under a workspace (bounded; secret paths refused
 *  for remote clients). */
export async function bridgeFileRead(
  bridge: RuntimeClient,
  workspaceId: string,
  path: string,
  includeVideo = false,
  streamMedia = false,
): Promise<ReadFileResult> {
  return (await workspaceOp(bridge, "file.read", {
    workspaceId,
    path,
    // Optional: older runtimes ignore it and return their binary/size fallback;
    // older clients never receive a new result kind from updated runtimes.
    ...(includeVideo ? { includeVideo: true } : {}),
    ...(streamMedia ? { streamMedia: true } : {}),
  })) as ReadFileResult;
}

/** Write one file's content under a workspace (bounded; secret paths refused for
 *  remote clients). Mirrors bridgeFileRead. */
export async function bridgeFileWrite(
  bridge: RuntimeClient,
  workspaceId: string,
  path: string,
  content: string,
  /** Replace the file only while it holds exactly this text. An older cloud
   *  worker ignores it and writes as before. */
  expectedContent?: string,
): Promise<WriteFileResult> {
  return (await workspaceOp(bridge, "file.write", {
    workspaceId,
    path,
    content,
    ...(expectedContent !== undefined ? { expectedContent } : {}),
  })) as WriteFileResult;
}

/** Transcripts retain only the returned path; paired clients need this write for attachments, not access to the private context canvas. */
export async function bridgeAttachmentWrite(
  bridge: RuntimeClient,
  workspaceId: string,
  args: AttachmentTransferOptions & {
    chatId?: string | null;
    attachmentId: string;
    base64: string;
    mimeType: string;
    filename: string;
  },
): Promise<{
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
  skipped?: boolean;
  pending?: boolean;
}> {
  return (await workspaceOp(
    bridge,
    "attachment.write",
    {
      workspaceId,
      ...args,
    },
    // A durable graph write can queue behind Design-owner publication; match the create budget.
    CONTEXT_GRAPH_QUEUE_TIMEOUT_MS,
  )) as {
    absolutePath: string;
    relativePath: string;
    mimeType: string;
    bytes: number;
    skipped?: boolean;
  pending?: boolean;
  };
}

// DESKTOP ONLY, like `file.ignored`: `.context/` holds private workspace
// material, so the engine refuses remote callers. platform/context-graph.ts
// short-circuits them first.

export async function bridgeContextGraphList(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<ContextGraphListWire> {
  const r = (await workspaceOp(bridge, "context.graph.list", {
    workspaceId,
  })) as Partial<ContextGraphListWire> | undefined;
  return {
    exists: r?.exists === true,
    items: Array.isArray(r?.items) ? (r.items as ContextGraphItemWire[]) : [],
    truncated: r?.truncated === true,
  };
}

export async function bridgeContextGraphScaffold(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const r = (await workspaceOp(
    bridge,
    "context.graph.scaffold",
    { workspaceId },
    CONTEXT_GRAPH_QUEUE_TIMEOUT_MS,
  )) as { ok?: boolean; created?: boolean; error?: string } | undefined;
  return {
    ok: r?.ok === true,
    created: r?.created === true,
    ...(typeof r?.error === "string" ? { error: r.error } : {}),
  };
}

export async function bridgeGitStatus(
  bridge: RuntimeClient,
  workspaceId: string,
  options: { paths?: string[]; includeTracking?: boolean; includeSummary?: boolean } = {},
): Promise<StatusResult> {
  return (await workspaceOp(
    bridge,
    "git.status",
    {
      workspaceId,
      paths: options.paths,
      includeTracking: options.includeTracking,
      ...(options.includeSummary === undefined ? {} : { includeSummary: options.includeSummary }),
    },
    GIT_READ_TIMEOUT_MS,
  )) as StatusResult;
}

/** Count each real Git comparison after engine-side remote secret filtering. */
export async function bridgeGitChangeCounts(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<ChangeCounts> {
  return (await workspaceOp(
    bridge,
    "git.changeCounts",
    { workspaceId },
    GIT_READ_TIMEOUT_MS,
  )) as ChangeCounts;
}

/** Sum the All Changes comparison only after engine-side remote secret filtering. */
export async function bridgeGitChangeLineCounts(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<ChangeLineCounts> {
  const result = (await workspaceOp(
    bridge,
    "git.changeLineCounts",
    { workspaceId },
    GIT_READ_TIMEOUT_MS,
  )) as Partial<ChangeLineCounts> | undefined;
  // An engine predating this op answers with no totals rather than an error;
  // read that as "nothing to show" instead of NaN reaching the tab.
  return {
    additions: Number(result?.additions) || 0,
    deletions: Number(result?.deletions) || 0,
  };
}

/** Exact "anything worth a PR?" boolean using the All Changes net comparison.
 * Powers the Create-PR button gate without treating a cancelling AD pair as a
 * submit-worthy diff. */
export async function bridgeGitHasChanges(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<boolean> {
  const result = (await workspaceOp(
    bridge,
    "git.hasChanges",
    { workspaceId },
    GIT_READ_TIMEOUT_MS,
  )) as { hasChanges?: boolean } | undefined;
  return result?.hasChanges ?? false;
}

/** Keep the legacy against selector; ref-mode inputs are guarded and remote secret files are removed from both hunks and raw patch. */
export async function bridgeGitDiff(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    filePath?: string;
    oldFilePath?: string;
    against?: "index" | "HEAD" | "main";
    mode?: DiffMode;
    base?: string;
    head?: string;
    rawPatch?: boolean;
    fullContext?: boolean;
    summaryLimit?: number;
    history?: ChangesHistory;
  },
): Promise<{
  hunks: Hunk[];
  patch?: string;
  files?: DiffFileSummary[];
  summary?: boolean;
}> {
  return (await workspaceOp(
    bridge,
    "git.diff",
    {
      workspaceId: args.workspaceId,
      filePath: args.filePath,
      ...(args.oldFilePath ? { oldFilePath: args.oldFilePath } : {}),
      against: args.against,
      mode: args.mode,
      base: args.base,
      head: args.head,
      rawPatch: args.rawPatch,
      ...(args.fullContext ? { fullContext: true } : {}),
      summaryLimit: args.summaryLimit,
      ...(args.history ? { history: args.history } : {}),
    },
    GIT_READ_TIMEOUT_MS,
  )) as {
    hunks: Hunk[];
    patch?: string;
    files?: DiffFileSummary[];
    summary?: boolean;
  };
}

/** For remote clients, remove commits' sensitive or unparseable paths from both file enumeration and raw patch. */
export async function bridgeGitShow(
  bridge: RuntimeClient,
  args: { workspaceId: string; sha: string },
): Promise<ShowCommitResult> {
  return (await workspaceOp(
    bridge,
    "git.show",
    {
      workspaceId: args.workspaceId,
      sha: args.sha,
    },
    GIT_READ_TIMEOUT_MS,
  )) as ShowCommitResult;
}

export async function bridgeGitLog(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    limit?: number;
    skip?: number;
    since?: number;
    ref?: string;
    base?: string;
  },
): Promise<Commit[]> {
  const r = (await workspaceOp(
    bridge,
    "git.log",
    {
      workspaceId: args.workspaceId,
      limit: args.limit,
      ...(args.skip !== undefined ? { skip: args.skip } : {}),
      since: args.since,
      ref: args.ref,
      base: args.base,
    },
    GIT_READ_TIMEOUT_MS,
  )) as { commits?: Commit[] } | undefined;
  return r?.commits ?? [];
}

export async function bridgeGitBranches(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<Branch[]> {
  const r = (await workspaceOp(bridge, "git.branches", { workspaceId })) as
    | { branches?: Branch[] }
    | undefined;
  return r?.branches ?? [];
}

export async function bridgeGitRemoteBranches(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<Branch[]> {
  const r = (await workspaceOp(bridge, "git.remoteBranches", {
    workspaceId,
  })) as { branches?: Branch[] } | undefined;
  return r?.branches ?? [];
}

// Relay Git writes use the host's workspace restriction list, not per-write approval; denials arrive as WORKSPACE_ERROR.

export async function bridgeGitStage(
  bridge: RuntimeClient,
  args: { workspaceId: string; paths: string[] },
): Promise<void> {
  await workspaceOp(
    bridge,
    "git.stage",
    {
      workspaceId: args.workspaceId,
      paths: args.paths,
    },
    LOCAL_GIT_TIMEOUT_MS,
  );
}

export async function bridgeGitDiscard(
  bridge: RuntimeClient,
  args: { workspaceId: string; paths: string[] },
): Promise<void> {
  await workspaceOp(bridge, "git.discard", {
    workspaceId: args.workspaceId,
    paths: args.paths,
  });
}

export async function bridgeGitUnstage(
  bridge: RuntimeClient,
  args: { workspaceId: string; paths: string[] },
): Promise<void> {
  await workspaceOp(bridge, "git.unstage", {
    workspaceId: args.workspaceId,
    paths: args.paths,
  });
}

export async function bridgeGitCommit(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    message: string;
    files?: string[];
    amend?: boolean;
  },
): Promise<{ sha: string; branch: string }> {
  return (await workspaceOp(
    bridge,
    "git.commit",
    {
      workspaceId: args.workspaceId,
      message: args.message,
      files: args.files,
      amend: args.amend,
    },
    LOCAL_GIT_TIMEOUT_MS,
  )) as { sha: string; branch: string };
}

export async function bridgeGitPush(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    setUpstream?: boolean;
    force?: boolean;
    remote?: string;
  },
): Promise<{ remoteRef: string; ahead: number; behind: number }> {
  return (await workspaceOp(
    bridge,
    "git.push",
    {
      workspaceId: args.workspaceId,
      setUpstream: args.setUpstream,
      force: args.force,
      remote: args.remote,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as { remoteRef: string; ahead: number; behind: number };
}

export async function bridgeGitPull(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    strategy: "rebase" | "merge";
    autoStash?: boolean;
    remote?: string;
  },
): Promise<{ applied: number; conflicts: string[] }> {
  return (await workspaceOp(
    bridge,
    "git.pull",
    {
      workspaceId: args.workspaceId,
      strategy: args.strategy,
      autoStash: args.autoStash,
      remote: args.remote,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as { applied: number; conflicts: string[] };
}

export async function bridgeGitRebase(
  bridge: RuntimeClient,
  args: { workspaceId: string; ontoBranch: string; autoStash?: boolean },
): Promise<{ applied: number; conflicts: string[] }> {
  return (await workspaceOp(
    bridge,
    "git.rebase",
    {
      workspaceId: args.workspaceId,
      ontoBranch: args.ontoBranch,
      autoStash: args.autoStash,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as { applied: number; conflicts: string[] };
}

export async function bridgeGitFetch(
  bridge: RuntimeClient,
  args: { workspaceId: string; prune?: boolean; remote?: string; unshallow?: boolean },
): Promise<{ summary: string; historyLimited?: true }> {
  return (await workspaceOp(
    bridge,
    "git.fetch",
    {
      workspaceId: args.workspaceId,
      prune: args.prune,
      remote: args.remote,
      ...(args.unshallow === undefined ? {} : { unshallow: args.unshallow }),
    },
    args.unshallow ? 90_000 : NETWORK_GIT_TIMEOUT_MS,
  )) as { summary: string; historyLimited?: true };
}

export async function bridgeGitStashSave(
  bridge: RuntimeClient,
  args: { workspaceId: string; message?: string },
): Promise<{ stashRef: string }> {
  return (await workspaceOp(bridge, "git.stashSave", {
    workspaceId: args.workspaceId,
    message: args.message,
  })) as { stashRef: string };
}

export async function bridgeGitStashPop(
  bridge: RuntimeClient,
  args: { workspaceId: string; stashRef: string },
): Promise<{ conflicts: string[] }> {
  return (await workspaceOp(bridge, "git.stashPop", {
    workspaceId: args.workspaceId,
    stashRef: args.stashRef,
  })) as { conflicts: string[] };
}

export async function bridgeGitCheckoutBranch(
  bridge: RuntimeClient,
  args: { workspaceId: string; branchName: string; createIfMissing?: boolean },
): Promise<void> {
  await workspaceOp(bridge, "git.checkoutBranch", {
    workspaceId: args.workspaceId,
    branchName: args.branchName,
    createIfMissing: args.createIfMissing,
  });
}

export async function bridgeGitCreateBranchFrom(
  bridge: RuntimeClient,
  args: { workspaceId: string; sourceBranch: string; newBranchName: string },
): Promise<void> {
  await workspaceOp(bridge, "git.createBranch", {
    workspaceId: args.workspaceId,
    sourceBranch: args.sourceBranch,
    newBranchName: args.newBranchName,
  });
}

/** Only the engine knows the retained branch prefix; an older engine's ok-only reply leaves the caller's optimistic guess. */
export async function bridgeGitRenameBranch(
  bridge: RuntimeClient,
  args: { workspaceId: string; newName: string },
): Promise<string | null> {
  const result = (await workspaceOp(bridge, "git.renameBranch", {
    workspaceId: args.workspaceId,
    newName: args.newName,
  })) as { branch?: unknown } | null;
  return typeof result?.branch === "string" ? result.branch : null;
}

export async function bridgeGitChangeTargetBranch(
  bridge: RuntimeClient,
  args: { workspaceId: string; newTarget: string; rebase?: boolean },
): Promise<{ baseBranch: string; conflicts: string[] }> {
  return (await workspaceOp(bridge, "git.changeTarget", {
    workspaceId: args.workspaceId,
    newTarget: args.newTarget,
    rebase: args.rebase,
  })) as { baseBranch: string; conflicts: string[] };
}

// The engine resolves workspace-scoped PR metadata without the checkout file filter; host credential mutations stay local.

/** Host's GitHub auth status (takes no workspaceId — probes the host token). */
export async function bridgeGhAuthStatus(
  bridge: RuntimeClient,
  workspaceId?: string,
): Promise<AuthStatusResult> {
  return (await workspaceOp(bridge, "gh.authStatus", workspaceId ? { workspaceId } : {})) as AuthStatusResult;
}

export interface GithubRepositoryOwnerAvatar {
  login: string;
  type: "user" | "org" | null;
  avatarUrl: string;
}

/** The engine validates the checkout's origin; callers do not supply owner/repo. */
export async function bridgeGhRepositoryOwnerAvatar(
  bridge: RuntimeClient,
  repoRoot: string,
): Promise<GithubRepositoryOwnerAvatar | null> {
  return (await workspaceOp(bridge, "gh.repoOwnerAvatar", {
    repoRoot,
  })) as GithubRepositoryOwnerAvatar | null;
}

/** Mirror the repo-access contract without importing engine code into the renderer. */
export interface GithubRepoAccess {
  state: "ok" | "blocked" | "unknown";
  connected?: boolean;
  code?: string;
  message?: string;
  remediation?: string;
}

/** Preflight for the Create PR control: can the selected GitHub connection
 *  actually reach this workspace's remote? Resolves a status object (the engine
 *  never throws for this op) so callers can distinguish a definite refusal from
 *  a probe that simply couldn't complete. */
export async function bridgeGhRepoAccess(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<GithubRepoAccess> {
  return (await workspaceOp(bridge, "gh.repoAccess", {
    workspaceId,
  })) as GithubRepoAccess;
}

export async function bridgeGhPrGet(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number },
): Promise<PR> {
  return (await workspaceOp(bridge, "gh.prGet", {
    workspaceId: args.workspaceId,
    prNumber: args.prNumber,
  })) as PR;
}

/** Backfill PRs opened outside the engine; null also covers missing remote or authentication. */
export async function bridgeGhPrSync(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<PR | null> {
  return (await workspaceOp(
    bridge,
    "gh.prSync",
    { workspaceId },
    NETWORK_GIT_TIMEOUT_MS,
  )) as PR | null;
}

export async function bridgeGhPrChecks(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number },
): Promise<PrChecksResult> {
  return (await workspaceOp(bridge, "gh.prChecks", {
    workspaceId: args.workspaceId,
    prNumber: args.prNumber,
  })) as PrChecksResult;
}

export async function bridgeGhPrRerunFailed(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number; headSha: string },
): Promise<{ rerun: number }> {
  return (await workspaceOp(
    bridge,
    "gh.prRerunFailed",
    { workspaceId: args.workspaceId, prNumber: args.prNumber, headSha: args.headSha },
    NETWORK_GIT_TIMEOUT_MS,
  )) as { rerun: number };
}

export async function bridgeGhPrCommits(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number },
): Promise<PrCommitSummary[]> {
  return (await workspaceOp(bridge, "gh.prCommits", {
    workspaceId: args.workspaceId,
    prNumber: args.prNumber,
  })) as PrCommitSummary[];
}

export async function bridgeGhPrReviews(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number },
): Promise<PrTimelineItem[]> {
  return (await workspaceOp(bridge, "gh.prReviews", {
    workspaceId: args.workspaceId,
    prNumber: args.prNumber,
  })) as PrTimelineItem[];
}

export async function bridgeGhPrCreate(
  bridge: RuntimeClient,
  args: { workspaceId: string; title: string; body: string; draft?: boolean },
): Promise<PR> {
  return (await workspaceOp(
    bridge,
    "gh.prCreate",
    {
      workspaceId: args.workspaceId,
      title: args.title,
      body: args.body,
      draft: args.draft,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as PR;
}

export interface GithubOwner {
  login: string;
  type: "user" | "org";
  avatarUrl: string | null;
}

export interface PublishRepoResult {
  originUrl: string;
  htmlUrl: string;
  owner: string;
  repo: string;
}

/** Publish-to-GitHub bridge ops (desktop-only — the engine refuses these for a
 *  relay client). */
export async function bridgeGhListOwners(
  bridge: RuntimeClient,
): Promise<GithubOwner[]> {
  return (await workspaceOp(bridge, "gh.listOwners", {})) as GithubOwner[];
}

export async function bridgeGhCheckRepoName(
  bridge: RuntimeClient,
  args: { owner: string; name: string },
): Promise<{ available: boolean }> {
  return (await workspaceOp(bridge, "gh.checkRepoName", {
    owner: args.owner,
    name: args.name,
  })) as { available: boolean };
}

export async function bridgeGhPublishRepo(
  bridge: RuntimeClient,
  args: { repoRoot: string; name: string; owner?: string; private?: boolean },
): Promise<PublishRepoResult> {
  return (await workspaceOp(bridge, "gh.publishRepo", {
    repoRoot: args.repoRoot,
    name: args.name,
    owner: args.owner,
    private: args.private,
  })) as PublishRepoResult;
}

/** Local-only `git init` + initial commit on an existing folder (no remote). */
export interface InitRepoInPlaceResult {
  branch: string;
  initialized: boolean;
}

export async function bridgeGitInitInPlace(
  bridge: RuntimeClient,
  repoRoot: string,
): Promise<InitRepoInPlaceResult> {
  return (await workspaceOp(bridge, "git.initInPlace", {
    repoRoot,
  })) as InitRepoInPlaceResult;
}

export async function bridgeGhPrUpdate(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    prNumber: number;
    title?: string;
    body?: string;
  },
): Promise<PR> {
  return (await workspaceOp(bridge, "gh.prUpdate", {
    workspaceId: args.workspaceId,
    prNumber: args.prNumber,
    title: args.title,
    body: args.body,
  })) as PR;
}

export async function bridgeGhPrMarkReady(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number },
): Promise<PR> {
  return (await workspaceOp(
    bridge,
    "gh.prMarkReady",
    {
      workspaceId: args.workspaceId,
      prNumber: args.prNumber,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as PR;
}

export async function bridgeGhPrMerge(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
  },
): Promise<{ sha: string }> {
  return (await workspaceOp(
    bridge,
    "gh.prMerge",
    {
      workspaceId: args.workspaceId,
      prNumber: args.prNumber,
      method: args.method,
      commitTitle: args.commitTitle,
      commitMessage: args.commitMessage,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as { sha: string };
}

export async function bridgeGhPrComment(
  bridge: RuntimeClient,
  args: { workspaceId: string; prNumber: number; body: string },
): Promise<{ id: number; url: string }> {
  return (await workspaceOp(bridge, "gh.prComment", {
    workspaceId: args.workspaceId,
    prNumber: args.prNumber,
    body: args.body,
  })) as { id: number; url: string };
}

export async function bridgeGhBranchList(
  bridge: RuntimeClient,
  args: { owner: string; repo: string },
): Promise<import("../git").GithubBranch[]> {
  return (await workspaceOp(bridge, "gh.branchList", { ...args })) as import("../git").GithubBranch[];
}

export async function bridgeGhPrList(
  bridge: RuntimeClient,
  args: {
    workspaceId?: string;
    owner?: string;
    repo?: string;
    originUrl?: string;
    state?: "open" | "closed" | "all";
  },
): Promise<PR[]> {
  return (await workspaceOp(bridge, "gh.prList", { ...args })) as PR[];
}


export async function bridgeGitReset(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    mode: "soft" | "mixed" | "hard";
    ref?: string;
    confirm?: boolean;
  },
): Promise<void> {
  await workspaceOp(bridge, "git.reset", { ...args });
}

export async function bridgeGitRestore(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    paths: string[];
    source: string;
    staged?: boolean;
  },
): Promise<void> {
  await workspaceOp(bridge, "git.restore", { ...args });
}

export async function bridgeGitClean(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    paths?: string[];
    directories?: boolean;
    confirm: boolean;
  },
): Promise<{ removed: string[] }> {
  return (await workspaceOp(bridge, "git.clean", { ...args })) as {
    removed: string[];
  };
}

export async function bridgeGitMerge(
  bridge: RuntimeClient,
  args: { workspaceId: string; branch: string; noFF?: boolean },
): Promise<{ merged: boolean; conflicts: string[] }> {
  return (await workspaceOp(bridge, "git.merge", { ...args })) as {
    merged: boolean;
    conflicts: string[];
  };
}

export async function bridgeGitCherryPick(
  bridge: RuntimeClient,
  args: { workspaceId: string; sha: string },
): Promise<{ conflicts: string[] }> {
  return (await workspaceOp(bridge, "git.cherryPick", { ...args })) as {
    conflicts: string[];
  };
}

export async function bridgeGitRevert(
  bridge: RuntimeClient,
  args: { workspaceId: string; sha: string },
): Promise<{ conflicts: string[] }> {
  return (await workspaceOp(bridge, "git.revert", { ...args })) as {
    conflicts: string[];
  };
}

export async function bridgeGitContinue(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{ conflicts: string[]; kind: string }> {
  return (await workspaceOp(bridge, "git.continue", { workspaceId })) as {
    conflicts: string[];
    kind: string;
  };
}

export async function bridgeGitAbort(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{ kind: string }> {
  return (await workspaceOp(bridge, "git.abort", { workspaceId })) as {
    kind: string;
  };
}

export async function bridgeGitStashApply(
  bridge: RuntimeClient,
  args: { workspaceId: string; stashRef: string },
): Promise<{ conflicts: string[] }> {
  return (await workspaceOp(bridge, "git.stashApply", { ...args })) as {
    conflicts: string[];
  };
}

export async function bridgeGitStashDrop(
  bridge: RuntimeClient,
  args: { workspaceId: string; stashRef: string },
): Promise<void> {
  await workspaceOp(bridge, "git.stashDrop", { ...args });
}

export async function bridgeGitDeleteBranch(
  bridge: RuntimeClient,
  args: { workspaceId: string; branchName: string; force?: boolean },
): Promise<void> {
  await workspaceOp(bridge, "git.deleteBranch", { ...args });
}

export async function bridgeGitStageHunk(
  bridge: RuntimeClient,
  args: { workspaceId: string; patch: string },
): Promise<void> {
  await workspaceOp(bridge, "git.stageHunk", { ...args });
}

export async function bridgeGitUnstageHunk(
  bridge: RuntimeClient,
  args: { workspaceId: string; patch: string },
): Promise<void> {
  await workspaceOp(bridge, "git.unstageHunk", { ...args });
}

export async function bridgeGitDiscardHunk(
  bridge: RuntimeClient,
  args: { workspaceId: string; patch: string },
): Promise<void> {
  await workspaceOp(bridge, "git.discardHunk", { ...args });
}

export async function bridgeGitTagCreate(
  bridge: RuntimeClient,
  args: { workspaceId: string; name: string; ref?: string; message?: string },
): Promise<void> {
  await workspaceOp(bridge, "git.tagCreate", { ...args });
}

export async function bridgeGitTagList(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<string[]> {
  return (await workspaceOp(bridge, "git.tagList", {
    workspaceId,
  })) as string[];
}

export async function bridgeGitTagDelete(
  bridge: RuntimeClient,
  args: { workspaceId: string; name: string },
): Promise<void> {
  await workspaceOp(bridge, "git.tagDelete", { ...args });
}

export async function bridgeGitListAllBranches(
  bridge: RuntimeClient,
  args: { repoSlug: string; repoRoot: string },
): Promise<Branch[]> {
  return (await workspaceOp(bridge, "git.listAllBranches", {
    ...args,
  })) as Branch[];
}

export async function bridgeGitRepoBranchCatalog(
  bridge: RuntimeClient,
  args: { repoRoot: string; remote?: string; fetch?: boolean },
): Promise<RepoBranchCatalog> {
  // Freshening can spend the default budget on fetch plus the bounded HEAD probe.
  return (await workspaceOp(
    bridge,
    "git.repoBranchCatalog",
    { ...args },
    args.fetch ? 20_000 : undefined,
  )) as RepoBranchCatalog;
}

export async function bridgeWorkspaceGet(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<Workspace> {
  return (await workspaceOp(bridge, "workspace.get", {
    workspaceId,
  })) as Workspace;
}

export async function bridgeWorkspaceLifecycleStatus(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{
  active: boolean;
  operation: "create" | "archive" | "restore" | "delete" | null;
  phase: string | null;
  startedAt: number | null;
}> {
  return (await workspaceOp(bridge, "workspace.lifecycleStatus", {
    workspaceId,
  })) as {
    active: boolean;
    operation: "create" | "archive" | "restore" | "delete" | null;
    phase: string | null;
    startedAt: number | null;
  };
}

export async function bridgeWorkspaceCreateFromBranchStatus(
  bridge: RuntimeClient,
  args: {
    repoRoot: string;
    repoSlug: string;
    branchName: string;
  },
): Promise<{
  active: boolean;
  operation: "create" | "archive" | "restore" | "delete" | null;
  phase: string | null;
  startedAt: number | null;
  workspace: Workspace | null;
}> {
  return (await workspaceOp(bridge, "workspace.createFromBranchStatus", {
    ...args,
  })) as {
    active: boolean;
    operation: "create" | "archive" | "restore" | "delete" | null;
    phase: string | null;
    startedAt: number | null;
    workspace: Workspace | null;
  };
}

export async function bridgeWorkspaceDelete(
  bridge: RuntimeClient,
  args: { workspaceId: string; includeBranch: boolean },
): Promise<void> {
  // Allow extra time for process and worktree cleanup; repository removal may proceed after a client timeout.
  await workspaceOp(bridge, "workspace.delete", { ...args }, 60_000);
}

export async function bridgeWorkspaceSetStatus(
  bridge: RuntimeClient,
  args: { workspaceId: string; status: string },
): Promise<void> {
  await workspaceOp(bridge, "workspace.setStatus", { ...args });
}

export async function bridgeWorkspaceReassignLocalOrganization(
  bridge: RuntimeClient,
  args: { fromOrganizationId: string; toOrganizationId: string | null },
): Promise<{ changes: number; repoSlugs: string[] }> {
  return (await workspaceOp(
    bridge,
    "workspace.reassignLocalOrganization",
    args,
  )) as { changes: number; repoSlugs: string[] };
}

/** Frame records may say a frame shows nothing, or report text beside an
 * instance host's children, only to a renderer that asks. */
export function showsNothingParam(bridge: RuntimeClient, workspaceId: unknown) {
  if (typeof workspaceId !== "string" || isCloudWorkspace(workspaceId)) return {};
  return {
    ...(bridge.supportsEngineCapability?.(DESIGN_OPTIONS_SHOW_NOTHING_CAPABILITY, workspaceId) ? { [DESIGN_OPTIONS_SHOW_NOTHING_PARAM]: true } : {}),
    ...(bridge.supportsEngineCapability?.(DESIGN_INSTANCE_SLOT_TEXT_CAPABILITY, workspaceId) ? { [DESIGN_INSTANCE_SLOT_TEXT_PARAM]: true } : {}),
  };
}

export async function bridgeWorkspaceSetMode(
  bridge: RuntimeClient,
  args: { workspaceId: string; mode: "code" | "design" },
): Promise<{
  ok: true;
  mode: "code" | "design";
  snapshot?: unknown;
}> {
  // Allow time for uncommitted Design initialization or legacy sparse checkout materialization.
  return (await workspaceOp(
    bridge,
    "workspace.setMode",
    { ...args, ...showsNothingParam(bridge, args.workspaceId) },
    60_000,
  )) as {
    ok: true;
    mode: "code" | "design";
    snapshot?: unknown;
  };
}

export async function bridgeWorkspaceArchive(
  bridge: RuntimeClient,
  args: { workspaceId: string; stashUncommitted?: boolean },
): Promise<{
  archivedAt: number;
  stashRef: string | null;
  workspace?: Workspace;
}> {
  // Archive scripts and worktree removal need the same lifecycle budget as creation.
  return (await workspaceOp(
    bridge,
    "workspace.archive",
    { ...args },
    60_000,
  )) as {
    archivedAt: number;
    stashRef: string | null;
    workspace?: Workspace;
  };
}

export async function bridgeWorkspaceContinueOnNewBranch(
  bridge: RuntimeClient,
  args: { workspaceId: string; baseBranch?: string; mergedSha?: string },
): Promise<{ branch: string; conflicts?: string[] }> {
  // Allow the bounded remote fetch to settle; legacy engines omit the carried-edit conflicts.
  return (await workspaceOp(
    bridge,
    "workspace.continueOnNewBranch",
    { ...args },
    60_000,
  )) as { branch: string; conflicts?: string[] };
}

export async function bridgeWorkspaceRestore(
  bridge: RuntimeClient,
  args: { workspaceId: string },
): Promise<{
  restoredAt: number;
  conflicts: string[];
  path: string;
  branch: string;
  adaptations: string[];
  workspace?: Workspace;
}> {
  // Restore applies its checkpoint or legacy stash after recreating the checkout, so use the create budget.
  return (await workspaceOp(
    bridge,
    "workspace.restore",
    { ...args },
    60_000,
  )) as {
    restoredAt: number;
    conflicts: string[];
    path: string;
    branch: string;
    adaptations: string[];
    workspace?: Workspace;
  };
}

export async function bridgeWorkspaceRecover(
  bridge: RuntimeClient,
  args: { workspaceId: string },
): Promise<Awaited<ReturnType<typeof bridgeWorkspaceRestore>>> {
  return (await workspaceOp(
    bridge,
    "workspace.recover",
    { ...args },
    60_000,
  )) as Awaited<ReturnType<typeof bridgeWorkspaceRestore>>;
}

export async function bridgeWorkspaceRecoveryInfo(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<WorkspaceRecoveryInfo> {
  return (await workspaceOp(bridge, "workspace.recoveryInfo", {
    workspaceId,
  })) as WorkspaceRecoveryInfo;
}

export async function bridgeWorkspaceLocate(
  bridge: RuntimeClient,
  args: { workspaceId: string; path: string },
): Promise<Awaited<ReturnType<typeof bridgeWorkspaceRestore>>> {
  return (await workspaceOp(bridge, "workspace.locate", { ...args }, 60_000)) as
    Awaited<ReturnType<typeof bridgeWorkspaceRestore>>;
}

export async function bridgeWorkspaceDeleteSnapshot(
  bridge: RuntimeClient,
  args: { workspaceId: string; archiveSnapshot: string; archivedAt: number },
): Promise<Workspace> {
  return (await workspaceOp(
    bridge,
    "workspace.deleteSnapshot",
    { ...args },
    60_000,
  )) as Workspace;
}

export async function bridgeWorkspaceCreateFromBranch(
  bridge: RuntimeClient,
  args: {
    repoRoot: string;
    repoSlug?: string;
    organizationId: string | null;
    branchName: string;
    sourceTool?: DetectedTool;
    /** Attach an existing PR (opening a PR by its head branch). */
    prNumber?: number;
    prUrl?: string | null;
  },
): Promise<CreatedWorkspace> {
  // Use the create budget for remote-only refs so the engine's bounded fetch fails first.
  return (await workspaceOp(
    bridge,
    "workspace.createFromBranch",
    { ...args },
    60_000,
  )) as CreatedWorkspace;
}

export async function bridgeWorkspaceAdoptExisting(
  bridge: RuntimeClient,
  args: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
    repoSlug?: string;
    organizationId: string | null;
    sourceTool?: DetectedTool;
  },
): Promise<CreatedWorkspace> {
  return (await workspaceOp(bridge, "workspace.adoptExisting", {
    ...args,
  })) as CreatedWorkspace;
}

/** Synthetic trunk workspaces need repoRoot; statusOnly skips command resolution and log, whereas omitLog retains real hasCommand and state. */
export async function bridgeWorkspaceSetupInfo(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    repoRoot?: string;
    statusOnly?: boolean;
    omitLog?: boolean;
  },
): Promise<{
  hasCommand: boolean;
  command: string | null;
  state: "running" | "passed" | "failed" | "stopped" | null;
  log: string;
  truncated: boolean;
}> {
  return (await workspaceOp(bridge, "workspace.setupInfo", {
    ...args,
  })) as {
    hasCommand: boolean;
    command: string | null;
    state: "running" | "passed" | "failed" | "stopped" | null;
    log: string;
    truncated: boolean;
  };
}

/** Synthetic trunk workspaces pass repoRoot because they have no engine workspace row. */
export async function bridgeWorkspaceRerunSetup(
  bridge: RuntimeClient,
  args: { workspaceId: string; repoRoot?: string },
): Promise<{ ok: boolean; hasCommand: boolean }> {
  return (await workspaceOp(bridge, "workspace.rerunSetup", {
    ...args,
  })) as { ok: boolean; hasCommand: boolean };
}

/** Stop a live setup run — records "stopped", not "failed" (Setup tab). */
export async function bridgeWorkspaceStopSetup(
  bridge: RuntimeClient,
  args: { workspaceId: string; repoRoot?: string },
): Promise<{ ok: boolean }> {
  return (await workspaceOp(bridge, "workspace.stopSetup", {
    ...args,
  })) as { ok: boolean };
}

export interface RunActionStatusWire {
  state: "running" | "finished" | "failed" | "stopped";
  /** Backed by a live in-memory run (vs a durable last-run row). */
  live: boolean;
  oneShot: boolean;
  startedAt: number | null;
  endedAt: number | null;
}

/** Per-action run statuses (live + durable last-run), keyed by actionId. The
 *  caller passes the deterministic per-action session ids it computed
 *  (runSessionId); the trunk passes `repoRoot` like the setup ops. */
export async function bridgeWorkspaceRunInfo(
  bridge: RuntimeClient,
  args: { workspaceId: string; repoRoot?: string; sessionIds: string[] },
): Promise<{ actions: Record<string, RunActionStatusWire> }> {
  return (await workspaceOp(bridge, "workspace.runInfo", {
    ...args,
  })) as { actions: Record<string, RunActionStatusWire> };
}

/** Cancelled means Stop or archive won during env resolution; no PTY exists to open. */
export interface RunStartReply {
  ok: boolean;
  hasCommand: boolean;
  alreadyRunning: boolean;
  cancelled?: boolean;
}

/** The engine resolves actionId to its configured command; the client must not send command text. */
export async function bridgeWorkspaceStartRun(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    repoRoot?: string;
    actionId: string;
    sessionId: string;
  },
): Promise<RunStartReply> {
  return (await workspaceOp(bridge, "workspace.startRun", {
    ...args,
  })) as RunStartReply;
}

/** Stop a live run action — records "stopped", not "failed". */
export async function bridgeWorkspaceStopRun(
  bridge: RuntimeClient,
  args: { workspaceId: string; sessionId: string },
): Promise<{ ok: boolean }> {
  return (await workspaceOp(bridge, "workspace.stopRun", {
    ...args,
  })) as { ok: boolean };
}

/** Replay buffered output when a fast exit removes the live mirror before the terminal mounts. */
export async function bridgeWorkspaceRunLog(
  bridge: RuntimeClient,
  args: { workspaceId?: string; sessionId: string },
): Promise<{ log: string; truncated: boolean }> {
  return (await workspaceOp(bridge, "workspace.runLog", {
    ...args,
  })) as { log: string; truncated: boolean };
}

export async function bridgeWorkspaceProposeBranchName(
  bridge: RuntimeClient,
  args: { workspaceId: string; prompt: string; force?: boolean },
): Promise<{
  renamed: boolean;
  branch: string;
  reason?: "already-renamed" | "no-keywords" | "validation-failed";
}> {
  return (await workspaceOp(bridge, "workspace.proposeBranchName", {
    ...args,
  })) as {
    renamed: boolean;
    branch: string;
    reason?: "already-renamed" | "no-keywords" | "validation-failed";
  };
}

export async function bridgeDetachStart(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<{ startedAt: number; checkpointSha: string; rootHead: string }> {
  return (await workspaceOp(bridge, "detach.start", { workspaceId })) as {
    startedAt: number;
    checkpointSha: string;
    rootHead: string;
  };
}

export async function bridgeDetachStop(
  bridge: RuntimeClient,
): Promise<{ stoppedAt: number; restoredHead: string }> {
  return (await workspaceOp(bridge, "detach.stop")) as {
    stoppedAt: number;
    restoredHead: string;
  };
}

export async function bridgeDetachStatus(bridge: RuntimeClient): Promise<{
  active: boolean;
  workspaceId?: string;
  startedAt?: number;
  checkpointSha?: string | null;
  heldByOtherPid?: number;
}> {
  return (await workspaceOp(bridge, "detach.status")) as {
    active: boolean;
    workspaceId?: string;
    startedAt?: number;
    checkpointSha?: string | null;
    heldByOtherPid?: number;
  };
}

// Resolve includes provenance; the engine masks secret-shaped environment values for remote clients.

export type SettingsLayer =
  | "user"
  | "managed"
  | "repo"
  | "repo-local"
  | "workspace-local";
export type SettingsDoc = Record<string, unknown>;

export interface ResolvedSettingsWire {
  effective: SettingsDoc;
  // Mirrors the engine's SettingsLayerName (engine/settings/schema.ts); unlike
  // SettingsLayer it includes `team` and `default`.
  sources: Record<
    string,
    | "default"
    | "user"
    | "team"
    | "repo"
    | "repo-local"
    | "workspace-local"
    | "managed"
  >;
  warnings: string[];
}

export interface SettingsReadWire {
  layer: SettingsLayer;
  path: string;
  doc: SettingsDoc;
  exists: boolean;
  error?: string;
  /** Raw TOML stays on desktop because it can carry unmasked secret-shaped values. */
  text?: string;
}

export interface SettingsWriteWire {
  layer: SettingsLayer;
  path: string;
  doc: SettingsDoc;
  warnings: string[];
}

export async function bridgeSettingsResolve(
  bridge: RuntimeClient,
  repoRoot?: string,
  /** When resolving a worktree's settings (per-workspace view): repo-local
   *  comes from this main checkout, workspace-local from `repoRoot`. */
  mainRepoRoot?: string,
  /** The organization a user-level view is for; the engine honours it only for its Local client. */
  ownerOrganizationId?: string,
): Promise<ResolvedSettingsWire> {
  return (await workspaceOp(bridge, "settings.resolve", {
    ...(repoRoot ? { repoRoot } : {}),
    ...(mainRepoRoot ? { mainRepoRoot } : {}),
    ...(ownerOrganizationId ? { ownerOrganizationId } : {}),
  })) as ResolvedSettingsWire;
}

export async function bridgeSettingsRead(
  bridge: RuntimeClient,
  layer: SettingsLayer,
  repoRoot?: string,
): Promise<SettingsReadWire> {
  return (await workspaceOp(bridge, "settings.read", {
    layer,
    ...(repoRoot ? { repoRoot } : {}),
  })) as SettingsReadWire;
}

/** Zero positive matches can flag a typo; null means the scan could not attribute matches. */
export interface FilesToCopyPatternWire {
  raw: string;
  pattern: string;
  negate: boolean;
  line: number;
  matchCount: number | null;
}

export interface FilesToCopyFileWire {
  path: string;
  bytes: number;
  /** False → untracked but NOT gitignored: it is still copied (the user named
   *  it), but it lands in the new workspace's Changes tab. */
  ignored: boolean;
}

/** One tick-box row: something git ignores here, whether or not the current
 *  patterns select it. Directory-collapsed, so `node_modules/` is ONE row. */
export interface FilesToCopyCandidateWire {
  path: string;
  isDir: boolean;
  /** `-1` for a directory — its size is deliberately not walked. */
  bytes: number;
}

export interface FilesToCopyPreviewWire {
  source: "worktreeinclude" | "file_include_globs" | "default";
  /** Resolved provenance may be team or default, not just a writable file layer. */
  sourceLayer?: SettingsLayer | "team" | "default";
  /** Absolute path of the repo's `.worktreeinclude`, when that source won. */
  sourcePath?: string;
  /** Its raw text, shown read-only instead of an empty editable box. */
  sourceText?: string;
  /** The folder files are copied FROM. */
  rootPath: string;
  patterns: FilesToCopyPatternWire[];
  files: FilesToCopyFileWire[];
  totalCount: number;
  /** Bytes across `files` only — a lower bound once `truncated`. */
  totalBytes: number;
  /** True when `files` was cut to the display cap; `totalCount` is the real
   *  number. */
  truncated: boolean;
  /** Matched but already tracked — `git worktree add` puts these in the
   *  workspace anyway, so copying is a no-op. */
  trackedMatches: string[];
  /** The tick-box universe: every ignored entry in the checkout, independent of
   *  the current patterns. Without it the pane could only ever show what is
   *  already selected, so nothing new would be discoverable. */
  candidates: FilesToCopyCandidateWire[];
  warnings: string[];
  /** An incomplete scan cannot confirm that zero files match. */
  complete: boolean;
}

/** An explicit empty patterns array previews a cleared draft rather than reusing saved patterns. */
export async function bridgeFilesToCopyPreview(
  bridge: RuntimeClient,
  repoRoot: string,
  opts: { mainRepoRoot?: string; patterns?: string[] } = {},
): Promise<FilesToCopyPreviewWire> {
  return (await workspaceOp(
    bridge,
    "filesToCopy.preview",
    {
      repoRoot,
      ...(opts.mainRepoRoot ? { mainRepoRoot: opts.mainRepoRoot } : {}),
      ...(opts.patterns ? { patterns: opts.patterns } : {}),
    },
    // The 15s engine scan budget excludes stats and serialization; renderer timeout must be longer.
    LOCAL_GIT_TIMEOUT_MS,
  )) as FilesToCopyPreviewWire;
}

/** One server discovered in another tool's native MCP config. Mirrors the
 *  engine McpServerRegistration union. */
export type DiscoveredMcpServerWire =
  | {
      name: string;
      transport: "stdio";
      command: string;
      cwd?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      oauth?: { clientId?: string; scopes?: string[]; requiresClientSecret?: boolean };
    };

export interface DiscoveredMcpSourceWire {
  source: string;
  label: string;
  path: string;
  exists: boolean;
  servers: DiscoveredMcpServerWire[];
  warning?: string;
}

/** Scanning home MCP configs is host-local: remote calls fail; a reply without sources reads as empty. */
export async function bridgeMcpScanNative(
  bridge: RuntimeClient,
  repoRoots: string[] = [],
): Promise<DiscoveredMcpSourceWire[]> {
  const res = (await workspaceOp(bridge, "mcp.scanNative", { repoRoots })) as {
    sources?: DiscoveredMcpSourceWire[];
  };
  return res.sources ?? [];
}

export interface ComposedMcpServerWire {
  name: string;
  transport: "stdio" | "http" | "sse";
  url?: string;
  command?: string;
  cwd?: string;
  args?: string[];
  source: string;
  /** Gateway-managed (oauth/header) vs directly injected (undefined). */
  auth?: "oauth" | "header";
  oauth_client_id?: string;
  oauth_scopes?: string[];
}

/** The host-local registry merges user and managed settings only; repo layers no longer supply MCP. */
export async function bridgeMcpResolveComposed(
  bridge: RuntimeClient,
): Promise<ComposedMcpServerWire[]> {
  const r = (await workspaceOp(bridge, "mcp.resolveComposed", {})) as {
    servers?: ComposedMcpServerWire[];
  };
  return r.servers ?? [];
}

export interface GatewayBackendStatusWire {
  name: string;
  url: string;
  state: "connected" | "needs-auth" | "error";
  toolCount: number;
  /** Pre-filter tool names are needed so users can re-enable excluded tools. */
  tools?: string[];
  detail?: string;
}
export interface McpGatewayStatusWire {
  running: boolean;
  /** Expose gateway failure so a backend needing OAuth cannot silently disappear. */
  error: string | null;
  servers: GatewayBackendStatusWire[];
}

/** Per-backend gateway status (connected / needs-auth / error + tool count).
 * Host-local; returns a not-running result when unavailable. */
export async function bridgeMcpGatewayStatus(
  bridge: RuntimeClient,
  repoRoot?: string,
): Promise<McpGatewayStatusWire> {
  const r = (await workspaceOp(
    bridge,
    "mcp.gateway.status",
    { ...(repoRoot ? { repoRoot } : {}) },
    120_000,
  )) as Partial<McpGatewayStatusWire>;
  return {
    running: r.running ?? false,
    error: r.error ?? null,
    servers: r.servers ?? [],
  };
}

/** Start the interactive OAuth sign-in for a gateway backend (opens the system
 *  browser). */
export async function bridgeMcpGatewayAuthorize(
  bridge: RuntimeClient,
  server: string,
  repoRoot?: string,
): Promise<GatewayBackendStatusWire> {
  const r = (await workspaceOp(bridge, "mcp.gateway.authorize", {
    server, ...(repoRoot ? { repoRoot } : {}),
  }, 330_000)) as {
    status: GatewayBackendStatusWire;
  };
  return r.status;
}

/** Forget a gateway backend's tokens (Disconnect → back to needs-auth). */
export async function bridgeMcpGatewayDisconnect(
  bridge: RuntimeClient,
  server: string,
  repoRoot?: string,
): Promise<void> {
  await workspaceOp(bridge, "mcp.gateway.disconnect", { server, ...(repoRoot ? { repoRoot } : {}) });
}

export async function bridgeMcpGatewayCancelAuth(bridge: RuntimeClient, server: string, repoRoot?: string): Promise<void> {
  await workspaceOp(bridge, "mcp.gateway.cancelAuth", { server, ...(repoRoot ? { repoRoot } : {}) });
}
export async function bridgeMcpGatewayReconnect(bridge: RuntimeClient, repoRoot?: string): Promise<void> {
  await workspaceOp(bridge, "mcp.gateway.reconnect", { ...(repoRoot ? { repoRoot } : {}) }, 120_000);
}
export async function bridgeMcpGatewaySetOAuthSecret(bridge: RuntimeClient, url: string, clientId: string, value: string): Promise<void> {
  await workspaceOp(bridge, "mcp.gateway.setOAuthSecret", { url, clientId, value });
}
export async function bridgeMcpValidateWorkingDirectory(bridge: RuntimeClient, directory: string, workspace?: string): Promise<void> {
  await workspaceOp(bridge, "mcp.validateWorkingDirectory", { directory, ...(workspace ? { workspace } : {}) });
}

/** The auth-header secret crosses the authenticated bridge once and stays in the engine vault, never renderer storage or TOML. */
export async function bridgeMcpGatewaySetHeaderSecret(
  bridge: RuntimeClient,
  url: string,
  headerName: string,
  value: string,
): Promise<void> {
  await workspaceOp(bridge, "mcp.gateway.setHeaderSecret", {
    url,
    headerName,
    value,
  });
}

/** Headless authorization returns the URL without opening a browser. */
export async function bridgeMcpGatewayBeginAuth(
  bridge: RuntimeClient,
  server: string,
  repoRoot?: string,
): Promise<string> {
  const r = (await workspaceOp(bridge, "mcp.gateway.beginAuth", {
    server, ...(repoRoot ? { repoRoot } : {}),
  }, 60_000)) as {
    authorizationUrl?: string;
  };
  if (!r.authorizationUrl) throw new Error("no authorization URL returned");
  return r.authorizationUrl;
}

/** Headless completion accepts the code or full redirect URL. */
export async function bridgeMcpGatewayCompleteAuth(
  bridge: RuntimeClient,
  server: string,
  code: string,
  repoRoot?: string,
): Promise<GatewayBackendStatusWire> {
  const r = (await workspaceOp(bridge, "mcp.gateway.completeAuth", {
    server, ...(repoRoot ? { repoRoot } : {}),
    code,
  }, 120_000)) as {
    status: GatewayBackendStatusWire;
  };
  return r.status;
}

/** Patch one layer file. Table values deep-merge per key; scalars/arrays
 *  replace; a `null` leaf DELETES that key (falling back to weaker layers). */
export async function bridgeSettingsWrite(
  bridge: RuntimeClient,
  layer: Exclude<SettingsLayer, "managed">,
  patch: SettingsDoc,
  repoRoot?: string,
): Promise<SettingsWriteWire> {
  return (await workspaceOp(bridge, "settings.write", {
    layer,
    patch,
    ...(repoRoot ? { repoRoot } : {}),
  })) as SettingsWriteWire;
}

/** Validate raw TOML and persist it verbatim; remote clients cannot use this editor. */
export async function bridgeSettingsWriteRaw(
  bridge: RuntimeClient,
  layer: Exclude<SettingsLayer, "managed">,
  text: string,
  repoRoot?: string,
): Promise<SettingsWriteWire> {
  return (await workspaceOp(bridge, "settings.writeRaw", {
    layer,
    text,
    ...(repoRoot ? { repoRoot } : {}),
  })) as SettingsWriteWire;
}

export interface SettingsMigrateLegacyResult {
  migratedRepos: string[];
  migratedProviders: string[];
  warnings: string[];
}

/** The Local migration merges beneath existing file values, so a rerun cannot overwrite choices. */
export async function bridgeSettingsMigrateLegacy(
  bridge: RuntimeClient,
  input: {
    repos?: Array<{ repoRoot: string; settings: Record<string, unknown> }>;
    providers?: Record<string, Record<string, unknown>>;
  },
): Promise<SettingsMigrateLegacyResult> {
  return (await workspaceOp(
    bridge,
    "settings.migrateLegacy",
    input,
    20_000,
  )) as SettingsMigrateLegacyResult;
}
