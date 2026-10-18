# Cold drift must retire the predecessor before wake

- Symptom: an automatically resumed cloud workspace registers successive engines
  that all fail history recovery.
- Cause: provider drift revokes engine access without committing boot-source
  retirement, while setup retries the resulting explicit recovery denial.
- Rule: exercise the real drift-to-start path with an active unsealed writer;
  require confirmed lifecycle retirement before resume. Keep authorization
  failures terminal and transient transport failures retryable.
- Encoded in `reconciler.integration.test.ts`, `linux-setup-executor.test.ts`
  and `agent-history-recovery.integration.test.ts`: stop prerequisites precede
  resume, stale bindings cannot publish drift, explicit denial stops retries,
  and a retired unsealed source recovers only through authenticated custody.
