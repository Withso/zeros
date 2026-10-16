# Master integration lessons from the 2026-10-15 Gate 0 day

The rehearsal, soak and owner test produced several integration mistakes and
near-misses. Each item is symptom, then cause, then rule.

- **Measure external durations before the first live dispatch.** The
  infrastructure profile required 33–36 minutes of access-token headroom, but
  Alpha WorkOS tokens last 300 seconds. The first real dispatch failed after
  about ten minutes of fixture work. Unit fakes used long-lived tokens, and
  scheduled runs always skipped, so nothing exercised the check. For every
  TTL, lease or timeout a harness asserts on, read the real value read-only
  first (consecutive refresh audits, not a session row's created/expiry pair)
  and pin a fake with that value in a test.
- **Do not trust cron cadence for a soak.** The hourly `zeros-dev-e2e` cron
  produced five runs in about nineteen hours. Count the actual runs in each
  window. An owner-approved fallback dispatcher may fill only uncovered hours,
  must never queue behind an active run, and stops on the first failure.
- **Run merge tooling from current main.** The master's tool checkout had stayed
  detached on an old commit. `pnpm agent:merge` there evaluated the gate with
  a stale reader and reported a false `hourly_unavailable` while the PR's own
  gate check passed. Before arming, confirm the tool checkout is at
  `origin/main`.
- **Never delete another agent's directories.** During a disk emergency, a
  verification tree that looked merged by its name was an active
  re-materialized tree. A process working-directory scan did not catch it.
  Each agent prunes only its own scratch. pnpm installs share data blocks
  through the store, so measure reclaimed space with `df`, not `du` or
  `find -links 1`.
- **Integration hygiene.** Start every integration branch from a clean
  `origin/main`. Check that the staged file list equals the frozen patch's
  list and that the hash matches. Pin pending evals to the PR number in a
  follow-up commit.
- **Run the repository layout contract when docs move.** A new
  `docs/cloud-workspace` guide failed `scripts/__tests__/repository-layout.test.ts`
  in CI, because the local full-root run had stopped under disk pressure. Any
  patch that adds a pinned-directory file runs that suite locally.
- **Gate a release on data safety.** A renderer-only release could not fix
  engine-side history deletion, and the auto-upgrade restore took the same
  destructive path. Hold releases while a confirmed data-loss path is unfixed,
  even when other fixes are ready.

Encoded here; individual product fixes carry their own fragments and evals.
