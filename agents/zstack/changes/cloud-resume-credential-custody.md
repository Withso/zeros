- **Fresh-store tests missed the resume failure.** The stopped FULL ledger kept
  the previous credential-control identity. Reproduce with a real seal, capture,
  authenticated restore and new engine/writer; migrate only verified custody,
  preserve old ACKs/floors and reject stale or partially migrated state. Encoded
  in `playbooks/bug-fix.md` and case `cloud-resume-credential-custody`.
- **Later work hid the first setup failure.** Retry admission cleared the current
  timing slot, while cleanup rollback or a late heartbeat could erase or replace
  the first error. Commit an exact-claim closed receipt before retirement and
  distinguish a lost crash lease from an observed engine stage. Closed producer/
  parser parity and non-retryable integrity cases are retained in
  `setup-claim-first-failure`. A slow-only request log cannot prove a call was skipped.
