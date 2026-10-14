- **Successful handoffs did not cover interrupted stop.** A retired writer
  without a seal correctly rejected an older checkpoint, but a catch-all code
  hid the failed predicate and treated every repeat as availability trouble.
  Run several complete seal/capture/restore cycles on one FULL ledger, then
  interrupt the next writer. Preserve the exact closed site through startup,
  cleanup and claim audit, and retry only transient availability. The test must
  also prove that refusal leaves the original ledger, ACKs and fences intact.
  Encoded in `playbooks/bug-fix.md`, the engine resume/checkpoint suites, the CP
  executor/worker suites, and case `cloud-resume-checkpoint-failure-site`.
