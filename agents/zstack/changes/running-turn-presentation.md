# Keep the current turn visible through reconnect and old receipts

Symptom: a chat looked finished while the agent was still running tools, and
an older completion could remove the successor's working state or plan review.

Cause: Codex/Cursor presentation relied only on streaming status. Adopted turns
had no local pending RPC identity, and notification effects ran even when the
store rejected an older terminal event. A prompt's delayed reply and cleanup
also assumed that an unchanged execution still meant the same foreground turn.

Rule: keep the most recently accepted foreground turn identity separate from
liveness, including after settlement. Clear it on execution/owner retirement.
Recheck that identity after each awaited receipt, tail read, recovery and final
backfill before changing presentation, cleaning up gates or resending. A stale
RPC still releases its own lock; a healthy successor that already finished must
be able to drain the next queued send. Run terminal effects only when the store
accepted that exact turn, reading fresh state between events in a batch.

Retained tests drive the production store and provider callbacks across Local,
organization-local and cloud with all three providers. They cover running and
already-settled successors, cloud tail reads, Local recovery/backfill, mode waits,
plan-review/queue effects, dead executions and stopped/cold turns. The actual
AgentChat browser checks tool boundaries, reconnect, hidden/reveal and Stop.
Missing indicators and duplicate dispatch are asserted independently of identity
fields. Keep the original red logs separate from harness/typing corrections.
