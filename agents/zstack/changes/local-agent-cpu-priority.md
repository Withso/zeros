# Local agent work runs below the UI's CPU priority

Symptom: during dogfooding the Mac stayed pegged (load 17 on 10 cores) while
agents ran typecheck, build and test suites; the Zeros UI and the user's own
apps competed with them at equal priority.
Cause: agent hosts, and therefore every tool command they start, inherited the
engine's normal priority.
Rule: a local agent host starts below normal priority (niceness 10) before it
runs anything, so its descendants inherit it at fork; it still uses idle cores.
Cloud agents keep normal priority on their own VM, and a target argument can
never be read as the supervisor's own option.
Encoded by: host-boundary.test.ts (grandchild niceness, look-alike target
argument), cloud-native-boundary.test.ts (no priority request reaches the VM),
agent-cpu-priority.test.ts (ZEROS_AGENT_CPU_PRIORITY=normal opt-out).
Proposed target: zeros-workspaces brief, Local realities.
