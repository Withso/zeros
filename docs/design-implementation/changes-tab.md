# Changes tab: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Changes tab”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Changes tab · Branch changes (`ChgWindow`)

Owner today: `shell/workbench/tabs/changes-surface.tsx · changes-tab.tsx · changes-diff-viewer.tsx · shell/pr/pr-status-row.tsx`

Changes:
- Hunk review is gone: no Accept or Reject under each hunk in the Uncommitted and Unstaged comparisons, and no Reject dialog.
- Each file is its own card: border1 edge, 8px corners, 12px apart and 12px in from the pane; a collapsed file is its header card.
- Viewed is the checkbox alone; it keeps its Viewed name for screen readers and a Mark viewed tooltip.
- Diff rows use the Files Diff view’s type and colours: 12px on a 1.6 line, 12px number padding, a 2px bar with + or − in the gutter, and the palette’s row, gutter and word washes.
- File tab names keep the tab colour; only the status letter is coloured: M yellow, U green, D red.
- Segmented: 28 track, 24 items; selected is bg1 + border2 in Light, bg4 with no edge in Dark.
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.
- Checkboxes are 16 with a 12px check.
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; while the changes list is open its toggle is a bg2-highlight fill with no edge.

Code notes:
- Hunk review is removed from the design. When implementing, delete its UI and its functionality: the Accept / Reject bar under each hunk (Changes and diffs opened in a Files tab), the Reject dialog, the stored decisions, the git.reviewHunk and git.reviewHunks operations and their tests. Keep merge-conflict resolution, which shares these files and whose input schema builds on the hunk one. (`features/code-review/hunk-review-actions.tsx · hunk-review-cache.ts · use-hunk-reviews.ts · review-hunk-model.ts · review-annotations.ts:36,74,96-160 · review-annotation-view.tsx:35-47 · shell/workbench/tabs/changes-diff-viewer.tsx:172-190,307-323,465,673-729 · file-viewer.tsx:653-660,891,1004-1024 · platform/git-review-actions.ts:17-30,57-85 · apps/desktop/src/engine/git/review-actions.ts:83-218 · hunk-review-store.ts · apps/desktop/src/engine/workspace/service.ts:549,644,737,1154 · apps/desktop/src/engine/zeros-engine.ts:514,565 · packages/protocol/src/git-review-actions.ts:36-55,65-81,102 · packages/protocol/src/review-hunks.ts`)
- Files run together in one stream: CodeView has no gap or item spacing, and each header closes with a border1 rule. (`shared/theme/diff-theme.ts:210-221 · shell/workbench/tabs/changes-diff-viewer.tsx:772`)
- Each header pairs its Viewed checkbox with a Viewed text label. (`shell/workbench/tabs/changes-diff-viewer.tsx:876-890`)
- The diff sets only its font family, so rows keep the diff package’s 13px on a 20px line while the editor and its Diff view use 12px on 1.6. (`shared/theme/diff-theme.ts:75-77 · shell/workbench/tabs/code-editor/theme.ts:38-42`)
- The changes-list toggle is a ghost button that fills bg2-hover while the list is open; the edge came from the proposal’s pressed recipe. (`shell/workbench/tabs/changes-surface.tsx:834-849`)
- A file tab tints its title as well as its status letter with the git colour (M yellow, U green, D red). (`shell/workbench/tab-strip.tsx:370-374,383-386 · shell/workbench/tabs/file-status.ts:4-18`)
- The toolbar row has no gap, so Single file sits flush against Hide changes where every other pair has 4px. (`shell/workbench/tabs/changes-surface.tsx:869-875 · shell/workbench/tabs/changes-diff-viewer.tsx:493`)
- Two tab-pill recipes in one band: chat pills 8px padding, 8px gap, 70–140px; workbench pills 10px padding, 6px gap, up to 180px; both 8px round where tabs spec 6. (`shell/conversation/chat-tabs.tsx:184 · shell/workbench/tab-strip.tsx:332 · shell/workbench/tab-chrome.ts:15-16`)
- Mirrored panel toggles differ: the sidebar toggle is 28px with a 16px glyph at stroke 1.5, the workbench toggle is forced to 24px with a 14px glyph at stroke 1. (`shell/sidebar-toggle.tsx:35-36,52 · shell/workbench/toggle-button.tsx:32-36,50`)
- In the 40px tab band, 28px pills and a 28px new-tab button sit beside the 24px panel toggle. (`shell/workbench/new-tab-menu.tsx:233-236 · shell/workbench/tab-chrome.ts:16 · shell/workbench/toggle-button.tsx:34-36`)
- Pill focus outlines are hidden at the strip ends by the 4px solid edge gutters and the overflow-hidden viewport. (`shell/use-sticky-tab-strip.tsx:60-61,396-403 · shell/workbench/tab-strip.tsx:306-337 · styles/global/scrollbars.css:18-23`)
- Second-row toolbars use five layouts: hand-built 36px rows with and without gaps, a 36px forced window header, 40px Design and Simulator headers, and Review’s 73 + 37px. (`shell/workbench/tabs/files-tab.tsx:495 · shell/workbench/tabs/changes-surface.tsx:869 · shell/terminal/terminal-workbench-layout.tsx:112 · shell/workbench/tabs/browser-tab.tsx:549 · features/design-workspace/design-directory-pill.tsx:40-41 · shell/workbench/tabs/review-tab.tsx:564,610`)

## Changes tab · No changes (`ChgEmpty`)

Owner today: `shell/workbench/tabs/changes-surface.tsx · changes-tab.tsx (ChangesList)`

Changes:
- Every Changes empty state uses one 24px fg3 icon 12px above one 13/18 fg2 line, the same as the Files tab.

Code notes:
- Four empty recipes in one tab: left-aligned text, a 40px icon overlay, a 28px icon with a 14px title, and a 12px-gap stack. (`shell/workbench/tabs/changes-tab.tsx:408-412,1261,1835-1840 · shell/workbench/tabs/changes-surface.tsx:972-974`)

## Changes tab · Loading (`ChgLoading`)

Owner today: `shell/workbench/tabs/changes-surface.tsx · changes-tab.tsx`

Changes:
- The first load draws shimmering skeleton cards and list rows where the diffs and files will land, instead of an icon over Loading changes…; the pane keeps a Loading changes name for screen readers.

Code notes:
- The first load is the empty-state overlay with Loading changes…, so the pane jumps from an icon to cards when the diffs land. (`shell/workbench/tabs/changes-surface.tsx:970-980`)

## Changes tab · Status banner (`ChgStatus`)

Owner today: `shell/workbench/tab-status.tsx · tab-content.tsx · shell/pr/cloud-history-notice.tsx`

Code notes:
- The tab banner is a fixed 48px even for one line, and its 12px inset sits 4px right of the 8px toolbar above. (`shell/workbench/tab-status.tsx:111`)

## Changes tab · Not a Git repository (`ChgNotGit`)

Owner today: `shell/workbench/tabs/changes-tab.tsx (NotAGitRepo) · changes-surface.tsx`

No change beyond the shared foundation and primitives.

## Changes tab · All states (`States_changes_tab_changes_surface`)

Composite board: implemented through the boards it imports.

## Comparison menu · Open (`ChgScopeMenu`)

Owner today: `shell/workbench/tabs/changes-scope-menu.tsx · changes-scope.ts`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

Code notes:
- The trigger has no hover fill; the menu is 260px but its submenus 320px; Retry is indented 14px against 8; picked rows swap the count for a check, so the trailing column jumps. (`shell/workbench/tabs/changes-scope-menu.tsx:232-246,364-374,394,426-442`)

## Comparison menu · Commit range (`ChgScopeCommits`)

Owner today: `shell/workbench/tabs/changes-scope-menu.tsx (HistoryItems) · changes-history-list.ts`

Changes:
- Several choices keep a left check column; the boxed checkboxes retire.

## Comparison menu · Agent turns (`ChgScopeTurns`)

Owner today: `shell/workbench/tabs/changes-scope-menu.tsx · changes-history-list.ts`

No change beyond the shared foundation and primitives.

## Changed files · Tree (`ChgList`)

Owner today: `shell/workbench/tabs/changes-tab.tsx (ChangesList, TreeRow, FileRow, StatusSquare)`

Changes:
- A viewed row keeps its counts and square at full strength; only the name turns fg2 and the file icon dims to match.

Code notes:
- A viewed row drops to 45% opacity as a whole, counts and status square included. (`shell/workbench/tabs/changes-tab.tsx:1503-1508`)
- Tree steps are 14px, and file rows have no chevron slot, so a child’s icon lands 4px left of its folder’s icon. (`shell/workbench/tabs/changes-tab.tsx:1504-1511,1787-1796`)
- Row heights come from line height: file rows 28, folders 26, section headers 30, while the virtualizer assumes 28; one row mixes 14px names, 13px letters and 11px counts. (`shell/workbench/tabs/changes-tab.tsx:1412,1504,1527,1547,1705,1787 · shell/workbench/tabs/large-change-set.ts:8`)
- Group headers differ: 32px with a 14px chevron (not sticky), 28px sticky for commits, and 30px with a 12px chevron in Changes. (`shell/workbench/tabs/review-shared-components.tsx:106-107,133 · shell/workbench/tabs/review-commits.tsx:55 · shell/workbench/tabs/changes-tab.tsx:1412`)

## Changed files · Row hover (`ChgListHover`)

Owner today: `shell/workbench/tabs/changes-tab.tsx (FileRow, RowBtn)`

Changes:
- Tooltips are solid bg3 with border2 and 6px corners; the translucent glass retires.

## Changed files · Search (`ChgSearch`)

Owner today: `shell/workbench/tabs/changes-surface.tsx · changes-search.ts · changes-tab.tsx`

Code notes:
- The search block is about 70px (a 24px input plus a bare count line, no divider) where Files uses a 36px header. (`shell/workbench/tabs/changes-surface.tsx:1026-1052`)

## Diff viewer · Unified (`ChgDiffUnified`)

Owner today: `shell/workbench/tabs/changes-diff-viewer.tsx · changes-diff-options.ts · shared/theme/diff-theme.ts`

Changes:
- File status is a tag before the checkbox: New in green, Deleted and Conflicted in red, Renamed in grey; a modified file has none.
- A new or untracked file keeps the green bar and + on every line but drops the row wash, as in the Files Diff view.
- Removed lines stay selectable and copyable, as now; numbers, signs, headers and separators stay out of a selection.

Code notes:
- Washes, word marks, edge bars and numbers derive from three base colours and two lab-mixed washes, not from the diff palette tokens. (`shared/theme/diff-theme.ts:66-71,86-91`)
- Source lines, removed ones included, opt back into text selection; headers, gutters and separators stay chrome. (`shared/theme/diff-theme.ts:79-81`)
- A new or untracked file is one all-added hunk, so every line takes the addition wash, though the viewer already knows the file is new. (`shared/theme/diff-theme.ts:90 · shell/workbench/tabs/changes-diff-viewer.tsx:714`)
- The unified / split control is built twice: 24px segments in a 28px track here, a 26px track with a shadow in Files. (`shell/workbench/tabs/changes-diff-viewer.tsx:494-511 · shell/workbench/tabs/file-viewer.tsx:765-789`)

## Diff viewer · Split (`ChgDiffSplit`)

Owner today: `shell/workbench/tabs/changes-diff-viewer.tsx · diff-style-store.ts`

No change beyond the shared foundation and primitives.

## Diff viewer · Collapsed and header states (`ChgDiffCollapsed`)

Owner today: `shell/workbench/tabs/changes-diff-viewer.tsx (ChangesDiffHeader)`

Changes:
- Expanded, a conflicted file’s card shows its conflict blocks with the Files tab’s three buttons and navigator, so its header has no Resolve conflicts button.
- Retry diff is the header’s one action: a compact secondary button 8px after the counts on the file that failed, which today only the tab banner offers; the error stays in its tooltip.
- With all files showing, checking Viewed only marks the file; nothing moves. Only one file at a time moves on.

Code notes:
- A conflicted file carries no patch, so its card has nothing to show below the header. (`shell/workbench/tabs/changes-tab.tsx:515-526`)
- Resolve conflicts is a ghost button before Copy. Retry diff renders only outside a tab status frame, and the Changes tab always has one, so a failed file goes to the tab banner, whose Retry reloads it. (`shell/workbench/tabs/changes-diff-viewer.tsx:678-697,819-827,859-872 · shell/workbench/tab-status.tsx:355-391 · shell/workbench/tab-content.tsx:53-63`)
- The header never names a file’s status; New, Deleted and Conflicted show only as the list’s square. (`shell/workbench/tabs/changes-diff-viewer.tsx:796-818 · shell/workbench/tabs/changes-tab.tsx:1606-1680`)
- Checking Viewed only marks the file, with one file or all files showing; proposed: with one file at a time it then opens the next unviewed file, with all files it stays put. (`shell/workbench/tabs/changes-diff-viewer.tsx:149-154,876-890 · shell/workbench/tabs/use-viewed-files.ts:127`)
- The expand glyph is 14px but copy is forced to 12; both buttons drop their hover fill; the path truncates from the end, so the file name is cut first. (`shell/workbench/tabs/changes-diff-viewer.tsx:780,796-806,832`)
- Three Viewed controls (a checkbox, a 22px hand-built box, an 18px round toggle); viewed rows dim to 45% here and 70% in Review. (`shell/workbench/tabs/changes-diff-viewer.tsx:876-890 · shell/workbench/tabs/file-viewer.tsx:729-743 · shell/workbench/tabs/review-shared-components.tsx:225-231`)

## Diff viewer · One file, list hidden (`ChgDiffSingle`)

Owner today: `shell/workbench/tabs/changes-diff-viewer.tsx · changes-sidebar-visible.ts`

Changes:
- With one file at a time, checking Viewed marks the file and opens the next unviewed one.

Code notes:
- Diff messages are 12 × 8 but No textual diff is 16; Changes hides its scrollbar while the Files diff keeps one. (`shell/workbench/tabs/changes-diff-viewer.tsx:600,614 · features/code-review/review-code-view.tsx:77,254`)

## Diff viewer · No text diff (`ChgDiffMessages`)

Owner today: `shell/workbench/tabs/changes-diff-data.ts · changes-diff-viewer.tsx`

Changes:
- A file without a text diff shows a message row instead of a fake line 1: a 16px icon and the message in 13/18 sans, 12px in from the card edge.
- Empty file and Unable to parse this diff use the same row, so every no-diff case reads alike.
- Diff text is 12px on a 1.6 line with 12px number padding, as in the Files Diff view.

Code notes:
- A file without a text diff renders its message as a one-line placeholder file, so the message reads as line 1 of code. (`shell/workbench/tabs/changes-diff-viewer.tsx:333-345 · shell/workbench/tabs/changes-diff-data.ts:69-83,123-124,237`)

## Discard · Confirm (`ChgDiscard`)

Owner today: `shell/workbench/tabs/discard-file.tsx (DiscardDialog)`

Changes:
- Ghost Cancel and a destructive Discard.
- Dialog: border2, 12px corners and a 16px inset; a 24px close, Ghost Cancel, and the footer rule retires.

Code notes:
- Discard renders ⌘↵ as a dimmed 10px span inside the destructive button; Review uses the Kbd chip. (`features/simulators/simulator-annotation-dialog.tsx:78-81 · shell/workbench/tabs/discard-file.tsx:207-210`)
- Hunk Accept / Reject are 28px with 12px glyphs; three dialog footers: ghost + destructive-secondary, secondary + destructive, ghost + primary. (`features/code-review/hunk-review-actions.tsx:158-183,224-241 · shell/workbench/tabs/discard-file.tsx:204-209 · features/code-review/merge-conflict-actions.tsx:279-289`)

## Comments · Lines selected (`ChgCommentSelect`)

Owner today: `features/code-review/review-selection-toolbar.tsx · use-inline-review.tsx · review-pierre-options.ts`

Changes:
- A + takes the number of the line under the pointer: 16px, 4px corners, blue-primary with a dark plus (white in Light); the line’s +/− steps aside.
- Dragging the + or the line numbers selects lines in blue: the selection fill over the row washes and blue numbers; the add / del bar stays.
- No selection toolbar. Releasing the drag opens the composer under the range (New comment); a click on + opens it for that one line.
- Selecting code text is a plain text selection for copying; it offers no comment action.

Code notes:
- Today a click or drag on the numbers commits a selection toolbar (range, Comment, Cancel) and only the gutter + opens the composer. Proposed: a released drag or a + click opens the composer; Esc or Cancel clears the selection. (`features/code-review/use-inline-review.tsx:220-246 · review-annotation-view.tsx:62-75 · review-selection-toolbar.tsx`)
- Selection takes the diff theme’s modified colour, --highlighted-bright (a neutral grey), so a selected line reads like a hovered one. Proposed: blue-primary over blue-bg for the rows and a stronger mix for the numbers. (`shared/theme/diff-theme.ts:69-70,88 · features/code-review/review-pierre-options.ts:2-11`)
- The keyboard path stays: ⌘/Ctrl + Shift + M opens the composer on the selected lines or the first hunk; ↑ / ↓ move the line, Shift extends it, Enter opens the composer. (`features/code-review/use-inline-review.tsx:265-350`)
- Later, not in this design: right-clicking selected lines shows an Add to agent pill that hands the range to the agent as context.
- The selection toolbar is 34px (bordered, 8 / 4px padding around 24px buttons) and the new-comment box is a separate shell. (`features/code-review/review-selection-toolbar.tsx:22 · features/code-review/review-annotation-view.tsx:76`)

## Comments · New comment (`ChgCommentNew`)

Owner today: `features/code-review/review-annotation-view.tsx · review-composer.tsx · use-inline-review.tsx`

Changes:
- The composer takes the agent composer’s look: sidebar-bg with a border2 edge, unchanged on focus; the range is its title, then a borderless 13 / 20 text area.
- One footer: Workspace comment, then Cancel (ghost) and Comment (primary, with its ⌘↵); the ⌘/Ctrl + Enter caption goes.
- The range stays blue while the draft is open.

Code notes:
- Today: a 12px medium label over a bordered textarea (border3, 8 / 6px padding), the ⌘/Ctrl + Enter caption, Comment as the default button, all in a border2 shell with 8px padding. (`features/code-review/review-composer.tsx:80-123 · review-annotation-view.tsx:76-81,128`)
- The same recipe as the Proposed agent composer on the Agent chat page: sidebar-bg, a border2 edge at rest and in focus, no shadow.
- Two comment cards (6px bg1 8px padding vs 8px bg2 12px padding) and two composers (bg1 13px vs bg2 14px). (`features/code-review/inline-review-thread.tsx:115-117 · shell/workbench/tabs/review-timeline.tsx:315-319,421,430-431 · features/code-review/review-composer.tsx:92,106`)

## Comments · Post to PR (`ChgCommentPr`)

Owner today: `features/code-review/review-annotation-view.tsx · review-composer.tsx · use-inline-review.tsx`

Changes:
- Where the comment goes is a segmented control in the footer, Workspace or Pull request; with Pull request on, the primary submit reads Post to PR.
- When the PR diff moved, a yellow notice sits above the footer, Pull request is disabled and the draft stays.
- The composer keeps the agent composer’s look (sidebar-bg, border2, no focus ring); the range stays blue while the draft is open.

Code notes:
- Today the destination is two buttons above the textarea (ghost and secondary-on) and the moved-diff message is fg3 text. (`features/code-review/review-annotation-view.tsx:101-127`)

## Comments · Open thread (`ChgThread`)

Owner today: `features/code-review/inline-review-thread.tsx · review-annotation-view.tsx`

Changes:
- A posted discussion sits on bg2 with a border2 edge, so it reads apart from the sidebar-bg code; its 36px head (icon, range, Resolve) sits over a border2 rule.
- Resolve is a secondary button; Cancel is the one ghost action, and submitting is the one primary.
- People get round initials avatars; agents get their own mark on a rounded square (Claude, Codex, Cursor) with an Agent badge; the Human label goes.
- The name is 13px medium with the date in fg3 right after it; text is 13 / 20; comments sit 16px apart.
- Reply is a field in the composer look beside your avatar; focusing it opens the reply box in place.

Code notes:
- Today: a border2 card with rounded-md corners and 12px text, a 32px head, comments split by border1 rules, each name followed by Human or Agent · provider with the date pushed right; Reply is a ghost text button. (`features/code-review/inline-review-thread.tsx:110-247,308-320`)
- Agent comments already carry their provider (claude, codex, cursor); AgentIcon renders those marks from the app’s bundled logos in their brand colours, so no fetching is needed. (`packages/protocol/src/code-review.ts:20-24 · features/agent/agent-icon.tsx · agent-icons-bundled.ts:18-30 · agent-brands.ts:29-60`)
- The thread header mixes a 24px link with a 28px Resolve, so it renders 36px and wraps its actions left-aligned onto a second line when narrow. (`features/code-review/inline-review-thread.tsx:117-128,158,167-199`)

## Comments · Reply (`ChgThreadReply`)

Owner today: `features/code-review/inline-review-thread.tsx · review-composer.tsx · review-draft-store.ts`

Changes:
- The reply box takes the reply field’s place: your avatar, then the composer look (sidebar-bg, border2, no focus ring) with Cancel and Reply ⌘↵.
- Reply to Alex Morgan stays the box’s accessible name; it is no longer printed above it.

Code notes:
- Today the reply composer prints its label (Reply to …) above the textarea and keeps the ⌘/Ctrl + Enter caption. (`features/code-review/inline-review-thread.tsx:293-307 · review-composer.tsx:80-82,106`)
- Text-only ghost actions keep their 6px button padding, so their labels sit 6px right of the comment text. (`features/code-review/inline-review-thread.tsx:265-289,310-320 · features/code-review/review-annotation-view.tsx:189-202`)

## Comments · Resolved (`ChgThreadResolved`)

Owner today: `features/code-review/inline-review-thread.tsx`

Changes:
- Folded, a resolved discussion is one quieter row that toggles: the chevron, a green Resolved pill, the first author and the comment count, then Reopen.
- No check icon and no avatar; Reopen is a secondary button.
- Expanded, the pill stays in the head beside the range; the comments read at full strength.

Code notes:
- Today the collapsed head shows Resolved, the first author and the range. The comment count is new; it comes from the thread (its comment count, else the loaded comments). (`features/code-review/inline-review-thread.tsx:118-136,186-204`)

## Comments · GitHub and outdated (`ChgThreadGithub`)

Owner today: `features/code-review/inline-review-thread.tsx · use-github-review.ts · github-review-model.ts`

Changes:
- The GitHub mark leads the head; Outdated is a badge; ↗ (arrow-up-right) opens the discussion on GitHub; Resolve is secondary.
- GitHub authors show their GitHub avatar: a person’s photo, or a review app’s logo (CodeRabbit, Greptile and the like) on a rounded square with a Bot badge; initials until it loads.
- Original code is a disclosure row; open, it shows the old lines with their numbers.
- More replies are available on GitHub is a divider line under the last comment.
- The reply box posts to the pull request; its primary submit reads Post reply to PR.

Code notes:
- Today GitHub and Outdated · code changed are fg3 words in the head, Original code is a details element over a pre on bg2, and the truncation line is fg3 text. (`features/code-review/inline-review-thread.tsx:137-158,205-211,253-255`)
- The engine already asks GitHub for each comment author’s avatar and sanitises the URL, but the review model drops it and the review actor has no avatar field. Carrying avatarUrl through shows people’s photos and review apps’ logos, as the Review tab already does with AvatarImage. (`apps/desktop/src/engine/git/github-inline-review.ts:49,82,185 · features/code-review/github-review-model.ts:86-90 · packages/protocol/src/code-review.ts:20-24 · shell/workbench/tabs/review-shared-components.tsx:87-96`)

## Comments · Earlier ranges (`ChgThreadsMore`)

Owner today: `features/code-review/review-annotation-view.tsx (ReviewUnplacedThreads) · review-feedback.tsx`

Changes:
- Discussions that lost their lines follow the last file under a 13px heading; each names its file, then uses the same card.
- Original range unavailable is a badge in the card’s head.
- Load more discussions is a secondary button under the list.

Code notes:
- Today these discussions sit in an unpadded block after the files, the path as fg3 text above a bordered thread. (`features/code-review/review-annotation-view.tsx:137-207`)

## Comments · Outdated range (`ChgThreadOutdated`)

Owner today: `features/code-review/inline-review-thread.tsx · review-anchors.ts`

Changes:
- Outdated is a badge in the head.
- Original code opens to the old line with its number in a 12px mono block on the diff surface.

Code notes:
- Today Original code is a details element: an fg3 summary and the old text in a pre on bg2, without line numbers. (`features/code-review/inline-review-thread.tsx:205-211`)

## Comments · Earlier replies (`ChgThreadHistory`)

Owner today: `features/code-review/inline-review-thread.tsx · use-code-review.ts`

Changes:
- Earlier replies wait behind a divider line: 2 of 24 comments loaded, then Load more replies as a secondary button.

Code notes:
- Today the count and Load more replies are an fg3 row between the comments and Reply. (`features/code-review/inline-review-thread.tsx:256-291`)

## Checks · Check-run annotations (`ChgCheckAnnotations`)

Owner today: `features/code-review/github-review-model.ts · inline-review-thread.tsx`

Changes:
- A check annotation reads like a comment by the check: its severity icon in the avatar slot, the check’s name, a severity pill and the line; the coloured edge goes.
- Failure is red, warning yellow, notice neutral, in the icon and the pill only; the card is the same bg2 as a discussion.
- The rule sits in a mono chip above the message; ↗ (arrow-up-right) opens the check; annotations stay read-only.

Code notes:
- Today the severity is a coloured word in the head and the annotation reads as a comment by Check. (`features/code-review/inline-review-thread.tsx:23-34,137-158`)

## Comments · Sending and retry (`ChgThreadRecovery`)

Owner today: `features/code-review/inline-review-thread.tsx · review-composer.tsx · review-draft-store.ts`

Changes:
- Sending: the primary submit shows a spinner and Sending…; the text dims and stays until the write lands; Cancel waits.
- Send failed: a red line under the text says why; the draft stays and Reply is ready again.
- Updating: the secondary Resolve shows a spinner and Updating…; if resolving fails, a red line at the card’s foot and the thread stays as it was.
- Loading replies: Load more replies shows a spinner and Loading replies…

Code notes:
- Today the busy states only swap the button text (Sending…, Updating…, Loading replies…) and errors are red text rows. (`features/code-review/review-composer.tsx:96-121 · inline-review-thread.tsx:186-204,326-330`)

## Comments · All states (`States_changes_tab_comments`)

Composite board: implemented through the boards it imports.

## Changes tab · More · All states (`States_changes_tab_scope_menu`)

Composite board: implemented through the boards it imports.

## Merge conflicts · Resolving (`ChgConflicts`)

Owner today: `features/code-review/merge-conflict-actions.tsx · shell/workbench/tabs/code-editor/source-editor.tsx · packages/protocol/src/merge-conflicts.ts`

Changes:
- No Resolve conflicts panel: each conflict is marked in the code, current lines in green under a HEAD band and incoming in blue above the branch band, with three filled buttons above it in white type: Accept current change in green, Accept incoming change in blue, Accept both in grey.
- A conflict navigator sits beside the file name and Copy: previous and next move the editor to each conflict, and 1 / 2 shows where you are; it hides once none remain.
- Accepting rewrites that block as an ordinary edit: ⌘Z undoes it and the file saves like any other, so the preview strip and Save resolution go.
- Conflicts look the same with Diff view on or off; while any remain Diff view waits, and File options reads Resolve conflicts first.
- Unpaired markers and read-only views show one notice above the code and no buttons; Design files get the same three buttons.
- File tab names keep the tab colour; only the status letter is coloured, so a conflict shows a red ! beside a plain name.
- The file name sits on the bar as plain text, with no edge or fill; its hit area stays 28px.
- File options beside the side-column toggles uses lucide ellipsis.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; the open side column’s toggle is a bg2-highlight fill with no edge.

Code notes:
- Nothing steps between conflicts today: the panel lists Conflict 1, Conflict 2 without moving the editor. The parser already returns each block’s start line, which a navigator can scroll to. (`features/code-review/merge-conflict-actions.tsx:200-232 · packages/protocol/src/merge-conflicts.ts:8,52`)
- A Design-owned file gets no choices: the panel only says Resolve Design conflicts in Design view. (`features/code-review/merge-conflict-actions.tsx:153-164`)
- Conflicts resolve in a panel above the editor: a Current / Incoming / Both row per conflict, a remaining count and Save resolution, then a preview strip before the code. (`features/code-review/merge-conflict-actions.tsx:160-256 · shell/workbench/tabs/code-editor/source-editor.tsx:341-380`)
- A conflicted file turns autosave off; only Save resolution writes it, through resolveConflict, which needs every conflict chosen and never stages the file, so Git keeps listing it as conflicted. (`shell/workbench/tabs/code-editor/source-editor.tsx:230-235 · apps/desktop/src/engine/git/review-actions.ts:221-275`)
- The file name is a bordered chip (border1, 4px corners, 8 / 4px padding), the same title chip terminals use. (`shell/workbench/tab-chrome.ts:24-26 · shell/workbench/tabs/file-viewer.tsx:227`)
- File options uses lucide SlidersHorizontal. (`shell/workbench/tabs/code-editor/file-editor-options.tsx:2,47-48`)
- The conflict list has no padding, so it clips the last choice’s focus ring, and its rows wrap the choices under the label when narrow. (`features/code-review/merge-conflict-actions.tsx:169,200-207`)
- A failed save is only a toast, the error that turns autosave off is never shown, and inline notices come in 26, 34 and 36px recipes. (`shell/workbench/tabs/code-editor/source-editor.tsx:220-232,357,364-381 · shell/workbench/tabs/file-viewer.tsx:905`)

## Merge conflicts · All states (`States_changes_tab_conflicts`)

Composite board: implemented through the boards it imports.

## Large change set · Over 1,000 files (`ChgLarge`)

Owner today: `shell/workbench/tabs/large-change-set.ts · changes-tab.tsx · changes-diff-data.ts`

Changes:
- A diff still loading shows four shimmering skeleton lines in its card instead of Loading diff…; Too large to display uses the message row with the header’s warning icon.

Code notes:
- Until a file’s patch arrives its card shows Loading diff… as line 1 of that placeholder, which is every card right after a restart. (`shell/workbench/tabs/changes-diff-data.ts:123-124 · shell/workbench/tabs/changes-diff-viewer.tsx:333-345`)
