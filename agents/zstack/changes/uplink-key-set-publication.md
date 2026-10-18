Connected verifiers retained an older key set after a control-plane update.
The store refreshed, but established transports did not subscribe to its
successful replacements. Older handshake and fetch results could also replace
newer state.

Drive key updates through the real database notification, source, transport and
verifier. Hold initial reads, fetches and verification across an update; require
the latest set to win, affected sessions to close and unrelated sessions to stay
usable. Encode the rule in `uplink-key-revocation.integration.test.ts`, the
adjacent key-store, uplink-server, verifier and engine-auth suites, and eval
`uplink-key-set-publication`.

When a database regression imports another engine boundary, include it in the
control-plane database input list; the import-closure test must remain green.

Parallel database shards sharing a disposable PostgreSQL cluster also need
enough shared lock capacity for concurrent schema resets. If a reset reports
`out of shared memory`, verify that limit and rerun the affected suites after
correcting the test cluster; do not count the failed run as a pass.
Start or restart the database daemon outside the verification-slot lock so it
cannot inherit that descriptor and hold the slot after the invoking shell exits.
