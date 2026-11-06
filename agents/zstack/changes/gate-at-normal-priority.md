# Run the test gates at normal priority, never under `nice`

Target: `gotchas.md` (Node, Vitest and TypeScript).

**Symptom.** To keep a UI smoke's timings steady, `pnpm test:git` was run as
`nice -n 19 pnpm test:git` beside it. One suite failed that passes on the
base commit: `engine/agents/containment/__tests__/host-boundary.test.ts`,
"runs a local agent host and its descendants below normal CPU priority",
with `expected 10 to be greater than or equal to 19`.

**Cause.** The test spawns a below-normal host and asserts its grandchild's
niceness is at least `max(own, 10)`, where `own` is the test process's own
niceness. Under `nice -n 19` that floor becomes 19, so the correctly lowered
child (10) fails. Rerun alone at normal priority, the file passes 15 of 15.

**Rule.** Run the gates at normal priority. To spare a concurrent smoke, run
them after it instead of lowering their priority; a build or a lint can still
run under `nice`.

**Encoded in.** This fragment, for `gotchas.md` at the next pack version.
