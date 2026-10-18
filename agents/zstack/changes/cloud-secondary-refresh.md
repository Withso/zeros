Preserve downstream observation when removing a shared catalog poll.

- Symptom: history, agent grants and collaborator roles stop revalidating when
  covered organizations no longer make periodic catalog reads.
- Cause: their revisions are independent of workspace documents, but the cache
  consumers reused successful catalog reads as their refresh opportunity.
- Rule: inventory every refresh subscriber before removing its upstream clock.
  Keep an explicit scoped fallback until the stream carries each resource's
  revision. Unrelated organizations must not invalidate or postpone one another.
- Encoded in ten-minute mixed-organization scheduler tests, hidden/resume and
  account cleanup, scoped registry/collaboration invalidation, and stopped-history
  retry tests that construct no runtime admission or catalog read.
