Tie stream observation to native authority and complete renderer catch-up.

- Symptom: an overlapping catalog snapshot could overwrite a same-version
  access update, and an admission could publish after its device session rotated.
- Cause: document versions do not version viewer authorization; a runtime
  request and the stream can also share a session while having different lifetimes.
- Rule: fence removals, account incarnations and pending reads separately from
  document versions. Retire old-session handles and refuse pending admissions
  before publishing them. Coverage needs both fresh ready metadata and a
  complete snapshot for the same connection revision.
- Encoded in the catalog overlap/removal, native session rotation, hidden
  retirement, malformed-frame and contract-mock regressions. Native validation
  remains strict; integration fixtures supply full claims and live expiry.
