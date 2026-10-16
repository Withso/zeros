# Preserve an optimistic chat close through delayed reads

Symptom: a closed tab reappeared while its asynchronous archive write was pending.
Cause: ARCHIVE_CHAT changed the archived flag without advancing updatedAt, so
the previous engine row won reconciliation's timestamp tie. A late title,
settings or touch callback could also lower a newly advanced close revision
back to the device clock before that held read returned.
Encoded by: renderer/state/__tests__/chat-close-reconciliation.test.ts and eval
optimistic-chat-close-revision, including all three placements and clock skew.
Proposed target: playbooks/bug-fix.md, step 2.
Proposed text: Hold persistence and replay the pre-action snapshot after an
optimistic close and reopen. Local metadata edits must advance past the last
observed revision, including with a slow device clock, while authoritative
deletions and genuinely newer remote changes retain their existing authority.
Replay late title/settings/touch callbacks between close and the held response;
advancing the close alone does not protect it from a later timestamp writer.
