# Checkpoint journal worker refusal

Symptom: the real-process CAS test passed alone but could lose a child and read
stdout EOF when another suite competed for CPU.

Cause: a lock owner can be descheduled beyond the journal's bounded SQLite wait.
The test child awaited open/write without handling the expected closed refusal;
the coordinator already handles it. Concurrent open probes also competed before
the writes the test intended to race.

Rule: separate setup from CAS, report only the exact known refusal over fixture
IPC, and keep unexpected exceptions fatal. Require one confirmed winner and its
exact persisted state, then prove the loser cannot reuse its original revision.
Hold real locks to test both refusal paths without extending production limits.

Encoded in the journal process tests, the worker refusal seed and CI-red
playbook. Production journal, coordinator, 25 ms busy limit and native custody
proofs remain unchanged.
