- Symptom: promoting a manual idle-restart action to a persistent preference
  exposes cancellation and deadline races, including an update that has not
  finished native staging.
- Cause: a rendered idle/ready snapshot can outlive a new send or an opt-out;
  the legacy install IPC can latch a restart for a later download completion.
- Rule: keep automatic preference intent separate from an explicit one-time
  request, recheck live activity and opt-in at the deadline, and require native
  staging when requesting a deferred install.
- Encoded in: the update-notifications timer and tests (including cancellation,
  current-work and opt-out races, required-update handoff, and native-ready IPC),
  plus personal preference persistence tests and the Local/organization-local/
  cloud active-work gate suite.
