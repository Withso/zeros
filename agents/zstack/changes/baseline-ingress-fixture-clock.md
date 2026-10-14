# Controlled baseline request timestamps

An orchestration test expected one certain request but intermittently observed
one possible request on unrelated PRs. Its synthetic engine receipt boundary
used real wall-clock time, while the fixture-to-client calibration introduced
uncertainty. A fixed sleep after the response did not separate the arrival from
the earlier receipt boundary.

Rule for the CI-red playbook: a controlled turn fixture needs an explicit event
timeline shared with its request counter. Advance at events, keep HTTP and the
counter real, and test calibration uncertainty directly. Do not widen the count
assertion, change the production uncertainty calculation, or add a sleep.

The retained baseline tests exercise zero and 250 ms calibration spans with
the same exact request counts. The existing prepare, boot-owner, consistency,
redaction and invalid-clock cases remain. Eval: `baseline-ingress-fixture-clock`.
