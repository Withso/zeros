# Tooltip hover intent

Symptom: routine actions and Design rows produced redundant hints, and composer
and adjacent controls could expose help before a deliberate hover.

Cause: inspector controls defaulted every accessible name into a tooltip, a
permission control requested a zero delay, and Radix's shared provider resets
its instant-open flag asynchronously even when its skip delay is zero.

Rule: opt in to meaningful hints without coupling them to accessible names.
Test absence before the hover deadline as well as eventual appearance, direct
pointer travel between neighbors, and suppression while a menu is open. Keep
keyboard help and native-overlay intent cleanup covered.

Conditional input hints must suppress a stable wrapper rather than add/remove
it with an empty label; remounting the input on validation loses editing focus.
The Motion property smoke enters an invalid value and corrects it by keyboard.

Encoded in `docs/design-system.md`, the shared tooltip and inspector primitives,
and `scripts/ui-smoke-tooltips.mjs` (overlay-positioning smoke). The browser
checks cover both themes and all supported owner/placement combinations.
