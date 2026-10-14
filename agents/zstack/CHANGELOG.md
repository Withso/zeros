# zstack changelog

Each entry records the lesson behind the change as symptom → cause → rule →
where it is encoded.

## 0.1.6

- **Style-build teardown could disappear before archive retry.** Settled
  command promises and cache eviction were mistaken for process-stop proof.
  Keep unresolved boundary authority until the original proof succeeds, and
  test archive retries, settings replacement, idle stop and eviction
  (`design/__tests__/style-build-lifecycle.test.ts`). The same suite proves
  that failed one-shot builds retry on reopen, not on presence heartbeats.
  The real-process presence-expiry test arms its short lease after startup,
  so scheduler coverage does not assume a shell starts within 50 ms.
- **Imported styles lost images and linked-CSS theme variables.** Render
  preparation skipped source-relative raster assets and scanned only HTML for
  Tailwind candidates. Test asset dependencies and canonical path restrictions,
  linked and snapshot CSS, and actual Local/cloud preview rendering
  (`style-sources.test.ts`, `style-sources-render.test.ts`,
  `verification-browser.test.ts`).

## 0.1.5

- **UI work had no procedure, and mockups drifted from the product.** 20 of 25 standalone mockups in
  `styles/Artifacts/` hand-copied token values that later changed, so designs no longer matched the app.
  Zeros mockups now live in `Zeros - Design/`, whose `tokens.css` `pnpm design:docs` generates and
  `check:ui` keeps fresh. UI work follows design → verify → approve → implement → look
  (`playbooks/ui-design.md`, `zeros-ui`).
- **A new workspace failed required gates for environment reasons.** Its setup ran only `pnpm install`,
  so `pnpm typecheck` lacked the control-plane dependencies and Playwright suites lacked Chromium. Install
  all three dependency graphs, and rerun failures in a clean base checkout before blaming the diff
  (`zstack-verify`).

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
