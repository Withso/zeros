Local provider connection changes without a reconnect

- Symptom: after switching a Local provider between an API key, its CLI login
  and saved accounts, the next send failed with "The provider connection
  changed. Reconnect this session before sending." A stale registry read could
  also show "Sign-in required" for a connection that worked.
- Cause: the gateway retired any Local execution whose credential fingerprint
  had changed and relied on the renderer to reconnect, but the engine re-adopts
  a live execution on reload, so recovery reached the retired route. Claude and
  Codex also keep history per native root (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`),
  so a resume under another account could not find the conversation. A forced
  registry refresh joined a read that began before the change.
- Rule: a Local execution adopts the current connection in place through the
  adapter's `runtimeConfiguration.updateCredentials` port at the next turn
  boundary, with one shared adoption per execution. A running turn keeps its
  process; native history moves to the new root only once no process writes it,
  and a newer copy is never replaced. Cloud executions are excluded at the
  gateway. A forced refresh waits for any earlier in-flight read. Probe provider
  resume behavior with the pinned runtimes and throwaway homes before relying on
  a copy: both CLIs find a copied file by id, and neither finds it without one.
- Encoded in: `gateway-account-switch.test.ts`, `gateway-connection-projection.test.ts`,
  `gateway-cursor-credentials.test.ts`, `app-server-adapter-credentials.test.ts`,
  the Claude and Cursor adapter credential tests, `provider-connection.test.ts`
  and `agents-cache-refresh.test.ts`.
- Verification: the incremental typecheck cache reported an error in an
  untouched file; a non-incremental run did not. A clean base worktree under
  `/tmp` changed path-dependent suites, so failures were attributed by swapping
  only the changed sources back in the same checkout. Both are in `zstack-verify`.
