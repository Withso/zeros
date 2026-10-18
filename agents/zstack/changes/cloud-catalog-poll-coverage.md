Preserve observation scope and lifecycle inputs when preparing poll removal.

- Symptom: one account can have streamed members, unstreamed members and guest
  grants; a global read waiting behind a scoped read could receive only the
  narrower observation.
- Cause: coverage belongs to an organization, membership and guest list routes
  authorize differently, and request sharing without a scope key loses intent.
- Rule: key shared observations by their complete scope. Retain global fallback
  for unknown/guest/bounded sets and repair a rejected membership scope through
  the authorized aggregate. Keep confirmed unrelated rows and order unchanged.
- Encoded in scoped HTTP/catalog regressions, ten-minute mixed-owner scheduler
  tests, coverage-loss lifecycle/wake tests and the disabled production gate.
- Scoped reconciliation also retains the published row order when another
  observation wins during the read. Empty or legacy membership snapshots do
  not prove that the known organization set is complete. Both races have
  failing-before-fix catalog/scheduler regressions.
- A stream's collaboration presence map is not an engine idle/update lease.
  Trace the downstream activity report and every catalog-refresh subscriber
  before removing their input cadence; coverage metadata is not parity proof.
