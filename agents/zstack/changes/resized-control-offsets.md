# A resized control takes new offsets, and every smoke that pins it

**Symptom.** `DialogCloseButton` grew from a 20px round button to the 24px
compact IconButton but kept `-my-1`, so in every dialog title row the close
sat 2px above the title's centre. The dialog-chrome ui-smoke measured that,
and still pinned the old header, body, close and footer; the keyboard-focus
smoke it imports pinned the radio's outline and the field's click-focus
edge. Crashes earlier in its shard hid all of it until the final registry
run.

**Cause.** The margins that held the old button inside a 20px line were not
recomputed for the new size, and the smokes for the primitive were looked
for by page name rather than by what they measure.

**Rule.** When a control's size changes, recompute the offsets that
compensated for the old size (`-my-0.5` centres a 24px button on a 20px
line). Find every smoke that pins a primitive by grepping
`scripts/ui-smoke*.mjs` for its `data-slot` names, role and old values, and
run those scenarios before committing.

**Target.** `playbooks/ui-design.md` step 6. **Encoded in.** Eval case
`resized-control-offsets`.
