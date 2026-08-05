// ──────────────────────────────────────────────────────────
// Codex rollout JSONL enumeration
// ──────────────────────────────────────────────────────────
//
// Codex sessions are persisted at
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
// (default CODEX_HOME = ~/.codex). The first line of each rollout is
// a session metadata record we can parse cheaply to produce the
// SessionInfo entries the UI expects from listSessions.
//
// Current rollouts begin with a `session_meta` record that nests
// id/cwd/title/timestamp under `payload` (the id is `payload.id`):
//   {"type":"session_meta","payload":{"id":"...","timestamp":"...","cwd":"...","title":"...",...}}
//
// Older rollouts used `thread.metadata` with those fields at the top
// level (kept for back-compat):
//   {"type":"thread.metadata","thread_id":"...","created_at":"...","cwd":"...","title":"...",...}
//
// followed by the full transcript (user/assistant/turn records).
// We stat + read just the first non-empty line of each file so
// enumeration stays under a few hundred reads even for heavy users.
//
// ──────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as readline from "node:readline";

import type { ListSessionsResponse } from "../../types";

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/**
 * Find every rollout JSONL under $CODEX_HOME/sessions. Walks
 * YYYY/MM/DD subdirs in reverse chronological order so newer
 * sessions appear first.
 */
async function findRolloutFiles(limit: number): Promise<string[]> {
  const root = path.join(codexHome(), "sessions");
  const out: string[] = [];
  let years: string[];
  try {
    years = (await fsp.readdir(root)).filter(nonDot).sort().reverse();
  } catch {
    return out;
  }
  for (const y of years) {
    const yDir = path.join(root, y);
    let months: string[];
    try {
      months = (await fsp.readdir(yDir)).filter(nonDot).sort().reverse();
    } catch {
      continue;
    }
    for (const m of months) {
      const mDir = path.join(yDir, m);
      let days: string[];
      try {
        days = (await fsp.readdir(mDir)).filter(nonDot).sort().reverse();
      } catch {
        continue;
      }
      for (const d of days) {
        const dDir = path.join(mDir, d);
        let files: string[];
        try {
          files = (await fsp.readdir(dDir)).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        files.sort().reverse();
        for (const f of files) {
          out.push(path.join(dDir, f));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** Read the first non-empty line of a file and parse it as JSON. */
async function readFirstLine(file: string): Promise<unknown | null> {
  let stream: Readable;
  try {
    stream = fs.createReadStream(file, { encoding: "utf-8" });
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

function nonDot(n: string): boolean {
  return !n.startsWith(".");
}

interface RawSessionEntry {
  sessionId: string;
  title?: string;
  createdAt?: number;
  cwd?: string;
}

/**
 * Enumerate recent Codex threads. Returns sessions newest-first,
 * capped at `limit` to keep the scan bounded.
 */
export async function listCodexSessions(
  opts: { cwd?: string; limit?: number } = {},
): Promise<ListSessionsResponse> {
  const limit = opts.limit ?? 50;
  const files = await findRolloutFiles(limit * 2); // oversample; some files may lack a session_meta / thread.metadata head

  const sessions: RawSessionEntry[] = [];
  for (const file of files) {
    if (sessions.length >= limit) break;
    const head = await readFirstLine(file);
    if (!head || typeof head !== "object") continue;
    const rec = head as Record<string, unknown>;
    const type = rec.type;
    if (type !== "thread.metadata" && type !== "session_meta") continue;
    // Real `session_meta` rollouts nest id/cwd/title/timestamp under `payload`
    // (the id is `payload.id`); the legacy `thread.metadata` form carried them
    // at the top level. Resolve a payload view so both parse — WITHOUT this,
    // every session_meta rollout yields a null sessionId and is skipped, so the
    // workbench Sessions browser lists ZERO Codex threads.
    const p =
      type === "session_meta" && rec.payload && typeof rec.payload === "object"
        ? (rec.payload as Record<string, unknown>)
        : rec;
    const sessionId =
      typeof p.id === "string"
        ? (p.id as string)
        : typeof p.thread_id === "string"
          ? (p.thread_id as string)
          : typeof p.session_id === "string"
            ? (p.session_id as string)
            : null;
    if (!sessionId) continue;

    // Optional cwd filter — skip sessions that weren't in this project.
    const entryCwd = typeof p.cwd === "string" ? (p.cwd as string) : undefined;
    if (opts.cwd && entryCwd && entryCwd !== opts.cwd) continue;

    // `timestamp` is an ISO-8601 STRING in real rollouts (top-level for
    // session_meta, and `payload.timestamp`); `created_at` is the legacy numeric
    // form. Prefer the string, fall back to numeric — otherwise the Sessions
    // tab has no recency to sort/display by.
    const tsRaw =
      p.timestamp ?? rec.timestamp ?? p.created_at ?? rec.created_at;
    const parsedTs =
      typeof tsRaw === "string"
        ? Date.parse(tsRaw)
        : typeof tsRaw === "number"
          ? tsRaw
          : NaN;

    sessions.push({
      sessionId,
      title: typeof p.title === "string" ? (p.title as string) : undefined,
      createdAt: Number.isFinite(parsedTs) ? parsedTs : undefined,
      cwd: entryCwd,
    });
  }

  return {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title ?? "Untitled",
      // engine SessionInfo doesn't require createdAt but many
      // clients show it; emit as _meta for forward compat.
      _meta: s.createdAt ? { createdAt: s.createdAt, cwd: s.cwd } : undefined,
    })),
  } as never;
}
