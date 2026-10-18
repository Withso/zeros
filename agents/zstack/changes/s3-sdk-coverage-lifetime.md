S3 coverage must expire with its connection and its catalog snapshot.

- Symptom: a resumed cursor or delayed snapshot could otherwise suppress polls
  without current per-organization proof, and a coverage callback stopping the
  client could be followed by an unwanted retry.
- Cause: replay position is not completion of catch-up; event consumers can
  synchronously retire the connection while its close handler is still running.
- Rule: tie positive coverage to a fresh ready revision and a race-fenced
  snapshot. Invalidate it immediately on drain, reset, disconnect or stop, and
  recheck lifetime after callbacks before scheduling more work.
- Encoded in cloud-client's mixed-organization, stale-snapshot, resumed-ready
  and stop-during-coverage regression tests. Runtime binding validation also
  refuses malformed or cross-target metadata before creating a socket.
