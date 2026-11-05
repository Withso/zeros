# A dev-server import failure in one smoke scenario is a rerun, not a regression

Target: `skills/zstack-verify` ("When a check fails").

**Symptom.** After a renderer change, ui-smoke shard 3 failed three checks in
overlay-positioning. One GitHub disconnect variant timed out waiting for its
menu, and the scenario and the run both reported the same uncaught
`Failed to fetch dynamically imported module: …/features/settings/github-section.tsx`.
The diff touched nothing that module imports, the sibling variants on the
same page passed in the same run, and the shard had passed on the previous
head.

**Cause.** The Vite dev server failed one dynamic import fetch during a long
shard run. The incident log recorded only the uncaught error, with no
dependency re-optimization or reload notice.

**Rule.** When a smoke failure is a `Failed to fetch dynamically imported
module` for a module outside the diff's import graph, first confirm that
(`grep` the module's imports for the changed files), then rerun that scenario
alone, twice, on the same head before investigating further. The CLI selects
only shards, so a scratch runner imports the scenario module from
`scripts/ui-smoke/scenarios.mjs` against its own dev server. Report the shard
result and the isolated reruns together; never call the shard green.

**Encoded in.** This fragment until it is folded into the skill's "When a
check fails" line.
