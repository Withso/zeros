Healthy observation used the error-attempt count, so a previous-lease refusal
lengthened the first post-dispatch timer. Keep an independently bounded ordinal
in the existing accepted-result write; initialize only from a successful start,
never reset the original dispatch timestamp, and preserve error/Retry-After
floors and conservative legacy rows. Real-PG tests measure 1000 -> 500ms for
the first timer without adding a query or bypassing setup's commit boundary.

The initial test fixture used a workspace status as a provider state. Retain
the corrected provider `provisioning` shape and the failed fixture receipt;
invalid test vocabulary is not a product regression. The tests and
`cloud-healthy-observation-after-refusal` eval encode the scheduling lesson.
