# Provider waits and terminal codes come from its documented envelope

- Symptom: Boat's 503 `retryAfterSeconds`, per-IP `retryAfter` and
  refused-start `window` were ignored, so retries ran on generic backoff. A
  resume refused with 409 `snapshot_data_expired` after 14 stopped days failed
  the wake instead of starting checkpoint recovery.
- Cause: the client parsed only an HTTP `Retry-After` header, which Boat never
  sends, and had no mapping for the documented expired-data code.
- Rule: when adding or changing a provider boundary, read the provider's error
  and limits documentation. Pin every documented wait field and every code that
  ends an operation with a wire-shaped test, and keep vendor text out of errors.
- Encoded in `skills/zstack-review/SKILL.md` (Tests) and eval
  `boat-body-retry-hints`.
