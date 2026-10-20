# Final-save cleanup for a never-started recovery candidate

Symptom: a replacement failed history restoration before boot activation, then
its rollback Delete and independent compute Stop waited forever for a final save
that the rejected incarnation could not produce.

Cause: the destructive-dispatch consumer treated an unused candidate like an
accepted running generation. A fake checkpoint or a broad missing-writer bypass
would erase the distinction between failed setup and lost unsaved work.

Rule: drive the real owner recovery, failed setup, rollback and independent
compute Stop in real PostgreSQL. A distinct immutable receipt must bind the
unused incarnation and its retained checkpoint, preserve the original failure,
and fence new authority before allowing ordinary provider cleanup. Revalidate
after awaited inspection, retain compute settlement and dispatch holds, and test
different retry deadlines plus N-1 retry and capture writes.

Initial durable-record synchronization runs before native history restoration.
Do not infer accepted work from a nonzero batch count, or ignore batches based
on timing alone: compare the exact events to the retained source. The only
admitted normalization is a single primary metadata upsert differing in
`createdAt` alone, before setup failed. Keep its batch ID in the receipt and
fence further events; any new identity, content, tombstone or extra event refuses.

Retain old-schema producers in migration regressions, but apply the remaining
expansions before running the current worker. A worker that calls a newly added
SQL function cannot be tested against a deliberately truncated migration ladder.
The historical recovery-job case now preserves the pre-0171 producer and runs
the current consumer only after the complete upgrade; the other 0171 cases keep
their exact schema boundary.

Encoded in `unstarted-candidate-cleanup.integration.test.ts`, the 0175 migration
and its exact expand-exception tests. Local Personal and organization-local
execution are unchanged. A cleanup receipt is never saved-history proof.
