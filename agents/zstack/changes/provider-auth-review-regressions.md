# Provider authentication needs persistence and completion-boundary regressions

- Unchanged saved-account reads repeatedly invalidated Settings. The real
  decoder and mutation schema returned different property order, which mocked
  manager stores hid. Exercise the manager against the real encrypted-store
  codec, require unchanged reads to publish no changes, and retain strict v1
  compatibility. Encoded in `electron/__tests__/secret-store.test.ts`.
- Local credentials remained isolated because an earlier startup block
  overrode the launcher's default. Execute the full environment/identity
  initialization with the real launcher helper, including inherited hosted
  paths and explicit isolation. Encoded in `local-development.test.ts`.
- Moving startup errors out of toasts hid failures behind completed history.
  Determine whether the current turn can actually display the failure using
  its authoritative cached row. Cover completed, cancelled and unfinished
  history, remounts, and all three placements. Encoded in
  `agent-error-notifications.test.ts` and `ui-smoke-agent-preparation.mjs`.
- Canceling renewal after native credential completion retained the new profile
  with its old private revision. Observe native completion before status and
  cleanup; publish the exact profile's generation even when those later steps
  fail. Hold each boundary and check the real gateway verdict, with controls
  for cancellation before a write, native failure, newer selections and account
  removal. Encoded in `provider-account-renewal.test.ts`.

These findings were caught during branch review before integration. The retained
regressions are the lesson enforcement; no escaped-main replay case is claimed.
