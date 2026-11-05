# Terminal: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Terminal”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Terminal tab · Shell (`TermWindow`)

Owner today: `shell/workbench/tabs/terminal-tab.tsx · shell/terminal/terminal-workbench-layout.tsx · shell/terminal/terminal-session-view.tsx`

Changes:
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; toggles add border4.

Code notes:
- One terminal, two headers: a 36px toolbar with 24px actions beside a 28px chip in the tab, and a 40px strip with 28px buttons and a 4px leading edge when docked. (`shell/terminal/terminal-workbench-layout.tsx:89-160 · shell/workbench/tabs/terminal-tab.tsx:770,799-817,1431,1507-1515`)
- The setup terminal is inset 8 × 4px (first line 4px under the header) while run and shell terminals use 8px. (`shell/workbench/tabs/setup-tab.tsx:527 · shell/workbench/tabs/terminal-tab.tsx:866`)
- Pill focus outlines are hidden at the strip ends by the 4px solid edge gutters and the overflow-hidden viewport. (`shell/use-sticky-tab-strip.tsx:60-61,396-403 · shell/workbench/tab-strip.tsx:306-337 · styles/global/scrollbars.css:18-23`)
- Second-row toolbars use five layouts: hand-built 36px rows with and without gaps, a 36px forced window header, 40px Design and Simulator headers, and Review’s 73 + 37px. (`shell/workbench/tabs/files-tab.tsx:495 · shell/workbench/tabs/changes-surface.tsx:869 · shell/terminal/terminal-workbench-layout.tsx:112 · shell/workbench/tabs/browser-tab.tsx:549 · features/design-workspace/design-directory-pill.tsx:40-41 · shell/workbench/tabs/review-tab.tsx:564,610`)
- Top bands don’t share a midline or divider: the workspace header is a 40px PanelHeader with its border inside (midline 19.5px), the tab band is borderless (midline 20px), so the collapsed workbench toggle moves 0.5px when it changes owner. (`shell/conversation/workspace-header.tsx:77 · shell/workbench/workbench-pane.tsx:188-195`)

## Terminal tab · Run action running (`TermRun`)

Owner today: `shell/terminal/terminal-workbench-layout.tsx · shell/terminal/run-session-buttons.tsx · shell/workbench/tabs/terminal-tab.tsx`

Code notes:
- Run session buttons are shrunk to 24px and sit beside a 28px undock button. (`shell/terminal/run-session-buttons.tsx:38-43 · shell/workbench/tabs/terminal-tab.tsx:787-817`)
- Sidebar rows have a 30px pitch, the right reservation switches between 28 and 64px by state (the truncation point jumps 16px), and Run is forced to 24px. (`shell/terminal/terminal-workbench-layout.tsx:180,259-276,375 · shell/workbench/tabs/files-tab.tsx:245`)

## Terminal tab · Tab pills (`TermPills`)

Owner today: `shell/workbench/tab-strip.tsx · shell/terminal/terminal-tab-indicators.ts`

Code notes:
- The terminal sub-tab drifts from the workbench pill: manual margins, a 140px label cap (vs 180) and a 16px close under a 32px fade (vs 20px under 40). (`shell/workbench/tabs/terminal-tab.tsx:1564-1616 · shell/workbench/tab-strip.tsx:332,433-444`)
- (exited) is shown three ways: dimmed with a 4px gap in pills, plain and undimmed in the sidebar. (`shell/workbench/tab-strip.tsx:378-380 · shell/workbench/tabs/terminal-tab.tsx:1575 · shell/terminal/terminal-workbench-layout.tsx:306`)

## Session output · Process exited (`TermExited`)

Owner today: `shell/terminal/terminal-session-view.tsx · shell/terminal/terminal-workbench-layout.tsx`

No change beyond the shared foundation and primitives.

## Session output · Failed to start (`TermFailed`)

Owner today: `shell/terminal/terminal-session-view.tsx · shell/terminal/terminal-exit-policy.ts · shell/workbench/tab-status.tsx`

Changes:
- What failed is one 32px row under the toolbar; the terminal stays empty instead of printing the error into it.
- No connection drops the empty state that repeated the banner.

Code notes:
- The tab banner is a fixed 48px even for one line, and its 12px inset sits 4px right of the 8px toolbar above. (`shell/workbench/tab-status.tsx:111`)

## Session output · Reconnecting (`TermStatus`)

Owner today: `shell/workbench/tab-status-model.ts · shell/workbench/tab-status.tsx · shell/terminal/cloud-terminal-indicator.tsx`

Changes:
- Reconnecting and engine errors are one 32px row above the output, which stays.
- A starting cloud workspace shows one quiet line, not a banner over an empty state.

## Bottom panel · Docked (`TermPanel`)

Owner today: `shell/workbench/tabs/terminal-tab.tsx (TerminalPanel, TerminalSubTabStrip) · shell/terminal/terminal-panel-resizer.tsx`

Changes:
- Tree rows are 28; the selected row fills bg2-highlight.

Code notes:
- The panel uses hard-coded sizes (40px collapsed, min 140px, calc(100% - 181px)), and its resizer hit zone is 15px against 7px for vertical seams. (`shell/workbench/tabs/terminal-tab.tsx:196-197,742 · shell/terminal/terminal-panel-resizer.tsx:327`)

## Bottom panel · Collapsed (`TermPanelCollapsed`)

Owner today: `shell/workbench/tabs/terminal-tab.tsx (TerminalPanel)`

No change beyond the shared foundation and primitives.

## Run actions · Not started (`TermRunEmpty`)

Owner today: `shell/workbench/tabs/terminal-tab.tsx (RunActionOverlay)`

Changes:
- Not started and last run share the empty-state recipe: icon, Dev server, the command or the last outcome, then Start.
- The outcome badge that repeated the line retires.

Code notes:
- Loading uses a 20px spinner with 14px medium text in one place and 16px with 13px fg2 in another; empty states use 12 and 8px gaps. (`shell/workbench/workbench-pane.tsx:219-226 · shell/workbench/tabs/setup-tab.tsx:694-728 · shell/workbench/tabs/terminal-tab.tsx:1255-1262,1329-1342`)

## Run actions · Finished (`TermRunDone`)

Owner today: `shell/workbench/tabs/terminal-tab.tsx (RunActionOverlay, RunStatusBadge)`

Code notes:
- The outcome cluster pairs a 24px badge with a 28px Rerun and floats over the last output rows with no reserved inset; the busy spinner is 16px against a 14px glyph. (`shell/workbench/tabs/terminal-tab.tsx:1158-1163,1309-1316 · shell/workbench/tabs/setup-tab.tsx:562-581,641-649,669-671`)

## Run actions · No run script (`TermRunAdd`)

Owner today: `shell/workbench/tabs/terminal-tab.tsx (RunAddEmpty)`

Changes:
- One empty-state recipe: icon, title, one line, then the action.

## Run actions · Two runs live (`TermRunMany`)

Owner today: `shell/terminal/terminal-workbench-layout.tsx · shell/terminal/run-session-buttons.tsx · shell/terminal/use-run-control.ts`

No change beyond the shared foundation and primitives.

## Run actions · Couldn't start (`TermRunFailed`)

Owner today: `shell/terminal/use-run-control.ts · shared/ui/primitives/elements/toast.tsx`

Changes:
- A failed start says why in one red line under the action, not a toast; the action stays ready.

## Terminal · More · All states (`States_terminal_terminal_tab`)

Composite board: implemented through the boards it imports.

## Setup · Setting up workspace (`TermSettingUp`)

Owner today: `shell/workbench/workbench-pane.tsx (SettingUpRow)`

No change beyond the shared foundation and primitives.

## Setup · Not run (`TermSetupEmpty`)

Owner today: `shell/workbench/tabs/setup-tab.tsx (WorkspaceSetup empty states)`

Changes:
- Every state is the empty-state recipe: icon, Setup, one line, then the action.
- The outcome badge that repeated the last-run line retires.

## Setup · Running (`TermSetupRunning`)

Owner today: `shell/workbench/tabs/setup-tab.tsx (WorkspaceSetup)`

No change beyond the shared foundation and primitives.

## Setup · Finished (`TermSetupDone`)

Owner today: `shell/workbench/tabs/setup-tab.tsx (SetupStatusBadge)`

No change beyond the shared foundation and primitives.

## Setup · All states (`States_terminal_setup`)

Composite board: implemented through the boards it imports.
