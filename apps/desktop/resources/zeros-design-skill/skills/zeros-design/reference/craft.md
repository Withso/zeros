# Craft

How to get a good first draft quickly and keep it easy for people to edit. These are working practices, not format rules; `reference/format.md` lists what frames support.

## Recreating a reference or editing a frame

For a simple visual request, produce an editable HTML/CSS draft early, then refine what the rendered frame shows. The format (`reference/format.md`) and verification (`reference/verify.md`) pages support that work; style syncing, reusable components and application builds are separate tasks unless the request needs them.

1. **Read the reference and current source.** Inspect the supplied image with the provider's image tool, the selected frame, its canvas record and `rules.md`. Re-read files before editing. Match the composition, text, color relationships and typography with ordinary HTML/CSS.
2. **Resolve the viewport once.** Preserve the selected frame's ID, position and dimensions by default, including when it is blank. If a reference has different proportions, adapt its layout or fit the composition inside that viewport. An explicit request to resize or match the reference's viewport takes precedence; update only that frame's geometry. A proportion mismatch alone does not authorize resizing.
3. **Write the first draft before optional precision work.** Use a close available font when the reference does not name one. Pixel sampling, font identification, image-processing dependencies and geometric fitting are useful when a visible mismatch or the requested precision calls for them; they are not prerequisites for drawing text and simple shapes. If a measurement is inconclusive, use a reasonable approximation and inspect the render.
4. **Save, validate and look.** Use the supplied verification command, capture the result and inspect the PNG. Correct visible differences in a focused pass. Continue when a concrete mismatch remains; do not keep revisiting an already resolved choice without new evidence. Report any remaining approximation that matters to the request.

Use already-declared styles and tokens when they fit. A standalone reference can use frame-local CSS; it does not require scanning the application or setting up style syncing. Markup captured or pasted from a site or an app keeps its own classes: put `data-zd-captured` on its root (on `<body>` when the whole frame is captured), optionally naming the source, say so in the frame title (`"Pricing — captured"`), and do not copy its classes into the directory's other frames. Mark only markup that really came from elsewhere; the marker is not a way to quiet warnings on the directory's own frames. Keep content in normal flow where practical. Decorative circles, overlapping artwork and edge-clipped shapes may use absolute positioning inside a relative container; separate elements also remain selectable on the canvas.

## Layout that stays editable

- Flex and grid containers with `gap` and padding map onto the inspector's auto-layout controls and the canvas padding and gap handles (`reference/editor.md`).
- Sibling groups (buttons, chips, rows, toolbars, cards) spaced with `gap` keep their spacing when a person reorders, duplicates or deletes one. Spacing made of whitespace text or per-element margins tends to drift after such edits.
- Absolute positioning suits overlays and decorative shapes inside a relative container; each positioned element stays separately selectable.

## Content and states

- Use real copy from the request, the codebase or the reference. Where a fact is missing, a visible placeholder such as `[Repository name]` reads better than invented content.
- Show the states the surface has (`reference/states.md`) and check each theme the design supports.
- Draw controls with the elements they are: `<button>`, `<a href>`, `<input>` with a `<label>`. Text contrast of 4.5:1 (3:1 from 24px) keeps a mockup honest about legibility, and colors that must be told apart read best when they also differ in lightness.

## Follow the existing vocabulary

- Reuse what the directory already declares: its style sources, the application's utility classes and tokens, `tokens.css` and its components. A frame never reinvents a class that exists under another name.
- Write a token as `var(--name)` rather than the value it holds; copy exact values from source only where no token exists.
- Declarations shared by several elements belong in one class; inline `style` is for one-off values and people's Style panel edits.
- Markup repeated three or more times belongs in a component (`reference/format.md`, Components).
- A targeted request stays targeted: change what was asked and leave unrelated layout, spacing, colors and copy as they are.
