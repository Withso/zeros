# Main required-check migration

The repository owner runs `scripts/ci/ruleset-migration.mjs` with an authenticated
`gh` session that has repository Administration write access. The automation
identity can read the ruleset but cannot update it. This tool changes only
`Withso/zeros` ruleset **20461995**, for `main`; it never changes workflow
definitions, producers, repository settings, or release rulesets.

`GH_TOKEN` and `GITHUB_TOKEN` take precedence over `gh`'s stored login. In a shell
provisioned with the automation token, remove those inherited variables before
using the owner's stored login. Keep authentication out of command arguments
and rollout artifacts.

All managed requirements remain bound to GitHub Actions integration **15368**.
The initial nine contexts are `quality`, `test`, `build`, `source-sync (macOS)`,
`control plane`, `ui-smoke (composer)`, `secret scan (PR commit range)`,
`actionlint`, and `codeql`. The final four are `zeros/ci-gate`, `actionlint`,
`codeql`, and `secret-scan`.

## Preparation and tool behavior

1. Hold auto-merge and coordinate manual merges and ruleset administration for
   the entire transition. Verify the Alpha provider isolation prerequisites in
   the CI rollout before weakening the PR requirements. Beta and Production
   keep their existing workflows, evidence identities, and provider settings.
2. Review the producer changes on `main`. Checks must come from the canonical
   selected workflow; shadow jobs must use distinct names. A cosmetic green
   alias does not qualify as a replacement scan or selected gate.
3. Populate final-name checks on **every currently open PR source head**,
   including forks, using fresh eligible PR events or head updates. Rerunning
   an old run uses its original definition; a dispatch does not establish the
   required PR check. Keep stale PRs held until their current heads qualify.
   Qualify merge-group canaries separately if a merge queue is in use.
4. Keep an independent original snapshot before the first operation:

   ```bash
   mkdir -p .context/ci-rollout
   gh api --method GET repos/Withso/zeros/rulesets/20461995 > .context/ci-rollout/main-original.json
   ```

Node and `gh` are the only runtime dependencies. From the repository root:

```bash
node scripts/ci/ruleset-migration.mjs --help
node scripts/ci/ruleset-migration.mjs plan --stage add-gate
node scripts/ci/ruleset-migration.mjs verify --stage add-gate
node scripts/ci/ruleset-migration.mjs apply --stage add-gate
```

`plan` fetches the live ruleset, prints the exact JSON patch and PUT payload,
and writes `.context/ci-rollout/<stage>.json`. It also saves `<stage>.diff.json`
and `<stage>.before.json`. Only the required-check list changes; every other
rule, parameter, bypass actor, condition, enforcement value, and
`strict_required_status_checks_policy` is retained. GitHub GET-only metadata is
excluded from the PUT body. Extra requirements added by the owner are retained,
so the final set has four managed contexts plus any such extra requirements.

`verify` requires a real successful completion within the last seven days from
integration 15368 for every incoming context, and green reporting on every open
PR's current source head. It prints missing, pending, failing, foreign-source,
and duplicate-producer gaps and exits nonzero on any gap. `add-secret-scan`
also rechecks the gate; `finalize` checks all four retained names; rollback
checks all nine legacy names. The deliberately skipped legacy composer PR
placeholder is accepted only for rollback's current-head check; its recent
success must still come from the real post-merge workload.

The verifier reads all pages of PRs, check runs, and recent Actions runs. Actions
searches use daily UTC buckets to avoid GitHub's 1,000-result filtered-search
limit and fail closed if a bucket reaches that limit or pagination is incomplete.
Completion time determines recent success. Current PR checks also supply
evidence for recent reruns of older open heads. Historical discovery covers
runs created in the window's UTC dates; an old closed head with only a recent
rerun may not be discovered. If that is the sole evidence, generate fresh
eligible canary evidence instead of bypassing verification.

Job metadata distinguishes competing workflow producers and two jobs with the
same display name in one run attempt from legitimate reruns. Replacement names
and the independent scanners must have one observed workflow producer across
the evidence window. Legacy family names can belong to the separate PR `CI`
and push `Preflight` workflows on different heads during rollback, but cannot
collide on the same head. This checks observed executions; the owner must also
review workflow definitions for dormant duplicate jobs. The tool records each
PR's current tested merge SHA for the final population comparison; GitHub
reports the required Actions checks against the PR source SHA.

`apply` defaults to a dry run. Only **`apply ... --yes`** can issue a PUT, and it
always plans from the live ruleset and verifies again in that same invocation.
A prior successful `verify`, a saved payload, or an edited file cannot authorize
a write. Immediately before PUT it rechecks the live ruleset, the PR population,
current source and tested heads, and current check conclusions. It refuses an
inactive ruleset or a changed payload. After PUT it reads back the complete
writable ruleset, prints the before/after required lists, and saves
`<stage>.after.json`. An already-applied stage makes no PUT.

GitHub's ruleset API has no compare-and-swap transaction spanning PR heads and
ruleset updates. Keep merges and other admin edits held until readback completes.
If a write fails or readback differs, inspect the fresh live ruleset and saved
snapshots before replanning; the tool never attempts a blind corrective write.
Repeated planning overwrites that stage's local files, so retain the independent
original snapshot and copy observation snapshots when needed. Do not use a raw
PUT of an old backup for rollback: it can erase unrelated owner changes.

## Stage 1: add the selected gate

Safe only after the selective CI implementation is on `main`, the genuine
`zeros/ci-gate` producer is green on every open PR head, and the nine legacy
producers are still reporting. This stage moves **9 → 10** managed requirements.

```bash
node scripts/ci/ruleset-migration.mjs plan --stage add-gate
node scripts/ci/ruleset-migration.mjs verify --stage add-gate
node scripts/ci/ruleset-migration.mjs apply --stage add-gate
# Inspect the printed diff, payload, and dry-run evidence, then:
node scripts/ci/ruleset-migration.mjs apply --stage add-gate --yes
```

Observe at least **24 hours of dual enforcement**, including new PR heads,
forks, failures, and any merge-group canaries. Keep the old requirements and
producers intact through the overlap. A missing gate today is an expected
verification failure; do not apply until its producer exists and qualifies.

## Stage 2: add the replacement secret scan

Safe only after a real `secret-scan` producer exists on `main`, proves equivalent
or stronger commit-range coverage, and is green on all current open PR heads.
The old `secret scan (PR commit range)` producer must still report. This moves
**10 → 11** managed requirements, requiring both scan names.

```bash
node scripts/ci/ruleset-migration.mjs plan --stage add-secret-scan
node scripts/ci/ruleset-migration.mjs verify --stage add-secret-scan
node scripts/ci/ruleset-migration.mjs apply --stage add-secret-scan
node scripts/ci/ruleset-migration.mjs apply --stage add-secret-scan --yes
```

Observe the dual scan names on current and new PR heads before retirement.
If scan overlap is unavailable, retain the old requirement and stop here until
an explicit producer migration supplies it.

## Finalize after observation

Safe after the gate observation window and dual-scan canaries have passed, with
all four final names green on every current PR head. The tool refuses to
finalize unless all four are already required. It removes only the six legacy
family requirements and the old secret-scan name, moving **11 → 4**.

```bash
node scripts/ci/ruleset-migration.mjs plan --stage finalize
node scripts/ci/ruleset-migration.mjs verify --stage finalize
node scripts/ci/ruleset-migration.mjs apply --stage finalize
node scripts/ci/ruleset-migration.mjs apply --stage finalize --yes
```

Confirm the readback, then retire the legacy PR producers in the coordinated
workflow change. Preserve the full `Preflight` and `CodeQL` release-evidence
identities and Beta/Production's existing barrier. Resume ordinary merge
operations only after the current-head and incoming-head canaries remain green.

## Rollback: restore producers, restore requirements, then retire replacements

First restore the legacy workflow producers, triggers, and exact display names
while keeping the new producers available. Populate their contexts on every
current open head with fresh eligible runs, and obtain real successes within
seven days. The tool cannot restore workflows and refuses to re-add missing or
unqualified old contexts.

Restore the old requirements **alongside** the replacements:

```bash
node scripts/ci/ruleset-migration.mjs plan --stage rollback --rollback-phase restore
node scripts/ci/ruleset-migration.mjs verify --stage rollback --rollback-phase restore
node scripts/ci/ruleset-migration.mjs apply --stage rollback --rollback-phase restore
node scripts/ci/ruleset-migration.mjs apply --stage rollback --rollback-phase restore --yes
```

From the final state this first PUT moves **4 → 11**, without removing a final
requirement. `restore` is the default rollback phase and repeating it makes no
additional write. Confirm that the nine legacy requirements are now enforced
and observe the restored producers before the second phase:

```bash
node scripts/ci/ruleset-migration.mjs plan --stage rollback --rollback-phase retire
node scripts/ci/ruleset-migration.mjs verify --stage rollback --rollback-phase retire
node scripts/ci/ruleset-migration.mjs apply --stage rollback --rollback-phase retire
node scripts/ci/ruleset-migration.mjs apply --stage rollback --rollback-phase retire --yes
```

This second verified PUT moves **11 → 9**, removing only `zeros/ci-gate` and
`secret-scan`. It refuses to run unless all nine legacy requirements are already
present. Retire replacement producers only after this readback; keep at least
one qualified gate/family set and every required scanner throughout. No phase
disables protection or changes the strict flag.
