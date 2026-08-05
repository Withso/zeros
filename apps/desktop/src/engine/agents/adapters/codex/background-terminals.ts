// Codex background-terminal normalization.
//
// The app-server endpoint is paginated and returns process telemetry with a
// bigint field. The renderer intentionally needs none of that chrome: it gets
// the same compact Background Task rows as Claude (name, elapsed, Stop). This
// module keeps pagination/bounds and lifecycle reconciliation pure enough to
// race-test without booting a Codex child process.

import type { BackgroundTask } from "@zeros/protocol/agent-events";

import type { ThreadBackgroundTerminal } from "./generated/v2/ThreadBackgroundTerminal";
import type { ThreadBackgroundTerminalsListResponse } from "./generated/v2/ThreadBackgroundTerminalsListResponse";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadSourceKind } from "./generated/v2/ThreadSourceKind";

export const MAX_CODEX_BACKGROUND_TERMINALS = 100;
export const MAX_CODEX_BACKGROUND_THREADS = 100;

const ALL_THREAD_SOURCE_KINDS: ThreadSourceKind[] = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

type Request = (
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number },
) => Promise<unknown>;

/** Fetch every page up to the renderer's explicit bound. Repeated cursors are
 * treated as an exhausted stream so a buggy server cannot spin forever. */
export async function collectBackgroundTerminals(
  request: Request,
  threadId: string,
): Promise<ThreadBackgroundTerminal[]> {
  const terminals: ThreadBackgroundTerminal[] = [];
  const seenProcessIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = (await request(
      "thread/backgroundTerminals/list",
      { threadId, cursor, limit: 100 },
      { timeoutMs: 5_000 },
    )) as ThreadBackgroundTerminalsListResponse;
    for (const terminal of response.data ?? []) {
      if (terminals.length >= MAX_CODEX_BACKGROUND_TERMINALS) break;
      if (!terminal?.processId || seenProcessIds.has(terminal.processId)) {
        continue;
      }
      seenProcessIds.add(terminal.processId);
      terminals.push(terminal);
    }
    const next = response.nextCursor ?? null;
    if (!next || terminals.length >= MAX_CODEX_BACKGROUND_TERMINALS) break;
    if (seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  } while (cursor);
  return terminals;
}

/** Discover already-loaded descendants when a parent thread is resumed.
 * Runtime item notifications cover newly-spawned children, but no new edge is
 * guaranteed for a child terminal that survived before this client attached. */
export async function collectLoadedDescendantThreadIds(
  request: Request,
  ancestorThreadId: string,
): Promise<string[]> {
  const threadIds: string[] = [];
  const seenThreadIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = (await request(
      "thread/list",
      {
        ancestorThreadId,
        cursor,
        limit: 100,
        // Omission defaults to interactive sources and excludes subagents.
        sourceKinds: [...ALL_THREAD_SOURCE_KINDS],
      },
      { timeoutMs: 5_000 },
    )) as ThreadListResponse;
    for (const thread of response.data ?? []) {
      if (
        threadIds.length >= MAX_CODEX_BACKGROUND_THREADS - 1 ||
        !thread?.id ||
        thread.id === ancestorThreadId ||
        thread.status?.type === "notLoaded" ||
        seenThreadIds.has(thread.id)
      ) {
        continue;
      }
      seenThreadIds.add(thread.id);
      threadIds.push(thread.id);
    }
    const next = response.nextCursor ?? null;
    if (
      !next ||
      threadIds.length >= MAX_CODEX_BACKGROUND_THREADS - 1 ||
      seenCursors.has(next)
    ) {
      break;
    }
    seenCursors.add(next);
    cursor = next;
  } while (cursor);
  return threadIds;
}

export function reconcileBackgroundTerminals(
  previous: ReadonlyMap<string, BackgroundTask>,
  terminals: ThreadBackgroundTerminal[],
  now: number,
  taskIdForTerminal: (terminal: ThreadBackgroundTerminal) => string = (
    terminal,
  ) => terminal.processId,
): {
  active: Map<string, BackgroundTask>;
  removed: BackgroundTask[];
} {
  const active = new Map<string, BackgroundTask>();
  for (const terminal of terminals.slice(0, MAX_CODEX_BACKGROUND_TERMINALS)) {
    if (!terminal.processId) continue;
    const taskId = taskIdForTerminal(terminal);
    if (!taskId || active.has(taskId)) continue;
    const prior = previous.get(taskId);
    const name = terminal.command || `Terminal ${terminal.processId}`;
    const unchanged =
      prior?.name === name &&
      prior.taskType === "codex_terminal" &&
      prior.command === terminal.command;
    active.set(
      taskId,
      unchanged && prior
        ? prior
        : {
            taskId,
            name,
            taskType: "codex_terminal",
            startedAt: prior?.startedAt ?? now,
            updatedAt: now,
            ...(terminal.command ? { command: terminal.command } : {}),
          },
    );
  }
  const removed = [...previous.values()].filter(
    (task) => !active.has(task.taskId),
  );
  return { active, removed };
}
