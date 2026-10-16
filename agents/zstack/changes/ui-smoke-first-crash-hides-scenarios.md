# UI smoke stops at the first crashing scenario

- **Symptom.** `pnpm test:ui-smoke` reported one crash, and none of the Design
  scenarios a change touched had run.
- **Cause.** The runner ends the whole run (or shard) at the first scenario that
  throws. `text-selection`, the first scenario of shard 1, and `code-review`
  failed on an untouched base checkout on this macOS host, so they hid every
  later scenario.
- **Rule.** Reproduce a failing scenario on a clean checkout of the base commit
  before blaming the diff. If it fails there too, run the rest from an untracked
  copy of `scripts/` with that scenario removed from `ui-smoke/scenarios.mjs` and
  `ui-smoke/shards.json`, putting the scenarios the change affects in one shard;
  delete the copy afterwards. Report the base failures and the affected-scenario
  result separately.
- **Encoded in.** `zstack-verify`, "Gotchas already paid for".
