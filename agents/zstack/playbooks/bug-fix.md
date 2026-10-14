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
   across reconciliation. For packaged imports, reproduce against staged
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
4. **Fix** the root cause with the smallest change. Keep compatibility.
   Local and cloud placements must both stay correct.
5. **Green.** Run the regression, the adjacent suites and the static gates
   (`zstack-verify`).
6. **Review** your own full diff (`zstack-review`), then deliver
   (`integrate-pr.md`).
7. **Learn.** If the bug escaped an existing check, add an eval case and
   strengthen that check (`zstack-learn`).
