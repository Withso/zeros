// ──────────────────────────────────────────────────────────
// Local orchestration store — families, shares, follows, receipts
// ──────────────────────────────────────────────────────────
//
// The engine-owned records behind `zeros local …` (migration v41). Chats stay
// in `chats`; this module only records who started whom, which links were
// shared into a family, who follows whom, the notifications owed to followers,
// idempotency receipts, the sender of agent-authored messages and the user's
// Stop. Nothing here is synced to other devices: Local work stays on the Mac.
// ──────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";
import type { LocalMessageNote } from "@zeros/protocol/agent-messages";
import { openZerosDb } from "./index";

export interface LocalLinkRow {
  chatId: string;
  parentChatId: string;
  rootChatId: string;
  createdRequestId: string | null;
  createdAt: number;
}

export type LocalShareKind = "chat" | "workspace";

export interface LocalShareRow {
  holderChatId: string;
  kind: LocalShareKind;
  targetId: string;
  grantedBy: string;
  createdAt: number;
}

export interface LocalFollowRow {
  followerChatId: string;
  targetChatId: string;
  events: string[];
  /** Empty for a chat-wide follow; a turn id for a one-turn `--notify`. */
  turnId: string;
  createdAt: number;
}

export type LocalNotificationState = "pending" | "delivered" | "unknown" | "retired";

export interface LocalNotificationRow {
  id: string;
  followerChatId: string;
  sourceChatId: string;
  event: "done" | "question" | "permission";
  eventKey: string;
  state: LocalNotificationState;
  text: string;
  /** How the follower's transcript shows it; null on rows from before v42. */
  note: LocalMessageNote | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalRequestRow {
  requesterChatId: string;
  requestId: string;
  command: string;
  payloadHash: string;
  state: string;
  targetChatId: string | null;
  turnId: string | null;
  result: unknown;
  error: unknown;
  createdAt: number;
  updatedAt: number;
}

// ── Families ──────────────────────────────────────────────

export function getLocalLink(chatId: string): LocalLinkRow | null {
  const row = openZerosDb()
    .prepare(
      "SELECT chat_id, parent_chat_id, root_chat_id, created_request_id, created_at FROM local_orchestration_links WHERE chat_id = ?",
    )
    .get(chatId) as
    | { chat_id: string; parent_chat_id: string; root_chat_id: string; created_request_id: string | null; created_at: number }
    | undefined;
  return row
    ? {
        chatId: row.chat_id,
        parentChatId: row.parent_chat_id,
        rootChatId: row.root_chat_id,
        createdRequestId: row.created_request_id,
        createdAt: row.created_at,
      }
    : null;
}

/** The root of a chat's family: the chat the user drives at the top. */
export function localRootOf(chatId: string): string {
  return getLocalLink(chatId)?.rootChatId ?? chatId;
}

/** Record that `parentChatId`'s agent started `chatId`. Idempotent. */
export function insertLocalLink(input: {
  chatId: string;
  parentChatId: string;
  requestId?: string | null;
  now?: number;
}): LocalLinkRow {
  const existing = getLocalLink(input.chatId);
  if (existing) return existing;
  const rootChatId = localRootOf(input.parentChatId);
  const createdAt = input.now ?? Date.now();
  openZerosDb()
    .prepare(
      `INSERT OR IGNORE INTO local_orchestration_links
         (chat_id, parent_chat_id, root_chat_id, created_request_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.chatId, input.parentChatId, rootChatId, input.requestId ?? null, createdAt);
  return getLocalLink(input.chatId)!;
}

/** Every chat in the same family as `chatId`, including the root and itself. */
/** A tab removed because its agent never connected: it leaves no family
 * member, follow or pending note behind. */
export function forgetLocalChat(chatId: string): void {
  const db = openZerosDb();
  db.transaction(() => {
    db.prepare("DELETE FROM local_orchestration_links WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM local_orchestration_follows WHERE follower_chat_id = ? OR target_chat_id = ?").run(chatId, chatId);
    db.prepare(
      "UPDATE local_orchestration_notifications SET state = 'retired', updated_at = ? WHERE (follower_chat_id = ? OR source_chat_id = ?) AND state = 'pending'",
    ).run(Date.now(), chatId, chatId);
  })();
}

export function localFamilyMembers(chatId: string): string[] {
  const root = localRootOf(chatId);
  const rows = openZerosDb()
    .prepare("SELECT chat_id FROM local_orchestration_links WHERE root_chat_id = ?")
    .all(root) as Array<{ chat_id: string }>;
  const out = new Set<string>([root, chatId]);
  for (const row of rows) out.add(row.chat_id);
  return [...out];
}

export function localChildrenOf(chatId: string): string[] {
  return (
    openZerosDb()
      .prepare("SELECT chat_id FROM local_orchestration_links WHERE parent_chat_id = ? ORDER BY created_at ASC")
      .all(chatId) as Array<{ chat_id: string }>
  ).map((row) => row.chat_id);
}

export function recordFamilyWorkspace(input: {
  rootChatId: string;
  workspaceId: string;
  createdByChatId: string;
  now?: number;
}): void {
  openZerosDb()
    .prepare(
      `INSERT OR IGNORE INTO local_orchestration_family_workspaces
         (root_chat_id, workspace_id, created_by_chat_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.rootChatId, input.workspaceId, input.createdByChatId, input.now ?? Date.now());
}

export function familyCreatedWorkspaces(rootChatId: string): string[] {
  return (
    openZerosDb()
      .prepare("SELECT workspace_id FROM local_orchestration_family_workspaces WHERE root_chat_id = ?")
      .all(rootChatId) as Array<{ workspace_id: string }>
  ).map((row) => row.workspace_id);
}

// ── Shares ────────────────────────────────────────────────

export function insertLocalShare(input: {
  holderChatId: string;
  kind: LocalShareKind;
  targetId: string;
  grantedBy: string;
  now?: number;
}): boolean {
  const result = openZerosDb()
    .prepare(
      `INSERT OR IGNORE INTO local_orchestration_shares
         (holder_chat_id, kind, target_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.holderChatId, input.kind, input.targetId, input.grantedBy, input.now ?? Date.now());
  return result.changes > 0;
}

/** Shares held by any of the given chats (a family shares everything). */
export function localSharesForChats(chatIds: readonly string[]): LocalShareRow[] {
  if (chatIds.length === 0) return [];
  const db = openZerosDb();
  const out: LocalShareRow[] = [];
  const statement = db.prepare(
    "SELECT holder_chat_id, kind, target_id, granted_by, created_at FROM local_orchestration_shares WHERE holder_chat_id = ?",
  );
  for (const chatId of chatIds) {
    for (const row of statement.all(chatId) as Array<{
      holder_chat_id: string;
      kind: LocalShareKind;
      target_id: string;
      granted_by: string;
      created_at: number;
    }>) {
      out.push({
        holderChatId: row.holder_chat_id,
        kind: row.kind,
        targetId: row.target_id,
        grantedBy: row.granted_by,
        createdAt: row.created_at,
      });
    }
  }
  return out;
}

// ── Follows and notifications ─────────────────────────────

export function upsertLocalFollow(input: {
  followerChatId: string;
  targetChatId: string;
  events: readonly string[];
  turnId?: string;
  now?: number;
}): void {
  openZerosDb()
    .prepare(
      `INSERT INTO local_orchestration_follows (follower_chat_id, target_chat_id, events, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(follower_chat_id, target_chat_id, turn_id) DO UPDATE SET events = excluded.events`,
    )
    .run(
      input.followerChatId,
      input.targetChatId,
      [...new Set(input.events)].sort().join(","),
      input.turnId ?? "",
      input.now ?? Date.now(),
    );
}

export function deleteLocalFollows(followerChatId: string, targetChatId: string): number {
  return openZerosDb()
    .prepare("DELETE FROM local_orchestration_follows WHERE follower_chat_id = ? AND target_chat_id = ?")
    .run(followerChatId, targetChatId).changes;
}

export function deleteLocalTurnFollow(followerChatId: string, targetChatId: string, turnId: string): void {
  openZerosDb()
    .prepare("DELETE FROM local_orchestration_follows WHERE follower_chat_id = ? AND target_chat_id = ? AND turn_id = ?")
    .run(followerChatId, targetChatId, turnId);
}

export function localFollowersOf(targetChatId: string): LocalFollowRow[] {
  return (
    openZerosDb()
      .prepare(
        "SELECT follower_chat_id, target_chat_id, events, turn_id, created_at FROM local_orchestration_follows WHERE target_chat_id = ?",
      )
      .all(targetChatId) as Array<{
      follower_chat_id: string;
      target_chat_id: string;
      events: string;
      turn_id: string;
      created_at: number;
    }>
  ).map((row) => ({
    followerChatId: row.follower_chat_id,
    targetChatId: row.target_chat_id,
    events: row.events ? row.events.split(",") : [],
    turnId: row.turn_id,
    createdAt: row.created_at,
  }));
}

export function localFollowsBy(followerChatId: string): LocalFollowRow[] {
  return (
    openZerosDb()
      .prepare(
        "SELECT follower_chat_id, target_chat_id, events, turn_id, created_at FROM local_orchestration_follows WHERE follower_chat_id = ?",
      )
      .all(followerChatId) as Array<{
      follower_chat_id: string;
      target_chat_id: string;
      events: string;
      turn_id: string;
      created_at: number;
    }>
  ).map((row) => ({
    followerChatId: row.follower_chat_id,
    targetChatId: row.target_chat_id,
    events: row.events ? row.events.split(",") : [],
    turnId: row.turn_id,
    createdAt: row.created_at,
  }));
}

/** Insert a notification once per (follower, source, event, key). Returns the
 * row when it is new, null when the event was already recorded. */
export function insertLocalNotification(input: {
  followerChatId: string;
  sourceChatId: string;
  event: LocalNotificationRow["event"];
  eventKey: string;
  text: string;
  note?: LocalMessageNote;
  now?: number;
}): LocalNotificationRow | null {
  const now = input.now ?? Date.now();
  const id = randomUUID();
  const result = openZerosDb()
    .prepare(
      `INSERT OR IGNORE INTO local_orchestration_notifications
         (id, follower_chat_id, source_chat_id, event, event_key, state, text, note_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.followerChatId,
      input.sourceChatId,
      input.event,
      input.eventKey,
      input.text,
      input.note ? JSON.stringify(input.note) : null,
      now,
      now,
    );
  if (result.changes === 0) return null;
  return {
    id,
    followerChatId: input.followerChatId,
    sourceChatId: input.sourceChatId,
    event: input.event,
    eventKey: input.eventKey,
    state: "pending",
    text: input.text,
    note: input.note ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function noteFrom(json: string | null): LocalMessageNote | null {
  if (!json) return null;
  try {
    const note = JSON.parse(json) as LocalMessageNote;
    return note && typeof note.chatId === "string" && typeof note.event === "string" ? note : null;
  } catch {
    return null;
  }
}

export function setLocalNotificationState(id: string, state: LocalNotificationState, now = Date.now()): void {
  openZerosDb()
    .prepare("UPDATE local_orchestration_notifications SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, now, id);
}

/** Claim a pending notification for one delivery attempt. The claim reads as
 * `unknown` until the outcome is known, so a crash between the provider
 * accepting the note and this record updating never sends it twice. */
export function claimLocalNotification(id: string, now = Date.now()): boolean {
  return (
    openZerosDb()
      .prepare(
        "UPDATE local_orchestration_notifications SET state = 'unknown', updated_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(now, id).changes > 0
  );
}

export function pendingLocalNotifications(followerChatId: string): LocalNotificationRow[] {
  return (
    openZerosDb()
      .prepare(
        `SELECT id, follower_chat_id, source_chat_id, event, event_key, state, text, note_json, created_at, updated_at
           FROM local_orchestration_notifications
          WHERE follower_chat_id = ? AND state = 'pending'
          ORDER BY created_at ASC`,
      )
      .all(followerChatId) as Array<{
      id: string;
      follower_chat_id: string;
      source_chat_id: string;
      event: LocalNotificationRow["event"];
      event_key: string;
      state: LocalNotificationState;
      text: string;
      note_json: string | null;
      created_at: number;
      updated_at: number;
    }>
  ).map((row) => ({
    id: row.id,
    followerChatId: row.follower_chat_id,
    sourceChatId: row.source_chat_id,
    event: row.event,
    eventKey: row.event_key,
    state: row.state,
    text: row.text,
    note: noteFrom(row.note_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Followers with notifications still owed (for retry on a state change). */
export function followersWithPendingNotifications(): string[] {
  return (
    openZerosDb()
      .prepare("SELECT DISTINCT follower_chat_id FROM local_orchestration_notifications WHERE state = 'pending'")
      .all() as Array<{ follower_chat_id: string }>
  ).map((row) => row.follower_chat_id);
}

/** Retire every outstanding notification for a follower (the user stopped
 * it), including one claimed by a delivery still in flight. */
export function retireLocalNotifications(followerChatId: string, now = Date.now()): number {
  return openZerosDb()
    .prepare(
      "UPDATE local_orchestration_notifications SET state = 'retired', updated_at = ? WHERE follower_chat_id = ? AND state IN ('pending', 'unknown')",
    )
    .run(now, followerChatId).changes;
}

/** Settle a claimed delivery. Only a claim (`unknown`) moves, so a note the
 * user's Stop retired meanwhile is never revived. */
export function settleLocalNotification(id: string, state: "delivered" | "pending", now = Date.now()): boolean {
  return (
    openZerosDb()
      .prepare("UPDATE local_orchestration_notifications SET state = ?, updated_at = ? WHERE id = ? AND state = 'unknown'")
      .run(state, now, id).changes > 0
  );
}

// ── Request receipts ──────────────────────────────────────

/** Canonical payload hash: key order never changes a request's identity. */
export function localPayloadHash(command: string, args: unknown): string {
  return createHash("sha256").update(`${command}\n${canonicalJson(args)}`).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function toRequestRow(row: {
  requester_chat_id: string;
  request_id: string;
  command: string;
  payload_hash: string;
  state: string;
  target_chat_id: string | null;
  turn_id: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}): LocalRequestRow {
  const parse = (raw: string | null): unknown => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    requesterChatId: row.requester_chat_id,
    requestId: row.request_id,
    command: row.command,
    payloadHash: row.payload_hash,
    state: row.state,
    targetChatId: row.target_chat_id,
    turnId: row.turn_id,
    result: parse(row.result_json),
    error: parse(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const REQUEST_COLUMNS =
  "requester_chat_id, request_id, command, payload_hash, state, target_chat_id, turn_id, result_json, error_json, created_at, updated_at";

export function getLocalRequest(requesterChatId: string, requestId: string): LocalRequestRow | null {
  const row = openZerosDb()
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM local_orchestration_requests WHERE requester_chat_id = ? AND request_id = ?`)
    .get(requesterChatId, requestId) as Parameters<typeof toRequestRow>[0] | undefined;
  return row ? toRequestRow(row) : null;
}

/** Claim a request id. Returns `{ fresh: true }` for a new claim, the existing
 * row for a replay, or `{ conflict }` when the id was used for other content. */
export function claimLocalRequest(input: {
  requesterChatId: string;
  requestId: string;
  command: string;
  payloadHash: string;
  now?: number;
}): { fresh: true } | { fresh: false; existing: LocalRequestRow } | { conflict: LocalRequestRow } {
  const db = openZerosDb();
  const now = input.now ?? Date.now();
  const tx = db.transaction(() => {
    const existing = getLocalRequest(input.requesterChatId, input.requestId);
    if (existing) {
      if (existing.command !== input.command || existing.payloadHash !== input.payloadHash) {
        return { conflict: existing } as const;
      }
      return { fresh: false, existing } as const;
    }
    db.prepare(
      `INSERT INTO local_orchestration_requests (${REQUEST_COLUMNS})
       VALUES (?, ?, ?, ?, 'accepted', NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(input.requesterChatId, input.requestId, input.command, input.payloadHash, now, now);
    return { fresh: true } as const;
  });
  return tx();
}

export function updateLocalRequest(
  requesterChatId: string,
  requestId: string,
  patch: { state?: string; targetChatId?: string | null; turnId?: string | null; result?: unknown; error?: unknown },
  now = Date.now(),
): void {
  const current = getLocalRequest(requesterChatId, requestId);
  if (!current) return;
  openZerosDb()
    .prepare(
      `UPDATE local_orchestration_requests
          SET state = ?, target_chat_id = ?, turn_id = ?, result_json = ?, error_json = ?, updated_at = ?
        WHERE requester_chat_id = ? AND request_id = ?`,
    )
    .run(
      patch.state ?? current.state,
      patch.targetChatId === undefined ? current.targetChatId : patch.targetChatId,
      patch.turnId === undefined ? current.turnId : patch.turnId,
      patch.result === undefined ? (current.result == null ? null : JSON.stringify(current.result)) : JSON.stringify(patch.result),
      patch.error === undefined ? (current.error == null ? null : JSON.stringify(current.error)) : JSON.stringify(patch.error),
      now,
      requesterChatId,
      requestId,
    );
}

/** The most recent turn this requester started in a target chat. */
export function lastAcceptedTurn(requesterChatId: string, targetChatId: string): string | null {
  const row = openZerosDb()
    .prepare(
      `SELECT turn_id FROM local_orchestration_requests
        WHERE requester_chat_id = ? AND target_chat_id = ? AND turn_id IS NOT NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(requesterChatId, targetChatId) as { turn_id: string } | undefined;
  return row?.turn_id ?? null;
}

/** The request (by this requester) that started or steered a turn. */
export function localRequestForTurn(
  requesterChatId: string,
  targetChatId: string,
  turnId: string,
): LocalRequestRow | null {
  const row = openZerosDb()
    .prepare(
      `SELECT ${REQUEST_COLUMNS} FROM local_orchestration_requests
        WHERE requester_chat_id = ? AND target_chat_id = ? AND turn_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(requesterChatId, targetChatId, turnId) as Parameters<typeof toRequestRow>[0] | undefined;
  return row ? toRequestRow(row) : null;
}

/** Boot recovery: no execution survives a restart, so in-flight requests end.
 * `dispatching` may have reached a provider → unknown; earlier states never did. */
export function recoverLocalRequestsAtBoot(now = Date.now()): { interrupted: number; unknown: number } {
  const db = openZerosDb();
  const tx = db.transaction(() => {
    const unknown = db
      .prepare("UPDATE local_orchestration_requests SET state = 'unknown', updated_at = ? WHERE state = 'dispatching'")
      .run(now).changes;
    const interrupted = db
      .prepare(
        "UPDATE local_orchestration_requests SET state = 'interrupted', updated_at = ? WHERE state IN ('accepted', 'provisioning', 'ready')",
      )
      .run(now).changes;
    return { interrupted, unknown };
  });
  return tx();
}

// ── Card answers ──────────────────────────────────────────

export interface LocalCardAnswerRow {
  cardId: string;
  chatId: string;
  kind: string;
  answeredByChatId: string;
  answer: string;
  answeredAt: number;
}

/** The winning agent answer to a card (first answer wins upstream). */
export function recordLocalCardAnswer(input: Omit<LocalCardAnswerRow, "answeredAt"> & { answeredAt?: number }): void {
  openZerosDb()
    .prepare(
      `INSERT OR IGNORE INTO local_orchestration_card_answers
         (card_id, chat_id, kind, answered_by_chat_id, answer, answered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.cardId, input.chatId, input.kind, input.answeredByChatId, input.answer.slice(0, 2_000), input.answeredAt ?? Date.now());
}

export function localCardAnswersFor(chatId: string, limit = 10): LocalCardAnswerRow[] {
  return (
    openZerosDb()
      .prepare(
        `SELECT card_id, chat_id, kind, answered_by_chat_id, answer, answered_at
           FROM local_orchestration_card_answers WHERE chat_id = ?
          ORDER BY answered_at DESC, rowid DESC LIMIT ?`,
      )
      .all(chatId, Math.max(1, Math.min(limit, 100))) as Array<{
      card_id: string;
      chat_id: string;
      kind: string;
      answered_by_chat_id: string;
      answer: string;
      answered_at: number;
    }>
  ).map((row) => ({
    cardId: row.card_id,
    chatId: row.chat_id,
    kind: row.kind,
    answeredByChatId: row.answered_by_chat_id,
    answer: row.answer,
    answeredAt: row.answered_at,
  }));
}

// ── Message provenance ────────────────────────────────────

export function recordLocalMessageOrigin(input: {
  chatId: string;
  messageId: string;
  kind: "agent" | "zeros";
  senderChatId?: string | null;
  now?: number;
}): void {
  openZerosDb()
    .prepare(
      `INSERT OR REPLACE INTO local_orchestration_message_origins
         (chat_id, message_id, origin_kind, sender_chat_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.chatId, input.messageId, input.kind, input.senderChatId ?? null, input.now ?? Date.now());
}

export function localMessageOrigins(
  chatId: string,
): Map<string, { kind: "agent" | "zeros"; senderChatId: string | null }> {
  const rows = openZerosDb()
    .prepare("SELECT message_id, origin_kind, sender_chat_id FROM local_orchestration_message_origins WHERE chat_id = ?")
    .all(chatId) as Array<{ message_id: string; origin_kind: "agent" | "zeros"; sender_chat_id: string | null }>;
  return new Map(rows.map((row) => [row.message_id, { kind: row.origin_kind, senderChatId: row.sender_chat_id }]));
}

export function localMessageOrigin(
  chatId: string,
  messageId: string,
): { kind: "agent" | "zeros"; senderChatId: string | null } | null {
  const row = openZerosDb()
    .prepare(
      "SELECT origin_kind, sender_chat_id FROM local_orchestration_message_origins WHERE chat_id = ? AND message_id = ?",
    )
    .get(chatId, messageId) as { origin_kind: "agent" | "zeros"; sender_chat_id: string | null } | undefined;
  return row ? { kind: row.origin_kind, senderChatId: row.sender_chat_id } : null;
}

// ── The user's Stop ───────────────────────────────────────

/** Record a Stop the user pressed in a chat. Agents may not restart it until
 * the user sends again. */
export function recordHumanStop(chatId: string, now = Date.now()): number {
  const db = openZerosDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT generation FROM local_orchestration_human_stops WHERE chat_id = ?")
      .get(chatId) as { generation: number } | undefined;
    const generation = (row?.generation ?? 0) + 1;
    db.prepare(
      `INSERT INTO local_orchestration_human_stops (chat_id, generation, stopped_at, cleared_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(chat_id) DO UPDATE SET generation = excluded.generation, stopped_at = excluded.stopped_at, cleared_at = NULL`,
    ).run(chatId, generation, now);
    return generation;
  });
  return tx();
}

/** The user sent a new message: agents may address the chat again. */
export function clearHumanStop(chatId: string, now = Date.now()): void {
  openZerosDb()
    .prepare("UPDATE local_orchestration_human_stops SET cleared_at = ? WHERE chat_id = ? AND cleared_at IS NULL")
    .run(now, chatId);
}

export function isHumanStopped(chatId: string): boolean {
  const row = openZerosDb()
    .prepare("SELECT cleared_at FROM local_orchestration_human_stops WHERE chat_id = ?")
    .get(chatId) as { cleared_at: number | null } | undefined;
  return row != null && row.cleared_at == null;
}
