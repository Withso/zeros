# Guest launcher inventory after rebase

Symptom: the base Python bytecode suite failed its exact entry-count assertion
after integrating the Computer self-test report with the bytecode guard.

Cause: the report added a final fresh supervisor status invocation. The collector
found it and its `-I -B` flags were correct, but the inventory still expected 36
launches rather than 37.

Rule: run the base Python security wrapper after changing or rebasing guest
launchers, reconcile the exact inventory and keep every real flag/cache check.

Encoded in `playbooks/ci-red.md` and
`scripts/cloud-workspace-validation/runtime-base-v4/tests/test_bytecode.py`.
The two original CI failures are retained; no production behavior changes.
