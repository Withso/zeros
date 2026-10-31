# What the inspector shows and edits

People edit frames in the Design tab while agents work on the same files. This page describes what the inspector shows and where its edits land, so you can read a frame after a person has changed it and predict how your markup will appear. It describes product behavior; it is not a list of authoring requirements. Write the HTML and CSS the design needs.

## Where edits land

- Style tab and canvas edits (position, size, auto layout, fill, stroke, effects, typography, Advanced rows) write declarations into the selected element's `style` attribute in its frame source. Existing declarations keep their place and formatting; new ones are appended.
- These edits do not rewrite class rules, `<style>` blocks, `tokens.css` or imported style sources. A value that comes from a class is overridden by an inline declaration on the edited element, so other elements sharing the class keep theirs.
- The theme editor writes Manual tokens in `tokens.css`. Imported style sources are read-only there; their repository files own them.
- Renaming a layer writes `data-name`. Editing text replaces the element's text. Frame titles, geometry and page membership live in `meta/canvas.json`.
- Saving never stages or commits. When you find unfamiliar inline declarations, they are often a person's edits; keep them unless the task changes them.

## Values as written

- The frame runtime resolves the whole cascade (the `style` attribute, every stylesheet, cascade layers, specificity and `!important`) and reports each winning declaration as written, for example `background-color: var(--primary-button-bg)`, with the tokens it reads and their resolved values.
- Each winner names its `selector` and a `scope`:
  - `inline`: the element's `style` attribute;
  - `element`: the matching selector's last compound names the element by class, id or attribute;
  - `base`: universal or type selectors, such as resets and imported preflight.
- Properties that reach a layer only through base selectors are reported separately (`baseStyleProperties`), so a reset does not read as the layer's own styling.
- Fill, text and stroke colors, and value fields such as type size, line height and letter spacing, show a token's name while unfocused. For `var(--a, var(--b))` they show the first token that resolves. The hover text adds the declaring source and the resolved value.
- The color picker has **Theme** and **Custom** tabs. Theme lists the color tokens the frame resolves, grouped by source and family and searchable: every imported style source, then Manual (`tokens.css`, which overrides an imported name), for the theme the canvas shows. Choosing one writes `var(--name)`; the token a field already reads is marked. Custom is the color field: hex, opacity, notation and eyedropper.
- The CSS tab lists the element's authored declarations as written. After a line it shows the computed value when that differs, and the source when the winner comes from an imported source or a linked stylesheet.

## The Advanced section

- Lists every authored declaration that no dedicated control shows, as an editable name/value row with the value as written. A row's tooltip reads "from `<selector>` in `<origin>`".
- Omits base-only properties and an imported source's own custom properties, such as Tailwind's `--tw-*`.
- Offers Remove only for inline winners. A class or stylesheet value is changed here by writing an inline value.
- Lists the layer's classes read-only, and adds any property by name.

## Layers

- Rows are the frame's elements, named by `data-name`, then a readable runtime name, then a type label. Frame rows show the frame title from `meta/canvas.json`.
- Content inside open declarative shadow roots (`<template shadowrootmode="open">`) and assigned slots appears in Layers and can be selected. Shadow layers accept style, text and attribute edits; delete, duplicate and move refuse them with a reason.
- Selection identities come from `data-oid`, which the canvas derives for ordinary HTML and saves when an edit needs one.

## Layout controls

- Flex and grid containers show auto-layout controls: direction, gap, padding, alignment, and, for grids, track counts. A track count is written as `repeat(N, minmax(0, 1fr))`.
- Canvas padding and gap handles edit the same declarations.

## Motion

- The motion timeline edits and previews CSS `@keyframes` from source. Transitions show in the Transition section.
- Captures stop animations so a still image is stable.
