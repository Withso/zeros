# Seal event cursors belong to their original stream

A cloud writer retained terminal history from a previous engine but restarted
its own native event sequence. The control plane compared the maximum event
cursor from every projected origin with the new seal's event cursor. A drained
writer was therefore refused whenever an older stream had advanced further.

Compare command and history events only when their original writer matches the
seal. Compare compact controls only when their native stream matches the sealing
engine. Retained history still participates in NORMAL record coverage, and every
projected pending command still blocks the seal. Preserve prior descriptors,
cursor values, exact ACK replay and all current-authority checks.

The real PostgreSQL mirror suite creates two engine/writer incarnations and
reprojects retained history. Regressions isolate inherited command, history-head
and compact-control cursors, with current-stream and retained-record refusals.
