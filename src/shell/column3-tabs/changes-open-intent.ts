// ──────────────────────────────────────────────────────────
// changeOpenIntent — the viewer intent for opening a change row
// ──────────────────────────────────────────────────────────
//
// Pure (no React/git) so the intent rules are unit-testable: an active turn
// filter wins (that turn's authored diff); otherwise the scope decides which
// diff the viewer shows and whether the Discard affordance applies (only the
// "All changes" filter on a file with uncommitted work). Used by the Changes
// tab so a row click, the Viewed auto-advance sweep, and the filter-change
// re-tag all agree.

import type { TurnInfo } from "@/native/turns";
import type { OpenFileOpts } from "../use-open-file-in-row1";
import type { ChangedFile } from "./changes-parse";
import type { Scope } from "./changes-scope";

export function changeOpenIntent(
  scope: Scope,
  turnFilter: TurnInfo | null,
  file: ChangedFile,
): OpenFileOpts {
  // Turn filter active → the file's per-turn (authored) diff.
  if (turnFilter) {
    return {
      diff: true,
      diffScope: "turn",
      turnChatId: turnFilter.chatId,
      turnId: turnFilter.turnId,
    };
  }
  const diffScope = scope.kind === "commit" ? "commit" : scope.kind;
  return {
    diff: true,
    diffScope,
    diffSha: scope.kind === "commit" ? scope.sha : undefined,
    discardable: scope.kind === "all" && file.committed === false,
    isNewFile: file.isNewFile === true,
  };
}

/** Preserve the historical diff identity while Viewed auto-advance swaps the
 * viewer to another path. `diffScope` alone is insufficient for commit/turn
 * diffs: their SHA or chat/turn ids select the actual comparison. */
export function changeAdvanceIntent(
  identity: Pick<
    OpenFileOpts,
    "diffScope" | "diffSha" | "turnChatId" | "turnId"
  >,
): OpenFileOpts {
  return { diff: true, ...identity };
}
