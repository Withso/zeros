// ──────────────────────────────────────────────────────────
// Local orchestration — reading another chat's transcript
// ──────────────────────────────────────────────────────────
//
// Projects persisted chat rows into the CLI's structured message rows:
//   full    — every user message, agent reply and (with --include-tools) tool
//             call, paged by a chat-scoped `ord` cursor;
//   summary — the existing concise transcript: user prompts + each turn's
//             final answer (no model is asked to summarize anything);
//   last    — the final answer of the latest (or a named) turn.
// User-role rows carry who sent them: the human, another agent (its chat link)
// or a Zeros note. Long text is truncated with an explicit flag.
// ──────────────────────────────────────────────────────────

import type { AgentMessage } from "@zeros/protocol/agent-messages";
import type { LocalMessageRow } from "@zeros/protocol/local-orchestration";
import { LOCAL_MAX_PAGE } from "@zeros/protocol/local-orchestration";
import { localMessageOrigins } from "../db/local-orchestration";
import { listChatMessagesAfterOrd, type PersistedMessageRow } from "../db/messages";
import { listTurnsForChat } from "../db/turns";

const TEXT_LIMIT = 20_000;
const TOOL_FIELD_LIMIT = 4_000;
const SCAN_PAGE = 500;

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parse(row: PersistedMessageRow): AgentMessage | null {
  try {
    return JSON.parse(row.payload) as AgentMessage;
  } catch {
    return null;
  }
}

export interface TranscriptOptions {
  view: "full" | "summary" | "last";
  afterOrd: number;
  limit: number;
  includeTools: boolean;
  turnId?: string;
  linkForChat: (chatId: string) => string;
}

export interface TranscriptPage {
  messages: LocalMessageRow[];
  nextCursor: string | null;
  turnStatus: string | null;
}

export function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^ord:(\d{1,12})$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

/** Every row of a chat, in order (bounded scan for summary/last). */
function allRows(chatId: string): PersistedMessageRow[] {
  const out: PersistedMessageRow[] = [];
  let after = 0;
  for (let page = 0; page < 200; page += 1) {
    const rows = listChatMessagesAfterOrd(chatId, after, SCAN_PAGE);
    out.push(...rows);
    if (rows.length < SCAN_PAGE) break;
    after = rows[rows.length - 1]!.ord;
  }
  return out;
}

export function readTranscript(chatId: string, options: TranscriptOptions): TranscriptPage {
  const turns = listTurnsForChat(chatId);
  const turnIds = new Set(turns.map((t) => t.turnId));
  const origins = localMessageOrigins(chatId);
  const fromOf = (msg: { id: string }): LocalMessageRow["from"] => {
    const origin = origins.get(msg.id);
    if (!origin) return { kind: "human" };
    if (origin.kind === "zeros") return { kind: "zeros" };
    return origin.senderChatId
      ? { kind: "agent", chatId: origin.senderChatId, chatLink: options.linkForChat(origin.senderChatId) }
      : { kind: "zeros" };
  };

  const project = (rows: PersistedMessageRow[], startTurn: string | null) => {
    const out: Array<LocalMessageRow & { ord: number }> = [];
    let current = startTurn;
    for (const row of rows) {
      const msg = parse(row);
      if (!msg) continue;
      if (msg.kind === "text") {
        if (msg.role === "user") {
          if (turnIds.has(msg.id)) current = msg.id;
          const turnId = msg.steeredTurnId ?? (turnIds.has(msg.id) ? msg.id : current);
          const body = clip(msg.text ?? "", TEXT_LIMIT);
          out.push({
            ord: row.ord,
            messageId: msg.id,
            turnId,
            role: "user",
            from: fromOf(msg),
            phase: null,
            text: body.text,
            truncated: body.truncated,
            createdAt: msg.createdAt,
          });
        } else if (msg.role === "agent" && !msg.retracted) {
          const body = clip(msg.text ?? "", TEXT_LIMIT);
          out.push({
            ord: row.ord,
            messageId: msg.id,
            turnId: current,
            role: "agent",
            from: null,
            phase: msg.phase ?? null,
            text: body.text,
            truncated: body.truncated,
            createdAt: msg.createdAt,
          });
        }
      } else if (msg.kind === "tool" && options.includeTools) {
        const input = clip(stringify(msg.rawInput), TOOL_FIELD_LIMIT);
        const output = clip(stringify(msg.rawOutput ?? msg.content), TOOL_FIELD_LIMIT);
        out.push({
          ord: row.ord,
          messageId: msg.id,
          turnId: current,
          role: "tool",
          from: null,
          phase: null,
          text: msg.title ?? "",
          truncated: input.truncated || output.truncated,
          createdAt: msg.createdAt,
          tool: { name: msg.title ?? msg.toolKind ?? "tool", status: msg.status, input: input.text, output: output.text },
        });
      } else if (msg.kind === "error_notice") {
        const body = clip(msg.message ?? "", TEXT_LIMIT);
        out.push({
          ord: row.ord,
          messageId: msg.id,
          turnId: msg.turnFailure?.turnId ?? current,
          role: "notice",
          from: null,
          phase: msg.severity,
          text: body.text,
          truncated: body.truncated,
          createdAt: msg.createdAt,
        });
      }
    }
    return out;
  };

  const strip = (rows: Array<LocalMessageRow & { ord: number }>): LocalMessageRow[] =>
    rows.map(({ ord: _ord, ...rest }) => rest);

  if (options.view === "full") {
    const limit = Math.max(1, Math.min(options.limit, LOCAL_MAX_PAGE));
    // Find the turn in force at the cursor so a later page still labels rows.
    const rows = listChatMessagesAfterOrd(chatId, options.afterOrd, limit);
    let startTurn: string | null = null;
    if (options.afterOrd > 0) {
      const before = allRows(chatId).filter((r) => r.ord <= options.afterOrd);
      for (const row of before) {
        const msg = parse(row);
        if (msg?.kind === "text" && msg.role === "user" && turnIds.has(msg.id)) startTurn = msg.id;
      }
    }
    let projected = project(rows, startTurn);
    if (options.turnId) projected = projected.filter((m) => m.turnId === options.turnId);
    const last = rows.at(-1);
    return {
      messages: strip(projected),
      nextCursor: rows.length >= limit && last ? `ord:${last.ord}` : null,
      turnStatus: null,
    };
  }

  const projected = project(allRows(chatId), null).filter((row) => !options.turnId || row.turnId === options.turnId);
  if (options.view === "summary") {
    const out: Array<LocalMessageRow & { ord: number }> = [];
    const finalByTurn = new Map<string | null, LocalMessageRow & { ord: number }>();
    for (const row of projected) {
      if (row.role === "agent") {
        const prior = finalByTurn.get(row.turnId);
        // Prefer a final answer; otherwise the turn's last reply.
        if (!prior || row.phase === "final_answer" || prior.phase !== "final_answer") finalByTurn.set(row.turnId, row);
      }
    }
    for (const row of projected) {
      if (row.role === "user") out.push(row);
      else if (row.role === "agent" && finalByTurn.get(row.turnId) === row) out.push(row);
      else if (row.role === "notice") out.push(row);
    }
    return { messages: strip(out), nextCursor: null, turnStatus: null };
  }

  // last: the final answer of the named or latest turn.
  const turn = options.turnId ? turns.find((t) => t.turnId === options.turnId) : turns.at(-1);
  if (!turn) return { messages: [], nextCursor: null, turnStatus: null };
  const inTurn = projected.filter((m) => m.turnId === turn.turnId && (m.role === "agent" || m.role === "notice"));
  const finals = inTurn.filter((m) => m.role === "agent" && m.phase === "final_answer");
  const answer = finals.at(-1) ?? inTurn.filter((m) => m.role === "agent").at(-1) ?? inTurn.at(-1);
  return { messages: answer ? strip([answer]) : [], nextCursor: null, turnStatus: turn.status };
}
