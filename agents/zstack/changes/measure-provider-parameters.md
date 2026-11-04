# Measure identity-provider parameters before relying on them

"Add account" first sent AuthKit `max_age=0`, the parameter WorkOS documents for
forcing re-authentication. A headless check against Alpha AuthKit showed it only
re-confirms the signed-in user ("Confirm it's you", email read-only), so a second
account could never be added. `prompt` has no documented values, yet
`prompt=login` was the only setting that showed an empty, editable sign-in form;
`select_account`, `consent` and `screen_hint=sign-in` silently reused the
browser session.

Rule: when a flow depends on how a hosted identity page behaves, drive the real
page once with test accounts (Playwright against Alpha, sessions revoked
afterwards) and record the observed matrix next to the code. A documented
parameter name is not evidence of the behavior you need.

Target: `gotchas.md` (identity providers) and the `zstack-verify` live checks.
Held by the WorkOS provider test pinning `prompt=login` and the observed matrix
in `docs/workos-authentication-migration.md`.
