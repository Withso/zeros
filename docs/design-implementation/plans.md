# Design implementation: plans for the larger functional changes

The page specs (`<page>.md`, generated from the Zeros Design canvas) say what
each board shows. This file says how to build the changes that are more than
styling: the code each one touches, the order, the tests and the Local and
cloud behavior. Each section is one reviewable change. Write the failing test
or usage example first (zstack), keep persisted keys readable, and log the
result in the README's status log.

## 1. Review: the new information architecture

Boards: every `Rev*` board in `review-tab.md`.

1. **Sub-tabs and persistence.** `ReviewSubtab` becomes
   `overview | description | activity | checks | commits`
   (`shell/workbench/tab-model.ts`). Read a persisted `"changes"` as
   `"overview"` and `"reviews"` as `"activity"` where tab state is restored
   (`column3-tabs-by-scope-v1`, see `docs/navigation-state-persistence.md`).
   `use-open-review-tab.ts` keeps sending `"checks"` for Show checks. Test:
   restoring each old value lands on its new tab.
2. **Post to PR moves to Changes first.** Posting needs the PR's confirmed
   head and base SHAs (`use-github-review.ts:173-226`). Pass them to the
   Changes surface when its comparison is the PR base, the way
   `review-tab.tsx:294-300` does today, so the composer's Pull request
   segment works there. Only then delete `review-changes.tsx`, its sub-nav
   entry, `ViewedToggle`, `FilePathLabel`, `RowChevron`, the
   `harness-review-comparison` page and `ui-smoke-review-comparison.mjs`
   (and its call from `ui-smoke-code-review.mjs`). Test: a Changes comment
   against the PR base posts with both SHAs; a stale head blocks it with the
   moved-diff notice.
3. **Header in rows.** State chip; repo and number; title at 20/28; author
   and branches with copy; age and size. Only Open on GitHub and More stay
   in the header. Merge, Ready for review and Archive move into PR status.
4. **Overview.** Split the status row's one derived state
   (`shell/pr/pr-status.ts:237-424`): local and branch kinds (uncommitted,
   ahead, behind, diverged, conflicts, behind base) feed **Git status**, one
   line with its one action and a chevron for the checklist; the GitHub kinds
   feed **PR status**: the verdict, the one action (Merge with the remembered
   method, Merge when ready, Ready for review, Archive), only the blockers with
   Add to chat, and what's done in one line. On Review the status row stops
   rendering (`workbench-pane.tsx:292-301,535-541`), so there is one Merge.
   **Findings** are inline threads whose author is a bot, check annotations
   and the agent's workspace comments, each with Add to chat and Add all to
   chat in the heading (`pr-action-prompts.ts:80-116`).
5. **Rail.** Reviewers with reviewDecision, assignees, labels, linked issue,
   and the change counts from the PR's own additions, deletions and files
   (no full diff read per sub-tab). New reads in `engine/git/github.ts` and
   `platform/git.ts`; cloud workspaces take the same reads through the
   worker's GitHub path.
6. **Description, Activity, Checks, Commits** as their boards show:
   Description renders the body with Edit in place; Activity puts events on
   one rail with All / People / Bots and an optimistic Posting… card;
   Checks gets a summary card with a segmented bar and the Failed, Expected,
   Running, Passed, Skipped groups; Commits group by day with the agent
   co-author and the chat each came from.
7. **Narrow.** Below 760px the rail folds into a Details list after PR
   status.

Verification: the review unit suites, `ui-smoke-code-review`, the PR action
smokes and renders of every `Rev*` board in both themes, Local and cloud.

## 2. Changes: one card per file

Board: `ChgWindow`. The diff is one virtualized Pierre `CodeView`
(`changes-diff-options.ts`). Give the layout a 12px `gap` and 12px inline
padding, draw each file's border1 edge and 8px corners on its item host in
the shadow CSS, and raise `diffHeaderHeight` and the item spacing in
`itemMetrics` by the same amounts so the virtualizer's estimates match the
painted cards (a mismatch leaves the last card outside the scroll extent).
Run `scripts/ui-smoke-changes.mjs`; it needs its fixture served from inside
Vite's allowed roots, so fix that first (it can't load here today, on this
branch or before it).

## 3. Changes: retire hunk review

Board: `ChgWindow` ("Hunk review is gone"). Remove the Accept and Reject rows
from `review-annotation-view.tsx` and the payload that feeds them, then the
renderer client (`platform/git-review-actions.ts`), the `git.reviewHunks`
engine operation and its protocol schemas. Persisted decisions need no
migration once nothing reads them; say so in the PR. The registered
`git-review-actions` ui-smoke asserts hunk controls: rewrite its hunk checks
to assert their absence and keep its other checks (its registry entry lives
in `scripts/ui-smoke/`, a CI-definition path, so the scenario id and export
stay).

## 4. Merge conflicts in place

Boards: `ChgConflicts` and the Files conflict frames. Mark each conflict in
the editor (current lines in green under a HEAD band, incoming in blue above
the branch band) with Accept current, Accept incoming and Accept both above
it, and a navigator beside the file name (previous, next, 1 / 2). Accepting
is an ordinary edit, so ⌘Z undoes it and the file saves as usual; the
Resolve conflicts panel, its preview strip and Save resolution go.
Unpaired markers and read-only views show one notice and no buttons. Diff
view waits while conflicts remain.

## 5. Diff rows: signs, bar and new files

Boards: `FilesDiffView`, `ChgDiffUnified`. Inside Pierre's shadow DOM: a 2px
change bar on the gutter edge with the + or − in the number padding, no row
wash for a new or untracked file (bar and + only), the caret line's fg1 5%
lift over any row colour, and a wrapped line's wash and bar down every
visual line. These are CSS on `[data-column-number]` and the line rows plus
a host attribute for new files; verify against both themes and the
text-selection smoke.

## 6. Comment authors

Board: `ChgThread`. Agents get their mark (Claude, Codex, Cursor) on a
rounded square with an Agent badge; GitHub authors show their avatar, review
apps their logo with a Bot badge; initials until an image loads. The thread
model needs the avatar URL and the agent provider for each comment.

## 7. Design: inspector and layers

Boards: `DsnWindow`, `DsnInspectorFrame`, `DsnInspectorText`,
`DsnInspectorCss`, `DsnThemeEditor`, `DsnInitGit`, `DsnConflicts`.
Inspector fields become filled 28px controls with no resting edge (labels
12 medium fg3, computed values fg2); only the sections in use show, and Add
property adds Stroke, Effects, Typography, Transform, Transition or Motion.
Layer rows move to 28px with the bg2-highlight selection: the row height is
part of `design-layer-layout.ts`, which the canvas tools measure, so change
it there with the layer-panel tests and the Design smokes. Long computed
and theme values end in an ellipsis inside their field. A failed Git init
is one red line under the text, in Design (`design-git-setup.tsx`) and in
the Changes tab's Initialize Git (`NotAGitRepo` in `changes-tab.tsx`), which
still show a filled red box; change both together. The conflict pause lists
its files in one quiet card that opens them in Changes. Canvas readouts
(selection size, rotation, spacing, the agent on the canvas) become one
canvas chip, 18px with 4px corners and no edge (the Badge and
MotionTimeline boards): today each overlay draws its own
`zd-design-selection-label` box, 20px with mixed padding, in
`design-canvas.tsx` and `design-workspace-overlays.tsx`; run the Design
smokes that measure them.

## 8. Web app: the dashboard, account pages and Ops

Boards: `web-app.md`. The centred pages now share one shell
(`apps/web/lib/page.ts`). What remains is per page and in the dashboard:

- **Copy.** Each reason one line under 70 characters; titles that name the
  state (Go to Zeros, Sign-in didn't finish); no dead ends (Open Zeros or Try
  again on every failure, the GitHub expired button stays).
- **Sign-in.** One page for WorkOS and the Auth0 rollback: Continue with
  Google and Continue with GitHub, both primary with their logos, 260px wide.
- **Dashboard** (`public/dashboard.css`, `public/dashboard.js`,
  `lib/dashboard.mjs`): the mac Settings anatomy (256px sidebar, 32px rows
  with 14px icons, 12px group labels, a 640px column, grouped cards with 12px
  corners), cloud organizations only (Local is gone from the web), the
  switcher as the first nav row, Sign out in Profile, Delete account as a
  destructive-secondary in a normal group, the 400px dialog recipe, toasts
  in the floating family.
- **Account pages** become centred pages with one primary; **Ops**
  (`public/ops.css`, `lib/ops.ts`) uses the dashboard shell with an Ops
  badge beside the logo.

Verify with `node --test apps/web/lib/*.test.mjs` and renders of each board
in both themes; `check:web-deploy` checks the live Pages deployments and
needs network access.
