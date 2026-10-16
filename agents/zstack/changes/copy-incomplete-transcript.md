# Copy must retain the history read's meaning

Symptom: Copy transcript reported that an existing conversation had no messages
while its current cloud history projection was incomplete after resume.

Cause: row-only bridge helpers discarded the verified page receipt and restore
head before the full-transcript reader could distinguish unknown from empty.

Rule: every page of a transcript copy must pass current-owner and current-head
checks before dropping metadata. An incomplete page is catching up, not an
empty page or end-of-history. Authenticated deletion remains known empty.

Encoded in copy-restoring-transcript.test.ts with the real runtime client,
bridge and Copy action, including incomplete older pages and passive reads
that never wake a workspace. Local reads retain their existing authority.
