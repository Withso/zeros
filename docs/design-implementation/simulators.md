# Simulators: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Simulators”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Simulator setup · States (`SimSetup`)

Owner today: `features/simulators/simulator-setup-screen.tsx · simulator-setup-model.ts`

Changes:
- One line says what the setup does; the check is one 32px status row with its fix beside it, not a filled card.
- Check again is a refresh icon; the details that repeated the fix button retire.

Code notes:
- The setup card pads 12 × 10 with 24px actions right above a 28px split button; metadata is 10–11px; cloud shows a lone icon with no caption. (`features/simulators/simulator-setup-screen.tsx:55-90,134-136,166 · features/simulators/simulator-tab.tsx:57-58`)

## Simulators · Cloud workspace (`SimCloud`)

Owner today: `features/simulators/simulator-tab.tsx · SimulatorUnavailable`

Changes:
- One empty state says why and what to do; the strip note and the phone outline retire.

## Setup · All states (`States_simulators_setup`)

Composite board: implemented through the boards it imports.

## Simulator · Running (`SimRunning`)

Owner today: `features/simulators/local-simulator-tab.tsx · SimulatorStage, SimulatorPicker · simulator-island.tsx · agent-control-bar.tsx (pill)`

Changes:
- Floating toolbar: 36 bar, 28 buttons, 14 icons, 10px corners, border2.
- Shortcut chips: 18 tall, bg2 + border2, 11/16 medium.
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.
- Headers: window 40 with 12 / 6 padding, panel 36 with 12 / 4.
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; toggles add border4.

Code notes:
- Screen states use a 20px LoaderCircle with 12px gaps (16px spinner elsewhere); controls pad 16px below against 12 for media. (`features/simulators/local-simulator-tab.tsx:99-111,399,429`)
- The simulator toolbar is a 40px window header while every other tab toolbar is 36px, so content shifts 4px between tabs. (`features/simulators/local-simulator-tab.tsx:385 · shared/ui/primitives/panel-header.tsx:11-13`)

## Simulator · Choose a simulator (`SimDeviceMenu`)

Owner today: `features/simulators/simulator-device-menu.tsx · SimulatorDeviceMenuContent`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

Code notes:
- Device rows are two-line (≈45px) beside 30px action rows, and Booted has a dot that Available lacks, so labels misalign by 12px. (`features/simulators/simulator-device-menu.tsx:22-26,58,67-104`)

## Simulator island · States (`SimIsland`)

Owner today: `features/simulators/simulator-island.tsx · SimulatorIsland`

Code notes:
- Icon buttons have 4px corners beside a 6px record button; recording swaps a 24px square for dot + timer, so the centered island widens and shifts. (`features/simulators/simulator-island.tsx:173,211,223-252 · shared/ui/primitives/icon-button.tsx:77`)

## Simulator · Keep running (`SimKeepRunning`)

Owner today: `features/simulators/simulator-controller.tsx · simulator-notices.ts · simulator-capture-actions.ts`

Changes:
- Toast joins the floating family: bg3, border2, 12px corners, 360 wide, close inside the top-right corner.
- Primary actions drop the stock shadow.

## Annotate · Drawing (`SimAnnotate`)

Owner today: `features/simulators/simulator-annotator.tsx · SimulatorAnnotateToolbar, AnnotationColorMenu`

Code notes:
- The annotate toolbar wraps to about 62px on narrow panes, so the device shrinks and jumps when Annotate opens. (`features/simulators/simulator-annotator.tsx:551-622 · features/simulators/local-simulator-tab.tsx:427-442`)

## Annotate · Note for the agent (`SimAnnotationNote`)

Owner today: `features/simulators/simulator-annotator.tsx · SimulatorAnnotator (note popover)`

Changes:
- Popovers and hover cards: bg3, border2, 12px corners, 12px padding.
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.

Code notes:
- The note popover pads 8px around a 28px input with 14px text; menus use a 6px inset and 13px. (`features/simulators/simulator-annotator.tsx:439-483`)

## Annotate · Discard confirmation (`SimDiscard`)

Owner today: `features/simulators/simulator-annotation-dialog.tsx · SimulatorAnnotationLeaveDialog`

Changes:
- Dialog: border2, 12px corners and a 16px inset; a 24px close, Ghost Cancel, and the footer rule retires.

Code notes:
- Discard renders ⌘↵ as a dimmed 10px span inside the destructive button; Review uses the Kbd chip. (`features/simulators/simulator-annotation-dialog.tsx:78-81 · shell/workbench/tabs/discard-file.tsx:207-210`)

## Captures · Stack (`SimCaptures`)

Owner today: `features/simulators/simulator-capture-stack.tsx · simulator-capture-model.ts`

Code notes:
- The hover toolbar is 30px and sits inside the card’s overflow, so its shadow is clipped; the duration chip has no vertical padding; from the fourth card on, cards share one z-layer. (`features/simulators/simulator-capture-stack.tsx:39,110,135,141-145`)
- Bottom-right surfaces use 16px (PiP, float stack) and 24px (captures, toasts) insets, so stacked cards misalign by 8px; the PiP uses an arbitrary rgba shadow. (`features/browser/browser-agent-picture-in-picture.tsx:380,440-456 · features/browser/browser-float-stack.tsx:248 · features/simulators/simulator-capture-stack.tsx:236`)

## Simulator · Annotate and capture · All states (`States_simulators_running`)

Composite board: implemented through the boards it imports.
