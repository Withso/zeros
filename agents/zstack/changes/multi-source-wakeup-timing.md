# Absolute timing floors on loops with several wake sources

- Symptom: the job-queue lost-hint integration test failed on a loaded CI
  runner while the queue behaved correctly.
- Cause: the test gated on "any claim at >= 990 ms" and then required the next
  claim at >= 1990 ms; the gate resolved on a late hint claim, and the already
  due poll ran at 1053 ms.
- Rule: when hints, polls and retry timers can all wake a loop, assert
  structural conditions (the job ran within N intervals with no hint possible;
  a new claim happened after the gate), not absolute floors.
- Encoded in `skills/zstack-review/SKILL.md` (Tests) and eval
  `job-queue-lost-hint-timing`.
