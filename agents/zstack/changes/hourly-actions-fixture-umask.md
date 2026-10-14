# Private Actions fixture directories

An hourly rebuild/diagnostic integration appeared to cause eleven unrelated
failures. All eleven instead reproduced with umask 002: the test created its
synthetic Git directory with the default 0777 mode, leaving it group-writable.
The canonical credential reader correctly refused the checkout, so later
receipt and orchestration assertions never reached their intended boundary.

Rule for the CI-red playbook: diagnose the earliest fixture-admission failure
before inferring a semantic merge conflict. Create private fixture directories
with explicit modes, and retain credential owner/type/mode checks unchanged.

The Actions fixture and the canonical linked-checkout fixture now request
mode 0700. Both retain regressions for umasks 002, 022 and 077 with scoped
restoration of the test process's umask. The latter was the only additional
failure when the full adjacent harness set ran under 002.
Eval: `hourly-actions-fixture-umask`.
