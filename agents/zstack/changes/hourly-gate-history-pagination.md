# Read every canary history page before proving the hourly gate

The zeros-dev merge gate proves "not live" (no lifecycle run has ever
succeeded) by reading the canary's run history. It read only the newest page of
100 runs, then failed closed when the history grew past 100 entries, so every
cloud PR was blocked as `hourly_unavailable` even though the true state was
`hourly_not_live`.

`hourlySnapshot` now reads every page (bounded to 10) for both the success and
full histories. A short, shifted or duplicated page is still unknown history and
fails closed. Encoded in `scripts/__tests__/zeros-dev-hourly-actions.test.ts`
with a 104-run two-page red and a mismatched-total control.
