# Design tab: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Design tab”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Design tab · Canvas (`DsnWindow`)

Owner today: `features/design-workspace/design-workbench-surface.tsx · design-workspace.tsx · design-canvas.tsx · design-floating-panel.tsx`

Changes:
- Inspector fields are filled 28s with no resting edge; labels 12 medium fg3, computed values fg2.
- Segmented: 28 track, 24 items; selected is bg1 + border2 in Light, bg4 with no edge in Dark.
- Tree rows are 28; the selected row fills bg2-highlight.
- Floating toolbar: 36 bar, 28 buttons, 14 icons, 10px corners, border2.
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.

Code notes:
- Mirrored panel toggles differ: the sidebar toggle is 28px with a 16px glyph at stroke 1.5, the workbench toggle is forced to 24px with a 14px glyph at stroke 1. (`shell/sidebar-toggle.tsx:35-36,52 · shell/workbench/toggle-button.tsx:32-36,50`)
- In the 40px tab band, 28px pills and a 28px new-tab button sit beside the 24px panel toggle. (`shell/workbench/new-tab-menu.tsx:233-236 · shell/workbench/tab-chrome.ts:16 · shell/workbench/toggle-button.tsx:34-36`)
- Second-row toolbars use five layouts: hand-built 36px rows with and without gaps, a 36px forced window header, 40px Design and Simulator headers, and Review’s 73 + 37px. (`shell/workbench/tabs/files-tab.tsx:495 · shell/workbench/tabs/changes-surface.tsx:869 · shell/terminal/terminal-workbench-layout.tsx:112 · shell/workbench/tabs/browser-tab.tsx:549 · features/design-workspace/design-directory-pill.tsx:40-41 · shell/workbench/tabs/review-tab.tsx:564,610`)
- Top bands don’t share a midline or divider: the workspace header is a 40px PanelHeader with its border inside (midline 19.5px), the tab band is borderless (midline 20px), so the collapsed workbench toggle moves 0.5px when it changes owner. (`shell/conversation/workspace-header.tsx:77 · shell/workbench/workbench-pane.tsx:188-195`)

## Design tab · No Design directory (`DsnCreate`)

Owner today: `features/design-workspace/design-workbench-surface.tsx (DesignWorkbenchSurface)`

Changes:
- One empty-state recipe: a 28px icon, a 14/20 title, one 13/18 line, then the action.
- Create Design directory is the one primary action; while it runs it keeps its place and shows a spinner.

Code notes:
- Today the order is icon, button, then “Start designing”, so the line reads as a caption under the button; the icon is 40px at stroke 1. (`features/design-workspace/design-workbench-surface.tsx:146-163`)

## Design tab · Initialize Git (`DsnInitGit`)

Owner today: `features/design-workspace/design-git-setup.tsx (DesignGitSetup)`

Changes:
- A failed init says so in one red line under the text; the button stays ready to try again.

Code notes:
- The failure today is a red block after the text, and the copy says “a workspace for Design” where it means this folder. (`features/design-workspace/design-git-setup.tsx:49-73`)

## Design tab · Paused for conflicts (`DsnConflicts`)

Owner today: `features/design-workspace/design-checkout-state.tsx (DesignCheckoutPause)`

Changes:
- The conflicted files sit in one quiet card; each opens in Changes, where the conflict blocks resolve them.
- Retry and Cancel rebase stay; a failed cancel shows one red line above them.

Code notes:
- Today the pause is a left-aligned text block with a bare file list and two buttons. (`features/design-workspace/design-checkout-state.tsx`)
- Rows open the file in Changes; conflicts resolve there for Code and Design alike. (`shell/workbench/tabs/changes-surface.tsx`)

## Design tab · Cancel operation (`DsnCancelOp`)

Owner today: `features/design-workspace/design-checkout-state.tsx (DesignCheckoutPause dialog)`

Changes:
- Dialog: border2, 12px corners and a 16px inset; a 24px close, Ghost Cancel, and the footer rule retires.

## Design tab · Checking and loading (`DsnStatus`)

Owner today: `features/design-workspace/design-workbench-surface.tsx · design-canvas.tsx · shell/workbench/tab-status.tsx`

Changes:
- Checking is one quiet line with a spinner; local main, none and load failure use the empty-state recipe.
- Load failure is one message with Retry, not a banner over a second empty state.

Code notes:
- The failure today stacks an error banner on top of “Retry to load Design”: two messages for one problem. (`features/design-workspace/design-workbench-surface.tsx:164-178 · shell/workbench/tab-status.tsx`)

## Design tab · All states (`States_design_tab_design_surface`)

Composite board: implemented through the boards it imports.

## Design toolbar · Directory menu (`DsnDirectoryMenu`)

Owner today: `features/design-workspace/design-directory-pill.tsx · design-directory-menu.tsx`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.
- Headers: window 40 with 12 / 6 padding, panel 36 with 12 / 4.

## Canvas · Tool rail (`DsnTools`)

Owner today: `features/design-workspace/design-canvas.tsx (Canvas tools) · design-inspector-kit.tsx (DesignToolbarButton)`

No change beyond the shared foundation and primitives.

## Canvas · Frame (`DsnFrame`)

Owner today: `features/design-workspace/design-canvas.tsx (frame article) · design-frame-render-surface.tsx · design-frame-runtime-iframe.tsx`

No change beyond the shared foundation and primitives.

## Canvas · Element selected (`DsnSelection`)

Owner today: `features/design-workspace/design-canvas.tsx · design-workspace-overlays.tsx (DesignResizeHandles, selection size)`

No change beyond the shared foundation and primitives.

## Canvas · Layers under pointer (`DsnHitStack`)

Owner today: `features/design-workspace/design-canvas.tsx (hit stack ContextMenu)`

No change beyond the shared foundation and primitives.

## Canvas · Drawing a frame (`DsnDrawFrame`)

Owner today: `features/design-workspace/design-canvas.tsx (creation draft, snap guides)`

No change beyond the shared foundation and primitives.

## Canvas · Editing text (`DsnTextEdit`)

Owner today: `features/design-workspace/design-inline-text-editor.tsx · design-canvas.tsx (text tool)`

No change beyond the shared foundation and primitives.

## Canvas · Agent writing (`DsnAgent`)

Owner today: `features/design-workspace/design-agent-drafts.tsx (draft badge, ghost, DesignAgentActivityChip)`

No change beyond the shared foundation and primitives.

## Canvas · All states (`States_design_tab_canvas`)

Composite board: implemented through the boards it imports.

## Layers · Tree (`DsnLayers`)

Owner today: `features/design-workspace/design-workspace-sidebar-panels.tsx · design-layer-label.ts`

No change beyond the shared foundation and primitives.

## Layers · Loading and empty (`DsnLayersStates`)

Owner today: `features/design-workspace/design-workspace-sidebar-panels.tsx · design-floating-panel.tsx`

No change beyond the shared foundation and primitives.

## Inspector · Nothing selected (`DsnInspectorPage`)

Owner today: `features/design-workspace/design-inspector.tsx · design-page-picker.tsx · design-canvas-background-editor.tsx`

No change beyond the shared foundation and primitives.

## Inspector · Pages menu (`DsnPageMenu`)

Owner today: `features/design-workspace/design-page-picker.tsx (DesignPagePicker)`

Changes:
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.
- One choice puts the check at the end of the row.

## Inspector · Delete page (`DsnDeletePage`)

Owner today: `features/design-workspace/design-page-picker.tsx (delete dialog)`

No change beyond the shared foundation and primitives.

## Inspector · Frame selected (`DsnInspectorFrame`)

Owner today: `features/design-workspace/design-inspector.tsx · design-style-editor.tsx · design-auto-layout-controls.tsx · design-layout-controls.tsx`

Changes:
- Only the sections in use show; Add property adds Stroke, Effects, Typography, Transform, Transition or Motion.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; toggles add border4.

Code notes:
- The style editor renders every section always, so an unstyled frame shows six empty headers; show a section once it has a value or is added. (`features/design-workspace/design-style-editor.tsx:1-6,279-680`)

## Inspector · Text selected (`DsnInspectorText`)

Owner today: `features/design-workspace/design-inspector.tsx · design-style-editor.tsx · design-typography-editor.tsx`

Changes:
- Only the sections in use show; Add property adds Stroke, Effects, Transform, Transition or Motion.

Code notes:
- The style editor renders every section always, so a text layer shows five empty headers; show a section once it has a value or is added. (`features/design-workspace/design-style-editor.tsx:1-6,279-680`)

## Inspector · CSS (`DsnInspectorCss`)

Owner today: `features/design-workspace/design-computed-css-editor.tsx · design-style-provenance.ts`

Changes:
- Long computed values end in an ellipsis instead of running past the panel edge.

## Theme editor · Variables (`DsnThemeEditor`)

Owner today: `features/design-workspace/design-theme-editor.tsx · design-theme-editor.css · design-theme-css.ts`

Changes:
- Long values end in an ellipsis inside their field.

## Motion · Timeline (`DsnMotion`)

Owner today: `features/design-workspace/design-motion-timeline.tsx · design-motion-timeline.css · design-motion-values.ts`

Changes:
- Primary actions drop the stock shadow.

## Design files · Files tab section (`DsnFilesPane`)

Owner today: `shell/workbench/tabs/design-files-pane.tsx · design-files-section.ts · workspace-file-tree.tsx`

No change beyond the shared foundation and primitives.

## Design tab · More · All states (`States_design_tab_design_toolbar`)

Composite board: implemented through the boards it imports.
