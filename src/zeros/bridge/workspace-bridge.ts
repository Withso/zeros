// ──────────────────────────────────────────────────────────
// workspace-bridge — renderer-side Remote Workspace API client
// ──────────────────────────────────────────────────────────
//
// The engine's Remote Workspace API (Phase 5) is reached with a single
// WORKSPACE_REQUEST { op, params } → WORKSPACE_RESPONSE { result } RPC pair,
// correlated by requestId (RuntimeClient.request handles that). On the WEB
// build this rides the relay; on desktop it would ride the local socket — but
// the desktop renderer uses the native IPC façade (native/git.ts) instead, so
// in practice this client is the WEB path, where native workspaceList() returns
// [] (no bridge to the host).
//
// Implements the FULL Remote Workspace surface over the bridge: workspace
// list/create, file tree/read, the git suite, GitHub PR ops, and chat /
// message / project history — every op the web client drives over the relay.
// ──────────────────────────────────────────────────────────

import type { RuntimeClient } from "./ws-client";
import type { BridgeMessage } from "./messages";
import type {
  Workspace,
  StatusResult,
  ChangeCounts,
  ChangeLineCounts,
  Hunk,
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
} from "../../native/git";
import type { ReadFileResult, WriteFileResult } from "../../native/files";
import type {
  TurnInfo,
  TurnResetResult,
  TurnUndoResult,
  TurnResetMode,
} from "../../native/turns";
import type { Project } from "../store/projects-store";
import type {
  ChatRowWire,
  PersistedMessageWire,
  ChatSummaryWire,
} from "../agent/agent-history-client";
import { trackGitOp } from "../analytics/agent-events";

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
  /** The engine attaches a remediation hint on structured GitErrors
   *  (index.ts WORKSPACE_ERROR envelope). It was previously dropped here —
   *  preserve it so the renderer can show actionable guidance. */
  remediation?: string;
}

/** Error thrown for a WORKSPACE_ERROR. Carries the engine's `code` and
 *  `remediation` (not just `message`) so the renderer's `isGitErrorShape()`
 *  matches (it keys on a string `code`) and `humanError()` can render the
 *  remediation hint. Previously `workspaceOp` threw a bare `Error`, so every
 *  git/GitHub error reached the UI as a message-only string with no `code` and
 *  no remediation — defeating all the engine's structured error UX. */
class WorkspaceOpError extends Error {
  readonly code: string;
  readonly remediation?: string;
  constructor(resp: WorkspaceErrorLike) {
    super(resp.message || `workspace op '${resp.op}' failed`);
    this.name = "WorkspaceOpError";
    this.code = resp.code;
    if (resp.remediation) this.remediation = resp.remediation;
  }
}

/** Git WRITE ops the UI issues over the bridge → the analytics `git_op` enum.
 *  Recording here (the single op choke point) restores `git_op` coverage that
 *  the removed commit-bar `trackGitOp` calls used to provide — now centrally,
 *  for every UI-issued git write. NOTE: gh.* PR ops are intentionally excluded
 *  (review-tab tracks `pr_create` directly — avoid double-counting), and
 *  agent-shell commits bypass the bridge entirely (the engine has no analytics
 *  client), so those remain out of scope here. */
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

/** Budget for NETWORK-BOUND git/GitHub writes (push / pull / fetch / rebase,
 *  PR create / mark-ready / merge). The 10s `workspaceOp` default is tuned for
 *  local DB reads; a slow remote or the GitHub merge API routinely exceeds it,
 *  so "Merge PR" used to reject with "Request timeout" → "Couldn't merge PR"
 *  even though GitHub completed the merge. If the op outlives even this budget
 *  the result still lands: these ops are in the engine's LONG_LIFECYCLE_OPS
 *  (src/engine/workspace/change-events.ts), so the completion DB_CHANGED
 *  broadcast includes the originator and the stale card self-heals. */
const NETWORK_GIT_TIMEOUT_MS = 60_000;

/** Budget for LOCAL-ONLY index writes (stage / commit). No network, but a huge
 *  working tree or hook-heavy repo can outlive the 10s default. */
const LOCAL_GIT_TIMEOUT_MS = 30_000;

/** Send a WORKSPACE_REQUEST and await its WORKSPACE_RESPONSE / WORKSPACE_ERROR
 *  (both echo requestId, so request() resolves on whichever arrives). Throws on
 *  a WORKSPACE_ERROR. */
async function workspaceOp(
  bridge: RuntimeClient,
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const tracked = GIT_OP_ANALYTICS[op];
  const resp = (await bridge.request(
    { type: "WORKSPACE_REQUEST", op, params } as Partial<BridgeMessage> & {
      type: string;
    },
    timeoutMs,
  )) as WorkspaceResponseLike | WorkspaceErrorLike;
  if (resp.type === "WORKSPACE_ERROR") {
    const err = new WorkspaceOpError(resp);
    if (tracked) trackGitOp({ op: tracked, outcome: "error", error: err });
    throw err;
  }
  if (tracked) trackGitOp({ op: tracked, outcome: "ok" });
  return resp.result;
}

// ── Turns (v13: footer / per-turn changes / reset) ──────────

export async function bridgeTurnsList(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<TurnInfo[]> {
  const r = (await workspaceOp(bridge, "turns.list", { workspaceId })) as
    | { turns?: TurnInfo[] }
    | undefined;
  return r?.turns ?? [];
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

/** Courier the active team's settings doc into the engine's in-memory team
 *  slot (O4). LOCAL-ONLY on the engine side — the op rejects remote callers
 *  so a paired device can't plant settings on this machine. */
export async function bridgeTeamSetContext(
  bridge: RuntimeClient,
  args: {
    teamId: string | null;
    doc: Record<string, unknown> | null;
  },
): Promise<void> {
  await workspaceOp(bridge, "team.setContext", args);
}

/** List the engine's workspaces over the bridge (works on the web build where
 *  the native IPC façade can't). Returns the engine's `{ workspaces }` payload,
 *  including the synthetic `local-main` primary-checkout entry. */
export async function requestWorkspaceList(
  bridge: RuntimeClient,
): Promise<Workspace[]> {
  const result = (await workspaceOp(bridge, "workspace.list")) as
    | { workspaces?: Workspace[] }
    | undefined;
  return result?.workspaces ?? [];
}

/** Like requestWorkspaceList but forwards the desktop's `{status, repoSlug}`
 *  filter. The engine PREPENDS the synthetic `local-main` entry (web needs it),
 *  which the desktop façade strips — see native/git.ts workspaceList(). */
export async function bridgeWorkspaceList(
  bridge: RuntimeClient,
  args: {
    status?: string;
    repoSlug?: string;
    archived?: boolean;
    withChanges?: boolean;
  } = {},
): Promise<Workspace[]> {
  const result = (await workspaceOp(bridge, "workspace.list", { ...args })) as
    | { workspaces?: Workspace[] }
    | undefined;
  return result?.workspaces ?? [];
}

/** List the engine's projects (Column 1 repos) over the bridge — the web
 *  build's source of truth (localStorage projects are empty in a browser).
 *  The engine seeds these from its known workspaces. */
export async function requestProjectList(
  bridge: RuntimeClient,
): Promise<Project[]> {
  const result = (await workspaceOp(bridge, "project.list")) as
    | { projects?: Project[] }
    | undefined;
  return result?.projects ?? [];
}

// ── Projects (write-through; Phase 1b) ──────────────────────
// Keyed on repoRoot. Desktop pushes its curated projects so the engine — and
// therefore web/mobile — sees repos that have no worktree yet. Host-approved
// for remote clients (WRITE_OPS); a local desktop client runs without a prompt.

interface ProjectPush {
  repoRoot: string;
  repoSlug?: string;
  name?: string;
  originUrl?: string | null;
}

export async function bridgeProjectUpsert(
  bridge: RuntimeClient,
  p: ProjectPush,
): Promise<void> {
  await workspaceOp(bridge, "project.upsert", { ...p });
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

// ── Remote-access restriction (per-workspace opt-out) ──────
// LOCAL-ONLY ops (off the engine's remote allowlist): the desktop owner decides
// what a paired device may see. Default is share-all (remote == local); adding a
// workspace here hides it — and its chats — from every relay client.

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

// ── Host folder picker (browse to open a project remotely) ──

export interface HostDirListing {
  /** The directory that was listed (realpath-resolved). */
  path: string;
  /** Parent directory for "up" navigation, or null at the fs root. */
  parent: string | null;
  /** Immediate child directories (dotfolders excluded), name-sorted. */
  entries: { name: string; path: string }[];
}

/** Browse host directories over the bridge so the web/phone can pick a folder
 *  to open as a project. `dirPath` empty → the host home dir. */
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

/** Create a workspace (worktree) over the bridge — the web/phone path for "new
 *  workspace" (the native IPC can't run in a browser). Returns the engine's
 *  created-workspace record (shape mirrors the native workspace_create). */
export async function bridgeWorkspaceCreate(
  bridge: RuntimeClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Create is a heavy op (best-effort fetch + `git worktree add` + file seeds).
  // The slow setup script no longer runs synchronously (it's a background PTY)
  // and the engine bounds its network probes (fetch 8s, ls-remote 5s) and the
  // ignored-file seed scan (8s) — but `git worktree add` itself is a full
  // checkout whose cost scales with repo size and disk cache. 60s (was 30s,
  // which large repos exceeded in the field): the engine keeps working past a
  // client-side timeout, so an under-budget cap doesn't cancel anything — it
  // just shows a spurious "Request timeout: WORKSPACE_REQUEST" and then the
  // workspace "magically" appears when the engine finishes anyway.
  return workspaceOp(bridge, "workspace.create", { ...args }, 60_000);
}

export interface PreparedWorkspaceCreateWire {
  workspaceId: string;
  path: string;
  repoSlug: string;
  branch: string;
}

/** Reserve a workspace identity + final path BEFORE the heavy create runs, so
 *  the desktop can navigate on click. Metadata-only by contract (validation +
 *  naming, no mkdir/checkout), so a disconnected prepare leaks nothing. */
export async function bridgeWorkspacePrepareCreate(
  bridge: RuntimeClient,
  args: { repoRoot: string; repoSlug?: string; prompt?: string },
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
  };
}

// ── Chats (sidebar list; Phase 2a) ──────────────────────────
// The chat list over the bridge — web reads it; desktop write-throughs into it.
// Not host-approved (a chat is the user's own metadata).

export async function bridgeChatList(
  bridge: RuntimeClient,
): Promise<ChatRowWire[]> {
  return (await bridgeChatSnapshot(bridge)).chats;
}

export interface ChatSnapshotWire {
  chats: ChatRowWire[];
  /** Complete engine tombstone set, used to reject stale boot-cache rows. */
  chatDeletions: string[];
}

/** Full chat snapshot plus deletion identities in one engine turn. */
export async function bridgeChatSnapshot(
  bridge: RuntimeClient,
): Promise<ChatSnapshotWire> {
  const r = (await workspaceOp(bridge, "chats.list")) as
    | { chats?: ChatRowWire[]; chatDeletions?: unknown }
    | undefined;
  return {
    chats: Array.isArray(r?.chats) ? r.chats : [],
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
  await workspaceOp(bridge, "chats.delete", { id });
}

export async function bridgeChatBulkUpsert(
  bridge: RuntimeClient,
  chats: ChatRowWire[],
): Promise<void> {
  await workspaceOp(bridge, "chats.bulkUpsert", { chats });
}

/** Prior chats in a folder with a summary (first user message) — the empty-
 *  composer handoff picker, served from the engine (Phase 2c). */
export async function bridgeChatSummaries(
  bridge: RuntimeClient,
  folder: string,
  excludeChatId?: string,
): Promise<ChatSummaryWire[]> {
  const r = (await workspaceOp(bridge, "chats.summariesForFolder", {
    folder,
    ...(excludeChatId ? { excludeChatId } : {}),
  })) as { summaries?: ChatSummaryWire[] } | undefined;
  return r?.summaries ?? [];
}

// ── Incremental delta sync (Phase 3, real pull) ─────────────

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

// ── Transcripts (Phase 2b reads) ────────────────────────────
// The engine persists messages on emit; the web reads windows of them here.

export async function bridgeMessageWindow(
  bridge: RuntimeClient,
  chatId: string,
  limit: number,
  before?: number,
): Promise<PersistedMessageWire[]> {
  const r = (await workspaceOp(bridge, "messages.window", {
    chatId,
    limit,
    ...(before !== undefined ? { before } : {}),
  })) as { messages?: PersistedMessageWire[] } | undefined;
  return r?.messages ?? [];
}

export async function bridgeMessageWindowOlder(
  bridge: RuntimeClient,
  chatId: string,
  limit: number,
  beforeMsgId: string,
): Promise<PersistedMessageWire[]> {
  const r = (await workspaceOp(bridge, "messages.windowOlder", {
    chatId,
    limit,
    beforeMsgId,
  })) as { messages?: PersistedMessageWire[] } | undefined;
  return r?.messages ?? [];
}

/** Wipe a chat's transcript in the engine (reset). */
export async function bridgeMessageClear(
  bridge: RuntimeClient,
  chatId: string,
): Promise<void> {
  await workspaceOp(bridge, "messages.clear", { chatId });
}

/** Delete a message and everything after it in the engine (click-to-edit). */
export async function bridgeMessageTruncateFrom(
  bridge: RuntimeClient,
  chatId: string,
  fromMsgId: string,
): Promise<void> {
  await workspaceOp(bridge, "messages.truncateFrom", { chatId, fromMsgId });
}

/** A full-text search hit (Phase 3). `chatId` lets the UI navigate to the
 *  matching chat; `payload` is the JSON AgentMessage for preview. */
export interface MessageSearchHit {
  chatId: string;
  msgId: string;
  payload: string;
  createdAt: number;
}

/** Phase 3 — cross-chat / cross-agent full-text search over transcripts. */
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

// ── Files (read) ────────────────────────────────────────────

/** Repo-relative file list under a workspace (gitignore-aware). The engine
 *  filters secret paths for remote clients. */
export async function bridgeFileTree(
  bridge: RuntimeClient,
  workspaceId: string,
  limit?: number,
): Promise<string[]> {
  const r = (await workspaceOp(bridge, "file.tree", { workspaceId, limit })) as
    | { files?: string[] }
    | undefined;
  return r?.files ?? [];
}

/** Read one file's content under a workspace (bounded; secret paths refused
 *  for remote clients). */
export async function bridgeFileRead(
  bridge: RuntimeClient,
  workspaceId: string,
  path: string,
): Promise<ReadFileResult> {
  return (await workspaceOp(bridge, "file.read", {
    workspaceId,
    path,
  })) as ReadFileResult;
}

/** Write one file's content under a workspace (bounded; secret paths refused for
 *  remote clients). Mirrors bridgeFileRead. */
export async function bridgeFileWrite(
  bridge: RuntimeClient,
  workspaceId: string,
  path: string,
  content: string,
): Promise<WriteFileResult> {
  return (await workspaceOp(bridge, "file.write", {
    workspaceId,
    path,
    content,
  })) as WriteFileResult;
}

// ── Git (read) ──────────────────────────────────────────────

export async function bridgeGitStatus(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<StatusResult> {
  return (await workspaceOp(bridge, "git.status", {
    workspaceId,
  })) as StatusResult;
}

/** Path-free totals for All / Uncommitted / Staged / Unstaged. The engine
 * computes these from each scope's real comparison and applies remote secret
 * filtering before counting. */
export async function bridgeGitChangeCounts(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<ChangeCounts> {
  return (await workspaceOp(bridge, "git.changeCounts", {
    workspaceId,
  })) as ChangeCounts;
}

/** ± line totals for the All Changes comparison — what the workspace tabs
 * render. Path-free like the file totals above, and filtered engine-side for a
 * remote client before summing. */
export async function bridgeGitChangeLineCounts(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<ChangeLineCounts> {
  const result = (await workspaceOp(bridge, "git.changeLineCounts", {
    workspaceId,
  })) as Partial<ChangeLineCounts> | undefined;
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
  const result = (await workspaceOp(bridge, "git.hasChanges", {
    workspaceId,
  })) as { hasChanges?: boolean } | undefined;
  return result?.hasChanges ?? false;
}

/** Per-file (or whole-tree) diff over the bridge. Supports both the legacy
 *  `against` selector AND the generalized `mode`/`base`/`head` comparison (e.g.
 *  the Changes/Review "All changes" vs a base branch) + `rawPatch`. The engine
 *  assertSafeGitRef-guards mode:'refs' base/head and drops secret files from
 *  BOTH the structured hunks and the raw patch for a remote client. */
export async function bridgeGitDiff(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    filePath?: string;
    against?: "index" | "HEAD" | "main";
    mode?: DiffMode;
    base?: string;
    head?: string;
    rawPatch?: boolean;
  },
): Promise<{ hunks: Hunk[]; patch?: string }> {
  return (await workspaceOp(bridge, "git.diff", {
    workspaceId: args.workspaceId,
    filePath: args.filePath,
    against: args.against,
    mode: args.mode,
    base: args.base,
    head: args.head,
    rawPatch: args.rawPatch,
  })) as { hunks: Hunk[]; patch?: string };
}

/** Show a single commit (its file list + the raw multi-file patch) over the
 *  bridge. Like git.diff, the engine drops secret files (both the `files`
 *  enumeration and the matching sections of the raw `patch`) for remote
 *  clients, failing closed on any file whose path is unparseable or
 *  sensitive on either side. */
export async function bridgeGitShow(
  bridge: RuntimeClient,
  args: { workspaceId: string; sha: string },
): Promise<ShowCommitResult> {
  return (await workspaceOp(bridge, "git.show", {
    workspaceId: args.workspaceId,
    sha: args.sha,
  })) as ShowCommitResult;
}

export async function bridgeGitLog(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    limit?: number;
    since?: number;
    ref?: string;
    base?: string;
  },
): Promise<Commit[]> {
  const r = (await workspaceOp(bridge, "git.log", {
    workspaceId: args.workspaceId,
    limit: args.limit,
    since: args.since,
    ref: args.ref,
    base: args.base,
  })) as { commits?: Commit[] } | undefined;
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

// ── Git (write) ─────────────────────────────────────────────
//
// One helper per engine WRITE op (service.ts WRITE_OPS). Op names + params
// match the engine switch cases EXACTLY. Writes from a remote client are
// host-approved engine-side: workspaceOp() either resolves with the op's
// result or rejects with the WORKSPACE_ERROR message (e.g. APPROVAL_DENIED) —
// the caller handles neither approval nor the host prompt.

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
  args: { workspaceId: string; prune?: boolean; remote?: string },
): Promise<{ summary: string }> {
  return (await workspaceOp(
    bridge,
    "git.fetch",
    {
      workspaceId: args.workspaceId,
      prune: args.prune,
      remote: args.remote,
    },
    NETWORK_GIT_TIMEOUT_MS,
  )) as { summary: string };
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

export async function bridgeGitRenameBranch(
  bridge: RuntimeClient,
  args: { workspaceId: string; newName: string },
): Promise<void> {
  await workspaceOp(bridge, "git.renameBranch", {
    workspaceId: args.workspaceId,
    newName: args.newName,
  });
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

// ── GitHub PR ops ───────────────────────────────────────────
//
// One helper per engine `gh.*` op. The engine resolves the workspaceId →
// owner/repo itself, so reads pass { workspaceId, prNumber } and the writes
// mirror the git-write contract: host-approved engine-side, workspaceOp()
// either resolves with the result or rejects with the WORKSPACE_ERROR message.
// PR metadata is NOT file content, so there is no secret filter on either end.
// Auth-credential mutations (sign-in / set-token / sign-out) are deliberately
// not remoted — there is no helper for them.

// ── GitHub (read) ───────────────────────────────────────────

/** Host's GitHub auth status (takes no workspaceId — probes the host token). */
export async function bridgeGhAuthStatus(
  bridge: RuntimeClient,
): Promise<AuthStatusResult> {
  return (await workspaceOp(bridge, "gh.authStatus")) as AuthStatusResult;
}

export interface GithubRepositoryOwnerAvatar {
  login: string;
  type: "user" | "org" | null;
  avatarUrl: string;
}

/** Best-effort owner avatar for an already-open GitHub checkout. The engine
 *  reads and validates the checkout's origin; callers never send owner/repo. */
export async function bridgeGhRepositoryOwnerAvatar(
  bridge: RuntimeClient,
  repoRoot: string,
): Promise<GithubRepositoryOwnerAvatar | null> {
  return (await workspaceOp(bridge, "gh.repoOwnerAvatar", {
    repoRoot,
  })) as GithubRepositoryOwnerAvatar | null;
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

/** Detect + backfill the workspace's PR from GitHub (for PRs opened outside the
 *  engine — agent `gh pr create`, terminal, github.com). Returns the PR (or null
 *  when there's no open PR / no remote / not authed). */
export async function bridgeGhPrSync(
  bridge: RuntimeClient,
  workspaceId: string,
): Promise<PR | null> {
  return (await workspaceOp(bridge, "gh.prSync", { workspaceId })) as PR | null;
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

// ── GitHub (write) ──────────────────────────────────────────

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

/** Owner login + type for the publish dialog's Owner dropdown. */
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

export async function bridgeGhPrList(
  bridge: RuntimeClient,
  args: {
    owner?: string;
    repo?: string;
    originUrl?: string;
    state?: "open" | "closed" | "all";
  },
): Promise<PR[]> {
  return (await workspaceOp(bridge, "gh.prList", { ...args })) as PR[];
}

// ── Git: extended ops (Phase 2 single-writer reroute) ───────
// Thin pass-throughs to the engine handle() cases added in
// workspace/service.ts. Return shapes mirror src/native/git.ts.

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
  // The fetch (freshen) pass may spend up to ~8s on `git fetch` plus a bounded
  // `ls-remote` HEAD probe — give it headroom over the 10s default budget.
  return (await workspaceOp(
    bridge,
    "git.repoBranchCatalog",
    { ...args },
    args.fetch ? 20_000 : undefined,
  )) as RepoBranchCatalog;
}

// ── Workspace lifecycle (Phase 2 single-writer reroute) ─────

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
  // Delete reaps workspace processes, evicts large ignored directories, and
  // removes the worktree before committing the row deletion. Give it the same
  // lifecycle budget as archive/restore so repository removal does not race
  // ahead merely because the generic 10s bridge timeout elapsed.
  await workspaceOp(bridge, "workspace.delete", { ...args }, 60_000);
}

export async function bridgeWorkspaceSetStatus(
  bridge: RuntimeClient,
  args: { workspaceId: string; status: string },
): Promise<void> {
  await workspaceOp(bridge, "workspace.setStatus", { ...args });
}

export async function bridgeWorkspaceArchive(
  bridge: RuntimeClient,
  args: { workspaceId: string; stashUncommitted?: boolean },
): Promise<{
  archivedAt: number;
  stashRef: string | null;
  workspace?: Workspace;
}> {
  // Archiving checkpoints the tree, runs the repo's archive script, evicts
  // heavy dirs, and removes the worktree — give it the same 60s budget as create
  // rather than the 10s default so a large worktree doesn't surface a timeout.
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
): Promise<{ branch: string }> {
  // Fetching the target is bounded engine-side but can outlive the default
  // request budget on a slow remote, so use the create-class timeout.
  return (await workspaceOp(
    bridge,
    "workspace.continueOnNewBranch",
    { ...args },
    60_000,
  )) as { branch: string };
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
  // Restore recreates the worktree, applies its checkpoint (or legacy stash),
  // and may adapt its branch/path, so it gets the create-class 60s budget too.
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

export async function bridgeWorkspaceCreateFromBranch(
  bridge: RuntimeClient,
  args: {
    repoRoot: string;
    repoSlug?: string;
    branchName: string;
    sourceTool?: DetectedTool;
    /** Attach an existing PR (opening a PR by its head branch). */
    prNumber?: number;
    prUrl?: string | null;
  },
): Promise<CreatedWorkspace> {
  // Opening a remote-only branch (a teammate's PR) fetches it first, so give
  // the op the same generous budget as workspace.create (60s, vs the 10s
  // default) — the engine bounds that fetch itself, so a hung remote fails
  // cleanly server-side instead of surfacing "Request timeout: WORKSPACE_REQUEST".
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
    sourceTool?: DetectedTool;
  },
): Promise<CreatedWorkspace> {
  return (await workspaceOp(bridge, "workspace.adoptExisting", {
    ...args,
  })) as CreatedWorkspace;
}

/** Read a workspace's background-setup output + state (Setup tab). The trunk /
 *  "main" — a synthetic `local:` workspace with no engine row — passes
 *  `repoRoot` so the engine can resolve the repo's setup command anyway.
 *  `statusOnly` skips the log payload + command resolution (the tab-dot
 *  poller); non-state fields come back as placeholders in that mode. */
export async function bridgeWorkspaceSetupInfo(
  bridge: RuntimeClient,
  args: { workspaceId: string; repoRoot?: string; statusOnly?: boolean },
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

/** (Re)run a workspace's setup command in the background (Setup tab). The
 *  trunk passes `repoRoot` (see bridgeWorkspaceSetupInfo). */
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

// ── Run actions (Run tab — the Setup trio, applied to run) ──

/** One run action's status as the engine reports it (RunManager). */
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

/** Start (or focus) a run action. The engine resolves the COMMAND from the
 *  repo settings by actionId and spawns it as the PTY's foreground process —
 *  the client never supplies a command string. */
export async function bridgeWorkspaceStartRun(
  bridge: RuntimeClient,
  args: {
    workspaceId: string;
    repoRoot?: string;
    actionId: string;
    sessionId: string;
  },
): Promise<{ ok: boolean; hasCommand: boolean; alreadyRunning: boolean }> {
  return (await workspaceOp(bridge, "workspace.startRun", {
    ...args,
  })) as { ok: boolean; hasCommand: boolean; alreadyRunning: boolean };
}

/** Stop a live run action — records "stopped", not "failed". */
export async function bridgeWorkspaceStopRun(
  bridge: RuntimeClient,
  args: { sessionId: string },
): Promise<{ ok: boolean }> {
  return (await workspaceOp(bridge, "workspace.stopRun", {
    ...args,
  })) as { ok: boolean };
}

/** One run action's buffered output — the terminal replays this when it mounts
 *  too late to attach to a fast-exiting run PTY (its live mirror is gone). */
export async function bridgeWorkspaceRunLog(
  bridge: RuntimeClient,
  args: { sessionId: string },
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

// ── Detach mode ─────────────────────────────────────────────

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

// ── Settings (TOML layers — engine-owned; settings foundation Phase 1) ──
// Wire shapes mirror src/engine/settings: resolve returns the deep-merged
// effective document plus a dot-path → layer provenance map (what renders
// "Inherited from User"); read/write address ONE layer file. Works for the
// desktop renderer AND the web client (paired devices may read and write;
// secret-shaped env values arrive masked on the web).

export type SettingsLayer =
  | "user"
  | "managed"
  | "repo"
  | "repo-local"
  | "workspace-local";
export type SettingsDoc = Record<string, unknown>;

export interface ResolvedSettingsWire {
  effective: SettingsDoc;
  // Mirrors the engine's SettingsLayerName (engine/settings/schema.ts) — the
  // resolver stamps whichever layer won, INCLUDING the cloud `team` layer,
  // which this union omitted.
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
  /** The raw file text — desktop only (stripped on remote: it carries unmasked
   *  secret-shaped env values). Powers the "Edit settings.toml" raw editor. */
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
): Promise<ResolvedSettingsWire> {
  return (await workspaceOp(bridge, "settings.resolve", {
    ...(repoRoot ? { repoRoot } : {}),
    ...(mainRepoRoot ? { mainRepoRoot } : {}),
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

// ── Files to copy (Settings → Files to copy) ───────────────────────────────

/** One include-list line plus how many files it matches on its own. A
 *  `matchCount` of 0 on a positive line is the typo signal the UI surfaces;
 *  `null` means attribution was skipped or the scan failed. */
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
  /** Settings layer the patterns resolved from — `repo-local` (this project)
   *  vs `user` (all projects) is what the scope control reflects. Widened
   *  beyond SettingsLayer because provenance can also name the non-file
   *  layers (`team`, `default`). */
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
  /** False → the scan was cut short. Say "couldn't check", never "0 files":
   *  zero and unknown are different answers. */
  complete: boolean;
}

/** What a new workspace of `repoRoot` would have copied into it. Pass
 *  `patterns` to preview an UNSAVED draft — including an empty array, which
 *  means "the box is cleared", not "use the saved list". */
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
    // The engine budgets the scan itself at 15s, and the stats + serialization
    // sit on top of that. The 10s default would have the renderer give up
    // BEFORE the engine does, turning a slow-but-successful preview into
    // "Request timeout" while git kept running.
    LOCAL_GIT_TIMEOUT_MS,
  )) as FilesToCopyPreviewWire;
}

// ── MCP adopt-scan (Customize → MCP "Import from other tools") ─────────────

/** One server discovered in another tool's native MCP config. Mirrors the
 *  engine McpServerRegistration union. */
export type DiscoveredMcpServerWire =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface DiscoveredMcpSourceWire {
  source: string;
  label: string;
  path: string;
  exists: boolean;
  servers: DiscoveredMcpServerWire[];
  warning?: string;
}

/** Scan the user's home MCP configs (Cursor / Claude / Codex / Factory) for
 *  servers to adopt. Desktop-only (the op reads home config files); returns an
 *  empty list on web / when the op is unavailable. */
export async function bridgeMcpScanNative(
  bridge: RuntimeClient,
  repoRoots: string[] = [],
): Promise<DiscoveredMcpSourceWire[]> {
  const res = (await workspaceOp(bridge, "mcp.scanNative", { repoRoots })) as {
    sources?: DiscoveredMcpSourceWire[];
  };
  return res.sources ?? [];
}

/** One server in the MERGED MCP registry, tagged with the layer it came from —
 *  for the Customize → MCP source badges + inherited group. */
export interface ComposedMcpServerWire {
  name: string;
  transport: "stdio" | "http";
  url?: string;
  command?: string;
  args?: string[];
  /** The settings layer this server was resolved from. */
  source: string;
  /** Gateway-managed (oauth/header) vs directly injected (undefined). */
  auth?: "oauth" | "header";
}

/** The merged MCP registry (user + managed — repo layers no longer carry MCP)
 *  for the badges + inherited view. Desktop-only; returns [] on web / when
 *  unavailable. */
export async function bridgeMcpResolveComposed(
  bridge: RuntimeClient,
): Promise<ComposedMcpServerWire[]> {
  const r = (await workspaceOp(bridge, "mcp.resolveComposed", {})) as {
    servers?: ComposedMcpServerWire[];
  };
  return r.servers ?? [];
}

// ── MCP gateway (auth:"oauth" backends, "Sign in" / status) ────────────────

export interface GatewayBackendStatusWire {
  name: string;
  url: string;
  state: "connected" | "needs-auth" | "error";
  /** Count of ENABLED tools (after the allowlist filter). */
  toolCount: number;
  /** ALL tool names the backend exposes (pre-filter), for the per-tool checkboxes. */
  tools?: string[];
  detail?: string;
}
export interface McpGatewayStatusWire {
  running: boolean;
  /** Why the gateway isn't running when it should be (e.g. its port is taken) —
   *  shown as "Gateway unavailable" so an OAuth server doesn't silently vanish. */
  error: string | null;
  servers: GatewayBackendStatusWire[];
}

/** Per-backend gateway status (connected / needs-auth / error + tool count).
 *  Desktop-only; returns a not-running result on web / when unavailable. */
export async function bridgeMcpGatewayStatus(
  bridge: RuntimeClient,
): Promise<McpGatewayStatusWire> {
  const r = (await workspaceOp(
    bridge,
    "mcp.gateway.status",
    {},
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
): Promise<GatewayBackendStatusWire> {
  const r = (await workspaceOp(bridge, "mcp.gateway.authorize", {
    server,
  })) as {
    status: GatewayBackendStatusWire;
  };
  return r.status;
}

/** Forget a gateway backend's tokens (Disconnect → back to needs-auth). */
export async function bridgeMcpGatewayDisconnect(
  bridge: RuntimeClient,
  server: string,
): Promise<void> {
  await workspaceOp(bridge, "mcp.gateway.disconnect", { server });
}

/** Store a static auth-header secret for an auth:"header" gateway backend. The
 *  value transits the LOCAL bridge once, then lives engine-only (the gateway
 *  vault + safeStorage) — never settings.toml, the renderer keychain, or the
 *  relay. Desktop-only. */
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

/** Headless sign-in step 1: get the authorization URL for a backend WITHOUT
 *  opening a browser (no-browser / remote environments). */
export async function bridgeMcpGatewayBeginAuth(
  bridge: RuntimeClient,
  server: string,
): Promise<string> {
  const r = (await workspaceOp(bridge, "mcp.gateway.beginAuth", {
    server,
  })) as {
    authorizationUrl?: string;
  };
  if (!r.authorizationUrl) throw new Error("no authorization URL returned");
  return r.authorizationUrl;
}

/** Headless sign-in step 2: finish with the code (or full redirect URL) the user
 *  pasted; resolves with the backend's new status. */
export async function bridgeMcpGatewayCompleteAuth(
  bridge: RuntimeClient,
  server: string,
  code: string,
): Promise<GatewayBackendStatusWire> {
  const r = (await workspaceOp(bridge, "mcp.gateway.completeAuth", {
    server,
    code,
  })) as {
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

/** Write a layer file as RAW TOML (the "Edit settings.toml" editor). Validated
 *  + written verbatim (comments/layout preserved). Desktop-only — rejected for
 *  remote clients. Rejects unparseable TOML (SETTINGS_BAD_TOML). */
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

/** One-time import of the legacy localStorage settings blobs (LOCAL-ONLY op;
 *  the engine merges UNDER existing file values, so re-runs can't clobber). */
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
