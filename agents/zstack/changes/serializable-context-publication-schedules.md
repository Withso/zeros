# Hold the commit schedule in serializable publication tests

A concurrent warm-context test synchronized the first INSERT attempts and then
required both promises to succeed. The losing caller could exhaust its three
serialization retries before the winner committed, correctly returning the
bounded transient `cloud_agent_credential_busy` refusal. The same fixture could
pass when the winner committed before the retry, making unrelated CI diffs red.

The retained regression drives both commit schedules. A stale snapshot retries
after a real winner commit and reuses that exact context. In the other schedule,
Postgres raises 40001 in all three losing transactions while the winner remains
held before COMMIT, and the exact 503 is required. Both retain one stored context
and their original per-request deadlines. Production retry and time limits are
unchanged. The CI-red playbook and the matching eval preserve this distinction.
