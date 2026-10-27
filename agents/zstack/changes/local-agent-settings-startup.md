Local agent settings during startup

- Symptom: reopening the Mac app displayed "Connect to the local engine to save
  agent settings" inside a restored conversation without a settings edit.
- Cause: session restoration derives provider credentials through the acknowledged
  settings flush, which treated a connecting Local engine as a terminal save
  error. A disconnect between readiness and the flush continuation could expose
  the same error again.
- Rule: settings-dependent session preparation waits for its owning runtime and
  an acknowledged settings snapshot. Recheck connection state after each await,
  keep the original readiness deadline, and abort the wait when its synchronizer
  retires. Local readiness expiry remains a recoverable transport condition;
  actual file errors still propagate. Cloud readiness retains its own contract.
- Encoded in: the real readiness waiter and settings synchronizer regressions in
  `agent-preferences-sync.test.ts` and `ws-client-cloud-reconnect.test.ts`.
