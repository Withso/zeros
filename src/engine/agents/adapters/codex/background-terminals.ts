// Codex background-terminal normalization.
//
// The app-server endpoint is paginated and returns process telemetry with a
// bigint field. The renderer intentionally needs none of that chrome: it gets
// the same compact Background Task rows as Claude (name, elapsed, Stop). This
// module keeps pagination/bounds and lifecycle reconciliation pure enough to
// race-test without booting a Codex child process.

import type { BackgroundTask } from "@zeros/core/agent-events";

import type { ThreadBackgroundTerminal } from "./generated/v2/ThreadBackgroundTerminal";
import type { ThreadBackgroundTerminalsListResponse } from "./generated/v2/ThreadBackgroundTerminalsListResponse";

export const MAX_CODEX_BACKGROUND_TERMINALS = 100;

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

export function reconcileBackgroundTerminals(
  previous: ReadonlyMap<string, BackgroundTask>,
  terminals: ThreadBackgroundTerminal[],
  now: number,
): {
  active: Map<string, BackgroundTask>;
  removed: BackgroundTask[];
} {
  const active = new Map<string, BackgroundTask>();
  for (const terminal of terminals.slice(0, MAX_CODEX_BACKGROUND_TERMINALS)) {
    if (!terminal.processId || active.has(terminal.processId)) continue;
    const prior = previous.get(terminal.processId);
    const name = terminal.command || `Terminal ${terminal.processId}`;
    const unchanged =
      prior?.name === name &&
      prior.taskType === "codex_terminal" &&
      prior.command === terminal.command;
    active.set(terminal.processId, {
      taskId: terminal.processId,
      name,
      taskType: "codex_terminal",
      startedAt: prior?.startedAt ?? now,
      // Preserve an identical observation's timestamp so periodic reads don't
      // rematerialize hot renderer selectors once per poll.
      updatedAt: unchanged ? prior.updatedAt : now,
      ...(terminal.command ? { command: terminal.command } : {}),
    });
  }
  const removed = [...previous.values()].filter(
    (task) => !active.has(task.taskId),
  );
  return { active, removed };
}
