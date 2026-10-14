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
4. **Fix** the root cause with the smallest change. Keep compatibility.
   Local and cloud placements must both stay correct.
5. **Green.** Run the regression, the adjacent suites and the static gates
   (`zstack-verify`).
6. **Review** your own full diff (`zstack-review`), then deliver
   (`integrate-pr.md`).
7. **Learn.** If the bug escaped an existing check, add an eval case and
   strengthen that check (`zstack-learn`).
