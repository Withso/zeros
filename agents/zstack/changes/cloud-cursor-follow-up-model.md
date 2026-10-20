# Retain the admitted model through Cursor cloud follow-ups

- Symptom: a successful cloud Cursor turn was followed by an immediate local
  admission failure before the next prompt reached the provider.
- Cause: configuration updates cleared the creation-time model while retaining
  exact-model enforcement. Warm-reuse tests mocked the adapter update port.
- Rule: exercise a completed turn and its follow-up through the actual
  configuration port. Cloud model identity belongs to the admitted execution;
  ordinary Local snapshots retain their own model selection semantics.
- Encoded in the native command pump regression, Cursor authority and Local
  snapshot controls, the bug-fix playbook, and the replay eval case.
