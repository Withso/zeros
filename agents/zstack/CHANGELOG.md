# zstack changelog

Each entry records the lesson behind the change as symptom → cause → rule →
where it is encoded.

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
