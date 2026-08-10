// ──────────────────────────────────────────────────────────
// agent-history-client — chat + transcript access over the bridge
// ──────────────────────────────────────────────────────────
//
// The engine's unified Zeros DB is the single source of truth for chats and
// transcripts. This module is a thin typed shell over workspace-bridge.ts for
// the desktop renderer and optional relay clients.
// The engine persists agent + user messages ON EMIT, so there is no renderer
// write path for transcripts (appendMessages is a vestigial no-op).
//
// Per-client UI state (scroll offsets, plan snapshots, policies) lives in
// device-local.ts, not here. Attachments use the workspace bridge's validated
// context-graph writer, with a native fallback during bridge startup.
// ──────────────────────────────────────────────────────────

import { nativeInvoke } from "../../platform/runtime";
import { notifyContextGraphChanged } from "../../platform/context-graph";
import type { AgentMessage } from "./use-agent-session";
import type {
  ProviderBinding,
  ProviderMetadata,
} from "@zeros/protocol/identities";
import {
  isAgentAttachmentDiskPath,
  readAgentAttachmentFile,
} from "./attachment-file-reader";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "../../platform/bridge/workspace-id-resolver";
import {
  bridgeAttachmentWrite,
  bridgeChatList,
  bridgeChatSnapshot,
  bridgeChatDelete,
  bridgeChatClearProviderIdentity,
  bridgeChatBulkUpsert,
  bridgeMessageWindow,
  bridgeMessageWindowOlder,
  bridgeMessageClear,
  bridgeMessageTruncateFrom,
  bridgeDbHead,
  bridgeDbPull,
  bridgeChatSummaries,
  type MessageSearchHit,
  type DbPullResult,
  type ChatMessageDelta,
  type ChatSnapshotWire,
} from "../../platform/bridge/workspace-bridge";

export type { MessageSearchHit, DbPullResult, ChatMessageDelta };

function requireBridge(action: string) {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error(
      `Can't ${action}: not connected to the Zeros engine yet — try again in a moment.`,
    );
  }
  return bridge;
}

export interface PersistedMessageWire {
  msgId: string;
  kind: string;
  /** JSON-serialized AgentMessage (string, not parsed) so the wire envelope
   *  stays stable as the message shape evolves. */
  payload: string;
  createdAt: number;
}

/** Parse a persisted on-disk message back into an AgentMessage. JSON.parse is
 *  wrapped so a corrupt row from an earlier build doesn't crash hydrate — bad
 *  rows are dropped and logged. */
export function fromPersistedMessage(
  p: PersistedMessageWire,
): AgentMessage | null {
  try {
    return JSON.parse(p.payload) as AgentMessage;
  } catch (err) {
    console.warn(
      `[Zeros agent-history] dropping unreadable message ${p.msgId}:`,
      err,
    );
    return null;
  }
}

/** Vestigial: the engine persists transcripts on emit (persist-on-emit +
 *  persistUserPrompt), so the renderer no longer writes them. Kept as a no-op so
 *  the sessions-provider flush call stays harmless. */
export async function appendMessages(
  _chatId: string,
  _messages: AgentMessage[],
): Promise<void> {
  /* no-op — engine-persists-on-emit owns the transcript */
}

export async function windowMessages(
  chatId: string,
  limit: number,
  before?: number,
): Promise<AgentMessage[]> {
  const rows = await bridgeMessageWindow(
    requireBridge("load the chat transcript"),
    chatId,
    limit,
    before,
  );
  return rows
    .map(fromPersistedMessage)
    .filter((m): m is AgentMessage => m !== null);
}

/** Fetch the next page of older messages relative to the oldest
 *  visible message. Chronological order; renderer prepends. Empty = no older
 *  rows (renderer hides "Load older"). */
export async function windowOlderMessages(
  chatId: string,
  limit: number,
  beforeMsgId: string,
): Promise<AgentMessage[]> {
  const rows = await bridgeMessageWindowOlder(
    requireBridge("load older chat messages"),
    chatId,
    limit,
    beforeMsgId,
  );
  return rows
    .map(fromPersistedMessage)
    .filter((m): m is AgentMessage => m !== null);
}

/** The engine clamps messages.window / messages.windowOlder at 1000 rows for
 *  every caller (workspace/service.ts), so this is the largest useful page.
 *  Asking for MORE than the clamp is harmless — the walk never treats a short
 *  page as the end of history, so the two numbers are not coupled. */
const TRANSCRIPT_PAGE = 1000;

/** A page can carry megabytes of tool payloads — well past what the 10s
 *  default (sized for small metadata ops) covers. */
const TRANSCRIPT_PAGE_TIMEOUT_MS = 60_000;

/** Backstop against an unterminated page walk (≈200k messages). */
const TRANSCRIPT_MAX_PAGES = 200;

/** Stop the walk once we hold more raw payload than the formatter could
 *  possibly keep (it caps the document at TRANSCRIPT_TOTAL_MAX and only ever
 *  shrinks payloads from there). Generous headroom over that cap, since
 *  per-field clipping means raw bytes and rendered bytes aren't 1:1.
 *
 *  Safe precisely BECAUSE both halves run newest-first: this walk pages
 *  backwards from the tail, and the formatter fills from the newest section
 *  back — so the rows we stop short of are the oldest, which are exactly the
 *  ones the formatter would have dropped anyway. Without this, a tool-heavy
 *  chat pulls hundreds of MB across 200 round trips to render 2 MB. */
const TRANSCRIPT_CHAR_BUDGET = 4_000_000;

/** Is `beforeMsgId` the oldest row this chat has? One row, not one page — the
 *  answer is a single bit and the walk only asks after it already holds
 *  megabytes.
 *
 *  A failure answers "no". This runs only on the bound path, where the
 *  alternative to a cheap wrong-in-the-safe-direction answer is failing a
 *  transcript read that has otherwise entirely succeeded: telling the user
 *  their copy may be partial costs them a sentence, and throwing costs them
 *  the transcript. */
async function noOlderThan(
  bridge: Parameters<typeof bridgeMessageWindowOlder>[0],
  chatId: string,
  beforeMsgId: string,
): Promise<boolean> {
  try {
    const probe = await bridgeMessageWindowOlder(
      bridge,
      chatId,
      1,
      beforeMsgId,
      TRANSCRIPT_PAGE_TIMEOUT_MS,
    );
    return probe.length === 0;
  } catch {
    return false;
  }
}

export interface LoadedTranscript {
  /** Chronological, oldest-first. */
  messages: AgentMessage[];
  /** False when a bound stopped the walk before the start of history, so the
   *  caller can say the copy is partial instead of reporting it complete. */
  complete: boolean;
}

/** A chat's persisted transcript, oldest-first — for "copy transcript", which
 *  must not silently stop at the renderer's window.
 *
 *  Neither in-memory source is usable here: a background tab's slot may be
 *  empty (or hold exactly HYDRATE_WINDOW rows from the tab-hover prefetch,
 *  which looks complete but isn't), and even the active slot is capped at
 *  MAX_MESSAGES_PER_CHAT. So we page the engine.
 *
 *  Two deliberate properties of the walk:
 *   - It cursors on the RAW wire `msgId`, not a parsed message. Mapping
 *     through fromPersistedMessage first would let a page whose rows all fail
 *     to parse filter down to [] and read as "no more history".
 *   - Only an EMPTY page ends it. Treating a short page as the end would
 *     couple this to the engine's exact row clamp, so lowering that clamp
 *     would silently cap every copy in the app. Costs one extra round trip. */
export async function loadFullTranscript(
  chatId: string,
): Promise<LoadedTranscript> {
  const bridge = requireBridge("copy the chat transcript");
  const pages: PersistedMessageWire[][] = [];
  let page = await bridgeMessageWindow(
    bridge,
    chatId,
    TRANSCRIPT_PAGE,
    undefined,
    TRANSCRIPT_PAGE_TIMEOUT_MS,
  );
  let chars = 0;
  let complete = true;
  while (page.length > 0) {
    pages.unshift(page);
    for (const r of page) chars += r.payload.length;
    if (
      pages.length >= TRANSCRIPT_MAX_PAGES ||
      chars >= TRANSCRIPT_CHAR_BUDGET
    ) {
      // Hitting a bound is not the same as leaving history behind, and the
      // difference is user-visible: `complete: false` is what turns an
      // otherwise silent success into "Attached the most recent part of X —
      // the full history was too large to read" and into the partial-copy
      // toast. A tool-heavy chat can blow the 4 MB budget INSIDE its first
      // page (one page is up to 1000 rows, and a single Read result can be
      // 100 KB), and that chat is complete — every row of it is in hand.
      //
      // So ask, rather than assume, with the cheapest question available: one
      // row older than the oldest we hold. `limit: 1` is below any clamp the
      // engine might apply, so this stays uncoupled from TRANSCRIPT_PAGE, and
      // an empty answer is the same proof-of-end the loop already relies on.
      // Fetching another full page to find out would cost megabytes to learn
      // one bit.
      complete = await noOlderThan(bridge, chatId, page[0].msgId);
      break;
    }
    page = await bridgeMessageWindowOlder(
      bridge,
      chatId,
      TRANSCRIPT_PAGE,
      page[0].msgId,
      TRANSCRIPT_PAGE_TIMEOUT_MS,
    );
  }
  return {
    messages: pages
      .flat()
      .map(fromPersistedMessage)
      .filter((m): m is AgentMessage => m !== null),
    complete,
  };
}

export async function clearChat(chatId: string): Promise<void> {
  await bridgeMessageClear(requireBridge("clear the chat transcript"), chatId);
}

/** Incremental delta sync. `dbHead()` is the engine's current global
 *  rev (a client's cursor right after a full load); `dbPull(since)` returns only
 *  what changed after the cursor (chat upserts + deleted ids). */
export async function dbHead(): Promise<number> {
  return bridgeDbHead(requireBridge("read the database revision"));
}

export async function dbPull(since: number): Promise<DbPullResult> {
  return bridgeDbPull(requireBridge("sync chat changes"), since);
}

/** Drop the message with the given id and
 *  every later message for this chat. The click-to-edit flow calls this before
 *  re-sending the edited prompt so the stored history matches the in-memory
 *  truncation. */
export async function truncateMessagesFrom(
  chatId: string,
  fromMsgId: string,
): Promise<number> {
  await bridgeMessageTruncateFrom(
    requireBridge("truncate the chat transcript"),
    chatId,
    fromMsgId,
  );
  return 0;
}

/** Hand-maintained 1:1 mirror of the engine's `ChatSummaryRow`
 *  (engine/db/chats.ts). There is no schema and no coercion at this boundary —
 *  the bridge result is a bare cast — so the two interfaces must be edited
 *  together or the renderer reads undefined. */
export interface ChatSummaryWire {
  chatId: string;
  title: string;
  folder: string;
  summary: string;
  summaryAt: number;
  /** The agent that authored the prior chat, used to
   *  render its monochrome logo on the summary pill. Null when no agent bound. */
  agentId: string | null;
  agentName: string | null;
  /** Prompts the user sent to this agent — the number on a transcript pill.
   *  NOT the persisted row count, which counts every tool call and reasoning
   *  block and so reported "55 messages" for a two-question chat. See the
   *  field's doc on the engine side. */
  userMessageCount: number;
  /** Epoch ms of the newest message; 0 when unknown. "Last active" in the
   *  transcript hover preview. Never an ordering key. */
  lastMessageAt: number;
}

/** Prior chats in this folder with a summary (the first user message), newest
 *  chat first by CREATION date. Drives the "Add chat transcripts" pill row on
 *  an empty chat. Served from the engine over the shared bridge. */
export async function listChatSummariesForFolder(args: {
  folder: string;
  excludeChatId?: string;
}): Promise<ChatSummaryWire[]> {
  if (!args.folder) return [];
  return bridgeChatSummaries(
    requireBridge("list chat summaries"),
    args.folder,
    args.excludeChatId,
  );
}

export interface AttachmentWriteResult {
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
  /** True when the exact bytes were already staged and disk did not change. */
  skipped?: boolean;
}

export interface AttachmentReadResult {
  base64: string;
  mimeType: string;
  bytes: number;
}

/** Only context-graph paths minted by the attachment writer (plus the previous
 *  chat-scoped layout during migration) are valid transcript references. A
 *  transcript can arrive over sync/import, so never let a forged `diskPath`
 *  turn edit-resend into an arbitrary workspace-file reader. */
export { isAgentAttachmentDiskPath } from "./attachment-file-reader";

/** Persist a base64-encoded attachment into the workspace's context graph
 *  (`<cwd>/.context-graph/<scope>/attachments/<attachmentId>/<file>`) and
 *  return both the absolute and cwd-relative paths. Every composer attachment
 *  lands here the moment it is staged — images so non-vision agents can
 *  reference them by path, text files / transcripts so the Context tab canvas
 *  shows what was attached. `chatId` is provenance only and optional: staging
 *  happens before the first prompt creates the chat. Unrelated to chat
 *  storage — a dedicated file-write IPC. */
export async function writeContextAttachment(args: {
  cwd: string;
  chatId?: string | null;
  attachmentId: string;
  base64: string;
  mimeType: string;
  filename: string;
}): Promise<AttachmentWriteResult> {
  const bridge = getActiveBridge();
  let result: AttachmentWriteResult;
  if (bridge) {
    let workspaceId = args.cwd;
    try {
      workspaceId =
        (await resolveBridgeWorkspaceIdForCwd(bridge, args.cwd)) ?? args.cwd;
    } catch {
      // A registered primary checkout has no workspace row. Local bridge ops
      // accept its trusted root; remote workspaces resolve above.
    }
    result = await bridgeAttachmentWrite(bridge, workspaceId, args);
  } else {
    result = await nativeInvoke<AttachmentWriteResult>(
      "agent_attachment_write",
      args,
    );
  }
  // Neither transport produces the renderer's filesystem intent signal at the
  // exact write boundary. Nudge the Context tab only when bytes changed; the
  // send-time idempotent safety net stays quiet.
  if (!result.skipped) notifyContextGraphChanged(args.cwd);
  return result;
}

/** Resolve a persisted disk reference back to prompt bytes for edit-resend.
 *  The base64 exists only for this read/send call; it is never copied into the
 *  message or composer document. Legacy data-URL messages bypass this path in
 *  reconstruct.ts and remain editable. */
export async function readImageAttachment(args: {
  cwd: string;
  diskPath: string;
  attachmentId?: string;
  mimeType: string;
}): Promise<AttachmentReadResult> {
  if (!isAgentAttachmentDiskPath(args.diskPath)) {
    throw new Error("invalid image attachment path");
  }
  const result = await readAgentAttachmentFile(args);
  if (result?.kind !== "image" || !result.dataUrl) {
    throw new Error(
      result?.kind === "too-large"
        ? "saved image is too large to re-send"
        : "saved image is no longer available",
    );
  }
  const match = /^data:([^;]+);base64,(.+)$/.exec(result.dataUrl);
  if (!match) throw new Error("saved image data is invalid");
  return {
    base64: match[2],
    mimeType: match[1] || args.mimeType,
    bytes: result.bytes,
  };
}

// There is deliberately NO remove counterpart: the context graph is
// append-only from the app (context-graph-staging.ts) — a record leaves the
// graph only when the user deletes it on disk.

// ── Chat list (sidebar metadata) — engine-backed over the bridge ──────────

/** Wire shape mirrors the engine chats row. The renderer translates to/from the
 *  in-memory ChatThread shape because store.tsx is the single source of truth on
 *  field types (booleans, optional fields). */
export interface ChatRowWire {
  id: string;
  folder: string;
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  effort: string;
  permissionMode: string;
  /** Exact agent mode id the user last selected (lossless vs permissionMode);
   *  null ≡ unset. Lets bypass/auto survive a restart. */
  lastModeId: string | null;
  /** Mode to return to when the Plan toggle is switched off; null ≡ unset. */
  prePlanModeId: string | null;
  fast: boolean;
  /** Extra dirs Claude can access beyond `folder` (the `/add-dir` command).
   *  Absolute paths; JSON-array TEXT in the engine `chats` table. */
  additionalDirectories: string[];
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Read/downgrade compatibility only. Live routing uses executionId and
   * durable resume uses providerBinding. */
  sessionId: string | null;
  providerBinding?: ProviderBinding | null;
  providerMetadata?: ProviderMetadata | null;
  pinned: boolean;
  archived: boolean;
  sourceChatId: string | null;
  /** "chat" | "terminal" | null. NULL is the legacy chat marker for rows written
   *  before the Conversation pane terminal-tab feature shipped. */
  kind: string | null;
}

export async function dbListChats(): Promise<ChatRowWire[]> {
  return bridgeChatList(requireBridge("list chats"));
}

/** Atomic live rows + deletion identities for exact boot reconciliation. */
export async function dbChatSnapshot(): Promise<ChatSnapshotWire> {
  return bridgeChatSnapshot(requireBridge("load the chat snapshot"));
}

export async function dbDeleteChat(id: string): Promise<void> {
  await bridgeChatDelete(requireBridge("delete the chat"), id);
}

export async function dbClearChatProviderIdentity(input: {
  chatId: string;
  agentId: string;
  resumeId: string;
}): Promise<boolean> {
  return bridgeChatClearProviderIdentity(
    requireBridge("clear a stale chat provider binding"),
    input,
  );
}

export async function dbReplaceAllChats(chats: ChatRowWire[]): Promise<void> {
  await bridgeChatBulkUpsert(requireBridge("save chats"), chats);
}
