# Playbook: bug fix

1. **Reproduce.** Capture the exact symptom: a closed error code, a failing
   check or user-visible behavior. Note the revision and environment.
2. **Red.** Write the smallest regression test that fails for the stated
   reason. For a race, reproduce it deterministically: hold the contended
   condition, or inject the delay. Never add a sleep and hope.
   For a scheduler, drive the real producer and consumer with a fake clock:
   assert no scheduled work after the queue drains, not just no requests.
   Cover records arriving during a pending flight and an open failure circuit.
3. **Root cause.** Trace to the mechanism (`file:line`). If you can only
   observe the symptom, say so, and fix only what the evidence supports.
   For worker failures, retain the first closed diagnostic before cleanup and
   across reconciliation, including late heartbeats and expired-claim recovery.
   For resume bugs, test a real sealed store across fresh engine/writer identities;
   a fresh database cannot expose inherited fences. Require authenticated
   predecessor custody for any atomic scope migration and retain old ACKs.
   Repeat complete handoffs and an interrupted, unsealed handoff on that same
   FULL store. Retain closed checkpoint failure sites through setup and cleanup;
   repeating a claim cannot repair missing lineage or authorize an older writer.
   For packaged imports, reproduce against staged
   sources; a checkout import or bundled CLI can hide a missing source file.
   For periodic disconnects, inspect client retirement timers before blaming
   server idle limits. Test real server closure, reconnect acknowledgement,
   durable replay and bounded backoff; distinguish planned rotation in logs.
   For pool isolation, test the boot composition and nested DB-bound services,
   not only pool sizes. Hold capacity on real Postgres, prove expired promise
   and callback acquires leave no queued work, and drain every owned pool.
   Inventory independent session-lock holders and hold them concurrently across
   provider barriers; their callbacks and an unrelated worker transaction must
   still progress. Count every lock pool in steady and rollout surge budgets.
   For renewal telemetry, test real success, refusal, concurrency and retirement
   paths. Use a separate monotonic clock, closed labels and bounded aggregates;
   never let logging alter authority outcomes or add idle timers. State exactly
   which boundary completed: a valid transport response is not final admission.
   For stop/resume races, hold the final checkpoint open across a real lease
   tick. Preserve its lifecycle intent; test every direct provider-stop caller,
   the native writer seal, and an audited deadline fallback before dispatch.
   A stop decision is not provider retirement proof or older-checkpoint custody.
   For migration fixtures, seed historical receipts against the schema at the
   migration cutoff. A current completion service can require tables that did
   not exist then; inspect the underlying SQL error before weakening a guard.
   Checkpoint/stop changes also run `recovery-migration.integration.test.ts`
   alongside the current-schema content, lease and reconciler suites.
   For canaries with durable fixtures and moving defaults, test unchanged,
   moved, unavailable and mid-run selection. Refresh at most once against the
   captured qualified tuple, with separate build/lifecycle/cleanup budgets.
   For public admission failures, inject the fault after grant creation. Keep
   a closed phase through confirmed cleanup; only typed transient provider
   errors offer retries. Test unknown defects, failed cleanup and repeated
   grant retirement through the HTTP boundary, without raw exception logging.
4. **Fix** the root cause with the smallest change. Keep compatibility.
   Local and cloud placements must both stay correct.
5. **Green.** Run the regression, the adjacent suites and the static gates
   (`zstack-verify`).
6. **Review** your own full diff (`zstack-review`), then deliver
   (`integrate-pr.md`).
7. **Learn.** If the bug escaped an existing check, add an eval case and
   strengthen that check (`zstack-learn`).
