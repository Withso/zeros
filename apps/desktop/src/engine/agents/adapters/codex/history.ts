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

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openOwnedTranscript, ownedTranscriptPath } from "../shared/transcript-file";

import { providerBindingForResume } from "@zeros/protocol/identities";

import type { ListSessionsResponse } from "../../types";

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_SCAN_ENTRIES = 32_768;

/** Bounded, asynchronous directory iteration. Dirent types exclude symlinked
 * dates and special files before any open; file opens validate again. */
async function entries(
  home: string, directory: string, pattern: RegExp, directories: boolean,
  budget: { remaining: number },
): Promise<string[]> {
  const names: string[] = [];
  if (budget.remaining <= 0) return names;
  try {
    const canonical = await ownedTranscriptPath(home, directory);
    const dir = await fsp.opendir(canonical);
    let count = 0;
    for await (const entry of dir) {
      budget.remaining--;
      count++;
      if ((directories ? entry.isDirectory() : entry.isFile()) && pattern.test(entry.name)) names.push(entry.name);
      if (count >= MAX_DIRECTORY_ENTRIES || budget.remaining <= 0) break;
    }
  } catch { /* A missing/replaced date directory does not invalidate others. */ }
  return names.sort().reverse();
}

async function findRolloutFiles(home: string, limit: number): Promise<string[]> {
  const root = path.join(home, "sessions");
  const out: string[] = [];
  const budget = { remaining: MAX_SCAN_ENTRIES };
  for (const y of await entries(home, root, /^\d{4}$/, true, budget)) {
    const yDir = path.join(root, y);
    for (const m of await entries(home, yDir, /^(?:0[1-9]|1[0-2])$/, true, budget)) {
      const mDir = path.join(yDir, m);
      for (const d of await entries(home, mDir, /^(?:0[1-9]|[12]\d|3[01])$/, true, budget)) {
        const dDir = path.join(mDir, d);
        for (const f of await entries(home, dDir, /\.jsonl$/, false, budget)) {
          out.push(path.join(dDir, f));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** Only the metadata prefix is needed, even for a very large rollout. Blank
 * prefixes and missing newlines count against the same strict byte limit. */
async function readFirstLine(home: string, file: string): Promise<unknown | null> {
  let opened: Awaited<ReturnType<typeof openOwnedTranscript>> | undefined;
  try {
    opened = await openOwnedTranscript(home, file);
    let prefix = Buffer.alloc(0);
    let position = 0;
    while (position < MAX_HEADER_BYTES) {
      const buffer = Buffer.alloc(Math.min(4096, MAX_HEADER_BYTES - position));
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
      position += bytesRead;
      prefix = Buffer.concat([prefix, buffer.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = prefix.indexOf(10)) >= 0) {
        const line = prefix.subarray(0, newline).toString("utf8").trim();
        prefix = prefix.subarray(newline + 1);
        if (line) return JSON.parse(line);
      }
      if (!bytesRead || position >= opened.stat.size) {
        const line = prefix.toString("utf8").trim();
        return line ? JSON.parse(line) : null;
      }
    }
  } catch { /* Invalid/unreadable metadata is a per-file miss. */ }
  finally { await opened?.handle.close().catch(() => {}); }
  return null;
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
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.min(200, Math.trunc(opts.limit!))) : 50;
  if (!limit) return { sessions: [] };
  const home = path.resolve(codexHome());
  const files = await findRolloutFiles(home, limit * 2); // oversample; some files may lack a session_meta / thread.metadata head

  const sessions: RawSessionEntry[] = [];
  for (const file of files) {
    if (sessions.length >= limit) break;
    const head = await readFirstLine(home, file);
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
      providerBinding: providerBindingForResume("codex", s.sessionId),
      cwd: s.cwd ?? opts.cwd ?? "",
      title: s.title ?? "Untitled",
      // engine SessionInfo doesn't require createdAt but many
      // clients show it; emit as _meta for forward compat.
      _meta: s.createdAt ? { createdAt: s.createdAt, cwd: s.cwd } : undefined,
    })),
  };
}
