# Review tab: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Review tab”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Review tab · Pull request open (`RevWindow`)

Owner today: `shell/workbench/tabs/review-tab.tsx · review-surface.tsx · review-changes.tsx · shell/pr/pr-status-island.tsx`

Changes:
- Sub-tabs are Overview, Description, Activity, Checks and Commits. The Changes sub-tab is gone: the diff lives in the Changes tab.
- The header reads in rows: state; repo and number; title; author and branches; age and size. Only Open on GitHub and More stay up there.
- Overview is Git status, PR status and Findings. Git status is one line with its one action; the full checklist opens on expand.
- PR status holds Merge: the verdict, only what blocks it with Add to chat, and what’s already done in one line.
- Findings collects comments from agents, bots and code scanning, each with Add to chat; Add all to chat sits in the heading.
- The rail keeps reviewers, assignees, labels and the linked issue, and counts the changes with Open changes.

Code notes:
- Remove the Changes sub-tab: drop "changes" from ReviewSubtab and REVIEW_SUBTABS, make "overview" the default, read a persisted "changes" (column3-tabs-by-scope-v1) as "overview", and rename "reviews" to "activity"; keep "description", "commits" and "checks" (the status row’s Show checks sends "checks"). (`shell/workbench/tab-model.ts:38-43,543,562-576 · shell/workbench/tabs/review-surface.tsx:110 · shell/pr/use-open-review-tab.ts:29-44 · docs/navigation-state-persistence.md:31`)
- Delete review-changes.tsx, its sub-nav entry and render, the Changes-only ViewedToggle, FilePathLabel and RowChevron, and the harness and smoke case that open sub="changes". (`shell/workbench/tabs/review-tab.tsx:549-553,656-673 · review-shared-components.tsx:205-280 · harnesses/harness-review-comparison.tsx:203 · scripts/ui-smoke-review-comparison.mjs`)
- Line comments reach GitHub only from that sub-tab today: posting needs confirmed head and base SHAs, which the Changes and Files tabs never pass. Give the Changes tab the PR’s SHAs when it compares against the PR base, so Post to PR moves there. (`features/code-review/use-github-review.ts:173-226 · shell/workbench/tabs/review-tab.tsx:294-300 · changes-surface.tsx:114-117 · files-tab.tsx:117-120`)
- Git status and PR status split the status row’s one derived state: local and branch kinds (uncommitted, ahead, behind, diverged, conflicts, behind base) go to Git status, the GitHub kinds to PR status. On Review the row itself stops rendering, so there is one Merge. (`shell/pr/pr-status.ts:237-424 · shell/workbench/workbench-pane.tsx:292-301,535-541`)
- Merge in PR status uses the remembered method; the row’s Merge always squashed. (`shell/pr/pr-status-island.tsx:554-575 · shell/workbench/tabs/review-tab.tsx:158-187`)
- Findings are inline threads whose author is a Bot, check annotations (CodeQL) and the agent’s workspace comments; human reviews stay in Activity. Add to chat inserts into the composer like today’s Add to chat; Add all to chat joins them in one message. (`apps/desktop/src/engine/git/github-inline-review.ts:164-207 · shell/workbench/tabs/review-tab.tsx:248-262 · shell/pr/pr-action-prompts.ts:80-116`)
- The changes count reads the PR’s additions, deletions and changed files instead of fetching the whole diff on every sub-tab. (`shell/workbench/tabs/review-tab.tsx:305-436,439-462`)
- New reads for the rail: requested reviewers and reviewDecision, assignees, labels, linked issues and the author’s avatar. (`platform/git.ts:333-358 · apps/desktop/src/engine/git/github.ts:1117-1157`)

## Review tab · No pull request (`RevEmpty`)

Owner today: `shell/workbench/tabs/review-surface.tsx · review-tab.tsx · review-shared-components.tsx · tab-status.tsx`

Changes:
- No pull request: the target branch and Create pull request live here, since Review no longer shows the status row.
- Create pull request carries the agent’s mark: the agent writes and opens it. The menu keeps draft, direct and manual.
- Connect, other host and load failure each say what happened and offer the one next step.
- One empty-state recipe: 28px icon, 14/20 title, 13/18 text, actions 8px below.

Code notes:
- Create PR sends creation to the agent; Create draft PR, Create PR directly, Create draft directly and Create PR manually stay in the menu. (`shell/pr/create-pr-button.tsx:184-200,453-520`)
- Other hosts resolve to no provider and show Review unavailable; the tab itself is hidden for remotes that aren’t github.com. (`shell/pr/review-provider.ts:147-156 · shell/workbench/tabs/review-surface.tsx:82-92 · shell/workbench/tab-capabilities.ts:13-14`)
- The load-failure state sat in 12px padding and the icons were 28px and 40px; both now use the recipe above. (`shell/workbench/tabs/review-tab.tsx:526-528,812-815`)

## Review tab · Loading pull request (`RevPending`)

Owner today: `shell/workbench/tabs/review-tab.tsx (ReviewPendingShell) · shell/pr/pr-status-island.tsx`

Changes:
- Loading keeps what the workspace already knows (repo, number, branches) and draws the rest as skeletons in their final sizes.
- Git status, PR status, Findings and the rail load in place; nothing moves when the pull request arrives.

Code notes:
- ReviewPendingShell has no badge or merge controls and swaps them in later; the row jumps from 11px to 28px when the PR loads. (`shell/workbench/tabs/review-tab.tsx:720-801,746-765,788`)
- Git status can render before GitHub answers: it is local. (`shell/pr/pr-status.ts:270-318`)

## PR header · States (`RevHeader`)

Owner today: `shell/workbench/tabs/review-tab.tsx (MergeControls) · review-shared-components.tsx (PrStateBadge) · review-model.ts`

Changes:
- The header reads in rows: the state; repo and number; the title at 20/28; the author and the branches with copy; age and size.
- Only Open on GitHub and More stay in the header. Merge, Ready for review and Archive move into PR status.
- Open, draft, waiting, merged and closed differ in the state chip, the age line and the PR status card.

Code notes:
- Header rows: state; repo and number; title; author and branches; age and size. Open on GitHub and More are the only header actions; Merge lives in PR status on Overview. (`shell/workbench/tabs/review-tab.tsx:563-605`)
- authorLogin, createdAt and mergedAt are already fetched; PR-level ± counts and the author’s avatar are not. (`platform/git.ts:333-358`)
- The PR status action and its disabled reason read one source. (`shell/workbench/tabs/review-model.ts:167-216`)
- Sub-nav pills were 24px with hidden-scroll overflow; these are the workbench’s 28px pills. (`shell/workbench/tabs/review-tab.tsx:610,620-623 · shell/workbench/tab-chrome.ts:16`)

## PR header · Merge method (`RevMergeMenu`)

Owner today: `shell/workbench/tabs/review-tab.tsx (MergeControls) · shell/pr/review-provider.ts`

Changes:
- The method menu opens from Merge in PR status; each method says what it does to the 3 commits.
- Menus: bg3, border2, 12px corners, 4px inset; the label is 12 medium fg3; the check sits at the end of the chosen row.
- GitHub’s names: Squash and merge, Create a merge commit, Rebase and merge.

Code notes:
- Methods come from the provider’s capabilities and the choice is saved per host under zeros.review.merge-method.github:github.com. (`shell/workbench/tabs/review-tab.tsx:158-187 · shell/pr/review-provider.ts:121-125`)
- Where the base branch uses a merge queue, the queue sets the method: the button becomes Merge when ready and the menu shows the queue.
- Merge buttons disagreed (a hand-built 24px split with 4px corners, a 28px Mark as ready, the row’s 28px Merge); PR status has one 28px split. (`shell/workbench/tabs/review-tab.tsx:579,859-867,891-910 · shell/pr/pr-status-island.tsx:172`)

## PR header · GitLab and Bitbucket (`RevProviders`)

Owner today: `shell/pr/review-provider.ts · shell/workbench/tabs/review-surface.tsx`

Changes:
- GitLab and Bitbucket use the same header, tabs and cards; only host words change: merge request and !42, Pipelines, Builds, Declined.
- Zeros keeps its own verbs on every host (Merge when ready, Update branch, Add to chat); host nouns follow the host.
- The Open on host button names the host; the merge label is the host’s method name.

Code notes:
- The provider seam already has family (github, gitlab, bitbucket-cloud, bitbucket-server), hostLabel, capabilities and a reviewNoun only harnesses use; only the GitHub provider exists. (`shell/pr/review-provider.ts:35-91,114-142`)
- GitHub-only spots to move behind it: the family gate, the “GitHub connection changed” text, the gh commands in the fix prompt, the row’s mergeable_state map and its direct gh calls. (`shell/workbench/tabs/review-tab.tsx:295 · review-data.ts:627,666,677 · shell/pr/pr-action-prompts.ts:90 · shell/pr/pr-status.ts:368-415 · shell/pr/pr-status-island.tsx:371-374`)
- The engine’s ForgeAdapter knows github, gitlab, bitbucket and origin, but checks, commits, reviews and diffs bypass it, and its merge method is GitHub’s three. (`apps/desktop/src/engine/git/forge.ts:3,67,89-100 · apps/desktop/src/engine/workspace/service.ts:4804-4828`)
- Bitbucket has no labels, so the rail hides Labels there; Bitbucket Cloud enforces merge checks only on Premium, so blockers say advisory.

## Overview · Git status (`RevGitStatus`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState)`

Changes:
- Git status is the branch on this machine: one line saying how it stands, with its one action; the chevron opens the full checklist.
- Commit and push, Push, Pull, Resolve and Update branch are the status row’s actions, now beside what they fix.
- While the agent works, the action waits with the reason.

Code notes:
- The local kinds of the status row’s derived state: uncommitted, ahead, behind, diverged, conflicts and behind base. (`shell/pr/pr-status.ts:270-318,380-392`)
- Commit & Push, Resolve and Update branch send a prompt to the agent; Push and Pull act directly. (`shell/pr/pr-status.ts:142-200 · shell/pr/pr-action-prompts.ts:28-70`)
- Prompt and Git actions wait while the agent works. (`shell/pr/pr-status.ts:216-234 · shell/pr/use-agent-working.ts:22`)

## Overview · PR status (`RevReadiness`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState) · shell/workbench/tabs/review-model.ts (reviewActionBlockReason)`

Changes:
- PR status is the pull request on GitHub: the verdict, the one action (Merge, Merge when ready, Ready for review, Archive), only what blocks it with Add to chat, and what’s already done in one line.
- Local Git state moved to Git status; nothing here repeats it.
- Merge is green when it can run and a quiet outline when it can’t.

Code notes:
- Every state maps to a GitHub kind of the status row’s derived state, plus merge when ready. (`shell/pr/pr-status.ts:320-424`)
- Add to chat reuses buildFixCheckPrompt and buildReviewCommentContext. (`shell/pr/pr-action-prompts.ts:80-116`)
- New reads: reviewDecision, required flags on checks and the auto-merge state. (`platform/git.ts:333-358`)
- Merge when ready is GitHub’s Enable auto-merge, GitLab’s Set to auto-merge and Bitbucket’s merge when builds pass; GitHub turns it off when someone without write access pushes, GitLab when commits are added.

## Overview · Findings (`RevAgentReview`)

Owner today: `shell/workbench/tabs/review-timeline.tsx · review-model.ts (composeTimeline)`

Changes:
- Findings are comments from agents, bots and code scanning: what it says, then who and where on a quiet second line.
- Each has Add to chat; Add all to chat in the heading sends them in one message.
- Resolved findings fold away under Show resolved.

Code notes:
- Sources: inline threads whose author is a Bot (coderabbitai, Greptile), check annotations (CodeQL) and the agent’s workspace comments. (`apps/desktop/src/engine/git/github-inline-review.ts:164-207 · features/code-review/inline-review-thread.tsx:28`)
- A finding opens on its line in Changes; resolving it there moves it under Show resolved.
- Bot reviews show today only as timeline cards, with no bot marker. (`shell/workbench/tabs/review-timeline.tsx:289-356`)

## Overview · Narrow pane (`RevNarrow`)

Owner today: `shell/workbench/tabs/review-tab.tsx · review-surface.tsx`

Changes:
- Below 760px the rail folds into a Details list after PR status; nothing is dropped.
- The header rows wrap on their own; Findings and status rows keep their one action on the right.

Code notes:
- The workbench pane resizes; the rail needs 224px plus a 32px gap, so the main column keeps at least about 480px.

## Description · Markdown (`RevDescription`)

Owner today: `shell/workbench/tabs/review-tab.tsx (DescriptionSection)`

Changes:
- Description is its own tab next to Overview: the rendered body with Edit in place.
- Headings 13 semibold fg1, text 13/20 fg2, list markers fg3.
- Empty: Write with Claude drafts it from the commits and the diff; nothing is saved until you save.

Code notes:
- Today the body is read-only markdown of pr.body; Edit needs an update call per host. (`shell/workbench/tabs/review-tab.tsx:805-819`)
- A drafted description records the commit it was written from, so a later push can offer Update instead of going stale.

## Activity · Timeline (`RevTimeline`)

Owner today: `shell/workbench/tabs/review-timeline.tsx · review-model.ts (composeTimeline)`

Changes:
- Reviews becomes Activity: events on one rail; review and comment cards; a failing check; the agent’s commits with the chat they came from.
- Bot comments fold to one line with Show; All, People and Bots filter the feed.
- Verdicts are badges on the card; Add to chat stays on every review.
- The composer says where the comment goes: Posts to GitHub.

Code notes:
- Timeline items are opened, commit, review, comment, merged and closed; the failed check comes from the Checks data, no new read. (`shell/workbench/tabs/review-model.ts:222-263`)
- Bots aren’t marked in the timeline today, only on inline threads; GitHub’s author type (Bot) drives the fold and the filter. (`apps/desktop/src/engine/git/github-inline-review.ts:186 · features/code-review/inline-review-thread.tsx:28`)
- Pending reviews are dropped and closed events use updatedAt; closedAt isn’t fetched. (`apps/desktop/src/engine/git/github.ts:2364 · shell/workbench/tabs/review-model.ts:252-255`)

## Activity · Posting a comment (`RevTimelinePosting`)

Owner today: `shell/workbench/tabs/review-timeline.tsx (CommentComposer, TimelineCard) · review-data.ts`

Changes:
- A sent comment shows at once as a faded card marked Posting…, and the box clears.
- On failure the card goes, the error sits in the box, the text comes back and Comment is ready again.

Code notes:
- The optimistic insert and rollback already exist; the error text names GitHub and needs the host’s name. (`shell/workbench/tabs/review-data.ts:624-661,627,666,677`)

## Checks · Failing (`RevChecksFailing`)

Owner today: `shell/workbench/tabs/review-checks.tsx · review-model.ts · shell/pr/pr-action-prompts.ts`

Changes:
- A summary card: counts, a segmented bar, Re-run failed and Add failures to chat.
- Groups run Failed, Expected, Running, Passed, Skipped; Passed folds while anything fails.
- Rows: status, name, Required, duration; on hover Add to chat and Open logs (↗).
- Expected is a required check that hasn’t reported, so it can’t hide as pending.

Code notes:
- Rows keep the API’s order and there is no re-run; Fix in chat and Add to chat already exist. (`shell/workbench/tabs/review-checks.tsx:88-92,101-135,143-192`)
- Re-run is new: GitHub re-runs failed Actions jobs; checks from other apps need that app.
- Required isn’t fetched; it comes from the base branch’s rulesets or branch protection, and lets Expected show. (`shell/workbench/tabs/review-model.ts:99-132`)
- Add to chat uses buildFixCheckPrompt, whose gh commands need a provider-neutral form before GitLab and Bitbucket. (`shell/pr/pr-action-prompts.ts:80-116`)

## Checks · All passed (`RevChecksPassed`)

Owner today: `shell/workbench/tabs/review-checks.tsx (DeploymentCard)`

Changes:
- All passed: a green summary, Passed open, and each deployment as a card with Open.
- No checks: the empty-state recipe, saying where results will appear.

Code notes:
- Deployment contexts are split out of commit statuses by name, and the summary counts both. (`apps/desktop/src/engine/git/github.ts:2123-2198`)

## Commits · Grouped by day (`RevCommits`)

Owner today: `shell/workbench/tabs/review-commits.tsx · review-model.ts`

Changes:
- Rows show the author with any agent co-author, the chat the commit came from, size and the commit’s checks.
- On hover: Copy SHA and Open on GitHub; the SHA chip stays.
- Day groups keep Today, Yesterday, Last 7 days, then month.

Code notes:
- Rows aren’t clickable today. Author, co-authors, date and ± counts are fetched; there is no agent or turn attribution. (`shell/workbench/tabs/review-commits.tsx · apps/desktop/src/engine/git/github.ts:2245-2319`)
- The chat link needs a local record of which chat turn made each commit; the agent mark comes from its Co-authored-by trailer.
- Per-commit check status is a new read (the commit’s check runs).

## PR status row · No pull request (`RevStatusNoPr`)

Owner today: `shell/pr/pr-status-row.tsx · create-pr-button.tsx · target-branch-select.tsx`

Code notes:
- The load-failure empty state is wrapped in 12px padding (a stray 24px block when managed); No pull request uses a 28px icon while discovery uses 40px. (`shell/workbench/tabs/review-tab.tsx:526-528,812-815 · shell/workbench/tabs/review-surface.tsx:82-92`)
- The PR island is 42px with borders top and bottom, the no-PR row 41px with a bottom border, so the row shifts when a PR appears; the View PR chip is about 24px with a fractional line height. (`shell/pr/pr-status-island.tsx:136,172,814,837 · shell/pr/pr-status-row.tsx:77,99`)

## PR status row · Create PR options (`RevCreatePrMenu`)

Owner today: `shell/pr/create-pr-button.tsx · create-pr-action.ts`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

Code notes:
- Merge buttons disagree: a hand-built 24px split with 4px corners, a 28px Mark as ready, a 28px island Merge with 4px corners and the 28 / 6px shared split. (`shell/workbench/tabs/review-tab.tsx:579,859-867,891-910 · shell/pr/pr-status-island.tsx:172 · shell/pr/create-pr-button.tsx:451-495`)

## PR status row · Target branch (`RevTargetBranch`)

Owner today: `shell/pr/target-branch-select.tsx`

Code notes:
- The head → base pair is drawn twice: 13px sans with a 14px arrow, and 11px mono with a 12px arrow. (`shell/pr/target-branch-select.tsx:181-200,248-253 · shell/workbench/tabs/review-tab.tsx:567-570`)
- Four search-field recipes: a 36px header with a 16px glyph, a 36px command row holding a 40px input, a 40px quick-open row, and a 24px input with a shadow. (`shell/workbench/tabs/files-search-sidebar.tsx:71-80 · shared/ui/primitives/command.tsx:106-112 · shell/workbench/new-tab-menu.tsx:262 · shell/workbench/tabs/changes-surface.tsx:1028-1040`)

## PR status row · Pull request states (`RevIsland`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState) · use-agent-working.ts`

No change beyond the shared foundation and primitives.

## Review tab · More · All states (`States_review_tab_review_surface`)

Composite board: implemented through the boards it imports.

## PR status · Local changes (`RevPrLocal`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState)`

No change beyond the shared foundation and primitives.

## PR status · Draft and checks (`RevPrChecks`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState)`

No change beyond the shared foundation and primitives.

## PR status · Mergeability (`RevPrMerge`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState)`

No change beyond the shared foundation and primitives.

## PR status · Merged and closed (`RevPrDone`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState)`

No change beyond the shared foundation and primitives.

## PR status · Loading and in flight (`RevPrBusy`)

Owner today: `shell/pr/pr-status-island.tsx · pr-status.ts (derivePrIslandState)`

Changes:
- Tooltips are solid bg3 with border2 and 6px corners; the translucent glass retires.
