import { createHash } from "node:crypto";
import type {
  ChangesHistory,
  TurnIdentity,
  TurnHistoryCursor,
} from "@zeros/protocol/changes-history";
import { listTurnsForWorkspace, type TurnRow } from "../db/turns";
import { diff, type DiffOptions, type DiffResult } from "./diff";
import { GitError } from "./errors";
import { runGitRead } from "./git-exec";
import { resolveRepoForGitOp } from "./worktree";
import { mapBounded } from "./bounded-parallel";
import { repoToplevel } from "./turns-git";

/** Git addresses a primary checkout by its registered path; historical chat
 * rows used the shared local-main id. Resolve both at the engine boundary and
 * constrain that legacy id to this exact repository, never another checkout. */
export async function listHistoryTurns(
  workspaceId: string,
  options: {
    limit?: number;
    offset?: number;
    before?: number;
    after?: TurnHistoryCursor;
  } = {},
): Promise<TurnRow[]> {
  const workspace = await resolveRepoForGitOp(workspaceId);
  const primary =
    workspace.id === "local-main" || workspace.id === workspace.repoRoot;
  const root = primary ? await repoToplevel(workspace.path) : null;
  return listTurnsForWorkspace(
    primary ? workspace.repoRoot : workspace.id,
    options.limit ?? 200,
    options.offset ?? 0,
    options.before,
    {
      after: options.after,
      ...(primary
        ? {
            localMainRoots: [
              ...new Set([workspace.path, ...(root ? [root] : [])]),
            ],
          }
        : {}),
    },
  );
}

function invalid(message: string): never {
  throw new GitError({ code: "VALIDATION_FAILED", message });
}

function sameTurn(turn: TurnRow, id: TurnIdentity): boolean {
  return turn.chatId === id.chatId && turn.turnId === id.turnId;
}

/** Select inclusive endpoints from the workspace's complete, newest-first
 * timeline. Never substitute another workspace or silently widen a lost range. */
export function selectHistoryTurns(
  turns: TurnRow[],
  selection: Extract<
    ChangesHistory,
    { kind: "turns" | "last-turn" | "turn-range" }
  >,
): TurnRow[] {
  if (selection.kind === "last-turn") return turns.slice(0, 1);
  if (selection.kind === "turns") return turns;
  const from = turns.findIndex((turn) => sameTurn(turn, selection.from));
  const to = turns.findIndex((turn) => sameTurn(turn, selection.to));
  if (from < 0 || to < 0)
    invalid(
      "A selected turn is no longer available. Choose another turn range.",
    );
  return turns.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** A file uses the snapshots of the turns that actually touched it. Comparing
 * just the outermost whole-workspace snapshots loses overlapping chat edits
 * and includes unrelated files. Group equal comparisons into one Git read. */
export function turnHistoryGroups(turns: TurnRow[], onlyPath?: string) {
  type Lineage = {
    base: string | null;
    head: string | null;
    first: number;
    last: number;
    paths: Set<string>;
  };
  const paths = new Map<string, Lineage>();
  for (const [index, turn] of [...turns].reverse().entries()) {
    const endedAt = turn.endedAt ?? turn.startedAt ?? index;
    for (const file of turn.files) {
      const old = file.oldPath ? paths.get(file.oldPath) : undefined;
      const current = paths.get(file.path);
      const prior = old ?? current;
      const entry = prior ?? {
        base: turn.preSnapshot,
        head: turn.postSnapshot,
        first: index,
        last: endedAt,
        paths: new Set<string>(),
      };
      // A rename can replace an already edited destination. Merge all aliases
      // into one lineage so no path is emitted by two different comparisons.
      if (old && current && old !== current) {
        if (current.first < entry.first) {
          entry.first = current.first;
          entry.base = current.base;
        }
        if (current.last > entry.last) {
          entry.last = current.last;
          entry.head = current.head;
        }
        for (const path of current.paths) {
          entry.paths.add(path);
          paths.set(path, entry);
        }
      }
      // Concurrent turns can finish out of start order. The final file is in
      // the last completion's snapshot, not necessarily the newest start's.
      if (endedAt >= entry.last) {
        entry.last = endedAt;
        entry.head = turn.postSnapshot;
      }
      entry.paths.add(file.path);
      if (file.oldPath) {
        entry.paths.add(file.oldPath);
        // Keep the old name in the same lineage. Recreating it in a later
        // selected turn must update this comparison, not emit a second diff
        // for a path that the rename comparison already covers.
        paths.set(file.oldPath, entry);
      }
      paths.set(file.path, entry);
    }
  }
  const groups = new Map<
    string,
    { base: string; head: string; paths: Set<string> }
  >();
  for (const entry of paths.values()) {
    if (onlyPath && !entry.paths.has(onlyPath)) continue;
    if (!entry.base || !entry.head) {
      invalid(
        "A selected turn's snapshots are unavailable. Choose another turn range.",
      );
    }
    const key = JSON.stringify([entry.base, entry.head]);
    const group = groups.get(key) ?? {
      base: entry.base,
      head: entry.head,
      paths: new Set<string>(),
    };
    for (const path of entry.paths) group.paths.add(path);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    paths: [...group.paths],
  }));
}

export async function historyDiff(
  options: Pick<
    DiffOptions,
    | "workspaceId"
    | "filePath"
    | "oldFilePath"
    | "rawPatch"
    | "summaryLimit"
    | "base"
    | "fullContext"
  >,
  selection: ChangesHistory,
): Promise<DiffResult> {
  if (selection.kind === "commits") return diff({ ...options, mode: "base" });
  if (selection.kind === "commit-range") {
    const workspace = await resolveRepoForGitOp(options.workspaceId);
    const { stdout } = await runGitRead(workspace.path, [
      "rev-list",
      "--parents",
      "--max-count=1",
      selection.from,
    ]);
    const [sha, parent] = stdout.trim().split(/\s+/);
    if (!sha) invalid("The first selected commit is unavailable.");
    // Git recognizes the empty tree even when the repository has never stored
    // an empty commit. Honor both supported object formats for a root range.
    const emptyTree = createHash(sha.length === 64 ? "sha256" : "sha1")
      .update("tree 0\0")
      .digest("hex");
    return diff({
      ...options,
      mode: "range",
      base: parent ?? emptyTree,
      head: selection.to,
    });
  }

  // -1 is SQLite's unbounded LIMIT. The menu is paginated separately; an All
  // Turns comparison must also include turns beyond the first menu page.
  const turns = selectHistoryTurns(
    await listHistoryTurns(options.workspaceId, { limit: -1 }),
    selection,
  );
  const groups = turnHistoryGroups(turns, options.filePath);
  const queries = groups.map((group) => ({
    ...options,
    mode: "range" as const,
    base: group.base,
    head: group.head,
    // Authored paths are literal filenames, never caller-supplied Git globs.
    filePaths: group.paths.map((path) => `:(literal)${path}`),
  }));
  let summary: DiffResult | undefined;
  if (options.summaryLimit !== undefined) {
    if (
      !Number.isSafeInteger(options.summaryLimit) ||
      options.summaryLimit < 0 ||
      options.summaryLimit > 100_000
    )
      invalid("Invalid history summary limit");
    const metadata = await mapBounded(queries, 4, (query) =>
      diff({ ...query, summaryLimit: 0 }),
    );
    const files = metadata.flatMap((result) => result.files ?? []);
    summary = { hunks: [], files, summary: true };
    // Apply the limit to the entire selected range, not each individual turn.
    if (files.length > options.summaryLimit) return summary;
  }
  const results = await mapBounded(queries, 4, async (query) => {
    try {
      return await diff({ ...query, summaryLimit: undefined });
    } catch (error) {
      if (
        summary &&
        error instanceof GitError &&
        error.message.startsWith("diff is larger than ")
      )
        return null;
      throw error;
    }
  });
  const patchBytes = results.reduce(
    (bytes, result) =>
      bytes +
      Buffer.byteLength(
        result?.patch ?? result?.hunks.map((hunk) => hunk.body).join("") ?? "",
      ),
    0,
  );
  if (
    results.some((result) => result === null) ||
    patchBytes > 64 * 1024 * 1024
  ) {
    if (summary) return summary;
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message:
        "Selected history is too large to display. Select a smaller range or an individual file.",
    });
  }
  return {
    hunks: results.flatMap((result) => result?.hunks ?? []),
    ...(options.rawPatch
      ? { patch: results.map((result) => result?.patch ?? "").join("") }
      : {}),
  };
}
