# Exercise empty-base sanitation as a lifecycle

- Symptom: empty-base sanitation rejected stock aliases and cache sockets;
  same-boot verification then rejected the deliberately cleared disk epoch.
  A failed exchange could lose its custody fence on reboot and retry cleanup.
- Cause: isolated empty-file checks missed both stock node kinds and the real
  sanitize, verify, sanitize, verify, cold-boot sequence. Retry checks preserved
  volatile state, hiding the loss of a pending fence under `/run`.
- Rule: run the real producer and readiness consumers across repeated
  sanitation. Keep target bytes, unknown custody, ordinary admission and cold
  admission protected; a builder exception needs exact empty-base preconditions.
  Destructive-operation fences must persist outside volatile and scrubbed roots.
  Drop the test's volatile tree before real boot repair, then retry both producer
  and verifier while asserting unknown custody bytes remain unchanged.
- Encoded in `runtime-base-v4/tests/test_sanitation.py`, the default Computer
  socket refusal, saved-tree controls in `cloud-runtime-base-v4.test.ts`, and
  the `empty-base-stock-leaves` and `empty-base-same-boot-readiness` evals.
