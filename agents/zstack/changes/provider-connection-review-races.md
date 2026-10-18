Provider connection restarts retain Stop, replay and authentication identity

- Symptom: Stop during a Codex connection restart was lost, a fresh-thread
  fallback ran without the previous conversation, and a late authentication
  rejection invalidated a newer selected account.
- Cause: cancellation lived only on the temporarily absent native session;
  the replacement-binding event dropped the replay marker; adoption failures
  were attributed to the selection at rejection instead of the attempted
  identity. A successful older turn could also clear a newer replay request.
- Rule: retain cancellation per accepted send outside the native-session map,
  including both gateway adoption and deferred adapter restarts. Scope Stop's
  error handling to preparation: internal cancellation for exact-model failure
  must still report that failure. Carry a fresh-thread replay request through
  the event, engine cache and exact-execution renderer reducer; preserve it
  across Stop and later switches until a noncancelled prompt acknowledges the
  same binding. Fence each adoption failure by its attempted fingerprint.
- Encoded in: `gateway-account-switch.test.ts`,
  `app-server-adapter-credentials.test.ts`, `agent-session-reload.test.ts`,
  `session-reload-lifecycle.test.ts` and the existing exact-model regression in
  `app-server-adapter-memory.test.ts`. The optional notification field also has
  legacy-shaped consumer coverage. These were caught before merge, not escaped
  production incidents.
- Browser verification exposed an old subscription harness returning `result`
  instead of the real completion envelope's `stopReason` and `response` fields.
  Its mocked completions now use the typed `createMessage` constructor, so a
  permissive generic cast cannot hide another protocol-shaped fixture error.
  Queue smoke records the user text separately from prepended context and
  asserts, for Claude/Codex/Cursor, that Stop preserves replay and the next
  successful prompt clears it (`scripts/ui-smoke-subscription.mjs`).
