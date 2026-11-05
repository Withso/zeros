# A board's states are measured on the element people see

**Symptom.** After the canvas round shipped, the user still found looks the
boards showed and the app did not: tool rows with targets hovered an unpadded
name and stood 36px tall, docked pickers floated on bg3 with a lift, chosen
GitHub cards and caret-selected pills drew edges, composer pills hovered only
their label's inner button, and tool description chips were 18px beside 20px
file tags.

**Cause.** Review read class names on the element a spec named. The box people
see was often its parent or child (an inner ghost Button, a nested row's
`min-h-7`), and the edge came through a condition
(`selected ? "border-border4 …"`) that the variant-only policy never read.
Smokes pinned the old resting edge, so a corrected look failed as a
regression.

**Rule.** For every state column a board shows (rest, hover, selected, focus,
open), measure the visible element in a ui-smoke harness: computed fill, edge
colour and width, padding, corner, height and pitch against its neighbours, in
both themes, with tokens resolved in that element's own theme scope (a probe
beside it, not on `body`). When an escape takes a form a check does not read,
extend the check to that form, and update the smoke that pinned the old look
in the same commit.

**Encoded in.** Target `playbooks/ui-design.md` step 7. `ui/selection-edge`'s
conditional half (`scripts/design-system/ui-policy.mjs`); the tool-presentation
(row shape, pitch, chip height), composer-suggestions (surface, gap, width),
composer-editor (pill hover and caret selection), local-links (hover edge) and
cloud-github (chosen card) smokes; eval cases `selection-fill-not-edge`,
`selection-edge-conditional`, `tool-row-target-padding`, `tool-row-one-pitch`,
`docked-picker-composer-surface`, `design-empty-sections-hidden`,
`pill-hover-one-shape` and `tool-description-chip-height`. Their `fixedBy`
names the branch commits; replace them with `pr:<number>` when the PR opens.
