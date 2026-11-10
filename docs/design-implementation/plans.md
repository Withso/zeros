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
the commits.

Status (2026-11-06): the data-backed leftovers landed, Local through the
engine and cloud through the control plane and the worker. Checks marks the
checks the base branch requires (branch protection and rules), lists required
checks that haven't reported in Expected, and Re-run failed restarts the
head's failed Actions runs only while the reader still sees that head. A turn
records the commits its own shell tools made once git finds them
(`TurnInfo.commits`, engine migration v45), and `turns.commits` names the
chat behind a pull request's commits: Commits rows link to it beside their
combined check result (`statusCheckRollup`), and Activity says which chat a
commit came from and adds the head's check failures with View checks. The
comment box shows the GitHub account it posts as, and a GitHub thread's reply
row shows the account its read used. RevEmpty says when the remote is another
host, and a first read that fails keeps the known header rows above the
banner's Retry. Still open: step 2 (posting from Changes).

RevProviders is a layout reference, not planned work (owner, 2026-11-05):
GitLab merge requests and Bitbucket pull requests are not being built now.
The Review tab already reads the host label and the merge methods from
`ReviewProvider` (`shell/pr/review-provider.ts`), whose capabilities also
name the review noun, and `ForgeFamily` lists GitLab and Bitbucket. An
adapter resolved from the origin host would fill the same rows; its copy
would then read the noun ("merge request") instead of the fixed "pull
request" wording.

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

Status (2026-11-05): landed. Diffs carry comments only, in Changes and in a
Files tab's diff. The Accept and Reject rows, the Reject dialog, the
renderer's hunk model, cache and hook, `git.reviewHunks` and
`git.reviewHunk` with their decision store, and the protocol's hunk schemas
are gone; decisions under `git.hunk-review.v1:` are no longer read. Stage,
unstage and discard keep their own hunk operations. The rest of
`platform/git-review-actions.ts` went with §4.

## 4. Merge conflicts in place

Boards: `ChgConflicts` and the Files conflict frames. Mark each conflict in
the editor (current lines in green under a HEAD band, incoming in blue above
the branch band) with Accept current, Accept incoming and Accept both above
it, and a navigator beside the file name (previous, next, 1 / 2). Accepting
is an ordinary edit, so ⌘Z undoes it and the file saves as usual; the
Resolve conflicts panel, its preview strip and Save resolution go.
Unpaired markers and read-only views show one notice and no buttons. Diff
view waits while conflicts remain.

Status (2026-11-05): landed. The Files editor marks each block in its rows
and gutter with the three accept buttons above it
(`code-editor/merge-conflict-blocks.ts`); an accept is one ordinary
transaction, so ⌘Z undoes it and autosave and ⌘S save it. A Changes card
draws the same rows in Pierre (`merge-conflict-pierre.tsx`) and writes an
accept through the ordinary file write, only over the text it shows; a file
that changed since refreshes instead (`changes-conflict-accept.ts`). Both
carry the navigator; a read-only view marks the blocks and points to the
editable file. Diff view waits while Git lists the file as conflicted, not
while markers remain, so the last accept never swaps editors and drops its
undo history. The Resolve conflicts panel, `platform/git-review-actions.ts`
and the `git.resolveConflict` operation are gone; `conflictReplacement` in
`@zeros/protocol/merge-conflicts` keeps CRLF and a missing final newline
exact. The conflict colours are tokens (`conflict-*`, and the solid
`green`, `blue` and `neutral` `-secondary` fills).

## 5. Diff rows: signs, bar and new files

Boards: `FilesDiffView`, `ChgDiffUnified`. Inside Pierre's shadow DOM: a 2px
change bar on the gutter edge with the + or − in the number padding, no row
wash for a new or untracked file (bar and + only), the caret line's fg1 5%
lift over any row colour, and a wrapped line's wash and bar down every
visual line. These are CSS on `[data-column-number]` and the line rows plus
a host attribute for new files; verify against both themes and the
text-selection smoke.

Status (2026-11-05): landed in Changes and the Files Diff view. The + or −
sits in the number's right padding, on a wrapped row's first visual line,
and a comment chip takes that corner on the row it shows on. The change bar
is a solid 2px. A new or untracked file keeps its bars and + without the row
or gutter wash (Changes keys on Pierre's `data-change-type="new"` header; the
Files Diff view applies it when its base is empty). The caret line lifts by
fg1 5% over any row colour, and turning Diff view on or off moves no text.

## 6. Comment authors

Board: `ChgThread`. Agents get their mark (Claude, Codex, Cursor) on a
rounded square with an Agent badge; GitHub authors show their avatar, review
apps their logo with a Bot badge; initials until an image loads. The thread
model needs the avatar URL and the agent provider for each comment.

Status (2026-11-05): landed on Changes and Files diffs. People show a round
photo or initials; agents their bundled mark with an Agent badge; review
apps their logo with a Bot badge; the provider suffix and the Human label are
gone. GitHub comments keep the avatar the engine and the control plane
already sanitise (`gh.prInlineReview`), so Local and cloud threads both show
photos; the wire actor schema is unchanged.

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
property popover raises the resting fill through `--zd-field-rest`.

The last three landed after them. A field bound to a variable shows the
variable glyph, and Detach variable writes the value it resolves to as a
plain value (colour fields and number fields alike). The selection header
names the layer or frame, with its type beside it only when the two differ;
the selection smokes read `data-design-selection-type` instead of its text.
Each theme row has a ⋯ with Rename… and Delete. Rename moves a variable's
`:root` and theme declarations to the new name; it waits while anything
reads the variable or an `@property` rule registers it, because no operation
rewrites the `var()` references yet, and the menu says which; a taken or
invalid name is refused with its reason. Delete removes the declarations,
asking first, in a small dialog, when something reads the variable; the
editor window itself stays non-modal.

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

- **Dashboard** (`public/dashboard.css`, `public/dashboard.js`,
  `lib/dashboard.mjs`). One set of markup builders in `public/dashboard.js`
  paints the server's first frame and every re-render, so the two cannot
  drift. The web lists cloud organizations only: Personal is each device's
  local space and never appears, and without a cloud organization Profile is
  the only section, offering Create organization when the account may create
  one. The switcher is the first nav row; its menu shows the role you hold,
  because organizations carry no member count. Profile holds the sign-in
  identity, Organizations (none yet, loading, or unreachable with a retry),
  recoverable organizations by name (`GET /v1/deletions` now returns
  `targetName`), Sessions with Sign out, and Delete account. General offers
  Remove only when a logo is set. Members gives admins a role select and a
  More actions menu (Remove from organization, Leave organization) and
  members a Leave button on their own row; pending invitations show their
  expiry and Revoke. Teams says "Everyone in <organization>", because teams
  carry no count. Sections load as skeleton rows and fail with Try again;
  dialogs follow the 400px recipe; toasts carry an icon and Dismiss, three at
  most. The page follows the system appearance before first paint.
- **Ops** (`lib/ops-pages.mjs`, `lib/ops.ts`, `public/ops.css`,
  `public/ops.js`). Sign-in, reauthentication, access denied and unavailable
  use the shared shell with Ops beside the logo. The console uses the
  dashboard layout: Deletion recovery, plus Identity recovery as its own
  section for platform owners (`?section=identity`, a new frame). The Ops
  host allows no inline style or script, so each page sends that policy plus
  one nonce, for the shell's stylesheet or the console's theme script, and the
  Ops host now serves `dashboard.css` and its tokens. Owners see Force purge
  disabled: developers run it with an owner's grant.

- **Open in Zeros on a cloud workspace.** The workspace page
  (`/workspace/<id>`) reads `GET /v1/cloud-v2/workspaces/<id>`, which answers
  only the workspace's creator while they are a member, and its Ready state
  offers Open in Zeros through
  `zeros[-channel]://cloud-workspace/<organization>/<workspace>`
  (`packages/protocol/src/cloud-workspace-link.ts`; the deployment picks the
  channel's scheme, and a root test keeps the web's string equal to the
  desktop parser). Electron main carries it on the Local links' navigation
  intent, so it opens a window and waits for the signed-in app. The desktop
  reads the workspace as the signed-in account, switches to its organization
  and opens it as the sidebar does, without starting it (since 2026-11-10 a
  link never starts a workspace; the first interaction does), and an archived
  one opens read-only. A cloud workspace's menu has Copy link, which copies
  the web page. Numbered `<organization ID>/w/<n>` pages and links followed;
  see `docs/cloud-workspaces.md`. The page's invite route and its two frames are gone: cloud
  workspaces are creator-only and the accept API was retired with cloud v1.

Nothing in §8 is left.

Verify with `node --test apps/web/lib/*.test.mjs` and renders of each board
in both themes; `check:web-deploy` checks the live Pages deployments and
needs network access.
