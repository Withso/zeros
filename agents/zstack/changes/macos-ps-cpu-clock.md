# Parse platform tool output against the platform's real format

Symptom: after a long dogfooding session the Resources popover listed only
Electron's five processes; the engine, every agent, terminal and agent-run
tool (tsc, vite, vitest) had disappeared, while the Mac was pegged by them.
Cause: macOS `ps -o time=` prints accumulated CPU as unbounded `MMM:SS.ss`
("77:46.90"). The parser accepted only GNU-style minutes below 60, dropped the
engine's row once it passed an hour of CPU, and the ownership walk then lost
the engine's entire subtree.
Rule: a parser for OS tool output carries a fixture captured from that OS,
including long-running values. When one row anchors a tree walk, test that a
long-lived parent keeps its descendants.
Encoded by: apps/desktop/electron/__tests__/process-metrics.test.ts (real macOS
rows past an hour of CPU, subtree retained) and the Resources ui-smoke check
for the engine, supervisor, agent and tool rows.
Proposed target: playbooks/bug-fix.md, platform-output fixtures.
