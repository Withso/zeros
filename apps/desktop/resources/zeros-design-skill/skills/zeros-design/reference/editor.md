# What the inspector shows and edits

People edit frames in the Design tab while agents work on the same files. This page describes what the inspector shows and where its edits land, so you can read a frame after a person has changed it and predict how your markup will appear. It describes product behavior; it is not a list of authoring requirements. Write the HTML and CSS the design needs.

## Where edits land

- Style tab and canvas edits (position, size, auto layout, fill, stroke, shadow, blur, typography, More styles rows) write each property where only the selected element owns it: its existing `style` declaration, or the one unconditional rule that targets exactly this element (`[data-oid="…"]`, or `body` in the frame's own `<style>`). Otherwise they write the element's `style` attribute. Existing declarations keep their place and formatting; new ones are appended.
- These edits do not rewrite class rules, `<style>` blocks, `tokens.css` or imported style sources. A value that comes from a class is overridden by an inline declaration on the edited element, so other elements sharing the class keep theirs.
- The theme editor writes Manual tokens in `tokens.css`. Imported style sources are read-only there; their repository files own them.
- Renaming a layer writes `data-name`. Editing text replaces the element's text. Frame titles, geometry and page membership live in `meta/canvas.json`.
- Saving never stages or commits. When you find unfamiliar inline declarations, they are often a person's edits; keep them unless the task changes them. Inline style is for such one-off values; declarations repeated on several elements belong in a class.

## Values as written

- The frame runtime resolves the whole cascade (the `style` attribute, every stylesheet, cascade layers, specificity and `!important`) and reports each winning declaration as written, for example `background-color: var(--primary-button-bg)`, with the tokens it reads and their resolved values.
- Each winner names its `selector` and a `scope`:
  - `inline`: the element's `style` attribute;
  - `element`: a matching selector in the rule's list names the element by class, id, attribute or state, by tag under such a context (`.card > p`), or by tag in a shadow root's own stylesheet;
  - `base`: universal selectors, bare tags in the document and `:where()`-wrapped preflight, such as resets.
- Properties that reach a layer only through base rules are reported separately (`baseStyleProperties`), so a reset does not read as the layer's own styling.
- Fill, text and stroke colors, and value fields such as radius, padding, gap, sizes, type size, line height and letter spacing, show a token as a pill with its name. For `var(--a, var(--b))` they show the first token that resolves. The hover card adds the declaring source and the resolved value.
- The Style panel says where a value comes from. "Styled by 2 classes and 9 utilities" under the header opens to the classes, utilities and component that style the layer, and what was changed on it; a row narrows the panel to that source's properties. A value changed on the layer over its class carries a small dot, and Reset (or Alt+Backspace) removes the layer's own declaration so the class value shows again; a value taken from a parent or a reset is dimmed. Hovering a field shows where its value comes from; a value forced by `!important` names its rule. To change a class or component value for every layer, edit the class in source rather than overriding it on one layer.
- With a frame selected (not a layer in it), a panel above Layers counts the frame's changes made by hand, values set on a layer over its class, component or another rule, and offers Tidy. Tidy sends you a brief that names each change; follow "Tidy changes made by hand" in [styling.md](styling.md). The panel writes nothing itself and shows what moved once your turn ends, so report the moves plainly in chat.
- A frame whose file declares options reads Component in the Style panel's header, with an Options section above the other sections: one row per option, which a person adjusts (a slider, a switch, choices, a colour, text, an easing). Each change writes that option's `default` in the frame's file. People do not add options there; Ask agent to change options sends you a brief (format.md, Change a component's options).
- On a component's main frame the Options section also has a Variant row: which variant the frame shows is the person's own view (never in Git); with a variant shown, a row writes that `<zd-variant>` line, and Save current as variant… adds one `<zd-variant>` line with the shown values that differ from the defaults. An instance in another frame (`<zd-name>`) shows the same rows with its own values: each change sets or removes one of the host's attributes (`zd-variant` for its variant), a value equal to what it inherits removes the attribute, and Reset removes them all. Its inner layers (`data-zd-part`) can be selected to read, never edited: change them on the main component, whose layer has the part's id. Text that a `{{ hole }}` fills on the main reads "Set by option …" and is not typed over.
- A layer with its own `:hover`, `:focus`, `:focus-visible`, `:active` or `:disabled` rules gets a State button in the Style panel's header. Picking a state shows the layer in it on the canvas, view only: the panel shows only what the state changes and edits nothing until Back to Default. To change a state's styles, edit its rule in source (for Tailwind, the `hover:` utility).
- A value that reads a token shows as a pill with the token's name; the panel's hover card names its source and value, and Detach at the end of the field writes the value it resolves to on each selected layer. A token the frame no longer declares reads "… is missing". Each field's token picker lists only tokens of the field's type, grouped by role, with the description from the token's `tokens.css` comment or its value.
- The color picker has **Theme** and **Custom** tabs. Theme lists the color tokens the frame resolves, grouped by source and family and searchable: every imported style source, then Manual (`tokens.css`, which overrides an imported name), for the theme the canvas shows. Choosing one writes `var(--name)`; the token a field already reads is marked. Custom is the color field: hex, opacity, notation and eyedropper.
- The CSS tab lists the element's authored declarations as written. After a line it shows the computed value when that differs, and the source when the winner comes from an imported source or a linked stylesheet.

## Editing values

- A field refuses a value CSS rejects instead of writing something else: a negative size, padding, gap, radius, border width, font size or duration writes nothing and the field keeps its value. Margins, insets, letter spacing and offsets keep negatives. Ranged values such as opacity are held to their range.
- Emptying a field restores its value. To remove a value set on the layer, a person uses Clear in the field's hover card (or Alt+Backspace); Reset does the same for a value that replaces a class or component value. Either removes the whole declaration, so after one the layer shows the class, inherited or initial value again.
- Fields take maths in one unit: `24*2`, `+8`, `x/2`, `50%/2` (which writes `25%`). Mixed units are refused; write `calc()` in CSS for those.
- A plain length with a unit (`50%`, `1rem`) shows as written. Tokens and unitless values show what they resolve to.
- The unit menu converts the value against what the unit measures: `12px` to rem writes `0.75rem` with a 16px root, and percent uses the parent's width as CSS resolves it. Units with no known basis are not offered, so expect px, % and rem, the unit already written, and `auto` only for margins and flex-basis. Converted percent and rem values have at most two decimals.
- On several layers with different values, a scrub or arrow moves each by the same step in its own unit, written in one undoable step. A layer whose value has no number (`auto`, `calc()`) is left as it is.
- A value written with a CSS math function (`calc()`, `clamp()`, `min()`, `max()` and the like) shows as written, dimmed, and is read only in the Style panel; its hover card offers Edit in CSS. People change it in the CSS tab, so keep such values readable.
- A value a rule forces with `!important` is read only, with a lock; the card names the rule and offers Ask agent to change, which asks you to remove the `!important` or move the value so the layer can be edited without changing other layers. When several layers are selected and one of them is computed or forced, the field is read only for all of them.
- A plain value that a theme rule makes differ (`[data-zd-theme="dark"] .card { … }`) carries a theme mark, and the card lists each other theme's value. Setting it on the layer writes one value for every theme, and the panel says so ("Changes Light and Dark."). Prefer a token when a value should follow the theme.
- A hidden layer stays editable; the header says Hidden (with Show) or "In a hidden layer". Show is the Layers eye: it changes the canvas, not the source.

## The More styles section

- Lists every authored declaration that no dedicated control shows, as an editable name/value row with the value as written. A row's tooltip reads "from `<selector>` in `<origin>`".
- Omits base-only properties and an imported source's own custom properties, such as Tailwind's `--tw-*`.
- Offers Remove only for inline winners. A value from a class or shared rule is overridden with an inline declaration; a rule that targets only this element is edited in place.
- Adds any property the browser implements by name (`zIndex` is written as `z-index`). It never lists the layer's classes; read those in the frame's HTML.

## Layers

- Layers is a drawer at the foot of the Style panel, closed by default; its header shows where the selection sits.
- Rows are the frame's elements, named by `data-name`, then a readable runtime name, then a type label. Frame rows show the frame title from `meta/canvas.json`.
- Content inside open declarative shadow roots (`<template shadowrootmode="open">`) and assigned slots appears in Layers and can be selected. As in the browser, only the first such template on a valid host attaches, closed roots stay opaque, and a slot shows its fallback only while nothing is assigned to it. Shadow layers accept style, text and attribute edits; delete, duplicate and move refuse them with a reason, so change their structure by editing the HTML.
- Selection identities come from `data-oid`, which the canvas derives for ordinary HTML and saves when an edit needs one.

## Canvas items

- The tool rail beside Text places a Section, a Note or a Link card (from a workspace file) at a click. Each create, move, resize, text edit and delete is one write to the page's `items` in `meta/canvas.json` and one Undo step.
- Items are not layers: they never appear in Layers, a selected item shows no Style fields, and no frame source changes.

## Layout controls

- Flex and grid containers show auto-layout controls: direction, gap, padding, alignment, and, for grids, track counts. A track count is written as `repeat(N, minmax(0, 1fr))`.
- Canvas padding and gap handles edit the same declarations.

## Motion

- The motion timeline edits and previews CSS `@keyframes` from source. Transitions show in the Transition section.
- Captures stop animations so a still image is stable.
