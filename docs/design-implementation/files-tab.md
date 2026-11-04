# Files tab: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Files tab”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Workbench tabs · Tab strip · New tab actions · New tab search (`FilesTabsRow`)

Owner today: `shell/workbench/tab-strip.tsx · tab-chrome.ts · workbench-pane.tsx · tabs/file-status.ts`

Changes:
- Viewed shows only while Diff view is on; with it off, as here, the header drops it.
- The file name sits on the bar as plain text, with no edge or fill; its hit area stays 28px.
- File tab names keep the tab colour; only the status letter is coloured: M yellow, U green, D red.
- File options beside Viewed uses lucide ellipsis.
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; the open side column’s toggle is a bg2-highlight fill with no edge.
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; toggles add border4.

Code notes:
- The file name is a bordered chip (border1, 4px corners, 8 / 4px padding), the same title chip terminals use. (`shell/workbench/tab-chrome.ts:24-26 · shell/workbench/tabs/file-viewer.tsx:227`)
- The side-column toggles are ghost buttons that fill bg2-hover while their column is open; the edge came from the proposal’s pressed recipe. (`shell/workbench/tabs/files-tab.tsx:240-252,261-270,290-293`)
- A file tab tints its title as well as its status letter with the git colour (M yellow, U green, D red). (`shell/workbench/tab-strip.tsx:370-374,383-386 · shell/workbench/tabs/file-status.ts:4-18`)
- File options beside Viewed uses lucide SlidersHorizontal. (`shell/workbench/tabs/code-editor/file-editor-options.tsx:2,47-48`)
- Tab pills are 8px round with 10 / 6px padding (off the grid); the panel toggle is forced to 24px beside a 28px +; counts are 11px beside a 13px label; a running terminal swaps its 14px glyph for a 12px stream, so the label shifts 2px. (`shell/workbench/tab-chrome.ts:16 · shell/workbench/tab-strip.tsx:332,342-353,384,407 · shell/workbench/toggle-button.tsx:32-35`)
- The terminal sub-tab drifts from the workbench pill: manual margins, a 140px label cap (vs 180) and a 16px close under a 32px fade (vs 20px under 40). (`shell/workbench/tabs/terminal-tab.tsx:1564-1616 · shell/workbench/tab-strip.tsx:332,433-444`)
- One list mixes 30px and 48px rows; the folder line truncates its tail, hiding the deepest folder; two empty recipes; fixed 280px wide. (`shared/ui/primitives/command.tsx:143,188 · shell/workbench/new-tab-menu.tsx:343-346,398-405,412`)
- Four search-field recipes: a 36px header with a 16px glyph, a 36px command row holding a 40px input, a 40px quick-open row, and a 24px input with a shadow. (`shell/workbench/tabs/files-search-sidebar.tsx:71-80 · shared/ui/primitives/command.tsx:106-112 · shell/workbench/new-tab-menu.tsx:262 · shell/workbench/tabs/changes-surface.tsx:1028-1040`)

## Files tab · File open · Open file · Couldn’t load · Context menu · Search · Working folders (`FilesTreeRow`)

Owner today: `shell/workbench/tabs/files-tab.tsx · file-viewer.tsx · code-editor/source-editor.tsx · workspace-file-tree.tsx`

Changes:
- Comments work as in the Changes tab: hovering a line puts a + on its number, a click opens the composer, dragging the numbers selects lines in blue and opens it on release.
- No separate comment column: the code starts 24px further left than today.
- Selecting code text stays a plain selection; it no longer opens a comment toolbar.
- Tree rows are 28; the selected row fills bg2-highlight.
- Every Files empty state uses one 24px fg3 icon over one 13/18 fg2 line: Couldn’t load, No preview and Password protected alike.
- Headers: window 40 with 12 / 6 padding, panel 36 with 12 / 4.

Code notes:
- A 24px comment column sits left of the line numbers whenever comments are available (the review extensions load before the base set), and its + shows only while that empty column is hovered. Proposed: drop the column and show the + in the number gutter. (`features/code-review/use-editor-code-review.tsx:94-147,347-362 · shell/workbench/tabs/code-editor/code-editor.tsx:87-88,275-276`)
- Number clicks and drags, text selections and Shift + arrow selections commit the selection toolbar today. Proposed: as in Changes, a number drag opens the composer and text selection stays plain; threads use the same cards. (`features/code-review/use-editor-code-review.tsx:364-406 · review-annotation-view.tsx:62-75`)
- Comments are off while Diff view is on (the editor review is inactive for an editable diff); the same gutter + should work there once diff lines map to review anchors. (`shell/workbench/tabs/code-editor/source-editor.tsx:110-115`)
- Viewed shows whenever the open file has changes, with Diff view on or off; proposed: only while Diff view is on. (`shell/workbench/tabs/file-viewer.tsx:506-508,536-540,725-746`)
- Grouped files stack two 36px bars; the viewer’s right cluster (~300px) never wraps, so it clips in panes narrower than 380px. (`shell/workbench/tabs/file-group-viewer.tsx:56-109 · shell/workbench/tabs/file-viewer.tsx:719,825-826 · shell/workbench/workbench-pane.tsx:82`)
- Tree rows use the library’s 30px height with 8 / 10px vertical padding; Changes rows are 28. (`shell/workbench/tabs/workspace-file-tree.tsx:66,125-140,241`)
- The unified / split control is built twice: 24px segments in a 28px track here, a 26px track with a shadow in Files. (`shell/workbench/tabs/changes-diff-viewer.tsx:494-511 · shell/workbench/tabs/file-viewer.tsx:765-789`)
- Three Viewed controls (a checkbox, a 22px hand-built box, an 18px round toggle); viewed rows dim to 45% here and 70% in Review. (`shell/workbench/tabs/changes-diff-viewer.tsx:876-890 · shell/workbench/tabs/file-viewer.tsx:729-743 · shell/workbench/tabs/review-shared-components.tsx:225-231`)
- Two tab-pill recipes in one band: chat pills 8px padding, 8px gap, 70–140px; workbench pills 10px padding, 6px gap, up to 180px; both 8px round where tabs spec 6. (`shell/conversation/chat-tabs.tsx:184 · shell/workbench/tab-strip.tsx:332 · shell/workbench/tab-chrome.ts:15-16`)
- Four empty-state recipes: Home 32px at stroke 1.5 with 14px text, the workbench 40px at stroke 1, Browser 28px, and the repo page text only. (`features/dashboard/dashboard-page.tsx:451-459 · shell/workbench/tab-status.tsx:58-65 · shell/workbench/tabs/browser-start-page.tsx:43-44,192 · features/repositories/repo-page.tsx:376-386`)
- Three empty states in one tab: a 24px icon at fg2/60, the 40px workbench empty state, and a 12px-gap stack. (`shell/workbench/tabs/file-viewer.tsx:1095-1097 · shell/workbench/tab-status.tsx:60-64 · shell/workbench/tabs/files-tab.tsx:349-363`)
- The tab banner is a fixed 48px even for one line, and its 12px inset sits 4px right of the 8px toolbar above. (`shell/workbench/tab-status.tsx:111`)
- The tree context menu overrides the shared menu: 8px corners, 4px inset, bg2 and border1, with 4px rows and a bg2-hover. (`shell/workbench/tabs/workspace-file-tree.tsx:924-925,983 · shared/ui/menu-surface.ts:16-25`)
- The action bar uses border2 (the sidebar uses border1) and 12 / 8px padding around a 28px Save (a 44px row); Select all is bare text with an 18px hit area. (`shell/workbench/tabs/working-directories-panel.tsx:241-269`)

## File viewer · File options · Markdown preview · No preview · Save failed (`FilesViewerRow`)

Owner today: `shell/workbench/tabs/code-editor/file-editor-options.tsx · editor-preferences.ts · source-editor.tsx`

Changes:
- Switch thumb sits 2px inside the track with one soft shadow.
- Shortcut chips: 18 tall, bg2 + border2, 11/16 medium.
- Segmented: 28 track, 24 items; selected is bg1 + border2 in Light, bg4 with no edge in Dark.
- Toast joins the floating family: bg3, border2, 12px corners, 360 wide, close inside the top-right corner.

Code notes:
- The options popover mixes 28px button rows (6px inset) with 32px switch rows (8px inset), so left edges and heights differ. (`shell/workbench/tabs/code-editor/file-editor-options.tsx:53-99`)
- The file header row mixes five control heights: a 28px title chip, 24px actions, a 22px Viewed, 26px segmented controls and 28px toggles; the breadcrumb glyph is 13px against 14 elsewhere. (`shell/workbench/tab-chrome.ts:26-28 · shell/workbench/tabs/file-viewer.tsx:228,732,757,765-809 · shell/workbench/tabs/files-tab.tsx:240-299`)
- The markdown column is max-w-3xl without mx-auto, so it hugs the left; body is 14 / 22.75 against 13 / 18 elsewhere. (`shell/workbench/tabs/file-viewer.tsx:897,1061-1071`)
- A failed save is only a toast, the error that turns autosave off is never shown, and inline notices come in 26, 34 and 36px recipes. (`shell/workbench/tabs/code-editor/source-editor.tsx:220-232,357,364-381 · shell/workbench/tabs/file-viewer.tsx:905`)

## Files tab · File viewer · All states (`States_files_tab_files_tab`)

Composite board: implemented through the boards it imports.

## Diff view · Editing, selection and changes (`FilesDiffView`)

Owner today: `shell/workbench/tabs/code-editor/editable-diff-editor.tsx · editable-diff-model.ts · source-editor.tsx · shared/theme/diff-theme.ts`

Changes:
- Viewed shows only while Diff view is on, as here; checking it marks the file and keeps it open instead of jumping to the next change.
- Diff view keeps the plain editor’s type and gutter: 12px mono on a 1.6 line, numbers padded 12px, so turning it on or off moves no text.
- Each change is drawn into its row: a 2px bar on the gutter edge, the row wash, a + or − in the gutter padding and the number in the change colour.
- Edited words take a stronger wash with 2px corners, on the removed and the added line alike.
- The caret line lifts by fg1 5% over any row colour; removed lines are read-only, so the caret and arrow keys step over them.
- Selection is the plain editor’s fg1 at 18%, painted over the row wash, so it reads the same on added and unchanged lines.
- Removed lines are not part of the file: a drag passes over them unpainted, and Copy leaves them out.
- Added: green row, bar and +. Removed: red row, bar and −, with the old line number. Changed: both rows, the edited words marked.
- A wrapped line keeps its wash and bar down every visual line; the number and sign stay on the first.
- A new or untracked file keeps the green bar and + but drops the row wash, so a whole file never turns green.
- Removed text keeps its syntax colours, so old code still reads as code.
- When Diff view can’t edit a file, the body says so in the one empty state (24px icon, 13/18 line) with Turn off Diff view.
- Retry shows only where it can help: a partial read can come back whole; a binary, deleted or oversized file can’t.

Code notes:
- Checking Viewed opens the next unviewed change in the same tab; proposed: mark the file and stay on it, as unchecking already does. (`shell/workbench/tabs/file-viewer.tsx:546-590`)
- Diff view swaps CodeMirror for Pierre’s CodeView, whose theme sets only the mono family: text grows from 12px on a 1.6 line to Pierre’s 13px on 20px, and every line shifts. (`shell/workbench/tabs/code-editor/source-editor.tsx:385-386 · shell/workbench/tabs/code-editor/theme.ts:38-42 · shared/theme/diff-theme.ts:75-77`)
- The gutter changes with it: CodeMirror pads numbers 12px each side, Pierre draws its own number column and change bar, so code starts at a different x. (`shell/workbench/tabs/code-editor/theme.ts:49-54 · shell/workbench/tabs/code-editor/editable-diff-editor.tsx:131-139`)
- Editing in Diff view is unified only and shows the whole file; the base is the committed file from a full-context diff, the editable side is the live draft. (`shell/workbench/tabs/code-editor/editable-diff-editor.tsx:123-139 · shell/workbench/tabs/code-editor/editable-diff-model.ts:50-103`)
- Pierre’s shadow CSS opts every source row into text selection, removed rows included, so copying across a change also copies text that is no longer in the file. (`shared/theme/diff-theme.ts:79-81`)
- CodeMirror paints selection fg1 at 18%; the diff surface’s theme sets no selection colour, so a drag there takes the system highlight. (`shell/workbench/tabs/code-editor/theme.ts:68-71 · shared/theme/diff-theme.ts:73-116`)
- Row and word washes come from Pierre: diff-addition and diff-deletion mixed 65% with diff-neutral, then 15% into the surface. (`shared/theme/diff-theme.ts:86-91`)
- A new or untracked file has no base, so every line renders as an addition and the whole editor turns green. (`shell/workbench/tabs/code-editor/editable-diff-model.ts:58-59 · shell/workbench/tabs/code-editor/editable-diff-editor.tsx:121-130`)
- A comparison that can’t become an editor (over 8 MB, binary, deleted or partial) throws; the error lands in the tab banner with Retry and the body stays empty. (`shell/workbench/tabs/code-editor/editable-diff-model.ts:60-82 · shell/workbench/tabs/code-editor/editable-diff-editor.tsx:78-89`)
- Only the size message says what to do; the binary, deleted and partial messages leave the way out to guesswork. (`shell/workbench/tabs/code-editor/editable-diff-model.ts:61-82`)

## Media preview · Image · Video (`FilesMediaRow`)

Owner today: `shell/workbench/tabs/file-media-preview.tsx · file-media-viewport.ts`

Changes:
- The zoom island sits centred under the image.
- Floating toolbar: 36 bar, 28 buttons, 14 icons, 10px corners, border2.
- Playback and zoom are one centred 36px island: play, seek, time and mute, a divider, then zoom out, 100%, zoom in and reset.
- The island is at most 480px wide and narrows with the tab instead of filling it; the seek bar takes the slack down to 48px and the time hides under 400px.

Code notes:
- The zoom island starts a left-aligned, wrapping row, so it sits bottom-left under a centred image. (`shell/workbench/tabs/file-media-preview.tsx:273-278`)
- Three zoom-island builds, all 34px (off the 32 / 36 scale): one in-flow with a shadow, one with no shadow and 10px time, and a fully round PDF island. (`shell/workbench/tabs/file-media-preview.tsx:273-277,294,394,438 · shell/workbench/tabs/document-controls.tsx:44-49,117`)
- Zoom and playback are two islands in one wrapping row; playback is flex-1 basis-48, so it stretches across the whole tab. (`shell/workbench/tabs/file-media-preview.tsx:273,320-327,392-395`)

## Documents · PDF · Password protected (`FilesDocsRow`)

Owner today: `shell/workbench/tabs/file-pdf-preview.tsx · document-controls.tsx`

Changes:
- The password prompt leads with the same 24px lock icon and 13/18 fg2 line as the other empty states, above the field and Open PDF.
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.

Code notes:
- The password prompt has no icon: a 13px label, the field and a compact Open PDF, unlike every other empty state in the tab. (`shell/workbench/tabs/file-pdf-preview.tsx:200-222`)
- A 28px input (14px text) is stacked over a 24px compact button, 12px apart. (`shell/workbench/tabs/file-pdf-preview.tsx:200-222 · shared/ui/primitives/input.tsx:16`)
