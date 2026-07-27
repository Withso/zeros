// ──────────────────────────────────────────────────────────
// agent-history-client — chat + transcript access over the bridge
// ──────────────────────────────────────────────────────────
//
// Since Phase 2c the engine's unified Zeros DB is the SINGLE source of truth for
// chats + transcripts, and this is a thin typed shell over the bridge
// (workspace-bridge.ts) used by BOTH desktop and web — electron/db.ts is gone.
// The engine persists agent + user messages ON EMIT, so there is no renderer
// write path for transcripts (appendMessages is a vestigial no-op).
//
// Per-client UI state (scroll offsets, plan snapshots, policies) lives in
// device-local.ts, not here. Image attachments still use a dedicated Electron
// file-write IPC (writeImageAttachment) — unrelated to chat storage.
// ──────────────────────────────────────────────────────────

import { nativeInvoke } from "../../native/runtime";
import type { AgentMessage } from "./use-agent-session";
import { getActiveBridge } from "../bridge/active-bridge";
import {
  bridgeChatList,
  bridgeChatSnapshot,
  bridgeChatDelete,
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
} from "../bridge/workspace-bridge";

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

/** Phase 2 §2.11.4 — fetch the next page of older messages relative to the oldest
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

export async function clearChat(chatId: string): Promise<void> {
  await bridgeMessageClear(requireBridge("clear the chat transcript"), chatId);
}

/** Phase 3 — incremental delta sync. `dbHead()` is the engine's current global
 *  rev (a client's cursor right after a full load); `dbPull(since)` returns only
 *  what changed after the cursor (chat upserts + deleted ids). */
export async function dbHead(): Promise<number> {
  return bridgeDbHead(requireBridge("read the database revision"));
}

export async function dbPull(since: number): Promise<DbPullResult> {
  return bridgeDbPull(requireBridge("sync chat changes"), since);
}

/** Phase 2 chat overhaul (2026-05-07): drop the message with the given id and
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

export interface ChatSummaryWire {
  chatId: string;
  title: string;
  folder: string;
  summary: string;
  summaryAt: number;
  /** Phase D2 (2026-05-07): the agent that authored the prior chat, used to
   *  render its monochrome logo on the summary pill. Null when no agent bound. */
  agentId: string | null;
  agentName: string | null;
}

/** Phase D2 (2026-05-07): prior chats in this folder with a summary (the first
 *  user message). Drives the "Add chat summaries:" pill row on
 *  new chats. Served from the engine — works on desktop AND web. */
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
}

/** Phase D2 (2026-05-07): persist a base64-encoded image attachment to the chat's
 *  working directory so non-vision agents can reference it by path. The engine
 *  writes to `<cwd>/.context/attachments/<chatId>/` and returns both the absolute
 *  and cwd-relative paths. Unrelated to chat storage — a dedicated file-write IPC. */
export async function writeImageAttachment(args: {
  cwd: string;
  chatId: string;
  attachmentId: string;
  base64: string;
  mimeType: string;
  filename: string;
}): Promise<AttachmentWriteResult> {
  return nativeInvoke<AttachmentWriteResult>("agent_attachment_write", args);
}

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
  sessionId: string | null;
  pinned: boolean;
  archived: boolean;
  sourceChatId: string | null;
  /** "chat" | "terminal" | null. NULL is the legacy chat marker for rows written
   *  before the Col-2 terminal-tab feature shipped. */
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

export async function dbReplaceAllChats(chats: ChatRowWire[]): Promise<void> {
  await bridgeChatBulkUpsert(requireBridge("save chats"), chats);
}
