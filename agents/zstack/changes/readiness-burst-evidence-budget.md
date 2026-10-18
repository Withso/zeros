# Bound readiness acceleration by exact evidence

- Symptom: a hydrated base can finish starting its host between ordinary status
  polls, adding detection delay to a wake.
- Cause: a positive stopped observation and a provider error share a retry loop;
  accelerating that entire loop would also accelerate failures and timeouts.
- Rule: spend a finite short-pause budget only on validated exact-base stopped
  evidence before admission. Errors keep their pacing and cannot rearm the
  budget. Keep the original absolute deadlines and post-admission behavior.
- Encoding: fake-clock tests retain four-pause exhaustion, unchanged provider
  errors and Retry-After, early/full restore timeouts, cancellation, ceilings,
  malformed/foreign evidence and the absence of access installation while
  waiting. These tests establish timing policy, not measured live latency.
