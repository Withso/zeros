# Preserve failed cleanup custody across an approved successor

Symptom: a stopped fixture's failed DELETE could not become a successful
Actions predecessor after the operator submitted a separate approved DELETE.
The canary still queried the original failed key.

Cause: the signed chain had no representation for a cleanup-only successor.
Treating a stopped VM, physical absence or a new operator request as successful
completion of the original attempt would have erased failure and ownership.

Rule: preserve the original signed artifact and lifecycle intent. Authenticate
one exact source artifact/run and append a separately signed cleanup-only
operator reference. Preserve earlier consumed handoffs, fetch fresh exact
retirement for every admission, and never let recovery dispatch a lifecycle
request or authorize runtime work. A consumed reference survives physical
completion without resurrecting a run. Missing receipts remain unavailable.

Encoded in the cleanup-recovery contract, exporter/importer, real Actions-entry
and CLI suites plus the fixture-operator-cleanup-recovery eval. Direct ordinary
lifecycle observation is also refused: it could otherwise mark the original
failed key confirmed. Boundary tests retain closed artifact errors and use
internally consistent old timestamps so freshness is actually exercised.
