# CI's PostgreSQL cannot be signalled from the test

- Symptom: a regression test that froze a backend with SIGSTOP passed locally
  and failed with ESRCH in CI.
- Cause: CI runs PostgreSQL in a service container, in another PID namespace.
- Rule: never depend on the server's process table, signals, `/proc` or local
  sockets. Reproduce connection races at the protocol layer, for example an
  in-test TCP relay that holds client bytes, and assert that the race window
  was open so the test cannot pass vacuously.
- Encoded in `skills/zstack-verify/SKILL.md` (Gotchas already paid for) and
  eval `dev-database-teardown-drain`.
