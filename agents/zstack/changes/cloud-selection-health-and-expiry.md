# Selected-source health and elapsed publication fences

- Symptom: Settings could show a selected account as connected after its
  material expired, and a selection retry could remain trapped behind an
  elapsed private publication operation.
- Cause: connection display inferred usability from vault metadata, while
  publication preflight reused its stale preparing row after recording expiry.
  A deterministic implicit operation ID could not distinguish a closed attempt
  from an authorized successor request.
- Rule: observe the exact selected revision and material in one SQL snapshot;
  refresh metadata is descriptive, never a grant. Re-read an elapsed durable
  operation after recording cancellation, require positive release or retirement,
  and bound overlapping closure work while committing progress. Preserve original
  deadlines and receipts, explicit-operation expiry, and committed lost-ACK
  replay. Only a later explicit request may open a successor.
- Encoded in: the credential-removal integration regressions, selected-source
  health integration and pure boundary tests, two replay evals and the bug-fix
  playbook. The durable contract is
  `docs/cloud-workspace/agent-connection-health.md`.
- Test lesson: a deployed database constraint correctly refused an unsupported
  refresh runtime fixture. Keep that guard; exercise impossible metadata at the
  pure reader boundary. A setup error is not an assertion red. The retained
  corrected exact-base run and fixed run use admissible SQL fixtures.
