# Dashboard (Home): board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Dashboard (Home)”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Dashboard · Board view (`HomeBoard`)

Owner today: `features/dashboard/dashboard-page.tsx · dashboard-toolbar.tsx`

Changes:
- The title drops the workspace count; the view toggle follows it, and List view uses lucide text-align-justify.
- Search is 280px and leads the toolbar; the filters keep to the right edge.
- Repository filters are 28px pills; the selected one sits on bg2-hover and does not change on hover.
- PR numbers are 24px pills coloured by PR state, as on the PR status island, with no link icon: brown while open, green when ready to merge, violet once merged.
- Segmented: 28 track, 24 items; the selected item fills selected-bg with no edge.
- Cards and tiles round to 12; hover lifts to border3 + bg2-highlight.
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.

Code notes:
- The title carries a 14px muted workspace count beside the 16px Dashboard heading. (`features/dashboard/dashboard-page.tsx:392-401`)
- List view uses lucide List; the proposal swaps it for TextAlignJustify. (`features/dashboard/dashboard-toolbar.tsx:63-64`)
- The search is min-w-40 flex-1, so it stretches over every free pixel of the toolbar; the filters reach the right edge only because the field fills the gap. (`features/dashboard/dashboard-toolbar.tsx:106-107`)
- Repository filters are ghost Buttons with 6px corners; the ghost hover (bg2-highlight) still repaints the selected bg2-hover chip. (`features/dashboard/dashboard-page.tsx:578-590 · shared/ui/primitives/button.tsx:19,40`)
- Home draws the PR as a plain 12px fg3 link in both views, while the PR status island already outlines #N in the PR colour (brown open, green ready to merge, violet merged, red closed). (`features/dashboard/dashboard-page.tsx:1123-1137 · shell/pr/pr-status-island.tsx:139-147 · styles/semantic-tokens.css:52-62`)
- Board columns pad 12px inside a 24px row, so the first card starts at 36px while the title and filters start at 24; gutters are 40px between columns vs 8px between cards. (`features/dashboard/dashboard-page.tsx:512,530,543`)

## Dashboard · List view (`HomeList`)

Owner today: `features/dashboard/dashboard-list.tsx`

Changes:
- Rows have no card, fill or divider: 40px rows, 2px apart, a quiet bg1-hover on hover; the title and branch lead the row on one line.
- Every display option is right-aligned on one subgrid with an even 16px gutter: the PR pill first, then the status tag, repository, changes, owner and last active.
- Status is a 24px tag with its icon and label instead of an icon before the name; PR pills take the PR colour (brown open, green ready to merge, violet merged) with no link icon.
- Repository is a pill chip like the filters; Owner is a 20px avatar; numbers use tabular figures.
- Whatever the Display menu shows, hidden options take no space and the gutters stay even.

Code notes:
- The list is table-fixed with set widths (repository 144 or 40, changes 96, cost 80, owner 96, active 80, actions 144), so short values float in wide boxes: Changes ends 16px before Owner while Owner ends about 70px before Active. (`features/dashboard/dashboard-list.tsx:106-121`)
- The table keeps a sticky header row of column labels above every list. (`features/dashboard/dashboard-list.tsx:122-158`)
- Each list row leads with a 16px status icon before the name, while the board shows status as its column. (`features/dashboard/dashboard-list.tsx:258-266`)
- The fixed columns keep 560px at any width, so in a narrow window the Workspace column, the only flexible one, truncates first; no column ever hides. (`features/dashboard/dashboard-list.tsx:106-121`)

## Home · No repositories yet (`HomeNoProjects`)

Owner today: `shell/no-projects-view.tsx · features/team/cloud-workspace-pause.tsx`

Changes:
- With no repositories, Home opens the Create page beside the sidebar instead of the full-window welcome; the centred logo goes.
- With no workspace selected, the app opens this Create page too, instead of an empty workspace that reads No workspace selected.
- Three banner buttons sit 24px under the composer in one row as wide as it, icon left and text right: bg2 tiles with 12px padding, 12px apart, 12px corners and a bare 20px icon; hover bg2-highlight with border3.
- The banners show only while no repository is added or chosen in Choose project; once one is, the page is the plain Create page.
- The composer matches Agent chat (sidebar-bg, border2 edge) with Create ↵ as its one primary button; the branch picker waits for a repository instead of sitting disabled.

Code notes:
- With no repositories the welcome view takes over: the Dashboard renders it in place of the Dashboard page, and every non-Home page lays it over the shell. (`app-shell.tsx:944,1051-1054,1088`)
- The welcome view centres a 64px logo 40px above three 112×176 vertical tiles inside an overflow-auto box, so in a short window the wrapped tiles push the logo out of reach. (`shell/no-projects-view.tsx:40,60-70`)
- The Create page is a 640px column centred in 32px padding: Choose project and the branch picker, then the composer. With no repositories its menu reads No projects yet above the same three actions. (`shell/dispatcher/dispatcher-modal.tsx:574-575,613-629,653-668`)
- With no workspace selected the workspace shell still renders; its top bar reads No workspace selected and the PR row repeats it. (`shell/conversation/conversation-header.tsx:575-578 · shell/pr/pr-status-row.tsx:119`)
- With no project the branch picker still shows, disabled, as Choose branch. (`shell/dispatcher/create-from-source.tsx:284,304`)
- The Create composer is bg2 with a border1 edge that turns border2 on focus, while the proposed Agent chat composer is sidebar-bg with border2. (`shell/dispatcher/dispatcher-composer.tsx:475`)

## App loading · Logo animation (`HomeLoading`)

Owner today: `index.html · shared/ui/startup-loader.tsx`

Changes:
- The loader shows the new Island Z at 64px running the Branding page’s Weave: rows step on a 72 ms beat, neighbours in opposite directions, one 1.8 s loop that lands on the resting Z.
- The Z is one quiet neutral gradient, fg1 at the top easing to fg3 at the bottom, in place of five halftone layers over the old logo.
- Colours come from tokens on bg1, so Light flips the ink and the page together; with reduced motion the Z simply rests.

Code notes:
- The loader stacks five halftone layers (base, dots, checks, hatch, blocks) masked by the old four-blob logo PNG at 80px, drifting on 5.2 to 6.4 s loops. (`index.html:108-255 · shared/ui/startup-loader.tsx:5-11,51-70`)
- Boot colours are hard-coded hex pairs (#121212 with #f2f2f0, #b6b6b2, #777774 and their light twins) outside the token system. (`index.html:68-80`)
- With bg1 at #141414 the boot background moves to #141414 too; left at #121212, the window changes shade when the first screen paints. (`index.html:69`)
- The Island Z and its Weave motion exist only on the Branding page; the app still masks apps/desktop/src/assets/zeros-logo.png. (`index.html:62-66,129-132`)

## Dashboard · Empty states (`HomeEmpty`)

Owner today: `features/dashboard/dashboard-page.tsx`

Changes:
- Empty state: a 32 icon in fg3 and one 13 fg2 line.

Code notes:
- Four empty-state recipes: Home 32px at stroke 1.5 with 14px text, the workbench 40px at stroke 1, Browser 28px, and the repo page text only. (`features/dashboard/dashboard-page.tsx:451-459 · shell/workbench/tab-status.tsx:58-65 · shell/workbench/tabs/browser-start-page.tsx:43-44,192 · features/repositories/repo-page.tsx:376-386`)

## Dashboard · Toolbar menus (`HomeMenus`)

Owner today: `features/dashboard/dashboard-toolbar.tsx · preferences.ts`

Changes:
- Archive and Sort move their checks to the end (one choice); Display keeps a left check column (several).
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

Code notes:
- One-choice menus disagree: Home uses leading dots (label 38px in) and leading checks, the sidebar trailing checks (label 14px in). (`features/dashboard/dashboard-toolbar.tsx:165,198,215 · shell/sidebar-workspace-menu.tsx:147-151,220-223`)

## Workspace card · Default (`HomeCard`)

Owner today: `features/dashboard/dashboard-page.tsx · DashboardCard`

Changes:
- Card content stacks on an even 4 / 8px rhythm.

Code notes:
- The action row is 24px with an action, 18px with only a PR link, and 0px when empty while its 10px margin stays, so cards in a column differ by up to 24px. (`features/dashboard/dashboard-page.tsx:1226-1255`)
- Card spacing steps 6 / 4 / 8 / 10px between title, status, metadata and actions. (`features/dashboard/dashboard-page.tsx:837-850,925,1214-1226`)
- The PR link is built three ways: two anchors with 2px gaps and a ghost button with no padding. (`features/dashboard/dashboard-page.tsx:1126-1135 · features/repositories/repo-page.tsx:232-241 · shell/sidebar-workspace-hover-card.tsx:139-143`)
- ± counts are spaced three ways: a literal space in the sidebar, a 4px gap in the hover card and 6px on Home. (`shell/workspace-change-counts.tsx:59 · shell/sidebar-workspace-hover-card.tsx:96 · features/dashboard/dashboard-metadata.tsx:108`)

## Workspace card · Actions (`HomeCardActions`)

Owner today: `features/dashboard/dashboard-page.tsx · DashboardCard action`

Changes:
- PR numbers are 24px pills coloured by PR state, as on the PR status island: brown while open, green when ready to merge, violet once merged.

Code notes:
- Compact controls carry 14px glyphs and spinners (the compact spec is 12px). (`features/dashboard/dashboard-page.tsx:722-724,735,758,1238-1240`)

## Workspace card · Worktree missing (`HomeCardMissing`)

Owner today: `{{src}}`

No change beyond the shared foundation and primitives.

## Workspace card · Cloud and folder (`HomeCardCloud`)

Owner today: `features/dashboard/dashboard-metadata.tsx · DashboardPlacement`

No change beyond the shared foundation and primitives.

## Workspace card · Creating (`HomeCardPending`)

Owner today: `features/dashboard/dashboard-page.tsx · PendingDashboardCard`

Code notes:
- The pending card has two rows at 80% opacity and no metadata or actions, so the column jumps 30–50px when the real card arrives. (`features/dashboard/dashboard-page.tsx:960-977`)

## Workspace card · Archived (`HomeCardArchived`)

Owner today: `features/dashboard/dashboard-page.tsx · ArchivedCard`

Code notes:
- The Archived column pads 4px below where siblings pad 8, and its count is fg2 against muted-fg. (`features/dashboard/dashboard-page.tsx:539-543,620-622`)

## Archived card · Options and saved snapshot (`HomeSnapshotDelete`)

Owner today: `features/dashboard/dashboard-page.tsx · ArchivedCard options`

Changes:
- Dialog: border2, 12px corners and a 16px inset; a 24px close, Ghost Cancel, and the footer rule retires.

Code notes:
- The dialog title has no wrap guard, so an unbroken name runs under the close button; insets are 16 / 12 for the header, 24 body and 10 footer. (`features/dashboard/dashboard-page.tsx:873-875 · shared/ui/primitives/dialog.tsx:213,226,239,257`)

## List row · States (`HomeListRow`)

Owner today: `features/dashboard/dashboard-list.tsx · DashboardListRow, PendingDashboardListRow`

Changes:
- Every state is the same plain row: no fill or divider; hover bg1-hover, archived titles in fg2.
- The status moves from the front of the name into a tag after the PR pill; folder, missing-folder and archived states use the same tag, and their repeated subtitle goes.
- PR pills take the PR state colour (brown open, green ready to merge, violet merged) and drop the link icon.
- Narrow windows drop options, not text: under 720px Status and Repository keep only their icons, Changes and Cost hide under 560px, Owner under 440px.
- Creating: a spinner and Setting up… across the row.

Code notes:
- Every cell pads 8px whatever its alignment, so right-aligned numbers beside left-aligned text open gaps from 16px to about 80px. (`features/dashboard/dashboard-list.tsx:124-157,282-327`)
- Rows are 48px table rows divided by a border1 rule; the branch line is text-3xxs. (`features/dashboard/dashboard-list.tsx:233,274`)

## Workspace cards · All states (`States_home_cards`)

Composite board: implemented through the boards it imports.

## Repository page · Workspaces (`HomeRepoPage`)

Owner today: `features/repositories/repo-page.tsx · RepoPage, RepoWorkspacesList, RepoWorkspaceRow`

Changes:
- Switch thumb sits 2px inside the track with one soft shadow.

Code notes:
- Repo page tabs force a 28px list but keep 4px padding, so 22px triggers overflow by 1px; the list is 8px round with 6px triggers. (`features/repositories/repo-page.tsx:593-600`)
- Page headers differ: a 16px h1 in a 58px padded row on the Dashboard, an 18px h1 about 84px down on the repo page with a clamp(24–100px) left gutter. (`features/dashboard/dashboard-page.tsx:389-392 · features/repositories/repo-page.tsx:557,567,579`)
- With the sidebar collapsed, Home gets an empty 40px band instead of the corner reserve, so the Dashboard title drops to y 56 and the repo title to about 124. (`app-shell.tsx:1074`)

## Repository page · Files (`SetFilesToCopy`)

Owner today: `features/repositories/files-to-copy-section.tsx (FilesToCopySection, TreeRowView) · files-to-copy-model.ts · repo-page.tsx (Files tab)`

Changes:
- Badges are 20 tall, 12/16 medium, 4px corners.
- Checkboxes are 16 with a 12px check.
- A repo-owned list is one message row (fg3 icon, Ghost Open file), not a blue box with an underlined link.

Code notes:
- Tree indents are uneven (a 24px first step, then 16px), so depth-2 checkboxes sit 6px left of their parent’s chevron. (`features/repositories/files-to-copy-section.tsx:559,625-629`)
- Tree rows, root path and patterns are 11px mono with 10px count chips beside 13px mono lines; tree rows are about 32px with 12px glyphs. (`features/repositories/files-to-copy-section.tsx:358,385,412-482,500-609`)
- Five empty-state recipes, from an unboxed 14px line to a 144px bordered card and a 96px dashed button. (`features/settings/settings-ui.tsx:253,269 · features/repositories/files-to-copy-section.tsx:385,402 · features/agent-extensions/customize-mcp.tsx:505 · features/agent-extensions/customize-extensions.tsx:388,398`)
- Loading is an empty 96px box, a 13px line, 14px text or a spinner; errors are 13px red in Settings and 14px in MCP and Skills. (`features/settings/providers-panel.tsx:398 · features/agent-extensions/customize-mcp.tsx:854-861 · features/agent-extensions/mcp-organization-page.tsx:82 · features/agent-extensions/customize-extensions.tsx:293,307-311`)
- Two header systems: SettingsGroup (12px fg2 + 12px muted, 8px above) and SettingsSection (14px fg1 + 13px fg2, 12px above). (`features/settings/settings-ui.tsx:49-56,106-116`)

## Dashboard states · Repository page · All states (`States_home_states`)

Composite board: implemented through the boards it imports.

## Dashboard states · Repository page · All states · Proposed (`States_home_states_proposed`)

Composite board: implemented through the boards it imports.
