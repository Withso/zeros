# Device sleep prevention follows execution, not the selected view

- Symptom: using the selected chat's loader for a native sleep assertion would
  miss other owners' background tasks; using the conservative restart gate
  would include turns waiting only for the user.
- Cause: presentation, restart safety and active execution have different
  lifetimes. Renderer timers also throttle while hidden, so they cannot own a
  battery safety cutoff.
- Rule: aggregate execution evidence across placements, retain independent
  tasks beside blocking questions, and own native power checks and bounded
  activity leases in Electron main. Revoke stale reads when their activity or
  power-source generation ends.
- Encoded in the keep-awake native controller, battery/IPC suites and renderer
  activity/preference tests; rationale and primary sources are in
  `docs/desktop-keep-awake.md`. This is a new feature, not an escaped-bug replay.
