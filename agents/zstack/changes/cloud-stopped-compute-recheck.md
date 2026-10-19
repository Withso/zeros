An accepted stopped observation could leave compute reconciliation asleep until
its ordinary deadline, including internal drains that never changed workspace
status. Enqueueing an earlier job alone does not change domain eligibility.

Test both deadlines through the real observation writer and compute claimant.
Use a durable coalesced sequence without an implicit lease-row FK lock, retain
requests arriving after the claim snapshot, and acknowledge only under the
live claim fence. Cover bookkeeping rollback after independent stopped proof:
recovery keeps the meter lag, rather than restoring the old ordinary deadline.
Retry-After and runtime-transition floors still win over pending requests.
Pin the allocation before provider I/O: an exact resource and generation can
still identify a replacement lease by the time the observation returns.

Encoded in the compute-leases PostgreSQL integration suite, the populated
data-purge migration suite, the cloud-stopped-compute-recheck eval, and the
bug-fix playbook.
