# Exact log-document sanitation

Symptom: ordinary alias refusal also rejects the stock systemd log-document
layout. An early correction retained a raced replacement but let a later
recursive sanitation attempt clear that rejected object's bytes.

Cause: a file-type diagnostic does not identify the link or prove its target,
and first-attempt refusal does not fence a later traversal of retained data.

Rule: admit only a fixed literal alias with an independently opened original
target and strict ancestry, ownership, mode and attribute checks. Materialize
the required empty saved-tree shape only after target sync. Retained unknown
objects must stay refused across retries; test the actual exchange and the
next ordinary sanitation pass. Keep offline layout support separate from
qualification of an image whose exact alias was not observed.

Encoded in `runtime-base-v4/tests/test_computer_build.py`, including original
target/parent replacement, native ACL, sync, descriptor cleanup and retry
controls; replayed by `cloud-computer-template-helpers.test.ts` and the
`computer-log-document-alias` / `computer-log-alias-retained-custody` evals.
