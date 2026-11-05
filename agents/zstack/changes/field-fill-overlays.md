# A fill change must carry the overlays that fade from it

**Symptom.** Design property fields moved their hover fill from `bg2-hover` to
`bg2-highlight` to match their sheet. The keyframe diamond and a size limit's
remove button still faded into `bg2-hover`, so a darker band would have shown
at the end of every hovered field. The remove button and the W/H resizing menu
also sit over their field without being inside it: with the pointer on them
the field lost its hover fill, and the remove button's fade lost its colour.

**Cause.** Each overlay repeated the field's fill as a literal token, so a
state change edited one rule and left the copies behind. `:hover` reaches an
element's ancestors, not a sibling laid over it.

**Rule.** Keep a control's fill in one custom property that every state sets
and every overlay reads. When an overlay is a sibling over the control, the
shared wrapper sets that property from its own `:hover`, `:focus-within` and
open state, and the control inherits it. Assert the overlay's hover with a
real pointer in a smoke.

**Encoded in.** Target `playbooks/ui-design.md` step 6. The `--zd-field-fill`
rules in `design-workspace-ui.css`, the trailing-menu hover check in
`ui-smoke-design-workspace`, and eval case `field-fill-overlays`, fixed by
`pr:839`.
