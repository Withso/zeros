# Snapshot comparisons and the system's own poll flips

- Symptom: the canary reported `cleanup_pending` for a correctly
  storage-pending predecessor; the retirement read returned 409.
- Cause: the read refused any difference between before and after snapshots,
  and the reconciler re-claims a blocked provider delete every ~257 s,
  flipping the intent for ~0.9 s without new evidence.
- Rule: before calling a snapshot stable, sample the live row for a full poll
  period of every writer. Tolerate only an evidence-free flip and pin a
  transition that must still be refused.
- Encoded in `playbooks/bug-fix.md` (Root cause) and eval
  `cloud-retirement-reconciler-poll`.
