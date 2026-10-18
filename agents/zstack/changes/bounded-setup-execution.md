# Bound setup execution separately from claims

- Symptom: a long setup command kept another eligible workspace queued even
  after a notification, despite available provider and database capacity.
- Cause: the scheduler awaited the entire executor before claiming more work.
  A capacity setting or parallel claim calls alone would not repair that loop.
- Rule: drive the real producer and scheduler with held executions. Bound active
  work across every entry point, refill on completion, and prove a full pool has
  no rapid queue polling. Recheck workspace exclusion after taking its lock:
  a candidate statement can have a snapshot older than another replica's claim.
- Encoding: setup worker integration and fake-clock scheduling tests cover
  initial fill, arrivals, refill, organization fairness, stale claims, retry
  dates, stop/delete isolation, shutdown and a single quiet idle fallback.
  The retained regression and operator bounds are recorded in the matching eval.
