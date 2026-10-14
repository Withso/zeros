# Runtime admission failures retain their boundary and cleanup outcome

- Symptom: admission failed after minting a grant with only an internal 500; the original failed boundary was missing.
- Cause: typed provider exceptions bypassed the public error contract, while grant cleanup exceptions were discarded. Repeating cleanup rewrote an already revoked row.
- Rule: fault the real post-grant route, classify only typed transient provider failures, preserve a closed phase, and publish retry advice only after confirmed retirement. Unknown faults and uncertain cleanup stay terminal; never log raw provider text.
- Coverage: real-Postgres admission regressions include an actual provider-client 5xx, internal and lookalike errors, authority revalidation, fresh-proof retry, one-use consume and idempotent revoke. Closed-error tests bound Retry-After and preserve only a SQLSTATE from database defects.
- Recorded in: the bug-fix playbook and eval `runtime-admission-provider-failure`. The historical incident's exact provider cause remains unproven.
