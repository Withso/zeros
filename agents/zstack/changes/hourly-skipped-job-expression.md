# Skipped Actions jobs can retain an unevaluated name

Applies to `ci-red`, the hourly canary reader and its regression fixtures.

GitHub returned `inputs.profile == 'gate0' && 'gate0' || 'lifecycle'` literally
for a job skipped by its job-level condition. An evaluated-name fixture missed
the failure: the reader threw before deciding that hourly was not live.

Recognize that exact provider shape only when the completed run is scheduled,
its single matching attempt's job is completed and skipped, and it has no
steps. Preserve the skipped conclusion and empty steps. This can prove that
the product never started; it cannot prove an executed green, reset activation,
hide a skipped result after activation or borrow Gate 0 coverage. Manual raw
names and other expressions remain unclassified and refused.

For a gate repair, inspect both path scope and the trusted base's evaluator.
An exception before repair-marker validation cannot be repaired by adding a
marker to the PR. Report that bootstrap limitation to the owner; do not invent
a passing result, noncloud exemption or execution of unreviewed PR policy.

The retained regression uses the exact observed name through both the Actions
reader and the cloud gate, checks prior receipt continuity, and keeps manual,
executed and malformed shapes refused. Five assertions fail on the parent.
