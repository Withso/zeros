# Exercise empty-base sanitation as a lifecycle

- Symptom: empty-base sanitation rejected stock aliases and cache sockets;
  same-boot verification then rejected the deliberately cleared disk epoch.
- Cause: isolated empty-file checks missed both stock node kinds and the real
  sanitize, verify, sanitize, verify, cold-boot sequence.
- Rule: run the real producer and readiness consumers across repeated
  sanitation. Keep target bytes, unknown custody, ordinary admission and cold
  admission protected; a builder exception needs exact empty-base preconditions.
- Encoded in `runtime-base-v4/tests/test_sanitation.py`, the default Computer
  socket refusal, saved-tree controls in `cloud-runtime-base-v4.test.ts`, and
  the `empty-base-stock-leaves` and `empty-base-same-boot-readiness` evals.
