# Inject a fixture's PATH through the production runtime channel

- **Symptom.** A held-child Git test passed without ever holding the child it
  meant to hold.
- **Cause.** The worker deliberately keeps only `GIT_*` and `GH_*` values from
  its broker wiring. A PATH passed that way never reached the child, which ran
  the real Git instead of the stub.
- **Rule.** Stub executables through the same channel production uses for
  PATH. Before releasing contention, observe the concrete child process. Never
  relax an environment allowlist to make a fixture work.
- **Encoded in.** The runtime PATH stub in
  `apps/cloud-worker/src/workspace/__tests__/checkout.test.ts`.
