# Queued work carries the version it was queued for

- **Symptom.** After the runtime pin changed on Alpha, the refresh queued for
  the new runtime installed the old one.
- **Cause.** During Railway's redeploy, the old and new processes both run for
  a few seconds. The new process queued the refresh. The old process claimed
  it first and installed the pin from its own configuration.
- **Rule.** Record on the job the version it was queued for. Whoever runs the
  job uses that recorded version, never its own configuration; fall back to
  its own only when the job names none.
- **Encoded in.** "installs the runtime a refresh was queued for, even when a
  process on another pin runs it" in
  `apps/control-plane/src/cloud/computer.integration.test.ts`.
