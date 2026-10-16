# Control plane and database region

- Symptom: while diagnosing slow control-plane requests, the fact that the
  control plane and its database ran in different regions surfaced late.
- Cause: every query paid a cross-region round trip, which query plans and
  database CPU do not show.
- Rule: when diagnosing latency, first confirm both run in the same region
  and measure one round trip.
- Encoded in `playbooks/alpha-operator.md` (Diagnosis).
