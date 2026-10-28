# Measure the element and the build that actually ran

- Symptom: a drag looked immediately responsive when only its selection box
  moved, and a shared-tree baseline could silently include another agent's fix.
- Cause: overlay motion was counted as the element's first change; HEAD alone
  did not identify dirty product sources or fixture instrumentation. Separate
  parent/iframe clocks and CSS zoom also made a raw box comparison misleading.
- Rule: freeze and fingerprint the product sources, fixture and production
  build before comparing them. Record element/style change separately from
  overlay change and authority settlement, pair iframe samples with their
  parent geometry, retain pairing skew, and fail changed-source evidence.
  Diagnostic DOM observations never replace native presentation/resource
  qualification or become noisy CI timing assertions.
- Encoded in `scripts/ui-smoke-design-manipulation.mjs`: exact build reuse,
  changed-source refusal, real input/change requirements, bounded parent/child
  samples, offset and continuity observations, custom-toast error detection,
  and browser/server teardown. Its zero/400 ms engine controls distinguish
  renderer feedback from persistence waits without raising any product budget.
