# One test PostgreSQL server per agent

- Symptom: database-backed control-plane suites skip silently without
  `TEST_DATABASE_URL`, and a cloud agent machine had no Docker and no
  approved system package install.
- Cause: separate databases in one server still share roles. Migration 0004
  creates the cluster-wide `zeros_app` role with a check-then-create race, so
  concurrent agents on one server can fail with `duplicate_object`. CI gives
  each shard its own server for the same reason.
- Rule: give each concurrent agent its own PostgreSQL 18 server. Without
  Docker or sudo, signature-verified PGDG packages unpacked with `dpkg -x`
  run as an unprivileged user.
- Encoded in `skills/zstack-verify/SKILL.md` (Gotchas already paid for).
