# Home dashboard presentation

Symptom: keyboard activation of a card's Archive action opened its workspace.
Cause: the containing card handled a bubbled Enter and prevented the native
button's click. Rule: a keyboard handler on a composite card must handle only
events whose target is the card itself; nested actions retain native activation.
Encoded in `scripts/ui-smoke-dashboard.mjs` (workspace-archives, shard 3) and
the `dashboard-card-action-keyboard` eval. Restoring the old handler reproduces
the navigation failure; the retained browser assertion passes with the guard.

Review also found that passive Home line totals could reuse an in-flight
comparison from another base, or prefer an old sidebar probe over newer All
Changes. Key flights by target and base, and fence shared publications with an
observation captured at the actual read. Local/cloud regressions in
`workspace-change-lines.test.ts` and `changes-snapshot-cache.test.ts`, plus a
held-response browser test, cover isolation and both completion orders.

Cold or failed archive reads must not announce an empty archive. Keep confirmed
rows and expose the source's loading/retry state. Icon-only repository cells
still need the repository's accessible name. Both conditions have browser
regressions, alongside owner switching, virtualization and inactive menus.
