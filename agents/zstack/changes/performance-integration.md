# Performance work: measure workarounds, run composition suites, check rebases

Symptom: the packaged engine stat-polled every file of every non-archived workspace every 1.5 s (8,305
pollers for one checkout of this repository) as a workaround for a bun FSEvents deadlock; nobody had
measured it. Four idle roots cost 4.67 % of a core against 0.03 % for one native recursive watch per root
in a Node helper.
Cause: a correctness workaround's cost scales with workspaces × files, and only a per-root measurement
shows it.
Rule: when a platform workaround replaces an event source with polling, record its per-unit cost
(per root, per file, per tick) in the change and test the replacement's fallback path. Prefer moving the
native capability into a helper process over polling in-process.
Encoded by: `apps/desktop/src/engine/git/watch-host.cjs`, `watch-host-client.ts` and their suite.

Symptom: a subagent's dispatch change passed its feature suites but broke four engine composition suites
whose reporter stubs lacked the new method.
Rule: a change to `zeros-engine.ts` dispatch or to an object the engine constructs runs the whole
`apps/desktop/src/engine/__tests__/` and `apps/desktop/electron/__tests__/` directories before it is pushed;
optional collaborators are called with optional calls.
Encoded by: the master/subagent instructions in this change; candidate for zstack-verify adjacency.

Symptom: during an integration rebase a failed resolution script was followed by `git add -A` and
`rebase --continue`, committing conflict markers.
Rule: after resolving, run `git diff --check` (it reports leftover markers) and grep for `^<<<<<<< ` before
continuing; anchor marker checks to line starts because fixtures legitimately contain marker text.
Encoded by: this fragment; candidate for playbooks/integrate-pr.md.

Symptom: a draft PR ran only the merge gate, so its CI never started.
Rule: mark an integration PR ready (it triggers `ready_for_review`) before waiting on CI.
Encoded by: this fragment; candidate for playbooks/integrate-pr.md.
