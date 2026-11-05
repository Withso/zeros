# A utility class cannot restyle a Design recipe

**Symptom.** An animated property's keyframe diamond was meant to turn the
Motion accent through `text-[var(--design-selection-stroke)]`, and section
glyphs carried `size-3`. The diamond stayed fg2 and every glyph stayed 14px.

**Cause.** The Design workspace's recipes (`design-workspace-ui.css`, imported
by a module) are unlayered. An unlayered declaration outranks every cascade
layer, so Tailwind's `@layer utilities` loses for any property the recipe
sets, whatever the selector's specificity.

**Rule.** Put a variant of a recipe-styled element in the recipe: a data
attribute or class that the CSS reads, never a utility class. Assert the
variant's computed value in a smoke.

**Encoded in.** The `data-motion-active` rule in `design-workspace-ui.css`,
the animated-diamond check in `ui-smoke-design-workspace`, and eval case
`unlayered-recipe-beats-utilities`, fixed by `pr:839`.
