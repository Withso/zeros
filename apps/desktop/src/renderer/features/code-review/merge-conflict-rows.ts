// What every surface that marks Git conflicts in place shares: the row kind of
// each line in a block, the accept choices, the marker notice, and where the
// reader is among the blocks. The Files editor (CodeMirror) and the Pierre
// views (Changes cards, read-only source) paint these rows their own way.

import type {
  ConflictChoice,
  MergeConflict,
  MergeConflictParseResult,
} from "@zeros/protocol/merge-conflicts";

export type ConflictRowKind =
  | "current-marker"
  | "current"
  | "base"
  | "separator"
  | "incoming"
  | "incoming-marker";

/** The kind of a 1-based line inside `conflict`, from `<<<<<<<` to `>>>>>>>`. */
export function conflictRowKind(
  conflict: MergeConflict,
  line: number,
): ConflictRowKind {
  if (line === conflict.startLine) return "current-marker";
  if (line === conflict.endLine) return "incoming-marker";
  if (line === conflict.separatorLine) return "separator";
  if (line > conflict.separatorLine) return "incoming";
  return conflict.baseLine !== undefined && line >= conflict.baseLine
    ? "base"
    : "current";
}

export const CONFLICT_CHOICES: ReadonlyArray<{
  choice: ConflictChoice;
  label: string;
}> = [
  { choice: "current", label: "Accept current change" },
  { choice: "incoming", label: "Accept incoming change" },
  { choice: "both", label: "Accept both" },
];

/** Blocks a surface can offer accept actions for. Markers that cannot all be
 * paired get one notice and no actions, so nothing rewrites a broken file. */
export function actionableConflicts(
  parsed: MergeConflictParseResult | null | undefined,
): readonly MergeConflict[] {
  return parsed && !parsed.errors.length ? parsed.conflicts : [];
}

export function conflictMarkerNotice(
  parsed: MergeConflictParseResult | null | undefined,
): string | null {
  const error = parsed?.errors[0];
  return error ? `${error.message} Fix it by hand.` : null;
}

export interface ConflictPosition {
  /** 1-based block shown in the navigator. */
  shown: number;
  next: number;
  previous: number;
}

/** Where `line` sits among the blocks: inside one, that one is shown and the
 * arrows step from it; between blocks, the next block below is shown and is
 * where Next goes. Both arrows wrap. */
export function conflictPosition(
  conflicts: readonly MergeConflict[],
  line: number,
): ConflictPosition {
  const count = conflicts.length;
  if (!count) return { shown: 0, next: -1, previous: -1 };
  const at = conflicts.findIndex(
    (conflict) => conflict.startLine <= line && line <= conflict.endLine,
  );
  if (at !== -1)
    return {
      shown: at + 1,
      next: (at + 1) % count,
      previous: (at - 1 + count) % count,
    };
  const below = conflicts.findIndex((conflict) => conflict.startLine > line);
  return below === -1
    ? { shown: count, next: 0, previous: count - 1 }
    : { shown: below + 1, next: below, previous: (below - 1 + count) % count };
}

/** Where a navigator without a caret moves from block `at` (none yet: the
 * first for Next, the last for Previous). */
export function stepConflict(
  at: number | undefined,
  count: number,
  direction: 1 | -1,
): number {
  if (count <= 0) return -1;
  if (at === undefined || at < 0 || at >= count)
    return direction > 0 ? 0 : count - 1;
  return (at + direction + count) % count;
}
