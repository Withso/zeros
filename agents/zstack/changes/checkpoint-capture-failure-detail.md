# Capture failures need evidence from the failing boundary

Symptom: a final capture failure reduced to unknown, followed by a cancellation
label that did not identify the original exception.

Cause: request, native Git, mutation and deadline boundaries emitted generic
exceptions; the deliberately closed reporter could not safely recover their
meaning from text. Parallel upload results also used array order to choose a
failure, allowing a later failure to replace the first one observed.

Rule: classify at the real boundary and retain closed metadata with the original
rejection. Never infer cause from arbitrary messages, paths, output or a later
cleanup label. Stop further admission on failure and join admitted work before
release; allSettled alone does not select the first observed failure. Keep an
optional companion separate from strict historical wire/audit documents, using
the same authority and replay fence. Clock faults, late callbacks and accidental
Promise rejections from observers must not change the product outcome.

Encoded in the retained cloud capture, progress, protocol parity and PostgreSQL
tests, and eval `checkpoint-capture-failure-detail`. Permission controls run with
all capability sets zero and NoNewPrivs=1; euid alone is not sufficient evidence.
