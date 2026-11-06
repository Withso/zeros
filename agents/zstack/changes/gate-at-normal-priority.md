# A gate run under `nice` reports the runner, and its priority failure is real

Target: `gotchas.md` (Node, Vitest and TypeScript).

**Symptom.** `nice -n 19 pnpm test:git`, run to spare a concurrent smoke,
failed `engine/agents/containment/__tests__/host-boundary.test.ts`, "runs a
local agent host and its descendants below normal CPU priority", with
`expected 10 to be greater than or equal to 19`. At normal priority the file
passes 15 of 15.

**Cause.** The host supervisor sets niceness 10
(`os.setPriority(PRIORITY_BELOW_NORMAL)`) without reading its own first. The
container runs as root, so from niceness 19 that call raised the host above
its parent; the test asserts the host never runs ahead of it
(`max(own, 10)`). Unprivileged, the call fails and an already-lower host
keeps its value, as `host-process-supervisor.mjs` intends.

**Rule.** Run the gates at normal priority so a result describes the code,
not the runner; to spare a smoke, run them after it. A failure that appears
only under `nice` is a finding: report it rather than call the child's
priority correct. A build or lint can still run under `nice`.

**Encoded in.** This fragment, for `gotchas.md` at the next pack version.
