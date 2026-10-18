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
