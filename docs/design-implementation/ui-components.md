# UI components: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “UI components”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## UI components — index (`Main`)

Owner today: `45 components · 7 groupsRecipes as of withso/zeros@d6c7e3aUsage counts from the 2026-10-17 audit`

No change beyond the shared foundation and primitives.

## Button — variants and states (`Button`)

Owner today: `shared/ui/primitives/button.tsx509 uses in 150 files`

Changes:
- Names say what they are: variant="default" becomes "primary"; sm, md and lg become one standard size.
- Primary and Destructive are flat; the Tailwind stock shadow is gone.
- Ghost shows Open while its menu is open, like Secondary.
- Pressed works on Secondary and Ghost through aria-pressed; Secondary on is retired.
- Loading is built in: a spinner replaces the leading icon and the button keeps its colour.
- Disabled uses aria-disabled: 50%, a not-allowed cursor, and hover stays so the reason tooltip can show.
- Icon-only buttons move to IconButton; the legacy shared/ui/button.tsx wrapper is removed.
- Rendered in the new palette: Destructive red, brighter focus ring.
- Design-tab buttons use these variants: Export is Secondary (Exporting… is the loading state), Motion Save is Primary when there are changes and disabled with its reason otherwise (a Ghost today), zoom is a Ghost with tabular figures, and the conflict pause pairs Secondary with Ghost.

## Icon button — sizes and states (`IconButton`)

Owner today: `shared/ui/primitives/icon-button.tsxIconButton 33 uses · Button icon sizes 125 uses`

Changes:
- One component for every icon-only action: Button size="icon" moves to IconButton.
- One shape: 6px corners (4px for the 20px inline size).
- One hover, bg2-highlight, visible on every surface (bg2-hover was 1.06:1 on raised surfaces).
- Inline gets the focus ring and a fixed 12px glyph (callers used 12, 14 and 16).
- Toggle on is the neutral selected fill (selected-bg, no edge); the active tool of a toolbar is the selection blue.
- The deprecated hover="subtle" and motion options are removed.
- Design-tab icon buttons use these sizes: section actions compact 24, row toggles standard 28 with the pressed recipe (pressed looked like hover), layer visibility and field keyframes inline 20, and the panel toggle shows its pressed state (none today).

## Split button — variants and states (`SplitButton`)

Owner today: `shared/ui/primitives/split-button.tsx1 use`

Changes:
- 28px tall in both variants (Primary was 26).
- Medium label in both variants, like Button.
- Each half takes Button’s focus ring, instead of an inset ring (Primary) or a fill that looked like hover (Secondary).
- The chevron uses muted-fg instead of fg2 at 50% opacity.
- Loading: the spinner replaces the action’s icon and the menu waits.

## Toolbar — floating tool group (`Toolbar`)

Owner today: `shared/ui/primitives/toolbar.tsx6 uses`

Changes:
- One size for every toolbar and island: bar 36, buttons 28, icons 14 (today 30, 34 or 40; 24 or 32; 12, 14 or 16).
- Hover uses bg2-highlight, visible on the toolbar (bg2-hover was 1.06:1).
- The active tool is the selection blue with a white icon in every toolbar; toggles stay neutral.
- Divider border2, 1 × 16; corners 10 on the bar, 6 on the buttons.
- Elevation is the Zeros dropdown shadow when floating, none when docked (Tailwind shadow-xl is gone).
- Keyboard: one Tab stop, arrow keys between tools.
- The Design rail, agent chip, simulator, browser, file-preview and PDF bars all follow it (below).

## Input — states (`Input`)

Owner today: `shared/ui/primitives/input.tsx72 uses in 40 files`

Changes:
- Text is 13/18, the same as Button and Select (it was 14/20).
- Every field has 8px side padding, so text lines up between an Input and a Select (Input was 12, Select 6).
- Hover lifts the border to border4, as on Select.
- Two kinds of focus: Tab shows the standard ring, the same as Button; clicking in and typing change nothing, the caret is the cue (today any focus turns the border bright).
- Invalid is a red border plus a message under the field; Field gives every form one label, hint and error recipe.
- A compact 24 size and an inline-rename look replace the height overrides and raw inputs (inspector fields, chat-tab rename).
- The Tailwind stock shadow is gone.
- Design-tab text entry uses three recipes: renames (layer, frame title, page) use the inline-rename and standard sizes instead of three local overrides (24 with 4 padding, 24 with 12 padding at 14px, 28); fields inside the inspector and its popovers, including Advanced’s add row and the token search, are filled property fields, not outlined Inputs.

## Textarea — states (`Textarea`)

Owner today: `shared/ui/primitives/textarea.tsx11 uses in 10 files`

Changes:
- The same field box as Input: 13/18 text, 8px side padding, hover and invalid.
- Typing changes nothing; only Tab focus shows the ring.
- The minimum height is three lines (68) instead of the arbitrary 60px.
- The Tailwind stock shadow is gone.

## Select — trigger and menu (`Select`)

Owner today: `shared/ui/primitives/select.tsx26 uses in 17 files`

Changes:
- The trigger uses the field box: 8px left padding (was 6), so a value lines up with Input text above or below it.
- The chevron is muted-fg, fg2 on hover and open, instead of fg2 at 50% opacity.
- The placeholder is fg3, like Input (it was fg2).
- Keyboard focus adds the 3px halo, a click just opens the list; invalid shows a red border (today’s invalid ring has no width, so it never appears).
- size="compact" is a real 24px size (today sm changes nothing).
- The chosen value carries a check at the end of its row, as in every single-choice menu.
- The Design tab’s selects are a filled variant of this trigger: the same 28, 8 left padding and chevron rules on a bg2 fill with no resting border, hover bg2-highlight, the keyboard ring, a fg3 placeholder (fg1 today) and the check at the end of the chosen row.

## Checkbox — states (`Checkbox`)

Owner today: `shared/ui/primitives/checkbox.tsx3 uses`

Changes:
- A 16px box, the same as Radio (it was 14).
- The check is a 2px stroke at 12px; today’s 3.5 stroke is overridden to 1px and reads faint.
- Hover lifts the border; a checked box darkens on hover.
- Disabled is 50% like every other control (Checkbox was 55%, Label 70%).
- The label is 13/18 with an optional 12px hint, and the whole row is the click target.
- The inspector’s checkbox rows (Clip content, Reverse order) use this Checkbox: the 16 box with its focus border instead of a custom 14 box, and help in a Tooltip instead of a native title.

## Radio group — states (`RadioGroup`)

Owner today: `shared/ui/primitives/radio-group.tsx2 uses`

Changes:
- The same 16px box as Checkbox: border4 at rest, fg3 on hover.
- Selected fills with inverted-bg and a dot, the same "on" look as a checked box (it was an fg1 ring).
- Focus is the standard halo instead of a 2px outline offset by 2.
- The label is 13/18 like every control label (it was 14).

## Switch (toggle) — states (`Switch`)

Owner today: `shared/ui/primitives/switch.tsx29 uses in 15 files`

Changes:
- Hover lifts the ring of an off switch, like Checkbox and Radio.
- The track’s stock shadow is gone; the thumb keeps one soft shadow.
- In dark the thumb is #0D0D0D on the brown track (8.5:1, from the color pass); the brown on-state stays.
- Settings rows use the same name and hint sizes as every field label.

## Slider — values (`Slider`)

Owner today: `shared/ui/primitives/slider.tsx0 uses`

Changes:
- Track border3, range and thumb fg1, instead of primary-button-bg, a button token.
- The thumb is a solid 14px dot with a bg1 ring; hover shows a soft halo, focus the standard ring.
- Disabled dims the whole slider (today nothing changes, because the disabled classes sit on a span).
- The video seek bar should use it instead of a raw range input.
- The colour picker’s hue and alpha strips and the gradient stop bar are their own picker sliders: a 12 rounded strip with a 14 thumb on white rings, and the keyboard ring on the focused thumb; a selected stop takes a neutral fg1 ring, not the focus colour.

## Dropdown menu — items (`DropdownMenu`)

Owner today: `shared/ui/primitives/dropdown-menu.tsx44 menus · 88 items in 33 files`

Changes:
- One floating surface for every menu, Select list, command list and popover: bg3, border2, 12px corners (was 16) and the dropdown shadow.
- Rows are 28 tall with 8px corners inside a 4px inset, so the corners stay parallel (8 inside 16 at 6 was a documented exception).
- One shortcut style everywhere: the Kbd chip (the 60% text shortcut retires).
- Choices follow what they are. One choice marks the chosen row with a check at its end, the way Select does; several choices (filters, view options) keep a check column on the left, so every option lines up whether it is on or off. The dot and the end box retire.
- Group labels are 12 medium fg3 in every menu (semibold here, regular fg2 in Context menu).
- Destructive items are red-primary and sit last.
- Design-tab menus use this surface and these rows: zoom (shortcuts become Kbd chips instead of 60% text), pages (Delete last in red-primary), fonts (each family in its own face), Design directories (the check at the end of the current one), size mode and blend mode (14 icons with the 8 gap; the size-mode icons render at 24 today).

## Context menu — items (`ContextMenu`)

Owner today: `shared/ui/primitives/context-menu.tsx7 menus · 21 items`

Changes:
- The same surface and rows as Dropdown menu.
- The group label is 12 medium fg3, like every menu (it was fg2 regular).
- Status glyphs are 14px like other menu icons, so their labels line up (16px pushed them 2px right).
- Delete sits last in red-primary, after a separator.
- The canvas’s only context menu, “Select layer”, lists the layers under the pointer with the menu label and Kbd chips for the depth (12 muted-fg text today).

## Command — palette and inline list (`Command`)

Owner today: `shared/ui/primitives/command.tsx10 uses in 8 files`

Changes:
- The same surface as menus: bg3, border2, 12px corners (the inline palette was 8).
- Inline rows are the menu row; the dialog uses one larger row, 36 tall with 16px icons (44 and 20 today).
- The search icon is muted-fg instead of 50% opacity.
- Shortcuts are Kbd chips (wide-tracked text today), and the dialog footer names the keys.
- Group headings are the menu label.
- The CSS tab’s autocomplete becomes this inline list on the menu surface (bg3, radius 12, 28 rows) instead of its own bg2 popup with radius 8, 30 rows and a custom shadow.

## Popover — surfaces (`Popover`)

Owner today: `shared/ui/primitives/popover.tsx28 uses in 24 files`

Changes:
- Popovers share the menu surface: 12px corners (16) and padding 12 (16).
- Three widths, sm 240 · md 320 · lg 400, instead of each feature setting its own (230, 320, 360, 384, 420).
- The usage meter draws fg1 on a border3 track with its numbers.
- A list popover uses menu rows instead of its own row recipe.
- Design property popovers (layout, stroke, effect, type, transform, colour, motion settings) use this surface at sm 240 or md 320 (240, 256 and 288 today), with a 28 header and 72 label rows.

## Hover card — surface (`HoverCard`)

Owner today: `shared/ui/primitives/hover-card.tsx8 uses in 7 files`

Changes:
- Hover cards join the floating family: bg3, border2 and 12px corners (bg2 at 8px today).
- Padding 12 and secondary text at 12px fg3, like popovers.
- Their trigger is the standard inline pill.

## Tooltip — variants (`Tooltip`)

Owner today: `shared/ui/primitives/tooltip.tsx292 uses in 105 files`

Changes:
- A solid bg3 chip with border2 and the dropdown shadow, instead of 40% glass with a blur: it reads the same on any background.
- 6px corners (4) with 8 × 3 padding and 12/16 text in fg1.
- Shortcuts are the Kbd chip, the same as menus (fg2 text today).
- Disabled buttons keep hover, so a tooltip can say why.
- Every Design-tab hint is this Tooltip: tool rail labels with Kbd chips, the panel toggle (its shortcut is in the label text today), value provenance, token descriptions, “Inherits Base” and disabled reasons. The seven native titles (checkbox help, Clip content, token descriptions, frame labels, the pivot, spacing handles) move to it.

## Dialog — anatomy (`Dialog`)

Owner today: `shared/ui/primitives/dialog.tsx34 dialogs`

Changes:
- 12px corners (8) and a border2 edge, like the other floating surfaces; the fill stays bg1.
- One 16px inset for header, body and footer (the footer was 10 with a divider).
- Three widths, sm 400 · md 520 · lg 640, instead of eleven.
- Cancel is always Ghost (13 Ghost and 11 Secondary today); the main action is Primary or Destructive.
- Close is a 24px IconButton (a 20px circle today); fields use the new field box.
- Design-tab dialogs use these widths and roles: Delete page is sm with Ghost Cancel and Destructive (Secondary Cancel today); cancelling a paused rebase is sm with Destructive secondary. The Theme editor window shares the surface, non-modal.

## Toast — variants (`Toast`)

Owner today: `shared/ui/primitives/elements/toast.tsxtoast() · toast.success() · toast.error()`

Changes:
- Toasts join the floating family: bg3, border2, 12px corners and the dropdown shadow (bg1, no border, 8px today).
- Width 360 (an arbitrary 350px today).
- Title 13 medium and description 12 fg2 (14 and 13 today), like popovers.
- Close is a 24px IconButton inside the top-right corner (outside the top-left today).
- Info draws blue-primary like every tone draws its own colour (fg2 today).

## Tabs — every tab style (`Tabs`)

Owner today: `shared/ui/primitives/tabs.tsx · shell/workbench/tab-chrome.ts · shell/conversation/chat-tabs.tsx`

Changes:
- Two styles instead of four: a segmented control for switching a view, and one tab for every strip (chrome, workbench and chat).
- One corner radius, 6 (the primitive used 6, the shell 8).
- Every tab is 13px and flat; the segmented control loses its 14px text and stock shadow.
- Every tab has a hover (only the shell tabs had one, and it was the active fill).
- Active is bg2 with fg1 medium text; hover is bg1-hover; keyboard focus is the standard ring.
- Chat and file tabs show the ✕ only on hover or keyboard focus. It is drawn over the end of the tab, on a fade in the tab’s own fill, so the tab keeps its width and the title runs under it.
- The selected segment never sits darker than its track: in Dark it lifts to bg4 (#3D3D3D) with no edge, because a border2 ring would read as a dark outline on the lighter fill; Light keeps bg1 with its border2 edge.
- In the Design tab, Style \| CSS is the standard tab (a tablist with the keyboard ring, not two pressed buttons); inspector segmented controls use this recipe on a 28 track with one Tab stop and arrow keys and no edge on the selected segment, and rotate/flip stay on a track as plain buttons.

## Panel header — sizes (`PanelHeader`)

Owner today: `shared/ui/primitives/panel-header.tsx9 uses in 7 files`

Changes:
- Actions are 28px IconButtons with 2px gaps at both sizes.
- The title is 13 medium fg1 and truncates.
- Height and gap overrides on window headers retire (36 and 8 today); the border1 divider stays.
- The Design tab uses both sizes: the Design toolbar and the inspector tab row are window 40; the selection header (40 today), Layers and inspector sections are panel 36. The lint row becomes the error Banner instead of red text in a header.

## List row — states (`ListRow`)

Owner today: `shared/ui/primitives/list-row.tsx6 uses in 5 files`

Changes:
- Hover is bg1-hover, the canvas’s own hover token, instead of bg2-hover at 40% alpha.
- Expanded has no fill: only the chevron turns, so a transcript with every tool call open stays plain. Hover is the only fill.
- The time uses fg3 (muted-fg is a 3:1 tier, below AA for text).
- 28 tall, and the keyboard ring.

## Sidebar row — states (`SidebarRow`)

Owner today: `shell/sidebar-workspace-row.tsxinside Surface kind="sidebar"`

Changes:
- Selected gets its own fill, bg2-highlight with fg1, so it no longer looks like hover (one shared fill today).
- Change counts are 12px (11).
- Keyboard focus is the standard ring.

## Badge — variants (`Badge`)

Owner today: `shared/ui/primitives/badge.tsx7 uses in 6 files`

Changes:
- One size: 20 tall, 12 medium, 6px padding, 4px corners (24 to 26 with 13 or 14px text today).
- Status badges are tinted pairs, family-bg with family-fg; Accent becomes Info (blue-bg with blue-fg).
- No stock shadows; Default and Destructive, which have no callers, retire.
- Callers stop reshaping it (the Admin badge and the 28px sign-in status).
- In the Design tab, “N selected” in Layers is the neutral Badge (a custom chip today); readouts on the canvas use the canvas chip instead.

## Pills — every type (`Pills`)

Owner today: `Pill primitive + 20 feature recipes`

Changes:
- Every pill the app ships has a row below: 22 kinds today, in eight heights from 17 to 28. Two sizes remain: 20 inline (12/16, 4 px corners) for text and rows, and 24 control (13/18, 6 px corners) around the composer.
- One neutral look for references: bg2 with border2, hover border3 with bg2-highlight; “on” fills selected-bg and keeps its resting edge.
- Tints only where they mean something: red for a failed tool target, brown for the Design mode tag, and a dashed outline for anything whose target is gone.
- Chat and workspace links are neutral inline pills too, with no blue: the icon tells them apart. A chat shows its agent’s logo in the agent’s colour (Claude terracotta, Codex periwinkle, Cursor fg1); a workspace shows its glyph in its PR status colour, as in the sidebar (brown open, green ready, violet merged, red closed or conflicting, fg2 while an agent works, quiet with no PR).
- Composer pills swap their icon for × on hover, so the width never changes. A pill the caret selects fills with selected-bg (a workspace link steps its blue up) and draws no ring; a missing file gets a yellow outline and a grey icon.
- File paths an agent writes stay brown text links, not pills, so replies stay easy to read.
- Four things leave the pill family: the Truncated tag becomes a Badge, Jump to latest becomes a button, the PR chip stays in its island, and the Fast pill is gone.

## Kbd — shortcuts (`Kbd`)

Owner today: `shared/ui/primitives/kbd.tsx5 uses in 4 files`

Changes:
- One shortcut style for menus, tooltips and the command palette (three today: this chip, 60% text and fg2 text).
- An 18px chip, border2 on bg2, so it reads on bg3 menus (border1 was faint there).
- Combinations are one chip per key.
- The Design tab’s shortcuts use the same chip in the rail, the Layers tree, fields and the canvas (V · F · T · ⌥T · ⇧A · ⇧M · ⌘\ · F2 · ⌘D · ⇧H).

## Avatar — sizes (`Avatar`)

Owner today: `shared/ui/primitives/avatar.tsx4 uses in 3 files`

Changes:
- The badge sits outside the clip, so it is a full circle (the round root clipped its outer half).
- Initials are fg1 medium on bg2-highlight (fg2 on bg2-hover today).
- Groups overlap by 6 with a 2px ring of the surface.

## Status icon — lifecycle (`StatusIcon`)

Owner today: `shared/ui/primitives/status-icon.tsx6 uses in 3 files`

Changes:
- Labels use fg3 (4.5:1) instead of muted-fg, the 3:1 metadata tier.
- Inside menus the glyph is 14px, the menu icon size; elsewhere 16.
- Status colours keep their meanings, as agreed.

## Progress bar — values (`ProgressBar`)

Owner today: `shared/ui/primitives/progress-bar.tsx2 uses`

Changes:
- The track is border3 at 4px, like the Slider (bg2 at 6px was 1.06:1 on raised surfaces).
- The fill is fg1 for plain progress, yellow-primary near a limit and red-primary over it (green-fg is a text-on-tint token).
- A missing value still shows an empty track, never an animation.

## Card — surfaces (`Card`)

Owner today: `shared/ui/primitives/card.tsx2 uses`

Changes:
- One card surface, shared with Settings groups: bg1-bright, border1, 12px corners and 16 padding (24 padding and a stock shadow today).
- The title is 13 medium (semibold with tight tracking today); the description 13 fg2.
- Footer actions are compact buttons on the right.

## Tile — states (`Tile`)

Owner today: `shared/ui/primitives/tile.tsx2 uses`

Changes:
- Hover is bg2-highlight with border3, visible on bg2 (bg2-hover was 1.06:1).
- Keyboard focus is the standard ring (a 1px border2 ring at 1.4:1 today).
- 12px corners like cards; the description is 12 fg2.

## Separator and scroll bar (`Separator`)

Owner today: `shared/ui/primitives/separator.tsx · scroll-area.tsx7 and 6 uses`

Changes:
- One rule: border1 on the canvas, border2 inside floating surfaces and toolbars.
- The always-visible scroll thumb is border2 at rest and border3 on hover (border1 at 1.2:1 today).
- Resizable edges in the Design tab (panel width, the Layers split and the Motion strip) show a 2px border4 line on hover and drag; today only the Motion strip shows anything, in the selection blue.

## Alert — variants (`Alert`)

Owner today: `shared/ui/primitives/alert.tsx0 uses`

No change beyond the shared foundation and primitives.

## Banner and empty state (`Banner`)

Owner today: `shell/workbench/tab-status.tsxWorkbenchTabFrame · 4 uses`

Changes:
- 32 tall on the panel’s own background, like the Diff viewer’s message rows, with a border1 rule below (48 with tone fills today).
- The tone is the 16px icon alone: red for errors, yellow for warnings, a spinner or an fg3 icon otherwise; the line is 13/18 fg2.
- One line that ends in an ellipsis; Retry and other actions are 24px Ghost buttons.
- The rules stay: one banner per tab, under the toolbar rows, no close or timer. The PR status row keeps its own strip.

## Loaders — variants (`Loaders`)

No change beyond the shared foundation and primitives.

## Settings rows — flat and grouped (`SettingsRows`)

Owner today: `features/settings/settings-ui.tsxSettingsRow 57 · SettingsSection 28 · SettingsGroup 24`

Changes:
- One layout, grouped cards (flat sections retire): bg1-bright, 12px corners, border1 dividers.
- Names are 13 medium everywhere (the text-[14px] override, 25 uses, retires); hints 12 fg3.
- Controls are the proposed Select, Input and Switch, right-aligned at 28.
- Group titles 13 medium with an optional 12 fg3 description.

## Audit — controls side by side (`ControlsCompared`)

Owner today: `Drawn from the same recipes as the sheets on this page`

Changes:
- Every 28px control lines up on one grid, with the same corners, type and focus.
- Each open choice below is settled.
- The Design inspector’s filled controls sit on the same 28 grid: property field, filled select, segmented track, row toggle, Secondary button and the Style tab.

## Property field — inspector values (`PropertyField`)

Owner today: `features/design-workspace/design-inspector-kit.tsxdesign-workspace-ui.css · .zd-fieldDesign UI standard v1`

Changes:
- Same geometry: 28 tall, 6 corners, 13/18 tabular values, a bg2 fill and no resting border, so dense sections stay quiet.
- Hover and an open menu use bg2-highlight (1.19:1 against bg2, was 1.06:1).
- Tab shows the standard ring, a highlighted-bright border with the 3px halo; a click in shows only the caret and the selected value, as on Input.
- Labels, units and suffixes are fg3 (AA, was muted-fg); a scrub label turns fg1 under the pointer with the resize cursor.
- In-field menus (size mode, unit, font, easing) change colour only, fg3 to fg1, on a 20 target, and open the standard single-choice menu, with the check at the end of the chosen row.
- Values have tiers that show: authored fg1, computed fg2, the “–” placeholder and Mixed in fg3; labels are 12 medium as intended (14 today).
- A token value shows its name with the variable glyph, its description in a Tooltip (a native title today); a value set by a stylesheet rule carries a 6px fg3 dot with an origin Tooltip, not the focus colour.
- Motion mode draws the keyframe button over the field’s end on a fade in the field’s own fill (the closable-tab rule); an animated property’s label takes the selection blue.
- A sizing limit’s remove button uses the same overlay. Every inspector control dims to 50% when disabled.

## Inspector — Style panel and CSS (`Inspector`)

Owner today: `features/design-workspace/design-inspector.tsx · design-style-editor.tsxdesign-computed-css-editor.tsx · design-page-picker.tsxdesign-workspace-ui.css`

Changes:
- One panel geometry: 40 tab header, 36 selection header, 36 section headers, 0 12 12 bodies with 8 gaps, border1 between sections.
- Style and CSS are the standard tab (28, active bg2, keyboard ring); zoom is a Ghost button with tabular figures that opens the zoom menu.
- The selection header is 36 like the Layers header, with the layer type in fg3 at the end.
- Section actions are compact 24 IconButtons with 12 glyphs; row actions (wrap, settings, independent sides) are standard 28 toggles that use the pressed recipe, the selected-bg fill with no edge.
- Empty sections read as quiet rows: a regular fg2 title that turns fg1 on hover, with one add button each.
- Rotate and flip keep their track but are plain buttons with a hover fill and no pressed state.
- Segmented controls take the Tabs recipe: track radius 8, segments radius 6; the selected segment has no edge and sits lighter than its track (bg4 in Dark, bg1 in Light).
- Clip content is the 16 Checkbox; Export uses Secondary buttons and a filled scale select.
- The CSS tab uses the Files tab code theme (properties, functions, values) at 12/20, the active line in bg1-hover, computed hints in fg3 sans 12, and a red rule on a line that does not parse.

## Property rows — lists, summaries and extras (`PropertyRows`)

Owner today: `design-style-editor.tsx · design-fill-editor.tsx · design-stroke-editor.tsx · design-effect-editor.tsxdesign-advanced-style-section.tsx (main, Nov 1)design-auto-layout-controls.tsx · design-layout-controls.tsx`

Changes:
- Every row is on the 28 grid with 8 gaps: list rows end in compact 24 actions (animate, remove) inside a 28 cell, so one inspector has one row height.
- Remove is always “−” as a compact IconButton; Advanced’s ✕ and 28 buttons follow it.
- The effect settings trigger shows the kind it opens (shadow, blur) instead of a sun for all four.
- Summaries (Transform, Motion, gradient and image fills) are one field-shaped button: icon 14 fg3, value fg1, meta 12 fg3, hover bg2-highlight; Motion’s icon is the filled diamond in the selection blue.
- Advanced uses filled fields for its rows and its add row (property with suggestions, value, add), with the class line in mono 12; values from a rule show the provenance dot.
- A sizing limit’s remove shares the field-overlay rule (a fade in the field’s own fill).
- The lint row is the error Banner recipe, red-bg with red-fg, so it reads as a failure.

## Property popovers — settings beside the inspector (`PropertyPopovers`)

Owner today: `design-auto-layout-controls.tsx · design-stroke-editor.tsx · design-effect-editor.tsxdesign-typography-editor.tsx · design-motion-timeline.tsxdesign-workspace-ui.css · .zd-popover`

Changes:
- Property popovers are the Popover recipe at two widths, sm 240 (Layout, Stroke, Effect, Transform, Colour) and md 320 (Type and Motion settings): bg3, border2, radius 12, padding 12, 8 gaps.
- One header: 28, the title 13 medium, actions as compact IconButtons (Reset).
- Rows are a 72 label in 12 fg3 beside the control; every field, select and segmented control inside sits on bg3-hover, so it reads the same against the surface in both themes.
- Text segments (Solid · Dashed, Regular · Italic) use the segmented recipe: the selected segment has no edge and sits lighter than its track (bg4 in Dark, bg3 in Light); the decoration segments use their glyphs instead of letters.
- Reverse order is the 16 Checkbox.

## Colour picker — tokens, custom and fill types (`ColorPicker`)

Owner today: `design-color-picker.tsx · design-color-tokens.ts (main, Nov 1)design-fill-editor.tsxdesign-workspace-ui.css · .zd-popover`

Changes:
- The picker is a sm 240 Popover (256 on the menu surface today) with the shared 28 header.
- Theme and Custom are the segmented recipe; Theme lists tokens as menu rows (28, swatch 14, the chosen token’s check at the end) under 12 medium fg3 group labels, with a filled search field like the inspector’s.
- The eyedropper is a standard 28 IconButton; the area and strips keep their thumbs, with the keyboard ring on the focused one.
- Gradient stops mark the selected stop with a neutral fg1 ring; highlighted-bright stays the focus colour.
- Fields inside sit on bg3-hover like every popover field; descriptions move to Tooltips.

## Layer tree — rows and states (`LayerTree`)

Owner today: `features/design-workspace/design-workspace-sidebar-panels.tsxdesign-layer-name-input.tsx · design-layer-label.tsdesign-workspace-ui.css`

Changes:
- The panel header is the 36 PanelHeader: the Layers fold, a neutral “1 selected” Badge and Collapse all as a standard 28 IconButton.
- Selected is bg2-highlight with fg1, like a selected Sidebar row; its descendants sit on bg2, and hover is bg1-hover, so the three read as separate steps.
- Type icons are fg3 (fg2 when selected), so names lead.
- A hidden layer’s name is fg3 (AA) with the eye-off button always shown; the visibility toggle is an inline 20 IconButton with aria-pressed.
- The disclosure gets a 16 slot and turns fg1 on hover.
- Rename is the inline-rename field (24, keyboard ring) in place of a resized Input.
- Loading, empty and error read as one line under the header; Couldn’t load offers a compact Retry.

## Theme editor — variables window (`ThemeEditor`)

Owner today: `design-theme-editor.tsx · design-theme-sources.tsxdesign-theme-editor.css`

Changes:
- The window joins the Dialog family it already resembles: bg1, border2, radius 12, a 40 title bar, and Close as a compact 24 IconButton (the 20 circle today).
- The rail is one recipe for sources and types: 12 medium fg3 section labels, 28 rows, selected bg2-highlight with fg1, counts 12 fg3, status glyphs in the StatusIcon colours.
- The active theme column is a neutral pressed toggle (the selected-bg fill, no edge); the selection blue stays on the canvas.
- Token names are code, so they are mono 12; type glyphs are fg3; an override of an imported token shows the Layers glyph in fg3 with a Tooltip.
- Value cells are filled fields; Reset is an inline 20 IconButton drawn over the field’s end on hover, the inspector’s overlay rule; inherited values show the inherited value in fg3 with an “Inherits Base” Tooltip.
- Row actions (rename, delete) sit in a compact ⋯ at the row’s end on hover.
- The source strip, paste panel and new-variable row use compact Ghost and Secondary buttons; the empty state is the standard one-line empty state with a 32 icon.

## Motion timeline — transport, lanes and keyframes (`MotionTimeline`)

Owner today: `design-motion-timeline.tsx · design-motion-timeline.cssdesign-workspace-overlays.tsx (motion overlay)`

Changes:
- The panel is the floating-window recipe (bg1, border2, radius 12, shadow) with the 40 header of the Theme editor; Close keeps the chevron because the timeline collapses rather than closes.
- Play is a standard IconButton whose pressed state is the neutral selected-bg fill with no edge; the selection blue stays for the playhead, keyframes, clip and the unsaved dot, which belong to the canvas.
- Ruler marks, the time total and counts are 12 fg3 tabular (11 muted-fg); grid lines are border1.
- Track hover actions are compact 24 IconButtons; a selected track keeps the soft blue row, an invalid one a red edge.
- Keyframes keep their 10 diamond with a 16 target; keyboard focus is the standard highlighted-bright ring.
- A layer with no properties shows one line, “Add a property to animate”; easing is a single-choice menu with the check at the end; presets are actions with no check.
- The resize strip shows a border4 line on hover, the same as the panel and Layers handles; the canvas chip is the selection readout: label blue with white text and diamond, no edge.

## Canvas chrome — frames, selection and overlays (`CanvasChrome`)

Owner today: `features/design-workspace/design-canvas.tsx · design-workspace-overlays.tsxdesign-layout-tools-overlay.tsx · design-agent-drafts.tsxsemantic-tokens.css · --design-*`

Changes:
- Chrome stays in screen px and keeps its geometry: 1 hover, 2 selection, 8 handles, labels 8 above.
- Frame labels are 11/16 medium in fg3 (AA; muted-fg today), fg1 on hover and the selection stroke when selected.
- Play is a compact 24 IconButton with a filled play glyph; playing uses the label blue (#0A6FC2) with white.
- The agent badge sits left of Play in the same chrome row, so they never overlap.
- One canvas chip for every readout: 18 tall, radius 4, padding 6, 11/16 medium tabular, no edge: the fill carries the tone. Selection readouts (size, padding, rotation, grid tracks, motion) take the label blue; gap takes a darker pink, #C21A87, 5.5:1 with white; measurement takes a fixed red, #C11F1F, 6.0:1 in both themes; the agent status chip is neutral and lifts off the canvas (bg4 in Dark, bg1 in Light) with the dropdown shadow.
- A typed spacing entry keeps the app’s white edge while it is being edited, so it reads as an input.
- Strokes keep their colours: selection and padding #0C8CE9, gap #F531B3; only text sits on the darker label fills.
- Ghost frames use a border3 dash; placeholders read as the standard one-line empty state, with a compact Retry.
