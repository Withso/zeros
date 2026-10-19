# Native runner ownership and deployed entrypoints

- A standalone helper ran during bundled engine import → its CLI guard saw
  the bundle's `import.meta.url` → keep shared support detection in a pure
  module and execute a real bundled import in a subprocess → retained in
  `scripts/__tests__/cloud-runner-runtime-bundle.test.ts`.
- A checked unit name could be replaced before Stop → inspection and a later
  name-based signal were separate operations → hold and signal the original
  native cgroup descriptor → compiled production-C regression replaces the
  pathname and checks that only the original inode is signalled, in
  `scripts/__tests__/cloud-runner-native-io.test.ts`.
- A rejected manager pin remained available to failed-start cleanup → the
  opened descriptor was published before its identity check → keep it local
  until validated, close rejected pins and retain unresolved original custody
  → retained mismatch, failed-stat and valid-pin later-failure controls in
  `cloud-runner-runtime.test.ts`, including the no-relaunch reservation.
- Natural completion dropped the last provider event → process exit preceded
  pipe closure and cleanup destroyed buffered stdout → join original child
  closure and preserve unread output after normal EOF → retained pipe and
  boundary regressions in the engine containment suites.
- Worker-source imports passed while installed helper copies lacked a new
  dependency → deployment layouts and executable helpers have separate closure
  requirements → test every install inventory, staged helper syntax and native
  shared-library load, then require actual installed runner qualification on
  supporting bases → runtime bundle, engine-view and qualification regressions.
- Independent branches added a third qualification argument and adjacent
  phases → retain one options contract and test runner admission with existing
  timers together → close the completed human-service timer before the runner
  gate and start census afterward, keeping the deployed closed labels and
  authority outcomes unchanged. Retained combined timing/failure probes cover
  both supporting and legacy bases.

These failures were found before delivery. No escaped-bug replay is claimed.
Injected driver tests and native file-descriptor probes do not qualify a real
systemd base or provider execution.
