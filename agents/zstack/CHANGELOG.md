# zstack changelog

Each entry records the lesson behind the change as symptom → cause → rule →
where it is encoded.

## 0.1.3

- **A concurrent last-slot test expected only a capacity refusal.** Bounded SERIALIZABLE retries can run
  out before the winner commits, which correctly returns transient contention. Control both commit
  schedules and assert each exact error and the capacity bound (`playbooks/ci-red.md`, case
  `warm-context-capacity-commit-order`).

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
