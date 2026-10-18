# Cloud preparation rollout and retained evidence

- Symptom: the canary repeated preparation while staff wakes reused it; deleted
  fixtures lost the clocks needed to attribute the difference.
- Cause: staff-only setup fixtures concealed the canary's required non-staff
  identity. Setup and engine rows were ephemeral, while successful audit and
  signed harness receipts omitted their bounded observations.
- Rule: reproduce a canary with its real identity and entitlement shape before
  changing a rollout. Preserve exact run/fence clocks and closed failure/reuse
  reasons before cleanup; distinguish engine registration from readiness and
  retain clock nesting. Preparation reuse never replaces fresh qualification.
- Encoded in setup-materials and setup-worker integration tests, the opt-in
  setup-evidence route, helper/contract parity tests, and signed artifact tests.
