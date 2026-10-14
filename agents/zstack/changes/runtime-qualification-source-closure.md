- **Qualification hid its first failure.** Pending cleanup replaced the closed
  smoke diagnostic, and reconciliation then replaced that with a timeout.
  Persist the first failure before cleanup and preserve it through retries,
  including a transient diagnostic-write outage (`playbooks/bug-fix.md`,
  case `qualification-first-failure-survives-cleanup`).
- **Checkout imports hid a missing runtime dependency.** The source engine's
  public channel-policy imports were outside the staged source slices. Validate
  the staged import and complete source engine in the archive probe, separately
  from bundled CLI help (`playbooks/bug-fix.md`, case `runtime-source-import-closure`).
