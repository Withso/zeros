Local provider authentication and recovery

- Symptom: a stored Cursor API key could remain disconnected, saved accounts
  could not be renewed in place, and Local development asked for credentials in
  every checkout. Cause: passive account discovery overrode key selection,
  runtime preferences lagged native state, and the Local launcher forced secret
  isolation. Rule: test credential selection at both native projection and
  engine admission, including a fresh checkout and explicit removal. Encoded in
  provider-credentials-selection, provider-env, secrets IPC, local-development
  and electron-local regressions.
- Symptom: stale account reads could survive A → B → A, and reauthentication
  could leave credentials after concurrent removal. Cause: account IDs alone
  do not identify an operation or credential generation. Rule: fence both,
  retain working selections on cancel, and clean up a removed profile after a
  late native login. Keep private generations outside strict legacy account
  records so another development worktree can still read them. Encoded in
  provider-account-manager, secret-store and gateway-registry-refresh tests.
- Symptom: new chats emitted generic provider-error toasts. Cause: passive
  session status drove the toast surface. Rule: keep terminal failures in the
  affected chat and transient preparation quiet, while preserving exact-owner
  authentication invalidation. Encoded in agent-error-notifications tests and
  the production-chat browser smoke for Local, organization-local and cloud.
- Verification: browser smoke must use the runner's normal fixture bootstrap
  and motion preference. An unrelated initial page can seed different settings;
  reduced-motion emulation intentionally disables the spin animation checked by
  usage smoke. These harness settings are not product regressions.
