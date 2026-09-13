# Changes comparisons and history

The Changes surface must use the same comparison for its file list, selected
file, line totals, and refreshes. A history selection must reach the engine;
it cannot be reconstructed from the current working tree.

## Comparison contract

| Menu selection    | Comparison                                                                               | Refresh behavior                    |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| Branch            | Selected target's fork point to the working tree, including untracked files              | Follows edits and target changes    |
| Uncommitted       | HEAD to the working tree, including untracked files                                      | Follows edits and staging           |
| Staged            | HEAD to the index                                                                        | Follows staging                     |
| Unstaged          | Index to the working tree, including untracked files                                     | Follows edits and staging           |
| All Commits       | Selected target's fork point to HEAD                                                     | Follows commits and target changes  |
| Commit range      | Parent of the oldest selected commit to the newest selected commit                       | Keeps explicit commit identities    |
| Latest agent turn | Recorded snapshots and authored paths of the newest file-changing turn in this workspace | Follows newly recorded turns        |
| All Turns         | Net changes across every recorded file-changing turn in this workspace                   | Follows newly recorded turns        |
| Turn range        | Net changes across the inclusive selected turn interval                                  | Keeps explicit chat/turn identities |

Git distinguishes the index, working tree, and commit comparisons. In
particular, plain `git diff` omits staged work, while `--cached` compares the
index to HEAD and supports an unborn branch. These are separate inputs, so
porcelain status cannot replace the actual comparisons. See the
[Git diff manual](https://git-scm.com/docs/git-diff).

Commit ranges include both selected endpoints. A root commit compares with the
empty tree because it has no parent; a merge commit uses its first parent.
The menu shows commits belonging to the current branch comparison, not every
unrelated branch's history. Git's parent and ancestry behavior is documented in
the [revision traversal manual](https://git-scm.com/docs/git-rev-list).

Turn ordering uses start time, then immutable chat/turn identities. A range
uses each authored path's earliest pre-snapshot and latest completion's
post-snapshot. This preserves files touched by intervening turns and handles
concurrent turns that finish out of start order. Rename aliases share one
comparison, including a later recreation of an old filename.

## Multi-file review contract

Changes renders the active comparison as one `@pierre/diffs` `CodeView`. The
default presentation places every file in one virtualized scroll region; the
focused presentation feeds the same viewer only the selected file. A path is
the stable item id for the lifetime of a comparison, and content, folding, or
presentation changes advance that item's version. Custom sticky headers own the
per-file path, line totals, copy action, viewed state, and independent fold
control. The shared header owns unified/split layout, fold/expand all, and the
all-files/focused switch.

File cards are contiguous with canvas-colored 36px headers. Hover or keyboard
focus reveals the fold arrow in the file icon's slot and the 12px copy icon.
`changes-diff-options.ts` keeps the native context controls at 24px with 12px
arrows and bridges their colors to the app tokens. Their CSS height and
CodeView's `hunkSeparatorHeight` must agree; inter-file gap, block padding, and
virtual hunk spacing are all zero. The scroller fills its containing pane so
the final header and diff body remain reachable as cards fold or wrap. A 64px
end gutter is part of CodeView's layout (and therefore its scroll extent), not
padding on the viewport or individual files. Both presentations hide the diff
column's scrollbar while retaining wheel, trackpad, and keyboard scrolling.

The first paint uses the comparison's compact Git patch. Patch-derived
`FileDiffMetadata` remains identity-stable because Pierre upgrades that object
in place. When a user expands an unchanged region, `loadDiffFiles` requests a
full-context patch for that exact file and comparison, reconstructs the old and
new contents, and lets Pierre hydrate the partial metadata. Added and deleted
files already contain their only existing side in the patch and do not need a
second read. This follows the library's documented
[`CodeView` and partial-diff hydration model](https://diffs.com/docs).

Rows returned without an inline patch (large-comparison summaries and restored
turn selections) build their first native diff from complete snapshots. Resolved
rows are reused synchronously on remount, including their layout, and probing
uncached rows must not evict those snapshots. Returning to a retained Changes
surface preserves its scroll position and folds; only a new file navigation
request scrolls to and expands the selected file.

Full context is valid only with a literal file path. It has a distinct cache
key from the compact patch, a four-request concurrency limit, and bounded
96-entry/32 MiB renderer caches. A single retained item may exceed the byte
budget so one large file can still finish; the engine independently rejects a
full-tree full-context request and enforces its response-size limit. This keeps
ordinary scope changes fast and avoids multiplying full-file work across every
row. Pierre's account of its
[virtualization, layout, memory, and deferred-highlighting architecture](https://pierre.computer/writing/on-rendering-diffs)
explains why one `CodeView` owns the whole code region.

Renamed files carry the optional `oldFilePath` through `git.diff`. Both names
become literal pathspecs so Git can recognize the rename while loading context.
The original path participates in the file-cache identity and remote secret
checks. Callers that omit it retain the existing single-path behavior.

## Implementation invariants

1. **Preserve comparison identity across the bridge.** `bridgeGitDiff` must send
   the history selection in `workspaceOp` parameters. Falling back to a working
   tree comparison is incorrect even when it happens to show similar files.
2. **Resolve primary-checkout aliases without crossing repository boundaries.**
   Changes addresses the checkout by its path; older records use `local-main`.
   The engine resolves both aliases and constrains them to the exact repository
   folder. Another repository's `local-main` turns cannot enter the result.
3. **Keep authored snapshots available.** They remain until chat deletion or
   reset. Only unattributed recovery checkpoints
   are subject to the existing retention cap.
4. **Page turns by immutable identity.** A keyset cursor prevents row
   updates or deletion from shifting subsequent pages. Offset fields remain
   for older callers, but a cursor takes precedence.
5. **Show errors independently of sidebar visibility.** The main surface exposes a retryable
   error and keeps the last confirmed comparison. Empty messages distinguish
   an empty scope, a request in progress, and a failed request.
6. **Distinguish failed menu reads from empty history.** Menu reads retain known
   entries and expose their own retry action. Git log failures propagate.
7. **Include the target in comparison identity.** Branch and All Commits
   section/file keys include the target branch, and the target travels through
   prefetch, selected-file reads, and the engine request.
8. **Share publication ownership for a refresh generation.** Surfaces observing the same
   refresh generation share a publication token. Older generations cannot
   overwrite newer results.
9. **Treat filenames literally.** Per-file reads use
   literal pathspecs, so a filename such as `[x].txt` cannot include `x.txt`.
10. **Support root commits in restored tabs.** Single-commit tabs use the
    inclusive history comparison instead of assuming `sha~1` exists.
11. **Count the comparison being displayed.** Staged and unstaged counts
    use the same Git comparisons, including when status and diff rename
    settings disagree.
12. **Handle overlapping turn completion and file lineages.** The final
    snapshot follows completion time, and merged rename lineages cannot emit
    duplicate path comparisons. Missing snapshots for an unrelated file do not
    block a requested file's available history.
13. **Load unchanged context by exact file identity.** Whole-comparison patches
    stay compact. Pierre's `loadDiffFiles` callback may request full context only
    for the file whose hidden region the user expands, while preserving the
    original `FileDiffMetadata` object for in-place hydration.
14. **Bound both rendering and retained contents.** One `CodeView` virtualizes
    all visible files. Full old/new snapshots use bounded, concurrency-limited
    caches so all-files mode cannot start an unbounded data waterfall.

These contracts are implemented in the
[bridge](../apps/desktop/src/renderer/platform/bridge/workspace-bridge.ts),
[history engine](../apps/desktop/src/engine/git/history-diff.ts),
[Git comparisons](../apps/desktop/src/engine/git/diff.ts),
[turn database](../apps/desktop/src/engine/db/turns.ts),
[Changes model](../apps/desktop/src/renderer/shell/workbench/tabs/changes-tab.tsx),
[section cache](../apps/desktop/src/renderer/shell/workbench/tabs/changes-snapshot-cache.ts),
and [file cache](../apps/desktop/src/renderer/shell/workspace-file-data-cache.ts).

## Regression evidence

Regression coverage includes:

- A real renderer-bridge-to-service test with temporary Git repositories and
  SQLite, covering all comparison modes, primary checkout aliases, repository
  isolation, and staged rename counts:
  [service integration tests](../apps/desktop/src/engine/workspace/__tests__/changes-history-service.test.ts).
- Inclusive commit and turn ranges, root commits, net cancellation, literal
  filenames, missing endpoints, missing snapshots, rename lineages, overlapping
  turn completion, and explicit target branches:
  [history tests](../apps/desktop/src/engine/git/__tests__/history-diff.test.ts).
- More than one page of commits/turns, tied timestamps, deleted page rows,
  updated revisions, and retention beyond 100 turns:
  [pagination tests](../apps/desktop/src/renderer/shell/workbench/tabs/__tests__/changes-history-list.test.ts)
  and [database tests](../apps/desktop/src/engine/db/__tests__/turns.test.ts).
- Owner/scope/base cache isolation, persistence, and stale-generation races:
  [section-cache tests](../apps/desktop/src/renderer/shell/workbench/tabs/__tests__/changes-snapshot-cache.test.ts)
  and [file-cache tests](../apps/desktop/src/renderer/shell/__tests__/workspace-file-data-cache.test.ts).
- A browser running the real Changes model and bridge against the real engine
  service, Git and SQLite. It selects all scopes, both kinds of range, changes
  the target branch, records a new latest turn, and verifies retained results,
  retry actions, and empty states with the sidebar closed:
  [browser integration](../scripts/ui-smoke-changes-history.mts).
- Dropdown click/hover/keyboard behavior, complete submenu paging, stable range
  selection, 13px text, 14px icons, 16px corners, toolbar layout, all-files and
  focused presentation, per-file controls, independent/global folds, native
  unchanged-context expansion, and wheel/keyboard access to the final painted
  lines with end spacing and hidden scrollbars after folding and resizing:
  [interaction smoke](../scripts/ui-smoke-changes.mjs).
- Full-context reconstruction and compact/full cache-key isolation, including
  native Pierre in-place hydration:
  [diff-data tests](../apps/desktop/src/renderer/shell/workbench/tabs/__tests__/changes-diff-data.test.ts)
  and [file-cache tests](../apps/desktop/src/renderer/shell/__tests__/workspace-file-data-cache.test.ts).

Run the two dedicated browser checks with:

```sh
TMPDIR=/private/tmp node --import tsx scripts/ui-smoke-changes-history.mts
TMPDIR=/private/tmp node scripts/ui-smoke-changes.mjs
```

## Recovery and limits

Already-pruned snapshots cannot be reconstructed accurately from today's
files. A selection requiring missing snapshots now reports that history is
unavailable instead of silently showing another comparison. Existing objects
may also have been collected after their hidden refs were removed; the
[Git garbage-collection manual](https://git-scm.com/docs/git-gc) explains why
retaining refs matters. This change prevents further expiry of authored
history, at the cost of keeping its Git objects for the chat's lifetime.

The integration fixtures use isolated real repositories. Passing them does not
imply recovery of previously deleted snapshots in an existing repository.
