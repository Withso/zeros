# Playbook: bug fix

1. **Reproduce.** Capture the exact symptom: a closed error code, a failing
   check or user-visible behavior. Note the revision and environment.
2. **Red.** Write the smallest regression test that fails for the stated
   reason. For a race, reproduce it deterministically: hold the contended
   condition, or inject the delay. Never add a sleep and hope.
   For a scheduler, drive the real producer and consumer with a fake clock:
   assert no scheduled work after the queue drains, not just no requests.
   Cover records arriving during a pending flight and an open failure circuit.
   For detached terminal proofs, exercise the real serialized terminal grid
   and replay/live boundary. Persist allocation intent before starting work,
   refuse uncertain restarts, and recheck output after the file read settles.
   Bounded native output proves only the native task, never an agent transcript.
3. **Root cause.** Trace to the mechanism (`file:line`). If you can only
   observe the symptom, say so, and fix only what the evidence supports.
   For worker failures, retain the first closed diagnostic before cleanup and
   across reconciliation, including late heartbeats and expired-claim recovery.
   For optional lifecycle evidence, test old strict wires and isolate reporting
   from authority/ingress budgets. Race cancellation against exact-request
   receipts; canonicalize identifiers before applying replay and storage bounds.
   For a stalled checkpoint, instrument the actual engine stage before awaiting
   its gate. Use finite, coalesced observations on an optional bounded transport;
   a report must never hold up sealing, renew authority, or change heartbeat
   compatibility. Preserve the first failure before cancellation and cleanup.
   For resume bugs, test a real sealed store across fresh engine/writer identities;
   a fresh database cannot expose inherited fences. Require authenticated
   predecessor custody for any atomic scope migration and retain old ACKs.
   Exercise the actual history rebuild across controls, queue and CP activation
   crash points. Prepared namespaces need fresh CP custody; verify latest heads
   against immutable edit/delete and terminal receipts before issuing new proof.
   Test the next clean stop after recovery and repeated activated unsealed
   handoffs. Retained lineage needs a CP-committed digest or an acknowledged
   successor inventory; an unsealed origin cannot acquire a fabricated seal.
   Repeat complete handoffs and an interrupted, unsealed handoff on that same
   FULL store. Retain closed checkpoint failure sites through setup and cleanup;
   repeating a claim cannot repair missing lineage or authorize an older writer.
   For stop/seal races, hold background replies across the admission fence and
   local cancellation. Assert authority and heartbeats survive through a real
   seal, while explicit revocation and wrong identities remain terminal.
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
   For fixture cleanup, distinguish compute retirement from physical erasure.
   Require the original accepted delete, every generation, fresh exact provider
   proof and a post-I/O authority recheck; preserve storage debt and the D1 gate.
   Test the actual record purge so a signed carry can later retire from positive
   retained proof, never from a missing row or a provider 404 alone.
4. **Fix** the root cause with the smallest change. Keep compatibility.
   Local and cloud placements must both stay correct.
5. **Green.** Run the regression, the adjacent suites and the static gates
   (`zstack-verify`).
6. **Review** your own full diff (`zstack-review`), then deliver
   (`integrate-pr.md`).
7. **Learn.** If the bug escaped an existing check, add an eval case and
   strengthen that check (`zstack-learn`).
