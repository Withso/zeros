# Browser: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Browser”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Browser · Start page (`BrwStart`)

Owner today: `shell/workbench/tabs/browser-start-page.tsx · browser-tab.tsx (BrowserChrome)`

Changes:
- Cards and tiles round to 12; hover lifts to border3 + bg2-highlight.
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.
- Empty state: a 32 icon in fg3 and one 13 fg2 line.
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.
- Headers: window 40 with 12 / 6 padding, panel 36 with 12 / 4.
- The browser toolbar is 36 with 28px buttons and a 28px omnibox (6px corners, 13px text).

Code notes:
- The hero is a 28px globe with 14px text; server rows are 48px tiles 6px apart with a 32px icon box and 11px detail. (`shell/workbench/tabs/browser-start-page.tsx:40-44,91-106,192`)
- The toolbar forces a 36px window header with every control at 24px; the omnibox is 24px with 4px corners and 14px text; Reload swaps a 14px glyph for a 16px spinner. (`shell/workbench/tabs/browser-tab.tsx:549-641,2247-2408 · shared/ui/primitives/panel-header.tsx:16-19`)
- Four empty-state recipes: Home 32px at stroke 1.5 with 14px text, the workbench 40px at stroke 1, Browser 28px, and the repo page text only. (`features/dashboard/dashboard-page.tsx:451-459 · shell/workbench/tab-status.tsx:58-65 · shell/workbench/tabs/browser-start-page.tsx:43-44,192 · features/repositories/repo-page.tsx:376-386`)
- In the 40px tab band, 28px pills and a 28px new-tab button sit beside the 24px panel toggle. (`shell/workbench/new-tab-menu.tsx:233-236 · shell/workbench/tab-chrome.ts:16 · shell/workbench/toggle-button.tsx:34-36`)
- Pill focus outlines are hidden at the strip ends by the 4px solid edge gutters and the overflow-hidden viewport. (`shell/use-sticky-tab-strip.tsx:60-61,396-403 · shell/workbench/tab-strip.tsx:306-337 · styles/global/scrollbars.css:18-23`)
- Second-row toolbars use five layouts: hand-built 36px rows with and without gaps, a 36px forced window header, 40px Design and Simulator headers, and Review’s 73 + 37px. (`shell/workbench/tabs/files-tab.tsx:495 · shell/workbench/tabs/changes-surface.tsx:869 · shell/terminal/terminal-workbench-layout.tsx:112 · shell/workbench/tabs/browser-tab.tsx:549 · features/design-workspace/design-directory-pill.tsx:40-41 · shell/workbench/tabs/review-tab.tsx:564,610`)

## Browser · Page loaded (`BrwLoaded`)

Owner today: `shell/workbench/tabs/browser-tab.tsx · IframeBrowserTab, BrowserChrome · tab-strip.tsx`

Changes:
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; toggles add border4.

## Start page · Local server states (`BrwStartStates`)

Owner today: `shell/workbench/tabs/browser-start-page.tsx · LocalServersSection · features/browser/local-dev-servers.ts`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

## Browser · Load and connection states (`BrwError`)

Owner today: `shell/workbench/tabs/browser-tab.tsx · NativeAgentBrowserTab, UnavailableBrowser`

Changes:
- Placeholders are one short line; a failed attach is the error row with Retry.

Code notes:
- Text-only 14px placeholders with no icon (32px and 16px padding). (`shell/workbench/tabs/browser-tab.tsx:189,680`)

## Browser tab · Preview unavailable (`BrwUnavailable`)

Owner today: `shell/workbench/tab-status.tsx · tab-status-model.ts · features/browser/use-iframe-webview.ts`

Changes:
- A failure is one 32px row under the toolbar; the page area no longer repeats it.

## Browser tab · All states (`States_browser_tab`)

Composite board: implemented through the boards it imports.

## Toolbar · States (`BrwToolbar`)

Owner today: `shell/workbench/tabs/browser-tab.tsx · BrowserChrome`

No change beyond the shared foundation and primitives.

## Toolbar · More browser actions (`BrwMoreMenu`)

Owner today: `shell/workbench/tabs/browser-tab.tsx · BrowserChrome menu · features/browser/browser-appearance-menu.tsx`

Code notes:
- The two More menus are 220 and 180px wide, Appearance is 140px, and the unavailable reason is an 11px label. (`shell/workbench/tabs/browser-tab.tsx:644,2410,2427 · features/browser/browser-appearance-menu.tsx:39`)

## Toolbar · Appearance (`BrwAppearance`)

Owner today: `features/browser/browser-appearance-menu.tsx · BrowserAppearanceMenu`

No change beyond the shared foundation and primitives.

## Device toolbar (`BrwDevice`)

Owner today: `features/browser/browser-device-toolbar.tsx · BrowserDeviceToolbar`

Code notes:
- The 36px device toolbar scrolls sideways with a visible bar when narrow (72px of chrome with the toolbar), and Dimensions adds a 4px offset. (`features/browser/browser-device-toolbar.tsx:350-353 · shell/workbench/tabs/browser-tab.tsx:2115-2117`)

## Toolbar and menus · All states (`States_browser_toolbar`)

Composite board: implemented through the boards it imports.

## Canvas mode (`BrwCanvas`)

Owner today: `shell/workbench/tabs/browser-tab.tsx · CanvasPresetRail, CanvasHeightIndicator · features/browser/canvas-knob-handles.tsx, browser-variant-frame.tsx`

Code notes:
- Canvas chrome is hand-built: 24 / 26px pills with a stock shadow, rail labels inside the zoomed wrapper (13px renders 2.6–26px), and a 34px variant header with 10px text. (`shell/workbench/tabs/browser-tab.tsx:1500,1964-1971,2477-2549 · features/browser/browser-variant-frame.tsx:190-250`)

## Design mode · Element picked (`BrwPicker`)

Owner today: `shell/workbench/tabs/browser-tab.tsx · ElementChip · electron/iframe-picker-script.ts`

Changes:
- Pills are neutral bg2 + border2: 20 inline, 24 as a control.

Code notes:
- The element chip is a fixed 340px (overflows panes under 356px) and assumes a 76px height, so tall chips run off the bottom; its remove target is 12px. (`shell/workbench/tabs/browser-tab.tsx:2555-2557,2638-2645,2656-2730`)

## Floating preview (`BrwFloat`)

Owner today: `features/browser/browser-float-stack.tsx · BrowserFloatBox · browser-tab.tsx (FloatingPreviewPlaceholder)`

Changes:
- Floating toolbar: 36 bar, 28 buttons, 14 icons, 10px corners, border2.

Code notes:
- The docked placeholder is another empty recipe (24px icon, 40px sides); the float title pill stretches to the 34px toolbar with 11px text. (`shell/workbench/tabs/browser-tab.tsx:2143-2152 · features/browser/browser-float-stack.tsx:404-418`)
- Bottom-right surfaces use 16px (PiP, float stack) and 24px (captures, toasts) insets, so stacked cards misalign by 8px; the PiP uses an arbitrary rgba shadow. (`features/browser/browser-agent-picture-in-picture.tsx:380,440-456 · features/browser/browser-float-stack.tsx:248 · features/simulators/simulator-capture-stack.tsx:236`)

## Agent browser · Picture in picture (`BrwAgentPip`)

Owner today: `features/browser/browser-agent-picture-in-picture.tsx · features/agent-control/agent-control-bar.tsx (strip)`

No change beyond the shared foundation and primitives.

## Design mode and floating · All states (`States_browser_design`)

Composite board: implemented through the boards it imports.
