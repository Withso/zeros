# Bound provisional disk paint after a failed history read

A transient history failure gives the already-started exact-owner disk read a
250 ms grace period. Without a deadline, hung native I/O can withhold the original
error forever. This grace period is only for provisional presentation and never
confirms history or authorizes a send.

Retain the original error, clear the timer when paint finishes promptly, and
fence any late paint after the request settles. The real-disk regression in
`platform/__tests__/cloud-transcript-revalidation.test.ts` holds native I/O for
all four owner-reported transient errors and asserts the deadline, unchanged
cache, and absence of a late callback.
