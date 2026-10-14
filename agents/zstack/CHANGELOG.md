# zstack changelog

Each entry records the lesson behind the change as symptom → cause → rule →
where it is encoded.

## 0.1.0 (Z0)

The pack is introduced: the router, verify, review, eval and learn skills,
five playbooks, and eleven seed eval cases from real Alpha incidents.

Lessons already encoded:
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
