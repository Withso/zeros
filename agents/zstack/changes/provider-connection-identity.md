Provider connection identity and CLI observation

- Symptom: a CLI showed a connected checkmark beside sign-in instructions,
  without naming the account. Cause: the dialog ignored native identity and
  refreshed only the engine verdict on focus. Rule: show the exact selected
  connection's identity, revalidate native metadata after external CLI changes,
  and keep API fallbacks honest when no email is provided. Encoded in
  provider-connection-dialog, subscription-connection-panel, cloud-provider-
  connections tests and ui-smoke-provider-identity.
- Symptom: a slow read could swallow a newer focus event or look fresh after
  Settings was hidden. Cause: the native ACK updates the shared cache and clears
  its earlier invalidation. Rule: preserve observation generations across that
  ACK, share observers, and leave skipped hidden probes stale for reveal. The
  browser regression holds the native reply across focus, hide and reveal.
- Symptom: a CLI's own API credential was called disconnected. Cause: the
  subscription-only reader was also used for device CLI detection. Rule: accept
  the native API account type only in CLI detection, keep browser ceremonies
  subscription-only, and do not request subscription usage without identity.
  Encoded in provider-subscription-drivers and provider-account-manager tests.
  The card also says Connected via CLI, so it never assigns an API login to a
  subscription; connection-methods and browser regressions cover that label.
- Symptom: native login detection and the engine's connected verdict could
  disagree. Cause: Claude's registry used legacy file presence, and command
  probes resolved a global CLI instead of the selected runtime. Rule: local
  authentication probes use the same configured or bundled executable as chats
  and the provider's native status command. Preserve cloud-owned discovery and
  runtime rejection fences. Encoded in gateway-registry-refresh and
  gateway-provider-probe-boundary tests, including staged-versus-PATH and
  explicit executable override fixtures.
