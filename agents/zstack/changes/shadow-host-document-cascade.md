# Shadow CSS loses to document rules on the host

**Symptom.** The Changes file cards drew no inset and no edge. Pierre's
shadow CSS held `:host { margin-inline: 12px; outline: 1px solid
var(--border1) }`, yet the host's margin computed to 0 and its outline took
the focus colour and painted under the code. A dark render showed a card only
because the code fill differs from the pane.

**Cause.** For normal declarations the outer context wins: any document rule
for a property beats a `:host` rule, whatever its specificity. Preflight
resets every element's margin, padding and border, and the base layer sets
`border-color` and `outline-color`. An inset outline also paints beneath
positioned and isolated children.

**Rule.** In shadow CSS, mark a host declaration `!important` when the
document sets that property; draw a card's edge as a border and count it in
the virtualizer's estimates (Pierre sizes a collapsed file as its header
region alone); and assert computed values in a smoke, not the rule's text. A
smoke that cannot run where you work hides stale pins: fix its harness first
and move its pins to the merged design in the same commit.

**Encoded in.** Target `playbooks/ui-design.md` step 7. The comments in
`changes-diff-options.ts`, the card measurement in `ui-smoke-changes`, and
eval case `shadow-host-document-cascade`, fixed by `pr:839`.
