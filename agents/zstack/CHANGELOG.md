# zstack changelog

Each entry records the lesson behind the change as symptom → cause → rule →
where it is encoded.

## 0.1.7

- Folds cloud lifecycle lessons on bounded SQL claims, timestamp precision,
  durable provider intent, additive migration ladder checks and opt-in provider
  recovery, plus root protocol invocation, isolated frozen-patch verification
  and the node-pty rebuild after `--ignore-scripts` (`changes/`, `zstack-verify`).
- Adds lock-holding concurrency sized to the role's pool, one test database
  per concurrent run, and the advisory-lock purpose registry check
  (`changes/`, `zstack-verify`).
- Adds the checkpoint round's lessons:
  - capping slow step classes in a shared slot pool;
  - missing-object Git fixtures;
  - comparing the staged diff with a frozen patch before committing;
  - one admission fence for background checkout moves;
  - aborting deferred work before Stop cancels its dependency;
  - injecting fixture PATH through the runtime channel;
  - running VM scripts once on the real image;
  - testing a case that only a script's primary path passes;
  - fencing operations by their own generation rather than by state;
  - passing shell path lists NUL-terminated, keeping trailing newlines, and
    checking the lister's status;
  - guarding every name on a pointer's route, not only where it resolves;
  - running `test:git` under umask 022
  (`changes/`, `zstack-verify`, `integrate-pr`).

## 0.1.6

Folds the lessons from #482 and #484, pins merged eval cases to their merge commits, and adds the
lessons from the first fixture lifecycle run.

- **Qualification hid its first failure.** Pending cleanup replaced the closed smoke diagnostic, and
  reconciliation then replaced that with a timeout. Persist the first failure before cleanup and keep it
  through retries, including a transient diagnostic-write outage (`playbooks/bug-fix.md`, case
  `qualification-first-failure-survives-cleanup`).
- **Checkout imports hid a missing runtime dependency.** The engine's channel-policy imports lay outside
  the staged source slices. Probe the staged import and the complete source engine in the archive,
  separately from bundled CLI help (`playbooks/bug-fix.md`, case `runtime-source-import-closure`).
- **A hidden or stable catalog still woke every two seconds.** The fetch guard suppressed requests but left
  the interval running. Use one visible next-due timeout and count callbacks as well as requests in
  fake-clock tests. Release the network flight before the slower cache restore, and recheck workspace
  eligibility after it (`docs/ui-interaction-performance.md`, case `cloud-catalog-next-due-timer`).
- **The owner was asked to rebuild before the runtime qualified.** A build pins the newest qualified
  runtime, which was still the broken one. Confirm qualification first, then compare the build's persisted
  `runtime_id` (`playbooks/alpha-operator.md`).
- **The integrate steps asked for the PR number before the PR existed.** Open the PR first, then pin
  pending cases and force-push with lease. Check all four PR sections before arming (`integrate-pr.md`).
- **A scripted lifecycle run chained cleanup after a failed resume.** It would have deleted the evidence.
  Stop at the first failed stage and capture database rows and control-plane logs first; a lifecycle run
  counts only once stop and resume pass (`zstack-verify`).
- **A plan recorded estimated times.** Every recorded time comes from a clock read (`zstack-verify`).
- **A subagent sat idle for 50 minutes** while its feed was quiet. Masters check session status when a feed
  goes quiet and send the next step (`zstack`).

## 0.1.5

- **Every PR appended to the same eval file and changelog,** so parallel PRs always conflicted. New eval
  cases now live in `evals/cases/<id>.json` and lessons in `changes/<id>.md`. The legacy `cases.json` stays
  readable (`zstack-eval`, `zstack-learn`, README).

## 0.1.4

- **A large database fixture hit the 5 s test timeout.** The retention pagination test runs 53 journals and
  153 deletion attempts and never starts the listener the PR changed. 2 ms of database delay reproduced it.
  Trace reachability first and separate test budgets from production deadlines (`playbooks/ci-red.md`,
  case `retention-pagination-test-budget`).

## 0.1.3

- **A concurrent last-slot test expected only a capacity refusal.** Bounded SERIALIZABLE retries can run
  out before the winner commits, which correctly returns transient contention. Control both commit
  schedules and assert each exact error and the capacity bound (`playbooks/ci-red.md`, case
  `warm-context-capacity-commit-order`).

## 0.1.2

- **An empty log queue still woke every second.** Its early return suppressed IPC but left the interval
  running. The flusher now wakes from enqueue and parks at the circuit deadline. Scheduler tests must
  count scheduled work after the queue drains and cover pending flights and backoff
  (`playbooks/bug-fix.md`, case `empty-renderer-log-poll`).

## 0.1.1

- **Subagents can't know their PR number** when they add an eval case. Use `fixedBy: "pending"` locally
  (`--allow-pending`); the integrator replaces it. CI stays strict (`zstack-eval`, `integrate-pr.md`).
- **Path-selected PR CI missed a concurrency race** that turned `main` red after #467. Label control-plane
  concurrency changes `ci:control-plane-db` (`zstack-verify`).
- **A new identifier form broke a downstream parser.** Named Computer references were rejected by the VM
  helper. Update every consumer in the same change (case `new-image-ref-form-unhandled-by-vm-helper`).

## 0.1.0 (Z0)

The pack is introduced: the router, verify, review, eval and learn skills,
five playbooks, and eleven seed eval cases from real Alpha incidents.

Lessons already encoded:
- **Result ownership must precede activity publication.** An unrelated Claude
  result kept a user promise pending but briefly published idle to attached
  clients. Classify ownership before translation; test every emitted activity
  snapshot across Personal Local, organization-local and cloud paths
  (`claude-sdk/__tests__/adapter.test.ts`).
- **Tool outcomes are not recovery evidence.** A late result without its
  invocation hid the failed-turn card and Retry. Require invocation evidence
  before treating a tool as resumed model work, and replay through the shared
  history reducer (`turn-failure-presentation.test.ts`).
- **An omitted activity flag is not an explicit false.** Monitor watchers can
  arrive as ordinary shell tasks on older Claude streams. Join native tool and
  task IDs as a fallback, retain explicit membership flags, and keep process
  ownership separate from the visible 2 → 1 → 0 task count. Native, adapter and
  browser regressions cover late joins, cancellation and an idle parent with
  only a watcher remaining (case `claude-monitor-visible-activity`).
- **Claude init does not confirm a resumable conversation.** Failed sign-in
  published an ID before Claude saved the conversation, so the next send resumed
  a missing session. Confirm root model work or success before persisting a new
  binding, retain existing confirmed bindings, and resolve historical sign-in
  UI only from real conversation progress (case `claude-provisional-auth-session`).
- **Feedback must survive its consumer.** Usage dedupe reset at intermediate
  results, while reusing an immutable notice ID dropped later status changes.
  Keep per-turn budget state, issue new receipts for changed states and project
  one tail notice across background replies and steering. Test the shared reducer,
  saved native message IDs and copied transcripts (`zstack-review`, Claude
  feedback and renderer regressions; case `claude-usage-status-through-history`).
- **Deduplication does not choose a visual surface.** Informational usage status
  is plain inbetween transcript text; authentication and blocked-turn failures
  use action notices. Browser checks now verify the usage row has no banner
  background, inset, border or action (`ui-smoke-claude-runtime-ui.mjs`).
- **Agent lifecycle records need one presentation owner.** A native child can
  emit both an Agent group and task lifecycle records. Join by exact child identity
  before hiding a duplicate; preserve unmatched records and unrepresented failures
  (`docs/agent-tool-presentation.md`, case `claude-agent-lifecycle-duplicate`).
  Failed status can precede its explanation: compare displayed detail, not just
  terminal status, and retain saved-history regressions in
  `agent-background-presentation.test.ts`.
- **Provider fixtures can lie.** A synthetic Boat tree passed while the real
  one failed. The rule is to qualify against a real response
  (`zstack-review`, case `boat-saved-tree-real-shape`).
- **Unlink does not persist on Boat's incremental save.** Sanitize by
  truncating in place and prove the saved artifact (case
  `sanitize-by-emptying-not-deleting`).
- **Read paths took mutation locks.** That caused 80% of DB time and
  reconnect loops. Reads take no mutation lock, and deadlines anchor at the
  start of the observation (case `read-path-took-owner-lock`).
- **Fixed sleeps make flakes.** Hold the condition instead (cases
  `fixed-sleep-lock-contention` and `interactive-shell-ignores-term`).
- **Exact time bounds break on clock skew.** Compare against documented bounds
  (case `authorization-window-clock-skew`).
- **Release workflows must not be partially rerun.** Carried jobs break
  signed-build provenance (`playbooks/ci-red.md`).
- **Shell pipes buffer output.** Use `sed -u` or `--line-buffered` when a later
  step needs the line right away (`zstack-verify`).
- **Environment changes masquerade as failures.** Check PATH tools, database
  encoding and disk preconditions first (`zstack-verify`,
  `playbooks/alpha-operator.md`).
