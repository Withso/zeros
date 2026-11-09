# Sidebar: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Sidebar”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Sidebar · Grouped by repository (`SideGrouped`)

Owner today: `shell/app-sidebar.tsx`

Changes:
- Rows are 32 with 6px corners; the selected row fills bg2-highlight, hover keeps the sidebar hover.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; a pressed toggle fills selected-bg with no edge.
- One 16px icon column: switcher, destinations, section labels and rows all start at 16px; trailing controls end 12px in.
- The profile row is a fixed 48px with an 8px gap and a 12px fg3 email.

Code notes:
- Folder entries reuse the 30px destination recipe forced to 32px, so the icon sits at 18px and the label at 42px against 16 and 40 for sibling rows. (`shell/app-sidebar.tsx:172,899-917`)
- The list scroller has no top padding, so the first header’s focus ring is cut off. (`shell/app-sidebar.tsx:850`)
- In the sidebar title band only the toggle is nudged up 1px (midline 19 vs 20), and its glyph is 16px while the arrows are 14px in the same 28px buttons. (`shell/sidebar-toggle.tsx:36,52 · shell/sidebar-history-buttons.tsx:27-28,110 · shell/resource-monitor.tsx:703`)
- Destination rows are 30px (off the 28 / 32 ladder) above 32px rows, while the Settings rail entry is 32px at 14px, so the nav changes when Settings swaps in. (`shell/app-sidebar.tsx:165-172 · features/settings/settings-page.tsx:433-434`)
- Right edges don’t line up: title-band buttons end 8px from the rail, header and footer buttons 12px, row trailing text 16px. (`shell/app-sidebar.tsx:744,831,973 · shell/sidebar-repository-header.tsx:66 · shell/sidebar-workspace-row.tsx:100`)
- The profile footer is 57px with an email and 49px without; the email is the same 13px as the name, and the name starts at 46px against 40 for rows. (`shell/app-sidebar.tsx:973-986`)

## Sidebar · Grouped by status (`SideStatus`)

Owner today: `shell/app-sidebar.tsx · shared/lib/workspace-status.ts`

Code notes:
- The list scroller takes the app's scrollbar since its rules went unscoped (2026-11-09): no classic macOS track, but its 6px slot appears on overflow, so the trailing clusters shift 6px then. (`shell/app-sidebar.tsx:843 · styles/global/scrollbars.css`)
- The grouped-row status gutter centres its mark 20px from the rail, while the header icon column is centred at 24px. (`shell/sidebar-workspace-row.tsx:107-108 · shell/sidebar-repository-header.tsx:68`)

## Sidebar · No grouping (`SideUngrouped`)

Owner today: `shell/app-sidebar.tsx · shell/sidebar-workspace-row.tsx`

Code notes:
- The repository icon is chipped in headers but bare in ungrouped rows, pending rows and the hover card, where the letter fallback inherits 13px text. (`shell/sidebar-repository-header.tsx:69-70,175-178 · shell/sidebar-workspace-row.tsx:143-144,564 · features/repositories/repository-icon.tsx:311`)

## Sidebar · Hidden (`SideHidden`)

Owner today: `shell/sidebar-toggle.tsx · CollapsedSidebarControls`

Code notes:
- With the sidebar collapsed, Home gets an empty 40px band instead of the corner reserve, so the Dashboard title drops to y 56 and the repo title to about 124. (`app-shell.tsx:1074`)

## Workspace row · Idle (`SideRowIdle`)

Owner today: `shell/sidebar-workspace-row.tsx · shell/workspace-glyph.tsx`

Code notes:
- Keyboard focus is invisible on the selected row: the 3px ring is clipped by overflow-hidden and focus only fills the row with the selected colour. (`shell/sidebar-workspace-row.tsx:100,110-111`)

## Workspace row · Selected (`SideRowSelected`)

Owner today: `shell/sidebar-workspace-row.tsx`

No change beyond the shared foundation and primitives.

## Workspace row · Agent working (`SideRowWorking`)

Owner today: `shell/sidebar-workspace-row.tsx · features/agent/agent-activity-indicator.tsx`

Code notes:
- Trailing marks use 12, 14 and 16px slots, so the name’s truncation point moves 2–4px whenever the state changes. (`shell/sidebar-workspace-row.tsx:422-458`)

## Workspace row · Line changes (`SideRowChanges`)

Owner today: `shell/workspace-change-counts.tsx`

Code notes:
- ± counts are spaced three ways: a literal space in the sidebar, a 4px gap in the hover card and 6px on Home. (`shell/workspace-change-counts.tsx:59 · shell/sidebar-workspace-hover-card.tsx:96 · features/dashboard/dashboard-metadata.tsx:108`)

## Workspace row · Unread (`SideRowUnread`)

Owner today: `features/agent/chat-unread-dot.tsx`

No change beyond the shared foundation and primitives.

## Workspace row · Awaiting you (`SideRowAwaiting`)

Owner today: `features/agent/agent-awaiting-indicator.tsx`

Code notes:
- Archive lands at three x positions: 6px from the edge normally, 4px on a drafted row and 5px on an awaiting row. (`shell/sidebar-workspace-row.tsx:118,122,440-443`)

## Workspace row · Unsent draft (`SideRowDraft`)

Owner today: `features/agent/composer-draft-indicator.tsx`

No change beyond the shared foundation and primitives.

## Workspace row · Run in progress (`SideRowRun`)

Owner today: `shell/sidebar-workspace-row.tsx · shared/ui/loading/run-stream.tsx`

No change beyond the shared foundation and primitives.

## Workspace row · Archiving (`SideRowArchiving`)

Owner today: `shell/sidebar-workspace-row.tsx`

No change beyond the shared foundation and primitives.

## Workspace row · Hover (`SideRowHover`)

Owner today: `shell/sidebar-workspace-row.tsx`

Code notes:
- The same trailing action is a 20px inline button with 4px corners on workspace rows and a 24px button with 6px corners on repository headers. (`shell/sidebar-workspace-row.tsx:294-306 · shell/sidebar-repository-header.tsx:72-73`)

## Workspace row · Pull request (`SideRowPr`)

Owner today: `shell/workspace-glyph.tsx · workspacePrTone`

No change beyond the shared foundation and primitives.

## Workspace row · Folder or design (`SideRowFolder`)

Owner today: `shell/sidebar-workspace-row.tsx`

No change beyond the shared foundation and primitives.

## Workspace row · Creating (`SideRowCreating`)

Owner today: `shell/sidebar-workspace-row.tsx · PendingSidebarWorkspaceRow`

Code notes:
- Opening &lt;repo&gt; puts a 14px spinner without the 16px glyph box, so the label sits at 38px instead of 40. (`shell/app-sidebar.tsx:953-958`)

## Repository header · States (`SideRepoHeader`)

Owner today: `shell/sidebar-repository-header.tsx`

Code notes:
- The header reflows on hover: settings and more actions switch from hidden to shown (52px), so long names re-truncate under the pointer. (`shell/sidebar-repository-header.tsx:193-199`)

## Repository header · More actions (`SideRepoMenu`)

Owner today: `shell/sidebar-repository-header.tsx`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

Code notes:
- The Set status check is 16px beside 14px status icons, and repository menus are 208 and 192px wide. (`shared/ui/workspace-context-menu.tsx:150 · shell/sidebar-repository-header.tsx:223,290 · shell/sidebar-workspace-row.tsx:147`)

## Workspace rows · Repository header · All states (`States_sidebar_rows`)

Composite board: implemented through the boards it imports.

## Organization switcher · Open (`SideOrgMenu`)

Owner today: `features/team/organization-switcher.tsx`

Code notes:
- No shared icon column: the org trigger icon is at 13px (a fixed 30px trigger), rows and headers at 16px, destinations and the Workspaces label at 18px. (`features/team/organization-switcher.tsx:153,158 · shell/app-sidebar.tsx:172,831`)

## Workspace display options (`SideFilterMenu`)

Owner today: `shell/sidebar-workspace-menu.tsx`

Changes:
- Group by moves its check to the end, like Sort; one choice, one convention.

Code notes:
- The filter menu breaks menu geometry: a 5px offset, a 36px search row with a 16px icon among 30px rows, a 34px empty row and four widths in one cascade. (`shell/sidebar-workspace-menu.tsx:132-133,161,176,179-181,248,258`)
- One-choice menus disagree: Home uses leading dots (label 38px in) and leading checks, the sidebar trailing checks (label 14px in). (`features/dashboard/dashboard-toolbar.tsx:165,198,215 · shell/sidebar-workspace-menu.tsx:147-151,220-223`)

## Workspace hover card (`SideHoverCard`)

Owner today: `shell/sidebar-workspace-hover-card.tsx · shell/pr/create-pr-button.tsx`

Code notes:
- The hover card sits 1px past the seam so it looks attached, and overrides the floating recipe (340px, 8px corners, 12px padding); its rhythm is 8 / 8 / 24. (`shell/sidebar-workspace-row.tsx:476-482 · shell/sidebar-workspace-hover-card.tsx:90,101-104,111,139`)
- The PR link is built three ways: two anchors with 2px gaps and a ghost button with no padding. (`features/dashboard/dashboard-page.tsx:1126-1135 · features/repositories/repo-page.tsx:232-241 · shell/sidebar-workspace-hover-card.tsx:139-143`)

## Workspace context menu (`SideContextMenu`)

Owner today: `shared/ui/workspace-context-menu.tsx`

No change beyond the shared foundation and primitives.

## Workspaces · No matches (`SideNoMatches`)

Owner today: `shell/app-sidebar.tsx · shell/sidebar-workspace-menu.tsx`

Code notes:
- Clear filter keeps its 1px border and 6px padding, so its label starts 7px right of the message above. (`shell/app-sidebar.tsx:962-966`)
