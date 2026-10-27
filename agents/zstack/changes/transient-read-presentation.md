Transient read presentation across desktop surfaces

- Symptom: startup, a slow history read or one failed refresh briefly painted
  settings, chat, Summary, provider, organization or picker errors.
- Cause: passive reads exposed their first exception directly, some used native
  preload presence as engine readiness, and history inferred failure from time.
- Rule: wait for the owning transport, retain exact-key confirmed content, and
  allow one bounded silent recovery attempt before presenting a read failure.
  Elapsed time is not evidence that history failed. Pause observation while a
  surface is hidden or its transport is disconnected; never wake a cloud VM
  for passive mirrored history. Genuine failures and explicit action outcomes
  remain visible.
- Read safety is independent of presentation: a quiet error still disables a
  write that depends on that read. MCP import must confirm the existing settings
  before replacing the server list, including malformed document responses.
  Starting a retry clears the cache error before data is confirmed; retain the
  observed read failure for write/access guards until the retry settles.
- A callback that only schedules an effect has not finished retrying. Keep the
  retry promise pending until the real result commits or observation retires;
  record every React commit to catch a one-frame error before eventual success.
- Workbench capability notices have no renderer on ordinary passive surfaces.
  Preserve an authoritative unsupported response there; do not turn it into an
  indefinite loading state or a repeated automatic retry.
- A rejected history read needs the same live-slot check as a successful one:
  store patching can create an absent slot before provider cleanup prunes its
  request map. Test removal and replacement during an in-flight read for every
  placement, and never recreate a retired session to report its error.
- Native IPC readiness and engine readiness are separate. Browser fixtures for
  engine-backed surfaces need the real connection provider as well as a request
  double; GitHub authentication settings use native IPC and work before the
  engine connects.
- Background preference sync retains pending choices, retries quietly once,
  then uses one persistent keyed notice that recovery/disposal dismisses.
- Encoded in: the shared read-recovery browser tests; settings, preference sync,
  history, Summary, team, import, Create, Design and tool presentation regressions;
  Create and transcript smoke checks; and the corresponding replay/seed cases.
  Native Mac launch and live cloud checks still require their own evidence.
- Replay assertions need stable human labels. Formatting a component function
  into a parameterized test name includes its source, so a product fix changes
  the assertion identity and makes an otherwise valid replay unverified.
