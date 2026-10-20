- **Wake can fail locally before the first heartbeat.** Whole-ledger inventory
  scans used a 100 ms limit. Cold or populated valid SQLite data could exceed
  it after CP had already authorized recovery; setup then waited out its
  separate readiness window. Empty and final reads could also miss a timeout.
  Use a finite monotonic proof budget shared across nested inventories and check
  completion. In deterministic tests, assert both delayed stages ran: a query
  pattern that misses whitespace can otherwise appear to prove a shared bound.
  Retain digest bytes, source retirement, file identity and every ACK/history
  fence. Encoded in real SQLite checkpoint/resume regressions,
  `playbooks/bug-fix.md`, and `cloud-checkpoint-inventory-budget`.
