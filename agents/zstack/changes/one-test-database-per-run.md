# Never share a test database with a running suite

- **Symptom.** An ad-hoc control-plane run during a background full suite on
  the same PostgreSQL server failed global setup, and the full run reported a
  migration-ladder deadlock that did not reproduce alone.
- **Cause.** Each run's global setup resets and re-migrates the public schema;
  two runs on one server clobber each other, even from a single agent.
- **Rule.** Keep a separate PostgreSQL server for ad-hoc runs while a full
  suite runs, and rerun any failure that overlapped another run in isolation
  before treating it as a regression.
