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

Status (2026-11-05): steps 1, 3, 4 and 5 landed: the sub-tabs and their
restore mapping, the header rows, Overview (Git status from the island's
`git-status` presentation, PR status with the one Merge, Findings) and the
rail, from the pull request's own totals, reviewers, assignees and labels
(engine and control plane read them from the same pulls response). Step 2 is
open: the Changes tab still cannot prove its Branch comparison is the
published diff, because the renderer never learns the comparison's head SHA
(the engine's diff and the worker's need to return it). Until then the
published diff, where Post to PR works, stays one step from Overview's rail
(Open changes, the `changes` destination). Step 6 landed after it:
Description, Activity, Checks and Commits sit in Overview's inset under a
section header; Description edits the body through the provider's
`updateBody` (`gh.prUpdate`, Local and cloud); Activity filters All, People
and Bots once an App has taken part and folds an App's review to one line
until Show; Checks opens on a summary card (counts, Add failures to chat, one
bar) and ends with deployment cards; Commits group by day with co-authors,
Copy, Open and the short SHA; the merge menu says what each method does to
the commits. Still open, each needing data the renderer doesn't have:
Re-run failed, Required badges and the Expected group (rerun and
branch-protection reads in the engine and control plane), a commit's check
state and chat link, GitLab and Bitbucket (RevProviders), and RevEmpty's
own Create pull request (it stays in the status row above) with step 7's
narrow fold of the header.

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

Status (2026-11-05): landed. `CHANGES_FILE_CARD_CSS` gives each item host
the 12px inset, a 1px border1 edge and 8px corners that clip; the layout has
a 12px top and gap, and a collapsed header drops its bottom rule. The inset
and edge are `!important`: a `:host` declaration loses to any document rule
for the same property, and preflight resets every element's margin and
border (the base layer also sets `outline-color`, so an outline edge painted
in the focus colour, under the code). `diffHeaderHeight` is 38, the 36px
header plus both edges, with `paddingBottom` 0: Pierre sizes a collapsed
file as its header region alone, so splitting the edges between the two
would leave each collapsed file 1px short. The smoke loads again (its
virtual fixture sits under a renderer serve root) and measures the cards
where it pinned flush headers.

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

Landed 2026-11-05; see the README's status log. Only the Style sections in use
show, and one Add property menu reveals Stroke, Effects, Typography,
Transform, Transition, Motion or Advanced and runs that section's own add
(`design-addable-sections.tsx`, through `InspectorSection`'s `addable`). In-field
labels and suffixes are fg3; the selected layer fills bg2-highlight (rows were
already 28px in `design-workspace-sidebar-panels.tsx`); long values end in an
ellipsis in fields and in the CSS tab. A failed Git init is one red line in
Design and in the Changes tab's Initialize Git (`EmptyStateError`), the
conflict pause is the empty-state recipe with its files in one quiet card that
opens them in Changes, and every canvas readout is one 18px chip with 4px
corners and no edge (`design-canvas-chip.ts`). The Design smokes reach hidden
sections through `addDesignSection` (`ui-smoke-design-helpers.mjs`).

The six component sheets' remaining spec lines landed after it (see the
audit): field states and the overlays on a field's end, owned and hidden
layer rows, the Layers messages and inline rename, the Inspector's header, section and segmented geometry, the
popover sizes and fills, and the theme editor's rail, table and modes. A
field's fill lives in `--zd-field-fill`, which its overlays read, and a
property popover raises the resting fill through `--zd-field-rest`. Still
open: the variable glyph and Detach variable in a bound field, the layer name
in the selection header, and the theme editor's row actions.

## 8. Web app: the dashboard, account pages and Ops

Boards: `web-app.md`. Landed on 2026-11-05:

- **Sign-in.** One page with Continue with Google and Continue with GitHub,
  both primary with their logos, stacked at 260px. Each sends one exact
  `provider=google|github` to `/auth/start`, which starts that provider
  directly. The owner chose this over the hosted chooser
  (`docs/workos-authentication-migration.md`); Ops, workspace pages and
  step-ups stay on Hosted AuthKit.
- **One shell.** `apps/web/lib/page.ts` follows the canvas recipe: the logo
  top-left, a 32px mark, an 18/24 title, one line, 28px actions, status and
  meta lines and the recovery-code box. Logos and tokens are inline, so it
  renders under every page's policy, and a test keeps the tokens equal to
  `styles/zeros-tokens.css`. The control plane's sign-in completion and
  failure pages and the cloud GitHub page use a verbatim copy
  (`apps/control-plane/src/hosted-page.ts`, kept equal by a test) and allow its
  stylesheet by hash.
- **Copy.** Every centred app page follows its frame: desktop sign-in, GitHub,
  invitations, cloud workspaces, the sign-in callback and the account states,
  which are now centred pages with one primary. Every failure ends on Open
  Zeros or Try again, and an expired GitHub handoff keeps Open Zeros without
  its nonce.
- **Removed frames.** The Auth0 rollback sign-in and callback, `/launch` and
  the legacy `?scheme=` handoff left the code with Auth0 (#800) and are gone
  from the canvas.

Still to do:

- **Dashboard** (`public/dashboard.css`, `public/dashboard.js`,
  `lib/dashboard.mjs`): the mac Settings anatomy (256px sidebar, 32px rows
  with 14px icons, 12px group labels, a 640px column, grouped cards with 12px
  corners), cloud organizations only (Local is gone from the web), the
  switcher as the first nav row, Sign out in Profile, Delete account as a
  destructive-secondary in a normal group, the 400px dialog recipe, toasts
  in the floating family.
- **Ops** (`public/ops.css`, `lib/ops.ts`): sign-in, reauthentication, access
  denied and unavailable on the shared shell with an Ops badge, and the
  console on the dashboard shell. The Ops host's policy allows no inline
  style, so these pages must send their own policy with the shell
  stylesheet's hash, as the control plane's pages do.
- **Open in Zeros on a cloud workspace.** The workspace page needs an app link
  that opens a cloud workspace; `zeros://workspace/<id>` is a Local link.

Verify with `node --test apps/web/lib/*.test.mjs` and renders of each board
in both themes; `check:web-deploy` checks the live Pages deployments and
needs network access.
