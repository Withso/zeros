# Claude context server accounting

- Symptom: plausible MCP fixtures hide normalization collisions and rounding
  errors, and a context refresh with new IDs/shares can be ignored by the store.
- Cause: tool names are normalized while instruction names are raw; the CLI
  also splits tool names at `__`. Summary tool estimates round independently
  from category totals. `isLoaded: false` still counts as used when tool search
  is disabled. The renderer's equality check originally compared only
  category names, kinds and token totals.
- Rule: qualify provider-shaped fixtures against a credential-free real control
  response when possible. Use native category accounting, join only identities
  the response can establish, conserve each category budget, and test new wire
  metadata through the shared state consumer as well as the producers. Keep
  best-effort controls bounded and fence retired query responses. A delayed
  context summary is telemetry, not evidence that a newer prompt was accepted;
  exclude it from the cloud outbox acknowledgement boundary.
- Encoded in the protocol context mapper, Local/cloud context refresh suites,
  cloud inbox acceptance and renderer/store regressions, keyboard disclosure
  smoke, and the `claude-context-server-accounting` seeded eval. No live model
  call is required.
