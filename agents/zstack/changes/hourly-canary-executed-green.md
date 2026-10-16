## A workflow success is not proof of a canary

A fully skipped workflow can report success, and the workflow-run API exposes
only its latest attempt. Check the actual lifecycle and signed-upload steps;
retain a prior successful attempt when a later rerun fails. Missing history
fails closed. The Actions policy regressions encode both cases.

Selecting the newest run of any status blocks cloud PRs throughout every
hourly run. Select the newest completed run or attempt instead; a newer run in
flight changes neither its outcome nor its completion-based two-hour expiry.
The green/red-plus-running and active-rerun regressions preserve this policy.

A completed PR check also keeps its old result when an hourly canary changes.
Refresh a separate required status from trusted main on PR/canary events and a
freshness schedule, and check again at CI completion and merge arming. A head
change invalidates the scope/review read. Check freshness after asynchronous
reads, not before them. GitHub scheduling remains an explicit delivery limit,
not an invented lease. The status writer has one context and no product keys.

Exercise the actual merge-wrapper adapter too: `gh api` exits with1 for both
an expected missing marker and other API failures. Only an observed HTTP404
can prove removal; forbidden/server responses stay closed and unprinted.
