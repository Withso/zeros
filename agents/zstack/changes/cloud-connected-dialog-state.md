# Keep an open account dialog on current health

Cloud Settings showed a healthy selected account in its row while Configure
still offered Connect. The dialog held the credential object from its opening
click, so later metadata could also leave its name and connected state stale.

Derive row and dialog readiness from the same current, nonrevoked credential
and matching selected health. Keep an imported account only as explicit retry
intent; its existence is not readiness. A connected dialog must not offer a
redundant Connect. Refresh the displayed identity by the selected account ID,
without changing that selection or starting a write.

The component regression replaces the metadata while Configure stays open and
covers ready, changed revision, revoked, missing, expired and unselected
sources. The real browser smoke reconnects, retains an import across a conflict,
then verifies the disabled Connected action and metadata refresh in both themes.
Local provider and owner-switch controls remain adjacent. Eval:
`cloud-connected-dialog-state`.
