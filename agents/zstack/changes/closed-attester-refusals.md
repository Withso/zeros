# Preserve the refusal before classifying a retry

- Symptom: repeated image-preflight refusals appeared as a setup deadline, and
  all-false admission flags obscured the failing inner attester check.
- Cause: the helper dropped a valid failed completion diagnostic; the provider
  override retried every image failure, and recovery treated a report-dependent
  metadata flag as independent evidence even when the report was absent.
- Rule: retain only validated closed child evidence, distinguish an absent report
  from a proved mismatch, and test classification through helper, worker audit
  and the authorized evidence reader. Unknown output never grants readiness or
  automatic replacement. Keep older helpers fail-closed and bounded.
- Encoding: real attester failure fixtures, strict schema parity and malformed
  output checks, plus the one-claim PostgreSQL qualification-refusal regression.
- Review correction: a valid closed diagnostic does not prove the check ran.
  Missing inventory and process-creation errors share names with completed
  refusals. Classify only proven predicates as terminal; retain bounded retries
  for ambiguous names. Test a real missing-file/spawn failure, then the same
  unchanged fixture succeeding, through the helper and retry consumer. Keep
  true refusal controls so retry eligibility never becomes admission success.
