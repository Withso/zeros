# Reuse unchanged transcript rows after validation

Symptom: refreshing an open transcript replaced unchanged rows and completed
turns along with the one message that changed.

Cause: serialized history windows constructed a new object for every row, so
turn memoization could not retain already rendered work.

Rule: after exact owner and restore-head validation, reuse equal rows by stable
message ID. The incoming window still determines membership and ordering,
including truncation. Equal head bytes alone are not a no-op: the first native
confirmation can invalidate rows that a projection observation preserved.

Encoded in transcript-incremental-refresh.test.ts and the real AgentChat
incremental browser scenario for all three placements. Keep the adjacent
cloud-history-live-lineage tests to protect projection/native provenance.
